import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import type { NextAuthConfig } from "next-auth";

// Allowed users loaded from env (comma-separated email list)
// e.g. AUTH_ALLOWED_USERS="jmiller@yrefy.com,kwilson@yrefy.com,crees@yrefy.com"
const ALLOWED_USERS = (process.env.AUTH_ALLOWED_USERS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

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
      if (!user.email) return false;
      // If no allowlist is configured, allow all tenant users
      if (ALLOWED_USERS.length === 0) return true;
      return ALLOWED_USERS.includes(user.email.toLowerCase());
    },
  },
  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },
};
