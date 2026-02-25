import Navbar from "@/components/Navbar";
import ScriptCard from "@/components/ScriptCard";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { FolderOpen } from "lucide-react";

export default async function ScriptsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; search?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/auth/signin");

  const { category, search } = await searchParams;

  const categories = await prisma.category.findMany({
    orderBy: { sortOrder: "asc" },
    include: { _count: { select: { scripts: true } } },
  });

  const scripts = await prisma.script.findMany({
    where: {
      isActive: true,
      ...(category ? { category: { is: { name: { contains: category.replace(/-/g, " ") } } } } : {}),
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
    include: { category: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">Scripts</h1>
            <p className="text-gray-400 text-sm mt-1">
              Browse and execute M365 PowerShell scripts
            </p>
          </div>
        </div>

        {/* Search & Filter */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <form className="flex-1">
            <input
              type="text"
              name="search"
              defaultValue={search}
              placeholder="Search scripts..."
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </form>
          <div className="flex gap-2 flex-wrap">
            <CategoryPill
              href="/scripts"
              label="All"
              active={!category}
              count={scripts.length}
            />
            {categories.map((cat) => (
              <CategoryPill
                key={cat.id}
                href={`/scripts?category=${cat.name.toLowerCase().replace(/\s+/g, "-")}`}
                label={cat.name}
                active={category === cat.name.toLowerCase().replace(/\s+/g, "-")}
                count={cat._count.scripts}
              />
            ))}
          </div>
        </div>

        {/* Scripts Grid */}
        {scripts.length === 0 ? (
          <div className="text-center py-16">
            <FolderOpen className="h-12 w-12 mx-auto text-gray-700 mb-3" />
            <p className="text-gray-400 font-medium">No scripts found</p>
            <p className="text-gray-500 text-sm mt-1">
              {search
                ? "Try a different search term."
                : "No scripts have been added yet."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {scripts.map((script) => (
              <ScriptCard
                key={script.id}
                id={script.id}
                name={script.name}
                slug={script.slug}
                description={script.description}
                categoryName={script.category.name}
                tags={script.tags}
                requiresAdmin={script.requiresAdmin}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function CategoryPill({
  href,
  label,
  active,
  count,
}: {
  href: string;
  label: string;
  active: boolean;
  count: number;
}) {
  return (
    <a
      href={href}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
        active
          ? "bg-blue-600 text-white"
          : "bg-gray-900 border border-gray-800 text-gray-400 hover:text-white hover:border-gray-700"
      }`}
    >
      {label}
      <span
        className={`text-xs ${active ? "text-blue-200" : "text-gray-600"}`}
      >
        {count}
      </span>
    </a>
  );
}
