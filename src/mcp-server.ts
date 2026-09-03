import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppConfig } from "./config.js";
import { registerExecTools } from "./exec-tools.js";
import { FileService } from "./file-service.js";
import { registerFileTools } from "./file-tools.js";
import { ProcessManager } from "./process-manager.js";
import { TaskJournal } from "./task-journal.js";
import { registerTaskTools } from "./task-tools.js";
import { SafetyPolicy } from "./safety-policy.js";
import { loadSafetyPolicyFile } from "./safety-policy-file.js";

export interface McpServices {
  processManager: ProcessManager;
  fileService: FileService;
  taskJournal: TaskJournal;
  safetyPolicy: SafetyPolicy;
}

export const MCP_SERVER_INSTRUCTIONS = `You are operating through cokacremote, an unrestricted remote development environment. Tools run directly on the host with the MCP service process's OS permissions.

Use cokacremote to inspect, edit, build, test, run, and verify software directly on the remote host.

Tool usage:
- Use exec_command for shell, build, test, package, Git, service, and log workflows.
- Use run_script for complete Bash, Node.js, or Python scripts.
- Use file tools for targeted file inspection and modification.
- Inspect the actual environment before making assumptions.
- Prefer targeted operations over unnecessarily broad commands or file rewrites.

Verification:
- Verify changes with the relevant build, typecheck, tests, logs, or runtime checks.
- Do not treat command execution alone as proof that the requested result works.
- Before starting or restarting a service, check existing processes and port usage.
- After starting a web service, verify the process, listening port, and HTTP response when practical.

Repository handling:
- Inspect Git status before modifying a repository and avoid overwriting unrelated existing changes.
- Review the resulting diff after modifications.
- Do not commit or push unless requested by the user.

Long-running commands:
- Poll long-running processes using the available process tools rather than repeatedly starting the same command.`;

export function createServices(config: AppConfig): McpServices {
  const taskJournal = new TaskJournal(config.taskJournalFile);
  return {
    processManager: new ProcessManager({
      maxRetainedOutputBytes: config.maxRetainedProcessOutputBytes,
      processRetentionMs: config.processRetentionMs,
      maxProcesses: config.maxProcesses,
      defaultMaxOutputBytes: config.maxOutputBytes,
      processIdleTimeoutMs: config.processIdleTimeoutMs,
      processMaxRuntimeMs: config.processMaxRuntimeMs,
      journal: taskJournal,
    }),
    taskJournal,
    safetyPolicy: new SafetyPolicy(config.safetyMode, config.defaultCwd, loadSafetyPolicyFile(config.safetyPolicyFile)),
    fileService: new FileService({
      defaultCwd: config.defaultCwd,
      maxChunkBytes: config.maxFileChunkBytes,
      maxEditFileBytes: config.maxEditFileBytes,
      maxOutputBytes: config.maxOutputBytes,
    }),
  };
}

export function createMcpServer(config: AppConfig, services: McpServices): McpServer {
  const server = new McpServer(
    {
      name: "cokacremote",
      version: "0.1.0",
      ...(config.publicUrl ? { websiteUrl: config.publicUrl } : {}),
    },
    {
      instructions: MCP_SERVER_INSTRUCTIONS,
      capabilities: { logging: {} },
    },
  );

  registerExecTools(
    server,
    config,
    services.processManager,
    services.fileService,
    services.taskJournal,
    services.safetyPolicy,
  );
  registerFileTools(server, config, services.fileService, services.taskJournal, services.safetyPolicy);
  registerTaskTools(server, services.taskJournal);
  return server;
}
