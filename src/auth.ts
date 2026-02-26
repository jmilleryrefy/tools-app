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

console.log("[AUTH] Auto-admin emails:", AUTO_ADMIN_EMAILS.length > 0 ? AUTO_ADMIN_EMAILS : "(none)");
console.log("[AUTH] Auto-operator emails:", AUTO_OPERATOR_EMAILS.length > 0 ? AUTO_OPERATOR_EMAILS : "(none)");

// Wrap the Prisma adapter to log all adapter operations
const baseAdapter = PrismaAdapter(prisma);
const loggingAdapter = new Proxy(baseAdapter, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value === "function") {
      return async (...args: unknown[]) => {
        console.log(`[AUTH ADAPTER] ${String(prop)} called with:`, JSON.stringify(args, null, 2).slice(0, 500));
        try {
          const result = await (value as Function).apply(target, args);
          console.log(`[AUTH ADAPTER] ${String(prop)} returned:`, JSON.stringify(result, null, 2)?.slice(0, 500) ?? "undefined");
          return result;
        } catch (error) {
          console.error(`[AUTH ADAPTER] ${String(prop)} THREW ERROR:`, error);
          throw error;
        }
      };
    }
    return value;
  },
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: loggingAdapter,
  session: { strategy: "database" },
  logger: {
    error: (code, ...message) => {
      console.error("[AUTH ERROR]", code, ...message);
    },
    warn: (code) => {
      console.warn("[AUTH WARN]", code);
    },
    debug: (code, ...message) => {
      console.log("[AUTH DEBUG]", code, ...message);
    },
  },
  debug: true,
  events: {
    async createUser({ user }) {
      console.log("[AUTH] createUser event fired for:", { id: user.id, email: user.email, name: user.name });
      // Auto-assign roles on first sign-in
      const email = user.email?.toLowerCase();
      if (email && AUTO_ADMIN_EMAILS.includes(email)) {
        console.log("[AUTH] Auto-assigning ADMIN role to:", email);
        await prisma.user.update({
          where: { id: user.id! },
          data: { role: "ADMIN" },
        });
      } else if (email && AUTO_OPERATOR_EMAILS.includes(email)) {
        console.log("[AUTH] Auto-assigning OPERATOR role to:", email);
        await prisma.user.update({
          where: { id: user.id! },
          data: { role: "OPERATOR" },
        });
      } else {
        console.log("[AUTH] No auto-role match, user will default to VIEWER:", email);
      }
    },
  },
  callbacks: {
    ...authConfig.callbacks,
    async session({ session, user }) {
      console.log("[AUTH SESSION] Session callback triggered for user:", { id: user.id, email: session.user?.email });
      if (session.user) {
        session.user.id = user.id;
        const dbUser = await prisma.user.findUnique({
          where: { id: user.id },
          select: { role: true },
        });
        session.user.role = dbUser?.role ?? "VIEWER";
        console.log("[AUTH SESSION] Session enriched:", { userId: user.id, role: session.user.role, dbUserFound: !!dbUser });
      } else {
        console.log("[AUTH SESSION] WARNING: session.user is falsy, session not enriched");
      }
      return session;
    },
  },
});
