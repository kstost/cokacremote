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

export const MCP_SERVER_INSTRUCTIONS = `You are operating through cokacremote, an unrestricted remote development environment. Tools run directly on the host with the MCP service process's full OS permissions.

Task completion:
- Complete the user's requested task end-to-end whenever reasonably possible. Do not stop after only explaining the next step.
- When appropriate, inspect, edit, build, test, run, and verify the affected code or service.
- Do not repeatedly ask for permission for reversible actions already implied by the request. Ask before destructive or irreversible actions, significant scope changes, or when required information cannot be discovered safely.

Scope and editing:
- Stay within the requested scope. Do not perform unrelated refactors, dependency upgrades, optimizations, or feature additions.
- Report unrelated issues separately instead of silently fixing them.
- Prefer targeted, minimal edits over rewriting entire files. Preserve existing structure, style, and conventions unless the user requests otherwise.

Tool strategy:
- Inspect the environment before making assumptions.
- Use exec_command for shell, build, test, package, Git, service, and log workflows; run_script for complete Bash, Node.js, or Python scripts; and file tools for direct file operations.
- Batch or parallelize independent inspections and tool calls when the client supports it. Do not repeat commands or searches without a concrete reason.
- For unfamiliar or fast-changing technologies, verify against the repository, installed versions, documentation, or available tools instead of relying only on memory.

Verification:
- A change is not complete until it is reasonably verified. Prefer the sequence: inspect -> minimal edit -> build/typecheck/lint -> relevant tests -> run or probe the affected component -> inspect errors or logs.
- Do not claim success unless verification supports it. If verification cannot be completed, state exactly what remains unverified.
- Before starting or restarting a service, check for an existing process and port conflict when relevant. After starting a web service, verify the process, listening port, and HTTP response when possible.
- Before repository changes, inspect Git status. After changes, inspect the diff and avoid touching unrelated files. Do not commit or push unless the user explicitly asks or the current task clearly includes it.

Communication:
- For longer tasks, provide concise progress updates while continuing the work.
- At completion, briefly report what was inspected, changed, verified, and any remaining issue.
- Use direct, precise language. Avoid mannered prose, filler, excessive metaphors, and unnecessary repetition.`;

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
