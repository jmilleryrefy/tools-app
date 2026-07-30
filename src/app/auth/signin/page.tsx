import { signIn } from "@/auth";
import { Terminal, AlertTriangle } from "lucide-react";

// Friendly messages for Auth.js error codes passed via ?error=
// https://errors.authjs.dev
const ERROR_MESSAGES: Record<string, string> = {
  OAuthAccountNotLinked:
    "This email is already associated with an account that isn't linked to Microsoft sign-in. Contact IT to resolve the account conflict.",
  AccessDenied:
    "Your account is not authorized to access this application. Only IT team members are permitted.",
  OAuthCallbackError:
    "Microsoft sign-in was cancelled or failed. Please try again.",
  Configuration:
    "The authentication service is misconfigured. Contact IT.",
  Verification:
    "The sign-in link is no longer valid. Please try again.",
};

const DEFAULT_ERROR_MESSAGE =
  "An unexpected error occurred during sign in. Please try again.";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const errorMessage = error
    ? ERROR_MESSAGES[error] ?? DEFAULT_ERROR_MESSAGE
    : null;

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

          {errorMessage && (
            <div
              role="alert"
              className="mb-6 flex items-start gap-3 rounded-lg border border-red-800 bg-red-950/60 p-3"
            >
              <AlertTriangle className="h-5 w-5 shrink-0 text-red-500 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-red-400">
                  Sign-in failed
                </p>
                <p className="text-xs text-red-300/80 mt-1">{errorMessage}</p>
                {error && (
                  <p className="text-[10px] text-red-400/50 mt-1 font-mono">
                    Code: {error}
                  </p>
                )}
              </div>
            </div>
          )}

          <form
            action={async () => {
              "use server";
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
