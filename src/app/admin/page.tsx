import Navbar from "@/components/Navbar";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import {
  Users,
  ScrollText,
  FolderOpen,
  History,
  Shield,
} from "lucide-react";

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/auth/signin");

  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });

  if (dbUser?.role !== "ADMIN") {
    redirect("/");
  }

  const [userCount, scriptCount, categoryCount, executionCount, recentExecutions] =
    await Promise.all([
      prisma.user.count(),
      prisma.script.count(),
      prisma.category.count(),
      prisma.scriptExecution.count(),
      prisma.scriptExecution.findMany({
        include: { script: true, user: true },
        orderBy: { startedAt: "desc" },
        take: 20,
      }),
    ]);

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center gap-2 mb-6">
          <Shield className="h-6 w-6 text-amber-500" />
          <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <AdminStat
            icon={<Users className="h-5 w-5 text-blue-500" />}
            label="Total Users"
            value={userCount}
          />
          <AdminStat
            icon={<ScrollText className="h-5 w-5 text-purple-500" />}
            label="Scripts"
            value={scriptCount}
          />
          <AdminStat
            icon={<FolderOpen className="h-5 w-5 text-green-500" />}
            label="Categories"
            value={categoryCount}
          />
          <AdminStat
            icon={<History className="h-5 w-5 text-orange-500" />}
            label="Total Executions"
            value={executionCount}
          />
        </div>

        {/* Recent Executions (All Users) */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800">
            <h2 className="font-semibold text-white">
              Recent Executions (All Users)
            </h2>
          </div>
          {recentExecutions.length === 0 ? (
            <div className="px-5 py-12 text-center text-gray-500">
              No executions recorded yet.
            </div>
          ) : (
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
                    User
                  </th>
                  <th className="px-5 py-3 text-xs font-medium text-gray-500 uppercase">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {recentExecutions.map((exec) => (
                  <tr key={exec.id} className="hover:bg-gray-800/50">
                    <td className="px-5 py-3">
                      <span
                        className={`text-xs font-medium ${
                          exec.status === "SUCCESS"
                            ? "text-green-400"
                            : exec.status === "FAILED"
                              ? "text-red-400"
                              : exec.status === "RUNNING"
                                ? "text-blue-400"
                                : "text-gray-400"
                        }`}
                      >
                        {exec.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-sm text-gray-200">
                      {exec.script.name}
                    </td>
                    <td className="px-5 py-3 text-sm text-gray-400">
                      {exec.user.name || exec.user.email}
                    </td>
                    <td className="px-5 py-3 text-sm text-gray-400">
                      {exec.startedAt.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}

function AdminStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center gap-3 mb-2">
        {icon}
        <span className="text-sm text-gray-400">{label}</span>
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
    </div>
  );
}
