import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAscii } from "node:buffer";
import { errorMessage } from "./errors.js";

const OUTPUT_CHUNK_BYTES = 16 * 1024;

export type ProcessOutputStream = "stdout" | "stderr";

interface OutputChunk {
  seq: number;
  stream: ProcessOutputStream;
  data: Buffer;
}

interface ManagedProcess {
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt: number | undefined;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  error: string | undefined;
  timedOut: boolean;
  chunks: OutputChunk[];
  pendingOutput: Record<ProcessOutputStream, Buffer>;
  retainedBytes: number;
  totalOutputBytes: number;
  droppedOutputBytes: number;
  nextSeq: number;
  waiters: Set<() => void>;
  exitWaiters: Set<() => void>;
  timeoutHandle: NodeJS.Timeout | undefined;
  idleTimeoutHandle: NodeJS.Timeout | undefined;
  cleanup: (() => Promise<void>) | undefined;
  taskId: string | undefined;
}

function isContinuationByte(value: number): boolean {
  return value >= 0x80 && value <= 0xbf;
}

function utf8SequenceLengthAt(
  data: Buffer,
  offset: number,
  final: boolean,
): number | undefined {
  const first = data[offset]!;
  if (first <= 0x7f) {
    return 1;
  }

  let length = 0;
  if (first >= 0xc2 && first <= 0xdf) {
    length = 2;
  } else if (first >= 0xe0 && first <= 0xef) {
    length = 3;
  } else if (first >= 0xf0 && first <= 0xf4) {
    length = 4;
  } else {
    return 1;
  }

  if (offset + 1 >= data.length) {
    return final ? 1 : undefined;
  }

  const second = data[offset + 1]!;
  if (!isContinuationByte(second)) {
    return 1;
  }
  if ((first === 0xe0 && second < 0xa0) || (first === 0xed && second > 0x9f)) {
    return 1;
  }
  if ((first === 0xf0 && second < 0x90) || (first === 0xf4 && second > 0x8f)) {
    return 1;
  }
  for (let index = 2; index < length; index += 1) {
    if (offset + index >= data.length) {
      return final ? 1 : undefined;
    }
    if (!isContinuationByte(data[offset + index]!)) {
      return 1;
    }
  }
  return length;
}

function splitOutputChunks(
  data: Buffer,
  final = false,
): { chunks: Buffer[]; remainder: Buffer } {
  if (isAscii(data)) {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < data.length; offset += OUTPUT_CHUNK_BYTES) {
      chunks.push(Buffer.from(data.subarray(offset, offset + OUTPUT_CHUNK_BYTES)));
    }
    return { chunks, remainder: Buffer.alloc(0) };
  }

  const chunks: Buffer[] = [];
  let chunkStart = 0;
  let cursor = 0;
  while (cursor < data.length) {
    const sequenceLength = utf8SequenceLengthAt(data, cursor, final);
    if (sequenceLength === undefined) {
      break;
    }
    if (
      cursor > chunkStart &&
      cursor + sequenceLength - chunkStart > OUTPUT_CHUNK_BYTES
    ) {
      chunks.push(Buffer.from(data.subarray(chunkStart, cursor)));
      chunkStart = cursor;
      continue;
    }
    cursor += sequenceLength;
    if (cursor - chunkStart === OUTPUT_CHUNK_BYTES) {
      chunks.push(Buffer.from(data.subarray(chunkStart, cursor)));
      chunkStart = cursor;
    }
  }
  if (cursor > chunkStart) {
    chunks.push(Buffer.from(data.subarray(chunkStart, cursor)));
  }
  return {
    chunks,
    remainder: Buffer.from(data.subarray(cursor)),
  };
}

export interface StartProcessRequest {
  executable: string;
  args: string[];
  commandForDisplay: string;
  cwd: string;
  env?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  stdin?: string | undefined;
  cleanup?: (() => Promise<void>) | undefined;
  taskId?: string | undefined;
}

export interface ReadProcessRequest {
  afterSeq?: number | undefined;
  waitMs?: number | undefined;
  maxOutputBytes?: number | undefined;
}

export interface ProcessReadResult {
  sessionId: string;
  taskId: string | undefined;
  command: string;
  cwd: string;
  running: boolean;
  pid: number | undefined;
  startedAt: string;
  endedAt: string | undefined;
  wallTimeMs: number;
  exitCode: number | null | undefined;
  signal: NodeJS.Signals | null | undefined;
  timedOut: boolean;
  error: string | undefined;
  stdout: string;
  stderr: string;
  output: string;
  nextSeq: number;
  hasMore: boolean;
  totalOutputBytes: number;
  droppedOutputBytes: number;
}

export interface ProcessManagerOptions {
  maxRetainedOutputBytes: number;
  processRetentionMs: number;
  maxProcesses: number;
  defaultMaxOutputBytes: number;
  processIdleTimeoutMs?: number;
  processMaxRuntimeMs?: number;
  journal?: { record(event: string, data?: Record<string, unknown>): Promise<void> };
}

export class ProcessManager {
  readonly #processes = new Map<string, ManagedProcess>();
  readonly #options: ProcessManagerOptions;

  constructor(options: ProcessManagerOptions) {
    this.#options = options;
  }

  start(request: StartProcessRequest): string {
    this.prune();
    this.#makeCapacity();

    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const sessionId = randomUUID();
    const managed: ManagedProcess = {
      sessionId,
      child,
      command: request.commandForDisplay,
      cwd: request.cwd,
      startedAt: Date.now(),
      endedAt: undefined,
      exitCode: undefined,
      signal: undefined,
      error: undefined,
      timedOut: false,
      chunks: [],
      pendingOutput: { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
      retainedBytes: 0,
      totalOutputBytes: 0,
      droppedOutputBytes: 0,
      nextSeq: 1,
      waiters: new Set(),
      exitWaiters: new Set(),
      timeoutHandle: undefined,
      idleTimeoutHandle: undefined,
      cleanup: request.cleanup,
      taskId: request.taskId,
    };
    this.#processes.set(sessionId, managed);

    child.stdout.on("data", (data: Buffer | string) => {
      this.#appendOutput(managed, "stdout", Buffer.from(data));
    });
    child.stderr.on("data", (data: Buffer | string) => {
      this.#appendOutput(managed, "stderr", Buffer.from(data));
    });
    child.stdin.on("error", (error) => {
      this.#recordStdinError(managed, error);
    });
    child.on("error", (error) => {
      managed.error = errorMessage(error);
      this.#finish(managed, null, null);
    });
    child.on("close", (code, signal) => {
      this.#finish(managed, code, signal);
    });

    const requestedTimeoutMs = request.timeoutMs ?? 0;
    const timeoutMs = requestedTimeoutMs > 0 ? requestedTimeoutMs : (this.#options.processMaxRuntimeMs ?? 0);
    if (timeoutMs > 0) {
      managed.timeoutHandle = setTimeout(() => {
        managed.timedOut = true;
        managed.error ??= `Process exceeded timeout of ${timeoutMs} ms`;
        this.#signal(managed, "SIGTERM");
        const forceTimer = setTimeout(() => {
          if (this.#isRunning(managed)) {
            this.#signal(managed, "SIGKILL");
          }
        }, 5000);
        forceTimer.unref();
      }, timeoutMs);
      managed.timeoutHandle.unref();
    }

    this.#resetIdleTimeout(managed);
    this.#journal("process.started", managed);

    if (request.stdin !== undefined && request.stdin.length > 0) {
      try {
        child.stdin.write(request.stdin, (error) => {
          if (error) {
            this.#recordStdinError(managed, error);
          }
        });
      } catch (error) {
        this.#recordStdinError(managed, error);
      }
    }
    return sessionId;
  }

  async read(
    sessionId: string,
    request: ReadProcessRequest = {},
  ): Promise<ProcessReadResult> {
    const managed = this.#require(sessionId);
    const afterSeq = Math.max(0, request.afterSeq ?? 0);
    const waitMs = Math.max(0, request.waitMs ?? 0);
    if (waitMs > 0) {
      await this.#waitForOutput(managed, afterSeq, waitMs);
    }

    const maxOutputBytes = Math.max(
      OUTPUT_CHUNK_BYTES,
      Math.min(
        request.maxOutputBytes ?? this.#options.defaultMaxOutputBytes,
        this.#options.defaultMaxOutputBytes,
      ),
    );
    const eligible = managed.chunks.filter((chunk) => chunk.seq > afterSeq);
    const selected: OutputChunk[] = [];
    let selectedBytes = 0;
    for (const chunk of eligible) {
      if (selectedBytes + chunk.data.length > maxOutputBytes) {
        break;
      }
      selected.push(chunk);
      selectedBytes += chunk.data.length;
    }

    const stdout = Buffer.concat(
      selected.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.data),
    ).toString("utf8");
    const stderr = Buffer.concat(
      selected.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.data),
    ).toString("utf8");
    const output = Buffer.concat(selected.map((chunk) => chunk.data)).toString("utf8");
    const nextSeq = selected.at(-1)?.seq ?? afterSeq;
    const now = managed.endedAt ?? Date.now();

    return {
      sessionId,
      taskId: managed.taskId,
      command: managed.command,
      cwd: managed.cwd,
      running: this.#isRunning(managed),
      pid: managed.child.pid,
      startedAt: new Date(managed.startedAt).toISOString(),
      endedAt:
        managed.endedAt === undefined
          ? undefined
          : new Date(managed.endedAt).toISOString(),
      wallTimeMs: now - managed.startedAt,
      exitCode: managed.exitCode,
      signal: managed.signal,
      timedOut: managed.timedOut,
      error: managed.error,
      stdout,
      stderr,
      output,
      nextSeq,
      hasMore: eligible.length > selected.length,
      totalOutputBytes: managed.totalOutputBytes,
      droppedOutputBytes: managed.droppedOutputBytes,
    };
  }

  async write(
    sessionId: string,
    input: string,
    closeStdin = false,
  ): Promise<void> {
    const managed = this.#require(sessionId);
    if (input.length === 0 && !closeStdin) {
      return;
    }
    if (!this.#isRunning(managed)) {
      throw new Error(`Process ${sessionId} is not running`);
    }
    if (managed.child.stdin.destroyed || !managed.child.stdin.writable) {
      throw new Error(`stdin is closed for process ${sessionId}`);
    }

    if (input.length > 0) {
      await new Promise<void>((resolve, reject) => {
        managed.child.stdin.write(input, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
    if (closeStdin) {
      managed.child.stdin.end();
    }
  }

  async waitForExit(sessionId: string, waitMs: number): Promise<void> {
    const managed = this.#require(sessionId);
    if (!this.#isRunning(managed) || waitMs <= 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        managed.exitWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      managed.exitWaiters.add(finish);
      if (!this.#isRunning(managed)) {
        finish();
      }
    });
  }

  async terminate(
    sessionId: string,
    signal: NodeJS.Signals = "SIGTERM",
    graceMs = 3000,
  ): Promise<ProcessReadResult> {
    const managed = this.#require(sessionId);
    if (this.#isRunning(managed)) {
      this.#signal(managed, signal);
      if (signal !== "SIGKILL" && graceMs > 0) {
        const forceTimer = setTimeout(() => {
          if (this.#isRunning(managed)) {
            this.#signal(managed, "SIGKILL");
          }
        }, graceMs);
        forceTimer.unref();
      }
    }
    return this.read(sessionId, { waitMs: Math.min(graceMs, 1000) });
  }

  list(): Array<{
    sessionId: string;
    taskId: string | undefined;
    pid: number | undefined;
    command: string;
    cwd: string;
    running: boolean;
    startedAt: string;
    endedAt: string | undefined;
    exitCode: number | null | undefined;
  }> {
    this.prune();
    return [...this.#processes.values()].map((managed) => ({
      sessionId: managed.sessionId,
      taskId: managed.taskId,
      pid: managed.child.pid,
      command: managed.command,
      cwd: managed.cwd,
      running: this.#isRunning(managed),
      startedAt: new Date(managed.startedAt).toISOString(),
      endedAt:
        managed.endedAt === undefined
          ? undefined
          : new Date(managed.endedAt).toISOString(),
      exitCode: managed.exitCode,
    }));
  }

  prune(): void {
    const cutoff = Date.now() - this.#options.processRetentionMs;
    for (const [sessionId, managed] of this.#processes) {
      if (managed.endedAt !== undefined && managed.endedAt < cutoff) {
        this.#processes.delete(sessionId);
      }
    }
  }

  async shutdown(): Promise<void> {
    const running = [...this.#processes.values()].filter((managed) =>
      this.#isRunning(managed),
    );
    for (const managed of running) {
      this.#signal(managed, "SIGTERM");
    }
    await new Promise((resolve) => setTimeout(resolve, running.length > 0 ? 500 : 0));
    for (const managed of running) {
      if (this.#isRunning(managed)) {
        this.#signal(managed, "SIGKILL");
      }
    }
  }

  #makeCapacity(): void {
    if (this.#processes.size < this.#options.maxProcesses) {
      return;
    }
    const completed = [...this.#processes.values()]
      .filter((managed) => managed.endedAt !== undefined)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    while (
      this.#processes.size >= this.#options.maxProcesses &&
      completed.length > 0
    ) {
      const managed = completed.shift();
      if (managed) {
        this.#processes.delete(managed.sessionId);
      }
    }
    if (this.#processes.size >= this.#options.maxProcesses) {
      throw new Error(
        `Maximum managed process count (${this.#options.maxProcesses}) reached`,
      );
    }
  }

  #require(sessionId: string): ManagedProcess {
    const managed = this.#processes.get(sessionId);
    if (!managed) {
      throw new Error(`Unknown process session: ${sessionId}`);
    }
    return managed;
  }

  #appendOutput(
    managed: ManagedProcess,
    stream: ProcessOutputStream,
    data: Buffer,
  ): void {
    managed.totalOutputBytes += data.length;
    this.#resetIdleTimeout(managed);
    const pending = managed.pendingOutput[stream];
    const combined = pending.length > 0 ? Buffer.concat([pending, data]) : data;
    const split = splitOutputChunks(combined);
    managed.pendingOutput[stream] = split.remainder;
    this.#storeOutputChunks(managed, stream, split.chunks);
    this.#trimRetainedOutput(managed);
    this.#notify(managed);
  }

  #storeOutputChunks(
    managed: ManagedProcess,
    stream: ProcessOutputStream,
    chunks: Buffer[],
  ): void {
    for (const data of chunks) {
      managed.chunks.push({ seq: managed.nextSeq, stream, data });
      managed.nextSeq += 1;
      managed.retainedBytes += data.length;
    }
  }

  #trimRetainedOutput(managed: ManagedProcess): void {
    while (
      managed.retainedBytes > this.#options.maxRetainedOutputBytes &&
      managed.chunks.length > 0
    ) {
      const removed = managed.chunks.shift();
      if (removed) {
        managed.retainedBytes -= removed.data.length;
        managed.droppedOutputBytes += removed.data.length;
      }
    }
  }

  #flushPendingOutput(managed: ManagedProcess): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const pending = managed.pendingOutput[stream];
      if (pending.length === 0) {
        continue;
      }
      const split = splitOutputChunks(pending, true);
      managed.pendingOutput[stream] = Buffer.alloc(0);
      this.#storeOutputChunks(managed, stream, split.chunks);
    }
    this.#trimRetainedOutput(managed);
  }

  #recordStdinError(managed: ManagedProcess, error: unknown): void {
    managed.error ??= `stdin write failed: ${errorMessage(error)}`;
    this.#notify(managed);
  }

  #finish(
    managed: ManagedProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (managed.endedAt !== undefined) {
      return;
    }
    this.#flushPendingOutput(managed);
    managed.endedAt = Date.now();
    managed.exitCode = code;
    managed.signal = signal;
    if (managed.timeoutHandle) {
      clearTimeout(managed.timeoutHandle);
      managed.timeoutHandle = undefined;
    }
    if (managed.idleTimeoutHandle) {
      clearTimeout(managed.idleTimeoutHandle);
      managed.idleTimeoutHandle = undefined;
    }
    this.#journal("process.completed", managed);
    this.#notify(managed);
    const exitWaiters = [...managed.exitWaiters];
    managed.exitWaiters.clear();
    for (const waiter of exitWaiters) {
      waiter();
    }
    if (managed.cleanup) {
      void managed.cleanup().catch((error) => {
        managed.error ??= `Cleanup failed: ${errorMessage(error)}`;
      });
    }
  }

  #resetIdleTimeout(managed: ManagedProcess): void {
    if (managed.idleTimeoutHandle) clearTimeout(managed.idleTimeoutHandle);
    const idleTimeoutMs = this.#options.processIdleTimeoutMs ?? 0;
    if (idleTimeoutMs <= 0 || !this.#isRunning(managed)) {
      managed.idleTimeoutHandle = undefined;
      return;
    }
    managed.idleTimeoutHandle = setTimeout(() => {
      managed.timedOut = true;
      managed.error ??= `Process was idle for ${idleTimeoutMs} ms`;
      this.#journal("process.idle_timeout", managed);
      this.#signal(managed, "SIGTERM");
      const forceTimer = setTimeout(() => { if (this.#isRunning(managed)) this.#signal(managed, "SIGKILL"); }, 5000);
      forceTimer.unref();
    }, idleTimeoutMs);
    managed.idleTimeoutHandle.unref();
  }

  #journal(event: string, managed: ManagedProcess): void {
    const journal = this.#options.journal;
    if (!journal) return;
    void journal.record(event, { taskId: managed.taskId, sessionId: managed.sessionId, command: managed.command, cwd: managed.cwd, pid: managed.child.pid, exitCode: managed.exitCode, signal: managed.signal, timedOut: managed.timedOut, error: managed.error, totalOutputBytes: managed.totalOutputBytes }).catch(() => undefined);
  }

  #notify(managed: ManagedProcess): void {
    const waiters = [...managed.waiters];
    managed.waiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  #waitForOutput(
    managed: ManagedProcess,
    afterSeq: number,
    waitMs: number,
  ): Promise<void> {
    if (managed.nextSeq - 1 > afterSeq || !this.#isRunning(managed)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        managed.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      managed.waiters.add(finish);
      if (managed.nextSeq - 1 > afterSeq || !this.#isRunning(managed)) {
        finish();
      }
    });
  }

  #isRunning(managed: ManagedProcess): boolean {
    return managed.endedAt === undefined;
  }

  #signal(managed: ManagedProcess, signal: NodeJS.Signals): void {
    const pid = managed.child.pid;
    if (pid === undefined) {
      return;
    }
    try {
      if (process.platform !== "win32") {
        process.kill(-pid, signal);
      } else {
        managed.child.kill(signal);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        managed.error ??= `Failed to signal process: ${errorMessage(error)}`;
      }
    }
  }
}
