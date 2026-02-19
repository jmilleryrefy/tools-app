import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

// GET /api/scripts - List all active scripts
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const category = searchParams.get("category");
  const search = searchParams.get("search");

  const scripts = await prisma.script.findMany({
    where: {
      isActive: true,
      ...(category ? { categoryId: category } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search } },
              { description: { contains: search } },
              { tags: { contains: search } },
            ],
          }
        : {}),
    },
    include: {
      category: { select: { id: true, name: true } },
      _count: { select: { parameters: true } },
    },
    orderBy: { name: "asc" },
  });

  return NextResponse.json(scripts);
}
