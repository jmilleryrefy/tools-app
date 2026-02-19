"use client";

import Link from "next/link";
import { ScrollText, Tag, Play } from "lucide-react";

interface ScriptCardProps {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  categoryName: string;
  tags: string | null;
  requiresAdmin: boolean;
}

export default function ScriptCard({
  name,
  slug,
  description,
  categoryName,
  tags,
  requiresAdmin,
}: ScriptCardProps) {
  const tagList = tags?.split(",").map((t) => t.trim()).filter(Boolean) ?? [];

  return (
    <Link
      href={`/scripts/${slug}`}
      className="group block bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-blue-500/50 hover:bg-gray-900/80 transition-all"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-blue-500" />
          <h3 className="font-semibold text-white group-hover:text-blue-400 transition-colors">
            {name}
          </h3>
        </div>
        {requiresAdmin && (
          <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">
            Admin
          </span>
        )}
      </div>

      <p className="text-sm text-gray-400 mb-4 line-clamp-2">
        {description || "No description available."}
      </p>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs bg-gray-800 text-gray-300 px-2 py-1 rounded">
            {categoryName}
          </span>
          {tagList.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 text-xs text-gray-500"
            >
              <Tag className="h-3 w-3" />
              {tag}
            </span>
          ))}
        </div>
        <Play className="h-4 w-4 text-gray-600 group-hover:text-blue-500 transition-colors" />
      </div>
    </Link>
  );
}
