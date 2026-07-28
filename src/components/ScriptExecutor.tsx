"use client";

import { useMemo, useRef, useState } from "react";
import {
  Play,
  Loader2,
  CheckCircle,
  XCircle,
  ChevronUp,
  ChevronDown,
  FileText,
  Table2,
} from "lucide-react";

/** Strip ANSI/VT escape sequences from terminal output */
function stripAnsi(text: string): string {
   
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[\?[0-9;]*[hl]/g, "");
}

// ---------------------------------------------------------------------------
// Structured output parsing
//
// The execute API runs scripts behind a prelude that shadows Format-Table /
// Format-List / Write-Host and emits single-line JSON markers ("@@UI@@{...}")
// for tables, property lists and colored lines. Everything else arrives as
// plain text. See src/lib/ps-output-prelude.ts.
// ---------------------------------------------------------------------------

const UI_MARKER = "@@UI@@";

type CellValue = string | number | boolean | null;

type UiSegment =
  | { kind: "text"; text: string }
  | { kind: "line"; text: string; color: string }
  | { kind: "table"; columns: string[]; rows: CellValue[][] }
  | { kind: "list"; items: { name: string; value: CellValue }[] };

/** Map PowerShell ConsoleColor names to Tailwind text classes */
const COLOR_CLASS: Record<string, string> = {
  Red: "text-red-400",
  DarkRed: "text-red-500",
  Green: "text-green-400",
  DarkGreen: "text-green-600",
  Yellow: "text-yellow-300",
  DarkYellow: "text-amber-500",
  Cyan: "text-cyan-400",
  DarkCyan: "text-cyan-600",
  Blue: "text-blue-400",
  DarkBlue: "text-blue-500",
  Magenta: "text-fuchsia-400",
  DarkMagenta: "text-fuchsia-600",
  Gray: "text-gray-400",
  DarkGray: "text-gray-500",
  White: "text-gray-100",
  Black: "text-gray-500",
};

function parseMarker(line: string): UiSegment | null {
  try {
    const data = JSON.parse(line.slice(UI_MARKER.length));
    if (data?.t === "table" && Array.isArray(data.columns) && Array.isArray(data.rows)) {
      return { kind: "table", columns: data.columns, rows: data.rows };
    }
    if (data?.t === "list" && Array.isArray(data.items)) {
      return { kind: "list", items: data.items };
    }
    if (data?.t === "line" && typeof data.text === "string") {
      return { kind: "line", text: data.text, color: data.color || "" };
    }
  } catch {
    // Incomplete or malformed marker (e.g. still streaming) - caller decides.
  }
  return null;
}

/**
 * Split raw streamed output into renderable segments. Consecutive plain text
 * lines are grouped into a single text segment; runs of blank lines are
 * collapsed to one.
 */
function parseOutput(output: string): UiSegment[] {
  const segments: UiSegment[] = [];
  const lines = output.split("\n");
  const endsComplete = output.endsWith("\n");
  let textLines: string[] = [];

  const flushText = () => {
    // Trim leading/trailing blanks and collapse blank runs inside the block.
    const cleaned: string[] = [];
    for (const l of textLines) {
      if (l.trim() === "" && (cleaned.length === 0 || cleaned[cleaned.length - 1] === "")) continue;
      cleaned.push(l.trim() === "" ? "" : l);
    }
    while (cleaned.length && cleaned[cleaned.length - 1] === "") cleaned.pop();
    if (cleaned.length) segments.push({ kind: "text", text: cleaned.join("\n") });
    textLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    if (line.startsWith(UI_MARKER)) {
      const seg = parseMarker(line);
      if (seg) {
        flushText();
        segments.push(seg);
      } else if (!(isLast && !endsComplete)) {
        // Malformed but complete marker line - show it raw rather than hide it.
        textLines.push(line);
      }
      // Incomplete trailing marker: still streaming, render on next chunk.
    } else {
      textLines.push(line);
    }
  }
  flushText();
  return segments;
}

// ---------------------------------------------------------------------------
// Output components
// ---------------------------------------------------------------------------

function formatCell(value: CellValue): string {
  if (value === null || value === undefined || value === "") return "\u2014";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
  }
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function OutputTable({ columns, rows }: { columns: string[]; rows: CellValue[][] }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);

  const numericCol = useMemo(
    () =>
      columns.map((_, i) =>
        rows.some((r) => typeof r[i] === "number") &&
        rows.every((r) => r[i] === null || r[i] === undefined || r[i] === "" || typeof r[i] === "number")
      ),
    [columns, rows]
  );

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { col, dir } = sort;
    return [...rows].sort((a, b) => {
      const av = a[col];
      const bv = b[col];
      const aEmpty = av === null || av === undefined || av === "";
      const bEmpty = bv === null || bv === undefined || bv === "";
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1; // empties always last
      if (bEmpty) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  }, [rows, sort]);

  const toggleSort = (col: number) =>
    setSort((prev) =>
      prev?.col === col ? (prev.dir === 1 ? { col, dir: -1 } : null) : { col, dir: 1 }
    );

  return (
    <div className="my-2 overflow-x-auto rounded-lg border border-gray-800">
      <table className="w-full text-xs sm:text-sm">
        <thead>
          <tr className="bg-gray-800/60">
            {columns.map((col, i) => (
              <th
                key={i}
                onClick={() => toggleSort(i)}
                className={`px-3 py-2 font-medium text-gray-300 whitespace-nowrap cursor-pointer select-none hover:text-white ${
                  numericCol[i] ? "text-right" : "text-left"
                }`}
                title="Click to sort"
              >
                <span className="inline-flex items-center gap-1">
                  {col}
                  {sort?.col === i &&
                    (sort.dir === 1 ? (
                      <ChevronUp className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3" />
                    ))}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, ri) => (
            <tr
              key={ri}
              className={`border-t border-gray-800/60 ${ri % 2 ? "bg-gray-900/40" : ""} hover:bg-gray-800/40`}
            >
              {columns.map((_, ci) => {
                const v = row[ci];
                const empty = v === null || v === undefined || v === "";
                return (
                  <td
                    key={ci}
                    className={`px-3 py-1.5 whitespace-nowrap ${
                      numericCol[ci] ? "text-right tabular-nums" : "text-left"
                    } ${empty ? "text-gray-600" : "text-gray-200"}`}
                  >
                    {formatCell(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 5 && (
        <div className="px-3 py-1.5 text-[11px] text-gray-500 border-t border-gray-800/60 bg-gray-900/40">
          {rows.length} rows
        </div>
      )}
    </div>
  );
}

function OutputList({ items }: { items: { name: string; value: CellValue }[] }) {
  const visible = items.filter((it) => it.value !== null && it.value !== undefined && it.value !== "");
  if (visible.length === 0) return null;
  return (
    <div className="my-2 rounded-lg border border-gray-800 divide-y divide-gray-800/60">
      {visible.map((it, i) => (
        <div key={i} className="grid grid-cols-1 sm:grid-cols-[minmax(10rem,30%)_1fr] gap-x-4 px-3 py-1.5 text-xs sm:text-sm">
          <span className="text-gray-500">{it.name}</span>
          <span className="text-gray-200 break-words">{formatCell(it.value)}</span>
        </div>
      ))}
    </div>
  );
}

function TextBlock({ text }: { text: string }) {
  return (
    <div className="font-mono text-xs sm:text-sm">
      {text.split("\n").map((line, i) => {
        const cls = line.startsWith("WARNING:")
          ? "text-yellow-300"
          : /^\s*(ERROR|Exception)\b/.test(line)
            ? "text-red-400"
            : "text-gray-300";
        return (
          <div key={i} className={`whitespace-pre-wrap break-words ${cls}`}>
            {line || "\u00A0"}
          </div>
        );
      })}
    </div>
  );
}

function StructuredOutput({ output }: { output: string }) {
  const segments = useMemo(() => parseOutput(output), [output]);
  return (
    <div className="space-y-1">
      {segments.map((seg, i) => {
        switch (seg.kind) {
          case "table":
            return <OutputTable key={i} columns={seg.columns} rows={seg.rows} />;
          case "list":
            return <OutputList key={i} items={seg.items} />;
          case "line":
            return (
              <div
                key={i}
                className={`font-mono text-xs sm:text-sm whitespace-pre-wrap break-words ${
                  COLOR_CLASS[seg.color] || "text-gray-300"
                }`}
              >
                {seg.text || "\u00A0"}
              </div>
            );
          default:
            return <TextBlock key={i} text={seg.text} />;
        }
      })}
    </div>
  );
}

/** Raw view: marker lines converted to a readable plain-text placeholder */
function rawView(output: string): string {
  return output
    .split("\n")
    .map((line) => {
      if (!line.startsWith(UI_MARKER)) return line;
      const seg = parseMarker(line);
      if (seg?.kind === "line") return seg.text;
      if (seg?.kind === "table")
        return [seg.columns.join("\t"), ...seg.rows.map((r) => r.map(formatCell).join("\t"))].join("\n");
      if (seg?.kind === "list")
        return seg.items.map((it) => `${it.name}: ${formatCell(it.value)}`).join("\n");
      return line;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------

interface Parameter {
  id: string;
  name: string;
  label: string;
  type: string;
  required: boolean;
  defaultValue: string | null;
  description: string | null;
}

interface ScriptExecutorProps {
  scriptId: string;
  parameters: Parameter[];
}

export default function ScriptExecutor({
  scriptId,
  parameters,
}: ScriptExecutorProps) {
  const [params, setParams] = useState<Record<string, string>>(() => {
    const defaults: Record<string, string> = {};
    parameters.forEach((p) => {
      if (p.defaultValue) defaults[p.name] = p.defaultValue;
    });
    return defaults;
  });
  const [output, setOutput] = useState<string>("");
  const [showRaw, setShowRaw] = useState(false);
  const [status, setStatus] = useState<
    "idle" | "running" | "success" | "error"
  >("idle");
  const outputRef = useRef<HTMLDivElement>(null);

  const handleExecute = async () => {
    setStatus("running");
    setOutput("");

    try {
      const res = await fetch("/api/scripts/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId, params }),
      });

      if (!res.ok) {
        const data = await res.json();
        setStatus("error");
        setOutput(data.error || "Execution failed");
        return;
      }

      if (!res.body) {
        setStatus("error");
        setOutput("No response stream available");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split("\n");
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() || "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));

            switch (currentEvent) {
              case "stdout":
              case "stderr":
                setOutput((prev) => prev + stripAnsi(data));
                // Auto-scroll to bottom
                if (outputRef.current) {
                  requestAnimationFrame(() => {
                    if (outputRef.current) {
                      outputRef.current.scrollTop = outputRef.current.scrollHeight;
                    }
                  });
                }
                break;
              case "error":
                setOutput((prev) => prev + "\nERROR: " + data);
                break;
              case "done":
                setStatus(data === "SUCCESS" ? "success" : "error");
                break;
            }
            currentEvent = "";
          }
        }
      }
    } catch {
      setStatus("error");
      setOutput("Failed to connect to execution API");
    }
  };

  return (
    <div className="space-y-4">
      {/* Parameters Form */}
      {parameters.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-medium text-gray-300 mb-2">
            Parameters
          </h3>
          {parameters.map((param) => (
            <div key={param.id}>
              <label className="block text-sm text-gray-400 mb-1">
                {param.label}
                {param.required && (
                  <span className="text-red-400 ml-1">*</span>
                )}
              </label>
              {param.description && (
                <p className="text-xs text-gray-500 mb-1">
                  {param.description}
                </p>
              )}
              {param.type === "BOOLEAN" ? (
                <select
                  value={params[param.name] || "false"}
                  onChange={(e) =>
                    setParams({ ...params, [param.name]: e.target.value })
                  }
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="true">True</option>
                  <option value="false">False</option>
                </select>
              ) : param.type === "MULTILINE" ? (
                <textarea
                  value={params[param.name] || ""}
                  onChange={(e) =>
                    setParams({ ...params, [param.name]: e.target.value })
                  }
                  rows={3}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  placeholder={param.defaultValue || ""}
                />
              ) : (
                <input
                  type={param.type === "NUMBER" ? "number" : "text"}
                  value={params[param.name] || ""}
                  onChange={(e) =>
                    setParams({ ...params, [param.name]: e.target.value })
                  }
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  placeholder={param.defaultValue || ""}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Execute Button */}
      <button
        onClick={handleExecute}
        disabled={status === "running"}
        className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white font-medium rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed"
      >
        {status === "running" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Play className="h-4 w-4" />
        )}
        {status === "running" ? "Executing..." : "Execute Script"}
      </button>

      {/* Output */}
      {(output || status === "running") && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/50">
            {status === "running" ? (
              <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
            ) : status === "success" ? (
              <CheckCircle className="h-4 w-4 text-green-400" />
            ) : (
              <XCircle className="h-4 w-4 text-red-400" />
            )}
            <span
              className={`text-sm font-medium ${
                status === "running"
                  ? "text-blue-400"
                  : status === "success"
                    ? "text-green-400"
                    : "text-red-400"
              }`}
            >
              {status === "running"
                ? "Running..."
                : status === "success"
                  ? "Execution Succeeded"
                  : "Execution Failed"}
            </span>
            <button
              onClick={() => setShowRaw((v) => !v)}
              className="ml-auto flex items-center gap-1.5 px-2 py-1 text-xs text-gray-400 hover:text-white rounded-md hover:bg-gray-800 transition-colors cursor-pointer"
              title={showRaw ? "Show formatted output" : "Show raw text output"}
            >
              {showRaw ? <Table2 className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
              {showRaw ? "Formatted" : "Raw"}
            </button>
          </div>
          <div ref={outputRef} className="p-4 max-h-[36rem] overflow-y-auto">
            {output ? (
              showRaw ? (
                <pre className="font-mono text-xs sm:text-sm text-gray-300 whitespace-pre overflow-x-auto">
                  {rawView(output)}
                </pre>
              ) : (
                <StructuredOutput output={output} />
              )
            ) : (
              <span className="font-mono text-sm text-gray-500">
                Waiting for output...
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
