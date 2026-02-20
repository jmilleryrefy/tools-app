import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

// Use the edge-safe config (no Prisma) for middleware
const { auth } = NextAuth(authConfig);

export default auth;

export const config = {
  matcher: [
    // Protect all routes except auth, api/auth, api/health, static files, and favicon
    "/((?!api/auth|api/health|auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
