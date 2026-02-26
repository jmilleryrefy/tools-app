import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";
import { NextResponse } from "next/server";

// Use the edge-safe config (no Prisma) for proxy
const { auth } = NextAuth(authConfig);

export const proxy = auth((req) => {
  const { pathname } = req.nextUrl;
  const isAuthenticated = !!req.auth;
  const cookieNames = req.cookies.getAll().map((c) => c.name);
  console.log(`[AUTH PROXY] ${req.method} ${pathname} | authenticated: ${isAuthenticated} | user: ${req.auth?.user?.email ?? "none"} | cookies: [${cookieNames.join(", ")}]`);
  if (!isAuthenticated) {
    console.log(`[AUTH PROXY] Unauthenticated request to ${pathname} — letting NextAuth handle redirect`);
  }
  // Let NextAuth's default behavior handle the redirect for unauthenticated users
  return NextResponse.next();
});

export const config = {
  matcher: [
    // Protect all routes except auth, api/auth, api/health, static files, and favicon
    "/((?!api/auth|api/health|auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
