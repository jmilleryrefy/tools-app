import Link from "next/link";
import { ShieldX, Terminal } from "lucide-react";

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  const isAccessDenied = error === "AccessDenied";

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="max-w-md w-full mx-4">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 shadow-2xl">
          <div className="flex items-center justify-center gap-3 mb-2">
            <Terminal className="h-8 w-8 text-blue-500" />
            <h1 className="text-2xl font-bold text-white">IT Tools</h1>
          </div>
          <p className="text-gray-400 text-center mb-8 text-sm">
            tools.it.yrefy
          </p>

          <div className="flex flex-col items-center text-center">
            <ShieldX className="h-12 w-12 text-red-500 mb-4" />
            <h2 className="text-lg font-semibold text-white mb-2">
              {isAccessDenied ? "Access Denied" : "Authentication Error"}
            </h2>
            <p className="text-gray-400 text-sm mb-6">
              {isAccessDenied
                ? "Your account is not authorized to access this application. Only IT team members are permitted."
                : "An error occurred during sign in. Please try again."}
            </p>
            <Link
              href="/auth/signin"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Back to Sign In
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
