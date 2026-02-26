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
