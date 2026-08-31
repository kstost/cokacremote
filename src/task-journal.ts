import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const AUTO_SESSION_GAP_MS = 15 * 60 * 1000;
const AUTO_PREFIX = "auto-";

export interface TaskEvent {
  seq: number;
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
  automatic?: boolean;
}

interface JournalView {
  summaries: TaskSummary[];
  eventsByTask: Map<string, TaskEvent[]>;
}

function compactCommand(command: string): string {
  const first = command.split("\n").map((line) => line.trim()).find(Boolean) ?? "command";
  return first.length > 72 ? `${first.slice(0, 69)}...` : first;
}

function appendProcessEvent(task: TaskSummary, entry: TaskEvent): void {
  task.eventCount += 1;
  if (entry.event === "process.started") {
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

function autoSessionComplete(task: TaskSummary): boolean {
  return task.commands.length > 0 && task.commands.every((command) => command.exitCode !== undefined || command.timedOut === true);
}

export class TaskJournal {
  readonly #file: string | undefined;
  readonly #memory: TaskEvent[] = [];
  #nextSeq = 1;
  #sequenceInitialized = false;
  #recordQueue: Promise<void> = Promise.resolve();

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
    const operation = this.#recordQueue.then(async () => {
      await this.#ensureSequence();
      const entry: TaskEvent = { seq: this.#nextSeq++, timestamp: new Date().toISOString(), event, ...data };
      this.#memory.push(entry);
      if (!this.#file) return;
      await mkdir(path.dirname(this.#file), { recursive: true });
      await appendFile(this.#file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    this.#recordQueue = operation.catch(() => undefined);
    await operation;
  }

  async getTaskEvents(taskId: string, afterSeq = 0, limit = 200): Promise<TaskEvent[]> {
    const view = await this.#view();
    const events = view.eventsByTask.get(taskId);
    if (!events) throw new Error(`Unknown task: ${taskId}`);
    return events
      .filter((entry) => entry.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  async getTask(taskId: string): Promise<TaskSummary | undefined> {
    return (await this.#view()).summaries.find((task) => task.taskId === taskId);
  }

  async listTasks(limit = 50): Promise<TaskSummary[]> {
    const tasks = (await this.#view()).summaries;
    return tasks.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  async #ensureSequence(): Promise<void> {
    if (this.#sequenceInitialized) return;
    if (this.#file) {
      try {
        const text = await readFile(this.#file, "utf8");
        let next = 1;
        for (const line of text.split("\n").filter(Boolean)) {
          try {
            const parsed = JSON.parse(line) as Partial<TaskEvent>;
            const raw = typeof parsed.seq === "number" && Number.isFinite(parsed.seq) ? Math.floor(parsed.seq) : next;
            const normalized = Math.max(next, raw);
            next = normalized + 1;
          } catch { /* Ignore malformed historical lines. */ }
        }
        this.#nextSeq = Math.max(this.#nextSeq, next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.#sequenceInitialized = true;
  }

  async #events(): Promise<TaskEvent[]> {
    if (!this.#file) return [...this.#memory];
    let persisted: TaskEvent[] = [];
    try {
      const text = await readFile(this.#file, "utf8");
      let nextSeq = 1;
      persisted = text.split("\n").filter(Boolean).flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as Partial<TaskEvent>;
          const raw = typeof parsed.seq === "number" && Number.isFinite(parsed.seq) ? Math.floor(parsed.seq) : nextSeq;
          const seq = Math.max(nextSeq, raw);
          nextSeq = seq + 1;
          return [{ ...parsed, seq } as TaskEvent];
        } catch { return []; }
      });
      this.#nextSeq = Math.max(this.#nextSeq, nextSeq);
      this.#sequenceInitialized = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const persistedKeys = new Set(persisted.map((e) => `${e.timestamp}|${e.event}|${String(e.sessionId ?? "")}|${String(e.taskId ?? "")}`));
    return [...persisted, ...this.#memory.filter((e) => !persistedKeys.has(`${e.timestamp}|${e.event}|${String(e.sessionId ?? "")}|${String(e.taskId ?? "")}`))]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.seq - b.seq);
  }

  async #view(): Promise<JournalView> {
    const events = await this.#events();
    const tasks = new Map<string, TaskSummary>();
    const eventsByTask = new Map<string, TaskEvent[]>();

    for (const entry of events) {
      const taskId = typeof entry.taskId === "string" ? entry.taskId : undefined;
      if (!taskId) continue;
      const taskEvents = eventsByTask.get(taskId) ?? [];
      taskEvents.push(entry);
      eventsByTask.set(taskId, taskEvents);
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
      if (entry.event === "task.completed") {
        task.eventCount += 1;
        task.status = "completed";
        task.endedAt = entry.timestamp;
      } else {
        appendProcessEvent(task, entry);
      }
    }

    const orphanEvents = events.filter((entry) => !entry.taskId && entry.event.startsWith("process."));
    let currentId: string | undefined;
    let currentLastAt = 0;
    for (const entry of orphanEvents) {
      const at = Date.parse(entry.timestamp);
      const startsNew = !currentId || !Number.isFinite(at) || at - currentLastAt > AUTO_SESSION_GAP_MS;
      if (startsNew) {
        const seed = typeof entry.sessionId === "string" ? entry.sessionId : `${entry.timestamp}-${entry.seq}`;
        currentId = `${AUTO_PREFIX}${seed}`;
        const command = typeof entry.command === "string" ? entry.command : "command";
        tasks.set(currentId, {
          taskId: currentId,
          title: `Auto session · ${compactCommand(command)}`,
          cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
          status: "active",
          startedAt: entry.timestamp,
          commands: [],
          filesChanged: [],
          eventCount: 0,
          automatic: true,
        });
        eventsByTask.set(currentId, []);
      }
      currentLastAt = Number.isFinite(at) ? at : currentLastAt;
      const task = tasks.get(currentId!)!;
      eventsByTask.get(currentId!)!.push(entry);
      appendProcessEvent(task, entry);
      if (autoSessionComplete(task)) {
        task.status = "completed";
        task.endedAt = entry.timestamp;
      } else {
        task.status = "active";
        task.endedAt = undefined;
      }
    }

    return { summaries: [...tasks.values()], eventsByTask };
  }
}
