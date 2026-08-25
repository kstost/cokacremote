import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import { FileService } from "./file-service.js";
import { ProcessManager } from "./process-manager.js";
import { runScript } from "./script-runner.js";
import { runTool } from "./tool-result.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "./tool-metadata.js";

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
): void {
  const authMetadata = toolAuthMetadata(config);
  const environmentSchema = z
    .record(z.string(), z.string())
    .optional()
    .describe("Environment variables added to or overriding the server process environment.");
  const sessionIdSchema = z
    .string()
    .uuid()
    .describe("Process session ID returned by exec_command or run_script.");
  const afterSeqSchema = z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Return only retained output chunks whose sequence number is greater than this value. Use the previous nextSeq value; zero starts with the earliest retained output.",
    );
  const timeoutSchema = z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Milliseconds before marking the process timed out and sending SIGTERM. Zero disables the timeout. A process still running five seconds after SIGTERM is sent SIGKILL.",
    );
  const maxOutputBytesSchema = z
    .number()
    .int()
    .min(16 * 1024)
    .max(config.maxOutputBytes)
    .default(config.maxOutputBytes)
    .describe("Maximum retained process-output bytes included in this result.");

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run an unrestricted shell command on the host. The command inherits the MCP server's full OS permissions, environment, filesystem, and network access. A successful start always returns a process session ID, current process state, and retained output; poll a running process with read_process or write_stdin.",
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
        timeoutMs: timeoutSchema,
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .default(10_000)
          .describe(
            "How long to wait for the process to exit before returning its current state. Zero returns immediately.",
          ),
        maxOutputBytes: maxOutputBytesSchema,
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
      _meta: authMetadata,
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
      maxOutputBytes,
    }) =>
      runTool(async () => {
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
        });
        await processManager.waitForExit(sessionId, yieldTimeMs);
        const result = await processManager.read(sessionId, {
          maxOutputBytes,
        });
        return processResult(result);
      }),
  );

  server.registerTool(
    "run_script",
    {
      title: "Run script",
      description:
        "Write a supplied script to a temporary executable file and run it with Bash, sh, Node.js, Python, or an arbitrary interpreter. Execution is unrestricted and has the MCP server's full host permissions. A successful start always returns a process session ID, current process state, and retained output.",
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
        timeoutMs: timeoutSchema,
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .default(10_000)
          .describe(
            "How long to wait for the script process to exit before returning its current state. Zero returns immediately.",
          ),
        maxOutputBytes: maxOutputBytesSchema,
        keepScript: z
          .boolean()
          .default(false)
          .describe(
            "Keep the temporary script after process exit and include its path in the result. When false, the temporary directory is removed after exit.",
          ),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
      _meta: authMetadata,
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
      maxOutputBytes,
      keepScript,
    }) =>
      runTool(async () => {
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
        });
        return processResult(result);
      }),
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process stdin",
      description:
        "Write text to an existing process session, optionally close stdin, then return current process state and retained output with sequence numbers greater than afterSeq.",
      inputSchema: {
        sessionId: sessionIdSchema,
        chars: z
          .string()
          .default("")
          .describe("Text to write to the process stdin. An empty value writes nothing."),
        closeStdin: z
          .boolean()
          .default(false)
          .describe("Close the process stdin after writing chars."),
        afterSeq: afterSeqSchema,
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(300_000)
          .default(250)
          .describe(
            "When stdin remains open, wait this long for output or process exit. When closeStdin=true, wait this long for process exit before returning.",
          ),
        maxOutputBytes: maxOutputBytesSchema,
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
      _meta: authMetadata,
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
        sessionId: sessionIdSchema,
        afterSeq: afterSeqSchema,
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(300_000)
          .default(1000)
          .describe(
            "How long to wait for output newer than afterSeq or for process exit. Zero returns immediately.",
          ),
        maxOutputBytes: maxOutputBytesSchema,
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
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
        "Send a signal to a managed process tree. When graceMs is greater than zero, SIGINT and SIGTERM escalate to SIGKILL if the process is still running after the grace period. The call may return while escalation is still pending.",
      inputSchema: {
        sessionId: sessionIdSchema,
        signal: z
          .enum(["SIGINT", "SIGTERM", "SIGKILL"])
          .default("SIGTERM")
          .describe("Signal sent to the managed process tree."),
        graceMs: z
          .number()
          .int()
          .min(0)
          .max(60_000)
          .default(3000)
          .describe(
            "For SIGINT or SIGTERM, milliseconds before SIGKILL escalation; zero disables escalation. The call waits at most one second before returning.",
          ),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentClosed,
      _meta: authMetadata,
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
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async () => runTool(() => ({ processes: processManager.list() })),
  );
}
