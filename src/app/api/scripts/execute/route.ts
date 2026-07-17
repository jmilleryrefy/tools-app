import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getM365TokensForUser, detectM365Needs, M365TokenError } from "@/lib/m365-token";
import { spawn } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

/**
 * Remove the top-level param(...) block from a PowerShell script string.
 * Handles nested parentheses (e.g. [Parameter(Mandatory=$true)]) and
 * skips parentheses inside quoted strings and comments so that default
 * values like "Hello (world)" don't break the matching.
 */
function stripParamBlock(script: string): string {
  // Only match a top-level param — skip any that appear inside comments.
  // Walk backwards from the match to verify the line isn't a comment.
  let searchFrom = 0;
  let match: RegExpExecArray | null;
  const paramRe = /\bparam\s*\(/g;

  while ((match = paramRe.exec(script)) !== null) {
    const lineStart = script.lastIndexOf("\n", match.index) + 1;
    const prefix = script.slice(lineStart, match.index).trim();
    if (!prefix.startsWith("#")) break; // not inside a comment
    searchFrom = match.index + match[0].length;
    paramRe.lastIndex = searchFrom;
    match = null;
  }

  if (!match || match.index === undefined) return script;

  const start = match.index;
  // Begin counting from the opening '(' that follows 'param'
  let i = start + match[0].length;
  let depth = 1;

  while (i < script.length && depth > 0) {
    const ch = script[i];

    // Skip single-line comments
    if (ch === "#") {
      while (i < script.length && script[i] !== "\n") i++;
      continue;
    }

    // Skip double-quoted strings (PowerShell uses backtick for escapes)
    if (ch === '"') {
      i++;
      while (i < script.length && script[i] !== '"') {
        if (script[i] === "`") i++; // skip escaped char
        i++;
      }
      i++; // move past closing quote
      continue;
    }

    // Skip single-quoted strings (no escape sequences in PS single-quotes)
    if (ch === "'") {
      i++;
      while (i < script.length && script[i] !== "'") i++;
      i++; // move past closing quote
      continue;
    }

    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    i++;
  }

  if (depth !== 0) return script; // unbalanced – leave script untouched

  // Also consume any trailing whitespace/newline after the closing ')'
  while (i < script.length && (script[i] === " " || script[i] === "\t")) i++;
  if (i < script.length && script[i] === "\r") i++;
  if (i < script.length && script[i] === "\n") i++;

  return script.slice(0, start) + script.slice(i);
}

export async function POST(req: NextRequest) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { scriptId, params } = await req.json();

  if (!scriptId) {
    return NextResponse.json(
      { error: "Script ID is required" },
      { status: 400 }
    );
  }

  // Fetch the script and user role in parallel to reduce latency
  const [script, dbUser] = await Promise.all([
    prisma.script.findUnique({
      where: { id: scriptId },
      include: { parameters: true },
    }),
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    }),
  ]);

  if (!script || !script.isActive) {
    return NextResponse.json({ error: "Script not found" }, { status: 404 });
  }

  if (dbUser?.role === "VIEWER") {
    return NextResponse.json(
      { error: "Your role does not permit script execution. Contact an admin to upgrade your role." },
      { status: 403 }
    );
  }

  if (script.requiresAdmin && dbUser?.role !== "ADMIN") {
    return NextResponse.json(
      { error: "This script requires admin privileges" },
      { status: 403 }
    );
  }

  // Acquire Microsoft 365 credentials for the services the script connects to:
  // - Microsoft Graph: delegated access token minted from the signed-in user's
  //   refresh token, so Graph calls run AS this user.
  // - Exchange Online: app-only certificate authentication. Exchange Online
  //   rejects the legacy PowerShell endpoint for delegated tokens issued to
  //   custom apps (empty 403), so scripts connect as the app's service
  //   principal via Connect-ExchangeOnline -AppId/-CertificateFilePath.
  // Done before creating the execution record so a failure doesn't leave a
  // dangling RUNNING row.
  const needs = detectM365Needs(script.content);
  let m365Tokens = null;
  if (needs.graph) {
    try {
      m365Tokens = await getM365TokensForUser(session.user.id, {
        graph: true,
        exo: false,
      });
    } catch (err) {
      const message =
        err instanceof M365TokenError
          ? err.message
          : "Failed to obtain Microsoft 365 access for your account.";
      return NextResponse.json({ error: message }, { status: 403 });
    }
  }

  if (needs.exo) {
    if (!process.env.EXO_CERT_PATH || !process.env.EXO_CERT_PASSWORD) {
      return NextResponse.json(
        {
          error:
            "Exchange Online certificate authentication is not configured on the server (EXO_CERT_PATH / EXO_CERT_PASSWORD).",
        },
        { status: 500 }
      );
    }
  }

  // Create execution record
  const execution = await prisma.scriptExecution.create({
    data: {
      scriptId: script.id,
      userId: session.user.id,
      params: params ? JSON.stringify(params) : null,
      status: "RUNNING",
    },
  });

  // Build the PowerShell script with parameters prepended
  let psScript = script.content;

  if (params && Object.keys(params).length > 0) {
    const paramBlock = Object.entries(params)
      .map(([key, value]) => `$${key} = "${String(value).replace(/"/g, '`"')}"`)
      .join("\n");
    // Remove any existing param() block so the prepended variable assignments
    // don't cause a ParserError (param() must be the first executable statement).
    // We match balanced parentheses to handle nested constructs like
    // [Parameter(Mandatory=$true)] inside the param block.
    psScript = stripParamBlock(psScript);
    psScript = paramBlock + "\n\n" + psScript;
  }

  // Write script to a temp file so pwsh can execute via -File.
  // Using -File instead of -Command with stdin avoids a known issue where
  // Format-Table and other formatting cmdlets hang or lose output when
  // PowerShell reads a multiline script from stdin.
  const scriptPath = join(tmpdir(), `ittools-${randomUUID()}.ps1`);
  await writeFile(scriptPath, psScript, "utf-8");

  const timeoutMs = parseInt(process.env.SCRIPT_TIMEOUT_MS || "120000", 10);
  const executionId = execution.id;

  // Stream output back to the client via SSE
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let fullOutput = "";
      let fullStderr = "";
      let closed = false;

      function send(event: string, data: string) {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      function closeController() {
        if (closed) return;
        closed = true;
        controller.close();
      }

      function cleanup() {
        unlink(scriptPath).catch(() => {});
      }

      send("execution_id", executionId);

      // M365 credentials for the script, passed via env (never written to
      // disk or argv):
      // - GRAPH_TOKEN: delegated token -> Connect-MgGraph -AccessToken (...)
      // - EXO_APP_ID / EXO_ORGANIZATION / EXO_CERT_PATH / EXO_CERT_PASSWORD:
      //   app-only certificate auth -> Connect-ExchangeOnline -AppId ...
      // Only the credentials the script needs are present (see detectM365Needs).
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TERM: "dumb",
        NO_COLOR: "1",
      };
      if (m365Tokens) {
        if (m365Tokens.graphToken) env.GRAPH_TOKEN = m365Tokens.graphToken;
        env.M365_UPN = m365Tokens.upn;
      }
      if (needs.exo) {
        env.EXO_APP_ID = process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
        env.EXO_ORGANIZATION =
          process.env.EXO_ORGANIZATION ||
          process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID;
        env.EXO_CERT_PATH = process.env.EXO_CERT_PATH;
        env.EXO_CERT_PASSWORD = process.env.EXO_CERT_PASSWORD;
      }

      const ps = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", scriptPath], {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });

      let stdoutDone = false;
      let stderrDone = false;
      let exitCode: number | null = null;

      function tryFinalize() {
        // Only finalize once all streams are drained AND the process has exited
        if (!stdoutDone || !stderrDone || exitCode === null) return;

        clearTimeout(timer);
        cleanup();
        const succeeded = exitCode === 0;
        const status = succeeded ? "SUCCESS" : "FAILED";

        prisma.scriptExecution.update({
          where: { id: executionId },
          data: {
            status,
            output: fullOutput || (succeeded ? "(no output)" : undefined),
            error: succeeded ? undefined : (fullStderr || `PowerShell exited with code ${exitCode}`),
            endedAt: new Date(),
          },
        }).finally(() => {
          send("done", status);
          closeController();
        });
      }

      ps.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        fullOutput += text;
        send("stdout", text);
      });

      ps.stdout.on("end", () => {
        stdoutDone = true;
        tryFinalize();
      });

      ps.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        fullStderr += text;
        send("stderr", text);
      });

      ps.stderr.on("end", () => {
        stderrDone = true;
        tryFinalize();
      });

      const timer = setTimeout(() => {
        ps.kill("SIGTERM");
        // If SIGTERM doesn't kill the process tree within 5s, force-kill
        const killTimer = setTimeout(() => {
          try { ps.kill("SIGKILL"); } catch {}
        }, 5000);
        ps.on("close", () => clearTimeout(killTimer));
        cleanup();
        send("error", `Script execution timed out after ${timeoutMs / 1000}s`);
        prisma.scriptExecution.update({
          where: { id: executionId },
          data: {
            status: "FAILED",
            error: `Script execution timed out after ${timeoutMs / 1000}s`,
            endedAt: new Date(),
          },
        }).finally(() => {
          send("done", "FAILED");
          closeController();
        });
      }, timeoutMs);

      ps.on("close", (code) => {
        exitCode = code ?? 1;
        tryFinalize();
      });

      ps.on("error", (err) => {
        clearTimeout(timer);
        cleanup();
        const message = `Failed to start PowerShell: ${err.message}`;
        send("error", message);
        prisma.scriptExecution.update({
          where: { id: executionId },
          data: {
            status: "FAILED",
            error: message,
            endedAt: new Date(),
          },
        }).finally(() => {
          send("done", "FAILED");
          closeController();
        });
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
