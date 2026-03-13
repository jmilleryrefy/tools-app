"use client";

import { useState } from "react";
import { ChevronRight, Code } from "lucide-react";
import CodeBlock from "./CodeBlock";

interface CollapsibleCodeBlockProps {
  code: string;
  language?: string;
}

export default function CollapsibleCodeBlock({
  code,
  language,
}: CollapsibleCodeBlockProps) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-lg font-semibold text-white hover:text-gray-300 transition-colors"
      >
        <ChevronRight
          className={`h-5 w-5 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Code className="h-5 w-5 text-gray-400" />
        Script Content
      </button>
      {open && (
        <div className="mt-3">
          <CodeBlock code={code} language={language} />
        </div>
      )}
    </div>
  );
}
