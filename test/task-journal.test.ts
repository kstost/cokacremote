import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TaskJournal } from "../src/task-journal.js";

describe("TaskJournal automatic sessions", () => {
  it("groups unscoped process events into dashboard-visible automatic sessions", async () => {
    const journal = new TaskJournal();
    await journal.record("process.started", { sessionId: "s1", command: "npm test", cwd: "/workspace/app" });
    await journal.record("process.completed", { sessionId: "s1", command: "npm test", cwd: "/workspace/app", exitCode: 0 });
    await journal.record("process.started", { sessionId: "s2", command: "git status", cwd: "/workspace/app" });
    await journal.record("process.completed", { sessionId: "s2", command: "git status", cwd: "/workspace/app", exitCode: 0 });

    const tasks = await journal.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ automatic: true, status: "completed", cwd: "/workspace/app", eventCount: 4 });
    expect(tasks[0]!.title).toContain("npm test");
    expect(tasks[0]!.commands.map((item) => item.command)).toEqual(["npm test", "git status"]);
    expect((await journal.getTaskEvents(tasks[0]!.taskId)).map((item) => item.event)).toEqual([
      "process.started", "process.completed", "process.started", "process.completed",
    ]);
  });

  it("distinguishes recovered intermediate failures from final failures", async () => {
    const recovered = new TaskJournal();
    await recovered.record("process.started", { sessionId: "bad", command: "false", cwd: "/workspace/app" });
    await recovered.record("process.completed", { sessionId: "bad", command: "false", cwd: "/workspace/app", exitCode: 1 });
    await recovered.record("process.started", { sessionId: "good", command: "npm test", cwd: "/workspace/app" });
    await recovered.record("process.completed", { sessionId: "good", command: "npm test", cwd: "/workspace/app", exitCode: 0 });
    const recoveredTask = (await recovered.listTasks())[0]!;
    expect(recoveredTask).toMatchObject({
      status: "completed",
      failedCommandCount: 1,
      lastCommandStatus: "success",
    });

    const failed = new TaskJournal();
    await failed.record("process.started", { sessionId: "good", command: "npm test", cwd: "/workspace/app" });
    await failed.record("process.completed", { sessionId: "good", command: "npm test", cwd: "/workspace/app", exitCode: 0 });
    await failed.record("process.started", { sessionId: "bad", command: "npm run broken", cwd: "/workspace/app" });
    await failed.record("process.completed", { sessionId: "bad", command: "npm run broken", cwd: "/workspace/app", exitCode: 2 });
    const failedTask = (await failed.listTasks())[0]!;
    expect(failedTask).toMatchObject({
      status: "completed",
      failedCommandCount: 1,
      lastCommandStatus: "failed",
    });
  });

  it("tracks tool-only recovery for explicit tasks", async () => {
    const journal = new TaskJournal();
    const task = await journal.startTask("File edits", "/workspace/app");
    await journal.record("tool.failed", { taskId: task.taskId, toolName: "write_file", error: "first attempt failed" });
    await journal.record("tool.completed", { taskId: task.taskId, toolName: "write_file", durationMs: 1 });
    await journal.completeTask(task.taskId);
    expect(await journal.getTask(task.taskId)).toMatchObject({
      status: "completed",
      toolFailureCount: 1,
      lastToolStatus: "success",
    });
  });

  it("keeps explicit tasks separate from automatic sessions", async () => {
    const journal = new TaskJournal();
    const explicit = await journal.startTask("Explicit task", "/workspace/app");
    await journal.record("process.started", { taskId: explicit.taskId, sessionId: "explicit", command: "npm build", cwd: "/workspace/app" });
    await journal.record("process.completed", { taskId: explicit.taskId, sessionId: "explicit", command: "npm build", cwd: "/workspace/app", exitCode: 0 });
    await journal.completeTask(explicit.taskId);
    await journal.record("process.started", { sessionId: "auto", command: "git status", cwd: "/workspace/app" });
    await journal.record("process.completed", { sessionId: "auto", command: "git status", cwd: "/workspace/app", exitCode: 0 });

    const tasks = await journal.listTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.some((task) => task.taskId === explicit.taskId && !task.automatic)).toBe(true);
    expect(tasks.some((task) => task.automatic)).toBe(true);
  });

  it("normalizes duplicate historical sequences and continues after the persisted maximum", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cokacremote-journal-"));
    const file = path.join(dir, "journal.jsonl");
    const old = [
      { seq: 1, timestamp: "2026-01-01T00:00:00.000Z", event: "process.started", sessionId: "a", command: "one" },
      { seq: 2, timestamp: "2026-01-01T00:00:01.000Z", event: "process.completed", sessionId: "a", command: "one", exitCode: 0 },
      { seq: 1, timestamp: "2026-01-01T00:01:00.000Z", event: "process.started", sessionId: "b", command: "two" },
    ];
    await writeFile(file, old.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const journal = new TaskJournal(file);
    const tasks = await journal.listTasks();
    const events = await journal.getTaskEvents(tasks[0]!.taskId);
    expect(events.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    await journal.record("process.completed", { sessionId: "b", command: "two", exitCode: 0 });
    const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { seq: number });
    expect(lines.at(-1)?.seq).toBe(4);
  });
});
