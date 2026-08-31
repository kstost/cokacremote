import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import { FileService } from "./file-service.js";
import { ProcessManager } from "./process-manager.js";
import { runScript } from "./script-runner.js";
import { runTool } from "./tool-result.js";
import { TaskJournal } from "./task-journal.js";
import { traceTaskTool } from "./task-tracing.js";
import { enforceAssessment, SafetyPolicy } from "./safety-policy.js";

const fullAccessAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

function processResult(result: Awaited<ReturnType<ProcessManager["read"]>>): Record<string, unknown> {
  return {
    ...result,
    completed: !result.running,
  };
}

export function registerExecTools(
  server: McpServer,
  config: AppConfig,
  processManager: ProcessManager,
  fileService: FileService,
  taskJournal: TaskJournal,
  safetyPolicy: SafetyPolicy,
): void {
  const environmentSchema = z
    .record(z.string(), z.string())
    .optional()
    .describe("Environment variables added to or overriding the server process environment.");

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run an unrestricted shell command on the host. The command inherits the MCP server's full OS permissions, environment, filesystem, and network access. Returns output immediately when complete or a process session ID when still running.",
      inputSchema: {
        cmd: z.string().min(1).describe("Shell command or script to execute."),
        workdir: z
          .string()
          .optional()
          .describe(`Working directory. Relative paths resolve from ${config.defaultCwd}.`),
        shell: z
          .string()
          .optional()
          .describe(`Shell executable. Defaults to ${config.defaultShell}.`),
        login: z
          .boolean()
          .default(true)
          .describe("Use login-shell semantics (-lc) instead of -c."),
        env: environmentSchema,
        stdin: z.string().optional().describe("Initial text written to stdin after spawn."),
        timeoutMs: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Maximum runtime in milliseconds. Zero means no timeout."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .default(10_000)
          .describe("How long to wait for output before returning a running session."),
        taskId: z.string().uuid().optional().describe("Optional development task journal ID."),
        approvalId: z.string().uuid().optional().describe("Approved one-time safety approval ID for a risky operation."),
        maxOutputBytes: z
          .number()
          .int()
          .min(16 * 1024)
          .max(config.maxOutputBytes)
          .default(config.maxOutputBytes)
          .describe("Maximum output bytes returned by this call."),
      },
      annotations: fullAccessAnnotations,
    },
    async ({
      cmd,
      workdir,
      shell,
      login,
      env,
      stdin,
      timeoutMs,
      yieldTimeMs,
      taskId,
      approvalId,
      maxOutputBytes,
    }) =>
      runTool(() => traceTaskTool(taskJournal, taskId, "exec_command", async () => {
        enforceAssessment(safetyPolicy, safetyPolicy.assessCommand(cmd), "exec_command", cmd.slice(0, 300), approvalId);
        const cwd = fileService.resolve(".", workdir);
        const executable = shell || config.defaultShell;
        const sessionId = processManager.start({
          executable,
          args: [login ? "-lc" : "-c", cmd],
          commandForDisplay: cmd,
          cwd,
          env,
          timeoutMs,
          stdin,
          taskId,
        });
        await processManager.waitForExit(sessionId, yieldTimeMs);
        const result = await processManager.read(sessionId, {
          maxOutputBytes,
        });
        return processResult(result);
      })),
  );

  server.registerTool(
    "run_script",
    {
      title: "Run script",
      description:
        "Write a supplied script to a temporary executable file and run it with Bash, sh, Node.js, Python, or an arbitrary interpreter. Execution is unrestricted and has the MCP server's full host permissions.",
      inputSchema: {
        runtime: z
          .enum(["bash", "sh", "node", "python", "custom"])
          .default("bash")
          .describe("Script runtime. Use custom with interpreter for any other runtime."),
        script: z.string().describe("Complete script source."),
        workdir: z
          .string()
          .optional()
          .describe(`Working directory. Relative paths resolve from ${config.defaultCwd}.`),
        args: z.array(z.string()).default([]).describe("Arguments passed after the script path."),
        env: environmentSchema,
        interpreter: z
          .string()
          .optional()
          .describe("Interpreter executable override. Required for runtime=custom."),
        interpreterArgs: z
          .array(z.string())
          .default([])
          .describe("Arguments placed before the temporary script path."),
        stdin: z.string().optional().describe("Initial text written to the script stdin."),
        timeoutMs: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Maximum runtime in milliseconds. Zero means no timeout."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .default(10_000),
        taskId: z.string().uuid().optional().describe("Optional development task journal ID."),
        approvalId: z.string().uuid().optional().describe("Approved one-time safety approval ID for a risky operation."),
        maxOutputBytes: z
          .number()
          .int()
          .min(16 * 1024)
          .max(config.maxOutputBytes)
          .default(config.maxOutputBytes),
        keepScript: z
          .boolean()
          .default(false)
          .describe("Keep the temporary script after the process exits and return its path."),
      },
      annotations: fullAccessAnnotations,
    },
    async ({
      runtime,
      script,
      workdir,
      args,
      env,
      interpreter,
      interpreterArgs,
      stdin,
      timeoutMs,
      yieldTimeMs,
      taskId,
      approvalId,
      maxOutputBytes,
      keepScript,
    }) =>
      runTool(() => traceTaskTool(taskJournal, taskId, "run_script", async () => {
        enforceAssessment(safetyPolicy, safetyPolicy.assessCommand(script), "run_script", `${runtime} script: ${script.slice(0, 240)}`, approvalId);
        const result = await runScript(processManager, {
          runtime,
          script,
          cwd: fileService.resolve(".", workdir),
          args,
          env,
          interpreter,
          interpreterArgs,
          stdin,
          timeoutMs,
          yieldTimeMs,
          maxOutputBytes,
          keepScript,
          taskId,
        });
        return processResult(result);
      })),
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process stdin",
      description:
        "Write text to an existing process session, optionally close stdin, then return new output.",
      inputSchema: {
        sessionId: z.string().uuid(),
        chars: z.string().default(""),
        closeStdin: z.boolean().default(false),
        afterSeq: z.number().int().min(0).default(0),
        yieldTimeMs: z.number().int().min(0).max(300_000).default(250),
        maxOutputBytes: z
          .number()
          .int()
          .min(16 * 1024)
          .max(config.maxOutputBytes)
          .default(config.maxOutputBytes),
      },
      annotations: fullAccessAnnotations,
    },
    async ({ sessionId, chars, closeStdin, afterSeq, yieldTimeMs, maxOutputBytes }) =>
      runTool(async () => {
        await processManager.write(sessionId, chars, closeStdin);
        if (closeStdin) {
          await processManager.waitForExit(sessionId, yieldTimeMs);
        }
        const result = await processManager.read(sessionId, {
          afterSeq,
          waitMs: closeStdin ? 0 : yieldTimeMs,
          maxOutputBytes,
        });
        return processResult(result);
      }),
  );

  server.registerTool(
    "read_process",
    {
      title: "Read process output",
      description:
        "Poll a managed process for output and terminal state. Pass the previous nextSeq as afterSeq to receive only newer output.",
      inputSchema: {
        sessionId: z.string().uuid(),
        afterSeq: z.number().int().min(0).default(0),
        waitMs: z.number().int().min(0).max(300_000).default(1000),
        maxOutputBytes: z
          .number()
          .int()
          .min(16 * 1024)
          .max(config.maxOutputBytes)
          .default(config.maxOutputBytes),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId, afterSeq, waitMs, maxOutputBytes }) =>
      runTool(async () =>
        processResult(
          await processManager.read(sessionId, {
            afterSeq,
            waitMs,
            maxOutputBytes,
          }),
        ),
      ),
  );

  server.registerTool(
    "terminate_process",
    {
      title: "Terminate process",
      description:
        "Send a signal to a managed process tree. SIGTERM escalates to SIGKILL after graceMs if necessary.",
      inputSchema: {
        sessionId: z.string().uuid(),
        signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL"]).default("SIGTERM"),
        graceMs: z.number().int().min(0).max(60_000).default(3000),
      },
      annotations: fullAccessAnnotations,
    },
    async ({ sessionId, signal, graceMs }) =>
      runTool(async () =>
        processResult(await processManager.terminate(sessionId, signal, graceMs)),
      ),
  );

  server.registerTool(
    "list_processes",
    {
      title: "List managed processes",
      description: "List running and recently completed process sessions.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => runTool(() => ({ processes: processManager.list() })),
  );
}
