import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProcessReadResult } from "./process-manager.js";
import { ProcessManager } from "./process-manager.js";

export type ScriptRuntime = "bash" | "sh" | "node" | "python" | "custom";

export interface RunScriptRequest {
  runtime: ScriptRuntime;
  script: string;
  cwd: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  interpreter?: string | undefined;
  interpreterArgs?: string[] | undefined;
  timeoutMs?: number | undefined;
  yieldTimeMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  stdin?: string | undefined;
  keepScript?: boolean | undefined;
  taskId?: string | undefined;
}

export interface RunScriptResult extends ProcessReadResult {
  scriptPath: string | undefined;
}

interface RuntimeDefinition {
  executable: string;
  extension: string;
}

function runtimeDefinition(request: RunScriptRequest): RuntimeDefinition {
  if (request.runtime === "custom") {
    if (!request.interpreter?.trim()) {
      throw new Error("interpreter is required when runtime is custom");
    }
    return {
      executable: request.interpreter,
      extension: ".script",
    };
  }

  const definitions: Record<Exclude<ScriptRuntime, "custom">, RuntimeDefinition> = {
    bash: { executable: request.interpreter || "bash", extension: ".sh" },
    sh: { executable: request.interpreter || "sh", extension: ".sh" },
    node: { executable: request.interpreter || process.execPath, extension: ".mjs" },
    python: { executable: request.interpreter || "python3", extension: ".py" },
  };
  return definitions[request.runtime];
}

function displayCommand(executable: string, args: string[]): string {
  return [executable, ...args].map((value) => JSON.stringify(value)).join(" ");
}

export async function runScript(
  processManager: ProcessManager,
  request: RunScriptRequest,
): Promise<RunScriptResult> {
  const runtime = runtimeDefinition(request);
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "remote-dev-mcp-script-"),
  );
  const scriptPath = path.join(temporaryDirectory, `script${runtime.extension}`);
  await writeFile(scriptPath, request.script, { mode: 0o700 });
  await chmod(scriptPath, 0o700);

  const processArgs = [
    ...(request.interpreterArgs ?? []),
    scriptPath,
    ...(request.args ?? []),
  ];
  const keepScript = request.keepScript ?? false;
  const cleanup = keepScript
    ? undefined
    : async () => {
        await rm(temporaryDirectory, { recursive: true, force: true });
      };

  let sessionId: string;
  try {
    sessionId = processManager.start({
      executable: runtime.executable,
      args: processArgs,
      commandForDisplay: displayCommand(runtime.executable, processArgs),
      cwd: request.cwd,
      env: request.env,
      timeoutMs: request.timeoutMs,
      stdin: request.stdin,
      cleanup,
      taskId: request.taskId,
    });
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  await processManager.waitForExit(sessionId, request.yieldTimeMs ?? 10_000);
  const result = await processManager.read(sessionId, {
    maxOutputBytes: request.maxOutputBytes,
  });
  return {
    ...result,
    scriptPath: keepScript ? scriptPath : undefined,
  };
}
