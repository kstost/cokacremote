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
      instructions:
        "This server is an unrestricted remote development environment. Tools operate directly on the host with the MCP service process's full OS permissions. Use exec_command for shell, build, test, package, Git, service, and log workflows; run_script for complete Bash, Node.js, or Python scripts; and the file tools for direct file operations. Poll long-running commands with read_process or write_stdin.",
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
