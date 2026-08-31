import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface TaskEvent {
  timestamp: string;
  event: string;
  taskId?: string;
  [key: string]: unknown;
}

export interface TaskSummary {
  taskId: string;
  title: string;
  cwd?: string;
  status: "active" | "completed";
  startedAt: string;
  endedAt?: string;
  commands: Array<{ sessionId?: string; command: string; cwd?: string; exitCode?: number | null; timedOut?: boolean }>;
  filesChanged: string[];
  eventCount: number;
}

export class TaskJournal {
  readonly #file: string | undefined;
  readonly #memory: TaskEvent[] = [];

  constructor(file?: string) {
    this.#file = file;
  }

  async startTask(title: string, cwd?: string): Promise<TaskSummary> {
    const taskId = randomUUID();
    await this.record("task.started", { taskId, title, cwd });
    return (await this.getTask(taskId))!;
  }

  async completeTask(taskId: string, summary?: string): Promise<TaskSummary> {
    if (!(await this.getTask(taskId))) throw new Error(`Unknown task: ${taskId}`);
    await this.record("task.completed", { taskId, summary });
    return (await this.getTask(taskId))!;
  }

  async record(event: string, data: Record<string, unknown> = {}): Promise<void> {
    const entry: TaskEvent = { timestamp: new Date().toISOString(), event, ...data };
    this.#memory.push(entry);
    if (!this.#file) return;
    await mkdir(path.dirname(this.#file), { recursive: true });
    await appendFile(this.#file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async getTask(taskId: string): Promise<TaskSummary | undefined> {
    const tasks = await this.#summaries();
    return tasks.find((task) => task.taskId === taskId);
  }

  async listTasks(limit = 50): Promise<TaskSummary[]> {
    const tasks = await this.#summaries();
    return tasks.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  async #events(): Promise<TaskEvent[]> {
    if (!this.#file) return [...this.#memory];
    let persisted: TaskEvent[] = [];
    try {
      const text = await readFile(this.#file, "utf8");
      persisted = text.split("\n").filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as TaskEvent]; } catch { return []; }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const persistedKeys = new Set(persisted.map((e) => JSON.stringify(e)));
    return [...persisted, ...this.#memory.filter((e) => !persistedKeys.has(JSON.stringify(e)))];
  }

  async #summaries(): Promise<TaskSummary[]> {
    const tasks = new Map<string, TaskSummary>();
    for (const entry of await this.#events()) {
      const taskId = typeof entry.taskId === "string" ? entry.taskId : undefined;
      if (!taskId) continue;
      if (entry.event === "task.started") {
        tasks.set(taskId, {
          taskId,
          title: typeof entry.title === "string" ? entry.title : "Untitled task",
          cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
          status: "active",
          startedAt: entry.timestamp,
          commands: [],
          filesChanged: [],
          eventCount: 1,
        });
        continue;
      }
      const task = tasks.get(taskId);
      if (!task) continue;
      task.eventCount += 1;
      if (entry.event === "task.completed") {
        task.status = "completed";
        task.endedAt = entry.timestamp;
      } else if (entry.event === "process.started") {
        task.commands.push({
          sessionId: typeof entry.sessionId === "string" ? entry.sessionId : undefined,
          command: typeof entry.command === "string" ? entry.command : "",
          cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
        });
      } else if (entry.event === "process.completed") {
        const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : undefined;
        const command = [...task.commands].reverse().find((item) => item.sessionId === sessionId);
        if (command) {
          command.exitCode = typeof entry.exitCode === "number" || entry.exitCode === null ? entry.exitCode : undefined;
          command.timedOut = entry.timedOut === true;
        }
      } else if (entry.event === "file.changed" && typeof entry.path === "string") {
        if (!task.filesChanged.includes(entry.path)) task.filesChanged.push(entry.path);
      }
    }
    return [...tasks.values()];
  }
}
