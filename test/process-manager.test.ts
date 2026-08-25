import { afterEach, describe, expect, it } from "vitest";

import { ProcessManager } from "../src/process-manager.js";

function createManager(): ProcessManager {
  return new ProcessManager({
    maxRetainedOutputBytes: 1024 * 1024,
    processRetentionMs: 60_000,
    maxProcesses: 16,
    defaultMaxOutputBytes: 1024 * 1024,
  });
}

describe("ProcessManager", () => {
  let manager: ProcessManager | undefined;

  afterEach(async () => {
    await manager?.shutdown();
  });

  it("captures stdout, stderr, and exit state", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: "/bin/bash",
      args: ["-c", "printf stdout; printf stderr >&2"],
      commandForDisplay: "test output",
      cwd: process.cwd(),
    });

    await manager.waitForExit(sessionId, 2000);
    const result = await manager.read(sessionId);

    expect(result).toMatchObject({
      running: false,
      exitCode: 0,
      stdout: "stdout",
      stderr: "stderr",
      timedOut: false,
    });
    expect(result.output).toContain("stdout");
    expect(result.output).toContain("stderr");
  });

  it("supports interactive stdin and closes cleanly", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: "/bin/cat",
      args: [],
      commandForDisplay: "cat",
      cwd: process.cwd(),
    });

    await manager.write(sessionId, "hello\n", true);
    await manager.waitForExit(sessionId, 2000);
    const result = await manager.read(sessionId);

    expect(result.running).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("terminates a command when its timeout expires", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: "/bin/bash",
      args: ["-c", "sleep 10"],
      commandForDisplay: "sleep 10",
      cwd: process.cwd(),
      timeoutMs: 50,
    });

    await manager.waitForExit(sessionId, 3000);
    const result = await manager.read(sessionId);

    expect(result.running).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timeout");
  });

  it("handles a rejected initial stdin write without crashing the server", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: "/bin/bash",
      args: ["-c", "true"],
      commandForDisplay: "true",
      cwd: process.cwd(),
      stdin: "x".repeat(1024 * 1024),
    });

    await manager.waitForExit(sessionId, 2000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await manager.read(sessionId);

    expect(result.running).toBe(false);
    expect(result.error).toMatch(/stdin write failed|EPIPE/i);
  });

  it("rejects a follow-up stdin write without emitting an unhandled error", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: "/bin/bash",
      args: ["-c", "exec 0<&-; printf ready; sleep 2"],
      commandForDisplay: "closed stdin",
      cwd: process.cwd(),
    });
    expect((await manager.read(sessionId, { waitMs: 1000 })).stdout).toContain("ready");

    await expect(manager.write(sessionId, "x".repeat(1024 * 1024))).rejects.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await manager.read(sessionId)).error).toMatch(/stdin write failed|EPIPE/i);
  });

  it("preserves UTF-8 characters across paged process output", async () => {
    manager = createManager();
    const expected = `${"a".repeat(16 * 1024 - 1)}😀B`;
    const encoded = Buffer.from(expected).toString("base64");
    const sessionId = manager.start({
      executable: process.execPath,
      args: ["-e", `process.stdout.write(Buffer.from(${JSON.stringify(encoded)}, "base64"))`],
      commandForDisplay: "unicode output",
      cwd: process.cwd(),
    });

    await manager.waitForExit(sessionId, 2000);
    const first = await manager.read(sessionId, { maxOutputBytes: 16 * 1024 });
    const second = await manager.read(sessionId, {
      afterSeq: first.nextSeq,
      maxOutputBytes: 16 * 1024,
    });

    expect(first.hasMore).toBe(true);
    expect(first.output + second.output).toBe(expected);
    expect(first.output + second.output).not.toContain("�");
  });

  it("lists processes without pruning and expires completed sessions independently", async () => {
    manager = new ProcessManager({
      maxRetainedOutputBytes: 1024 * 1024,
      processRetentionMs: 500,
      maxProcesses: 16,
      defaultMaxOutputBytes: 1024 * 1024,
    });
    const sessionId = manager.start({
      executable: "/bin/bash",
      args: ["-c", "true"],
      commandForDisplay: "true",
      cwd: process.cwd(),
    });

    await manager.waitForExit(sessionId, 2000);
    expect(manager.list()).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId, running: false })]),
    );
    await expect(manager.read(sessionId)).resolves.toMatchObject({ running: false });

    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(manager.read(sessionId)).rejects.toThrow("Unknown process session");
  });
});
