import Navbar from "@/components/Navbar";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { CheckCircle, XCircle, Clock, Loader2 } from "lucide-react";

export default async function HistoryPage() {
  const session = await auth();

  const executions = await prisma.scriptExecution.findMany({
    where: { userId: session?.user?.id },
    include: { script: true },
    orderBy: { startedAt: "desc" },
    take: 50,
  });

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Execution History</h1>
          <p className="text-gray-400 text-sm mt-1">
            Your recent script executions
          </p>
        </div>

        {executions.length === 0 ? (
          <div className="text-center py-16">
            <Clock className="h-12 w-12 mx-auto text-gray-700 mb-3" />
            <p className="text-gray-400 font-medium">No executions yet</p>
            <p className="text-gray-500 text-sm mt-1">
              Run a script to see your execution history here.
            </p>
          </div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800 text-left">
                  <th className="px-5 py-3 text-xs font-medium text-gray-500 uppercase">
                    Status
                  </th>
                  <th className="px-5 py-3 text-xs font-medium text-gray-500 uppercase">
                    Script
                  </th>
                  <th className="px-5 py-3 text-xs font-medium text-gray-500 uppercase">
                    Started
                  </th>
                  <th className="px-5 py-3 text-xs font-medium text-gray-500 uppercase">
                    Duration
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {executions.map((exec) => (
                  <tr key={exec.id} className="hover:bg-gray-800/50">
                    <td className="px-5 py-3">
                      <StatusBadge status={exec.status} />
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-sm text-gray-200">
                        {exec.script.name}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-sm text-gray-400">
                      {exec.startedAt.toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-sm text-gray-400">
                      {exec.endedAt
                        ? `${((exec.endedAt.getTime() - exec.startedAt.getTime()) / 1000).toFixed(1)}s`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "SUCCESS":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-green-400">
          <CheckCircle className="h-3.5 w-3.5" /> Success
        </span>
      );
    case "FAILED":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-red-400">
          <XCircle className="h-3.5 w-3.5" /> Failed
        </span>
      );
    case "RUNNING":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-blue-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-xs text-gray-400">
          <Clock className="h-3.5 w-3.5" /> Pending
        </span>
      );
  }
}
