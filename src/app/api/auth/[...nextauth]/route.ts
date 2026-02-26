import { handlers } from "@/auth";
import { NextRequest } from "next/server";

const originalGET = handlers.GET;
const originalPOST = handlers.POST;

export async function GET(req: NextRequest) {
  const isCallback = req.nextUrl.pathname.includes("/callback/");
  console.log(`[AUTH API] GET ${req.nextUrl.pathname}${req.nextUrl.search.slice(0, 80)}...`);
  console.log(`[AUTH API] GET request cookies: [${req.cookies.getAll().map((c) => c.name).join(", ")}]`);
  const response = await originalGET(req);
  if (isCallback) {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    console.log(`[AUTH API] Callback response status: ${response.status}`);
    console.log(`[AUTH API] Callback response Location: ${response.headers.get("location") ?? "(none)"}`);
    console.log(`[AUTH API] Callback Set-Cookie headers (${setCookies.length}):`);
    setCookies.forEach((c, i) => {
      // Log cookie name + attributes, truncate value for security
      const parts = c.split("=");
      const name = parts[0];
      const rest = parts.slice(1).join("=");
      const attrs = rest.includes(";") ? rest.slice(rest.indexOf(";")) : "";
      console.log(`[AUTH API]   [${i}] ${name}=<value>${attrs}`);
    });
  }
  return response;
}

export async function POST(req: NextRequest) {
  console.log(`[AUTH API] POST ${req.nextUrl.pathname}${req.nextUrl.search}`);
  return originalPOST(req);
}
