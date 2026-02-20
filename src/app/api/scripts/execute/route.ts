import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { spawn } from "child_process";

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

  try {
    // Build the PowerShell command with parameters
    let psScript = script.content;

    // Inject parameter values if provided
    if (params && Object.keys(params).length > 0) {
      const paramBlock = Object.entries(params)
        .map(([key, value]) => `$${key} = "${String(value).replace(/"/g, '`"')}"`)
        .join("\n");
      psScript = paramBlock + "\n\n" + psScript;
    }

    const output = await executePowerShell(psScript);

    // Update execution record
    await prisma.scriptExecution.update({
      where: { id: execution.id },
      data: {
        status: "SUCCESS",
        output,
        endedAt: new Date(),
      },
    });

    return NextResponse.json({
      executionId: execution.id,
      status: "SUCCESS",
      output,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    await prisma.scriptExecution.update({
      where: { id: execution.id },
      data: {
        status: "FAILED",
        error: errorMessage,
        endedAt: new Date(),
      },
    });

    return NextResponse.json(
      {
        executionId: execution.id,
        status: "FAILED",
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}

function executePowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutMs = parseInt(process.env.SCRIPT_TIMEOUT_MS || "120000", 10);

    const ps = spawn("pwsh", ["-NoProfile", "-Command", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    ps.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    ps.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      ps.kill("SIGTERM");
      reject(new Error(`Script execution timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    ps.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout || "(no output)");
      } else {
        reject(new Error(stderr || `PowerShell exited with code ${code}`));
      }
    });

    ps.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start PowerShell: ${err.message}`));
    });

    // Write script to stdin and close
    ps.stdin.write(script);
    ps.stdin.end();
  });
}
