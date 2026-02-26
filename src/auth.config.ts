import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import type { NextAuthConfig } from "next-auth";

// Allowed users loaded from env (comma-separated email list)
// e.g. AUTH_ALLOWED_USERS="jmiller@yrefy.com,kwilson@yrefy.com,crees@yrefy.com"
const ALLOWED_USERS = (process.env.AUTH_ALLOWED_USERS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

console.log("[AUTH CONFIG] Loaded allowed users list:", ALLOWED_USERS.length > 0 ? ALLOWED_USERS : "(empty - all tenant users allowed)");

// Edge-safe auth config — no Prisma, no Node.js modules
// Used by middleware for route protection
export const authConfig: NextAuthConfig = {
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID!,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET!,
      issuer: `https://login.microsoftonline.com/${process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID}/v2.0`,
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      console.log("[AUTH SIGN-IN] signIn callback triggered for user:", { email: user.email, name: user.name });
      if (!user.email) {
        console.log("[AUTH SIGN-IN] REJECTED: No email on user object");
        return false;
      }
      if (ALLOWED_USERS.length === 0) {
        console.log("[AUTH SIGN-IN] ALLOWED: No allowlist configured, permitting all tenant users");
        return true;
      }
      const allowed = ALLOWED_USERS.includes(user.email.toLowerCase());
      console.log(`[AUTH SIGN-IN] ${allowed ? "ALLOWED" : "REJECTED"}: ${user.email} (allowlist check)`);
      return allowed;
    },
  },
  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },
};
