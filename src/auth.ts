import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/auth.config";

// Auto-role assignment on first sign-in (comma-separated email lists from env)
// e.g. AUTH_AUTO_ADMIN_EMAILS="jmiller@yrefy.com"
//      AUTH_AUTO_OPERATOR_EMAILS="kwilson@yrefy.com,crees@yrefy.com"
const AUTO_ADMIN_EMAILS = (process.env.AUTH_AUTO_ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const AUTO_OPERATOR_EMAILS = (process.env.AUTH_AUTO_OPERATOR_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  events: {
    async createUser({ user }) {
      // Auto-assign roles on first sign-in
      const email = user.email?.toLowerCase();
      if (email && AUTO_ADMIN_EMAILS.includes(email)) {
        await prisma.user.update({
          where: { id: user.id! },
          data: { role: "ADMIN" },
        });
      } else if (email && AUTO_OPERATOR_EMAILS.includes(email)) {
        await prisma.user.update({
          where: { id: user.id! },
          data: { role: "OPERATOR" },
        });
      }
    },
    // [m365-auth-debug] Logs exactly what Entra returned when the account is
    // first linked. The critical signal is whether a refresh_token is present:
    // if false, Entra did not issue one (usually offline_access wasn't granted
    // or admin consent is missing). Note: PrismaAdapter only links on first
    // sign-in, so an existing user re-signing in does NOT trigger this.
    async linkAccount({ user, account }) {
      console.log("[m365-auth-debug] linkAccount", {
        userEmail: user.email,
        provider: account.provider,
        scope: account.scope,
        token_type: account.token_type,
        expires_at: account.expires_at,
        has_access_token: !!account.access_token,
        has_refresh_token: !!account.refresh_token,
        has_id_token: !!account.id_token,
      });
    },
    async signIn({ user, account, isNewUser }) {
      console.log("[m365-auth-debug] signIn", {
        userEmail: user.email,
        provider: account?.provider,
        scope: account?.scope,
        has_refresh_token: !!account?.refresh_token,
        isNewUser,
      });
    },
  },
  callbacks: {
    ...authConfig.callbacks,
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        const dbUser = await prisma.user.findUnique({
          where: { id: user.id },
          select: { role: true },
        });
        session.user.role = dbUser?.role ?? "VIEWER";
      }
      return session;
    },
  },
});
