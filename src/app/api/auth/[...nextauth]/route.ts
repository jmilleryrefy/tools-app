import { handlers } from "@/auth";
import { NextRequest } from "next/server";

const originalGET = handlers.GET;
const originalPOST = handlers.POST;

export async function GET(req: NextRequest) {
  console.log(`[AUTH API] GET ${req.nextUrl.pathname}${req.nextUrl.search}`);
  return originalGET(req);
}

export async function POST(req: NextRequest) {
  console.log(`[AUTH API] POST ${req.nextUrl.pathname}${req.nextUrl.search}`);
  return originalPOST(req);
}
