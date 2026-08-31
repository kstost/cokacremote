import { TaskJournal } from "./task-journal.js";
import { errorMessage } from "./errors.js";

export async function traceTaskTool<T>(
  journal: TaskJournal,
  taskId: string | undefined,
  toolName: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!taskId) return operation();
  const task = await journal.getTask(taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const started = performance.now();
  await journal.record("tool.started", { taskId, toolName });
  try {
    const result = await operation();
    await journal.record("tool.completed", {
      taskId,
      toolName,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
    });
    return result;
  } catch (error) {
    await journal.record("tool.failed", {
      taskId,
      toolName,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      error: errorMessage(error),
    });
    throw error;
  }
}
