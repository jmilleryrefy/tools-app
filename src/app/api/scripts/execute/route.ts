import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { spawn } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

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

  // Fetch the script
  const script = await prisma.script.findUnique({
    where: { id: scriptId },
    include: { parameters: true },
  });

  if (!script || !script.isActive) {
    return NextResponse.json({ error: "Script not found" }, { status: 404 });
  }

  // Check role permissions for admin scripts
  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });

  if (script.requiresAdmin && dbUser?.role !== "ADMIN") {
    return NextResponse.json(
      { error: "This script requires admin privileges" },
      { status: 403 }
    );
  }

  if (dbUser?.role === "VIEWER") {
    return NextResponse.json(
      { error: "Your role does not permit script execution. Contact an admin to upgrade your role." },
      { status: 403 }
    );
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

      const ps = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", scriptPath], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
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
