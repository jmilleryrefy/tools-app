"use client";

import { useState } from "react";
import { Play, Loader2, CheckCircle, XCircle } from "lucide-react";

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
  const [status, setStatus] = useState<
    "idle" | "running" | "success" | "error"
  >("idle");

  const handleExecute = async () => {
    setStatus("running");
    setOutput("");

    try {
      const res = await fetch("/api/scripts/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId, params }),
      });

      const data = await res.json();

      if (!res.ok) {
        setStatus("error");
        setOutput(data.error || "Execution failed");
        return;
      }

      setStatus(data.status === "SUCCESS" ? "success" : "error");
      setOutput(data.output || data.error || "No output");
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
      {output && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/50">
            {status === "success" ? (
              <CheckCircle className="h-4 w-4 text-green-400" />
            ) : (
              <XCircle className="h-4 w-4 text-red-400" />
            )}
            <span
              className={`text-sm font-medium ${status === "success" ? "text-green-400" : "text-red-400"}`}
            >
              {status === "success" ? "Execution Succeeded" : "Execution Failed"}
            </span>
          </div>
          <pre className="p-4 text-sm text-gray-300 overflow-x-auto whitespace-pre-wrap font-mono max-h-96 overflow-y-auto">
            {output}
          </pre>
        </div>
      )}
    </div>
  );
}
