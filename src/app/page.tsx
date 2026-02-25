import Navbar from "@/components/Navbar";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  ScrollText,
  FolderOpen,
  History,
  Play,
  ArrowRight,
} from "lucide-react";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/auth/signin");

  const [scriptCount, categoryCount, recentExecutions, recentScripts] =
    await Promise.all([
      prisma.script.count({ where: { isActive: true } }),
      prisma.category.count(),
      prisma.scriptExecution.count({
        where: { userId: session.user.id },
      }),
      prisma.script.findMany({
        where: { isActive: true },
        include: { category: true },
        orderBy: { updatedAt: "desc" },
        take: 5,
      }),
    ]);

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-1">
            Welcome back, {session.user.name?.split(" ")[0] || "User"}
          </h1>
          <p className="text-gray-400">
            Manage and execute M365 PowerShell scripts for your tenant.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <StatCard
            icon={<ScrollText className="h-5 w-5 text-blue-500" />}
            label="Available Scripts"
            value={scriptCount}
          />
          <StatCard
            icon={<FolderOpen className="h-5 w-5 text-purple-500" />}
            label="Categories"
            value={categoryCount}
          />
          <StatCard
            icon={<History className="h-5 w-5 text-green-500" />}
            label="Your Executions"
            value={recentExecutions}
          />
        </div>

        {/* Recent Scripts */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
            <h2 className="font-semibold text-white">Recently Updated</h2>
            <Link
              href="/scripts"
              className="text-sm text-blue-500 hover:text-blue-400 flex items-center gap-1"
            >
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {recentScripts.length === 0 ? (
            <div className="px-5 py-12 text-center text-gray-500">
              <ScrollText className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No scripts added yet.</p>
              <p className="text-sm mt-1">
                Run the seed command to populate sample scripts.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-gray-800">
              {recentScripts.map((script) => (
                <Link
                  key={script.id}
                  href={`/scripts/${script.slug}`}
                  className="flex items-center justify-between px-5 py-3 hover:bg-gray-800/50 transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    <Play className="h-4 w-4 text-gray-600 group-hover:text-blue-500 transition-colors" />
                    <div>
                      <p className="text-sm font-medium text-gray-200 group-hover:text-white transition-colors">
                        {script.name}
                      </p>
                      <p className="text-xs text-gray-500">
                        {script.category.name}
                      </p>
                    </div>
                  </div>
                  <span className="text-xs text-gray-600">
                    {script.updatedAt.toLocaleDateString()}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function StatCard({
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
