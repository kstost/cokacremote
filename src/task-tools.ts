import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { TaskJournal } from "./task-journal.js";
import { runTool } from "./tool-result.js";

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function registerTaskTools(server: McpServer, journal: TaskJournal): void {
  server.registerTool("start_task", {
    title: "Start development task",
    description: "Create a task journal that can group command execution and file changes across MCP calls.",
    inputSchema: { title: z.string().min(1).max(200), cwd: z.string().optional() }, annotations: writeAnnotations,
  }, async ({ title, cwd }) => runTool(async () => ({ ...(await journal.startTask(title, cwd)) })));

  server.registerTool("get_task", {
    title: "Get development task",
    description: "Return a task summary including commands and changed files.",
    inputSchema: { taskId: z.string().uuid() }, annotations: readAnnotations,
  }, async ({ taskId }) => runTool(async () => {
    const task = await journal.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return { ...task };
  }));

  server.registerTool("list_tasks", {
    title: "List development tasks",
    description: "List recent task journals.",
    inputSchema: { limit: z.number().int().min(1).max(200).default(50) }, annotations: readAnnotations,
  }, async ({ limit }) => runTool(async () => ({ tasks: await journal.listTasks(limit) })));

  server.registerTool("complete_task", {
    title: "Complete development task",
    description: "Mark a task journal as completed.",
    inputSchema: { taskId: z.string().uuid(), summary: z.string().max(4000).optional() }, annotations: writeAnnotations,
  }, async ({ taskId, summary }) => runTool(async () => ({ ...(await journal.completeTask(taskId, summary)) })));
}
