import Navbar from "@/components/Navbar";
import CodeBlock from "@/components/CodeBlock";
import CopyButton from "@/components/CopyButton";
import ScriptExecutor from "@/components/ScriptExecutor";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Calendar,
  Tag,
  Shield,
  FolderOpen,
  Download,
} from "lucide-react";

export default async function ScriptDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const script = await prisma.script.findUnique({
    where: { slug },
    include: {
      category: true,
      parameters: { orderBy: { sortOrder: "asc" } },
    },
  });

  if (!script || !script.isActive) {
    notFound();
  }

  const tagList =
    script.tags
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean) ?? [];

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Breadcrumb */}
        <Link
          href="/scripts"
          className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Scripts
        </Link>

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-start justify-between mb-3">
            <h1 className="text-2xl font-bold text-white">{script.name}</h1>
            <div className="flex items-center gap-2">
              <CopyButton text={script.content} />
              <a
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(script.content)}`}
                download={`${script.slug}.ps1`}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
              >
                <Download className="h-4 w-4" />
                Download
              </a>
            </div>
          </div>
          {script.description && (
            <p className="text-gray-400 mb-4">{script.description}</p>
          )}
          <div className="flex items-center gap-4 flex-wrap text-sm text-gray-500">
            <span className="flex items-center gap-1.5">
              <FolderOpen className="h-4 w-4" />
              {script.category.name}
            </span>
            <span className="flex items-center gap-1.5">
              <Calendar className="h-4 w-4" />
              Updated {script.updatedAt.toLocaleDateString()}
            </span>
            {script.requiresAdmin && (
              <span className="flex items-center gap-1.5 text-amber-400">
                <Shield className="h-4 w-4" />
                Requires Admin
              </span>
            )}
          </div>
          {tagList.length > 0 && (
            <div className="flex items-center gap-2 mt-3">
              {tagList.map((tag) => (
                <span
                  key={tag}
                  className="flex items-center gap-1 text-xs bg-gray-800 text-gray-400 px-2 py-1 rounded"
                >
                  <Tag className="h-3 w-3" />
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Script Content */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-white mb-3">
            Script Content
          </h2>
          <CodeBlock code={script.content} />
        </div>

        {/* Execution Section */}
        <div>
          <h2 className="text-lg font-semibold text-white mb-3">
            Execute Script
          </h2>
          <ScriptExecutor
            scriptId={script.id}
            parameters={script.parameters}
          />
        </div>
      </main>
    </div>
  );
}
