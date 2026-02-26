import { NextRequest, NextResponse } from "next/server";

// Optimistic cookie-based proxy for route protection.
// Because we use database sessions (not JWT), the edge middleware CANNOT validate
// sessions (no Prisma on the edge). Previously, wrapping with NextAuth's `auth()`
// caused it to invalidate and DELETE the session cookie since it couldn't look it up.
// Instead, we simply check for the session token cookie's presence and redirect to
// sign-in if missing. The real session validation happens server-side in each page/API.
const SESSION_COOKIE_NAME = "authjs.session-token";

export function proxy(req: NextRequest) {
  if (!req.cookies.has(SESSION_COOKIE_NAME)) {
    const response = NextResponse.redirect(new URL("/auth/signin", req.url));
    // Clear stale prefixed cookies from previous NextAuth config
    for (const cookie of req.cookies.getAll()) {
      if (cookie.name.startsWith("__Host-") || cookie.name.startsWith("__Secure-")) {
        response.cookies.delete(cookie.name);
      }
    }
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Protect all routes except auth, api/auth, api/health, static files, and favicon
    "/((?!api/auth|api/health|auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
