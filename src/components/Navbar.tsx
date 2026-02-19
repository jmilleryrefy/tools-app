import Link from "next/link";
import { auth, signOut } from "@/auth";
import {
  Terminal,
  LayoutDashboard,
  ScrollText,
  History,
  Shield,
  LogOut,
} from "lucide-react";

export default async function Navbar() {
  const session = await auth();
  const userRole = session?.user?.role;

  return (
    <nav className="bg-gray-900 border-b border-gray-800 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo & Brand */}
          <Link href="/" className="flex items-center gap-2.5 group">
            <Terminal className="h-6 w-6 text-blue-500 group-hover:text-blue-400 transition-colors" />
            <span className="font-bold text-lg text-white">IT Tools</span>
            <span className="text-xs text-gray-500 hidden sm:inline">
              tools.it.yrefy
            </span>
          </Link>

          {/* Navigation Links */}
          <div className="flex items-center gap-1">
            <NavLink href="/" icon={<LayoutDashboard className="h-4 w-4" />}>
              Dashboard
            </NavLink>
            <NavLink href="/scripts" icon={<ScrollText className="h-4 w-4" />}>
              Scripts
            </NavLink>
            <NavLink href="/history" icon={<History className="h-4 w-4" />}>
              History
            </NavLink>
            {userRole === "ADMIN" && (
              <NavLink href="/admin" icon={<Shield className="h-4 w-4" />}>
                Admin
              </NavLink>
            )}
          </div>

          {/* User Menu */}
          <div className="flex items-center gap-3">
            {session?.user && (
              <>
                <div className="text-right hidden sm:block">
                  <p className="text-sm font-medium text-gray-200">
                    {session.user.name}
                  </p>
                  <p className="text-xs text-gray-500">{session.user.email}</p>
                </div>
                <form
                  action={async () => {
                    "use server";
                    await signOut({ redirectTo: "/auth/signin" });
                  }}
                >
                  <button
                    type="submit"
                    className="p-2 text-gray-400 hover:text-red-400 hover:bg-gray-800 rounded-lg transition-colors cursor-pointer"
                    title="Sign out"
                  >
                    <LogOut className="h-4 w-4" />
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}

function NavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
    >
      {icon}
      <span className="hidden md:inline">{children}</span>
    </Link>
  );
}
