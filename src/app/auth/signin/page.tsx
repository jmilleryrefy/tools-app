import { signIn } from "@/auth";
import { Terminal } from "lucide-react";

export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="max-w-md w-full mx-4">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 shadow-2xl">
          <div className="flex items-center justify-center gap-3 mb-2">
            <Terminal className="h-8 w-8 text-blue-500" />
            <h1 className="text-2xl font-bold text-white">IT Tools</h1>
          </div>
          <p className="text-gray-400 text-center mb-8 text-sm">
            tools.it.yrefy — M365 Script Management
          </p>

          <form
            action={async () => {
              "use server";
              console.log("[AUTH SIGNIN PAGE] Sign-in form submitted, initiating microsoft-entra-id flow");
              await signIn("microsoft-entra-id", { redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="w-full flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-lg transition-colors cursor-pointer"
            >
              <svg className="h-5 w-5" viewBox="0 0 21 21" fill="none">
                <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
              </svg>
              Sign in with Microsoft
            </button>
          </form>

          <p className="text-gray-500 text-xs text-center mt-6">
            Authenticated via Microsoft Entra ID
          </p>
        </div>
      </div>
    </div>
  );
}
