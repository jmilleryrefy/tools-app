import { prisma } from "@/lib/prisma";

/**
 * Mints short-lived, resource-specific delegated access tokens for the
 * signed-in user so that executed PowerShell scripts can connect to
 * Microsoft 365 (Microsoft Graph and Exchange Online) AS THAT USER,
 * instead of triggering a separate interactive device-code login.
 *
 * Flow:
 *   1. At web sign-in (NextAuth + Microsoft Entra ID), we request
 *      `offline_access` so Entra issues a refresh token. The PrismaAdapter
 *      stores it in the `Account` table (`refresh_token`).
 *   2. At script-execution time we redeem that refresh token against the
 *      Entra token endpoint, once per target resource (Graph, EXO), using
 *      the `<resource>/.default` scope. `.default` returns a token carrying
 *      every delegated permission the app has been consented for, so the
 *      per-script `-Scopes` lists no longer matter.
 *
 * Because all operators are M365 admins, the resulting delegated tokens
 * carry the admin permissions the scripts require.
 *
 * NOTE: This is NOT the On-Behalf-Of grant. With NextAuth's database
 * session strategy there is no session JWT to exchange, so we use the
 * refresh token already persisted by the adapter (refresh_token grant).
 */

const TENANT_ID = process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID;
const CLIENT_ID = process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
const CLIENT_SECRET = process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET;

// Resource scopes. `.default` yields all consented delegated permissions
// for that resource, so we don't have to enumerate per-script scopes.
const GRAPH_SCOPE = "https://graph.microsoft.com/.default offline_access";
// Office 365 Exchange Online resource (well-known app id / resource URI).
const EXO_SCOPE = "https://outlook.office365.com/.default offline_access";

export class M365TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "M365TokenError";
  }
}

export interface M365Tokens {
  /** Present only when a Graph token was requested. */
  graphToken?: string;
  /** Present only when an Exchange Online token was requested. */
  exoToken?: string;
  /** UPN required by Connect-ExchangeOnline when using a delegated token. */
  upn: string;
}

/** Which Microsoft 365 resources a script needs tokens for. */
export interface M365Needs {
  graph: boolean;
  exo: boolean;
}

/**
 * Detect which Microsoft 365 services a PowerShell script connects to, based
 * on the connect cmdlets it invokes. This is more precise than inspecting
 * imported modules, since a script may import a module but only connect to one
 * service.
 */
export function detectM365Needs(scriptContent: string): M365Needs {
  return {
    graph: /\bConnect-MgGraph\b/i.test(scriptContent),
    exo: /\bConnect-ExchangeOnline\b/i.test(scriptContent),
  };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

/**
 * Redeem a refresh token for a resource-specific access token.
 * Returns the new access token and (if Entra rotated it) a new refresh token.
 */
async function redeemRefreshToken(
  refreshToken: string,
  scope: string
): Promise<TokenResponse> {
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new M365TokenError(
      "Microsoft Entra app credentials are not configured (AUTH_MICROSOFT_ENTRA_ID_*)."
    );
  }

  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    // Tokens must never be cached.
    cache: "no-store",
  });

  const data = (await res.json()) as TokenResponse & {
    error?: string;
    error_description?: string;
  };

  // [m365-auth-debug] Log the redemption outcome. On success we log only
  // non-sensitive metadata (never the tokens themselves); on failure we log
  // the Entra error code/description, which usually pinpoints the cause
  // (e.g. AADSTS65001 = no consent, AADSTS700082 = expired refresh token).
  if (!res.ok || !data.access_token) {
    console.error("[m365-auth-debug] token redemption FAILED", {
      requested_scope: scope,
      http_status: res.status,
      error: data.error,
      error_description: data.error_description,
    });
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new M365TokenError(
      `Failed to obtain Microsoft 365 token for scope "${scope}": ${detail}`
    );
  }

  console.log("[m365-auth-debug] token redemption OK", {
    requested_scope: scope,
    granted_scope: data.scope,
    expires_in: data.expires_in,
    rotated_refresh_token: !!data.refresh_token,
  });

  return data;
}

/**
 * Acquire delegated access tokens for the given user, minting only the
 * resources the script actually needs (see {@link detectM365Needs}). A
 * Graph-only script won't trigger an Exchange Online redemption, so missing
 * EXO consent never blocks Graph-only runs, and unused redemptions are avoided.
 *
 * Reuses the refresh token stored on the user's Microsoft Entra `Account`.
 * If Entra returns a rotated refresh token, it is persisted back so future
 * executions continue to work.
 *
 * Throws {@link M365TokenError} with an actionable message if the user has
 * no linked account / refresh token, or if a required redemption fails (e.g.
 * missing admin consent for the required delegated permissions).
 */
export async function getM365TokensForUser(
  userId: string,
  needs: M365Needs
): Promise<M365Tokens> {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "microsoft-entra-id" },
    select: {
      id: true,
      refresh_token: true,
      access_token: true,
      scope: true,
      expires_at: true,
      user: { select: { email: true } },
    },
  });

  // [m365-auth-debug] Surface the stored account state so we can tell whether
  // the row exists, whether a refresh token was persisted, and which scopes
  // were granted at sign-in.
  console.log("[m365-auth-debug] getM365TokensForUser", {
    userId,
    needs,
    account_found: !!account,
    userEmail: account?.user?.email,
    scope: account?.scope,
    expires_at: account?.expires_at,
    has_access_token: !!account?.access_token,
    has_refresh_token: !!account?.refresh_token,
  });

  if (!account) {
    throw new M365TokenError(
      "No Microsoft account is linked to your profile. Sign out and sign back in to grant access."
    );
  }

  if (!account.refresh_token) {
    throw new M365TokenError(
      "No refresh token is available for your account. Sign out and sign back in so the app can request offline access."
    );
  }

  const upn = account.user?.email;
  if (!upn) {
    throw new M365TokenError("Your account has no email/UPN to connect Microsoft 365 with.");
  }

  const result: M365Tokens = { upn };

  // Track the latest refresh token across redemptions. Entra single-tenant
  // refresh tokens are multi-resource, so one refresh token works for both
  // resources, but Entra may rotate it on each redemption — feed the rotated
  // value into the next call and persist the final value.
  let currentRefresh = account.refresh_token;

  if (needs.graph) {
    const graph = await redeemRefreshToken(currentRefresh, GRAPH_SCOPE);
    result.graphToken = graph.access_token;
    currentRefresh = graph.refresh_token ?? currentRefresh;
  }

  if (needs.exo) {
    const exo = await redeemRefreshToken(currentRefresh, EXO_SCOPE);
    result.exoToken = exo.access_token;
    currentRefresh = exo.refresh_token ?? currentRefresh;
  }

  // Persist the latest refresh token if it changed.
  if (currentRefresh !== account.refresh_token) {
    await prisma.account
      .update({
        where: { id: account.id },
        data: { refresh_token: currentRefresh },
      })
      .catch(() => {
        /* non-fatal: token still usable for this run */
      });
  }

  return result;
}
