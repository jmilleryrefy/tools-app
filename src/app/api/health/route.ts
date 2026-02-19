import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

async function getHealthResponse() {
  try {
    // Verify database connectivity
    await prisma.$queryRaw`SELECT 1`;

    return NextResponse.json(
      {
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "tools-app",
        uptime: process.uptime(),
        version: "0.1.0",
      },
      { status: 200 }
    );
  } catch {
    return NextResponse.json(
      {
        status: "error",
        timestamp: new Date().toISOString(),
        service: "tools-app",
        uptime: process.uptime(),
        version: "0.1.0",
        error: "Database connection failed",
      },
      { status: 503 }
    );
  }
}

export async function GET() {
  return getHealthResponse();
}

export async function HEAD() {
  const response = await getHealthResponse();
  return new NextResponse(null, { status: response.status });
}
