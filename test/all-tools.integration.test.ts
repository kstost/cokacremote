import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

const ALL_TOOLS = [
  "apply_patch",
  "chmod_path",
  "copy_path",
  "download_file",
  "exec_command",
  "hash_file",
  "list_directory",
  "list_processes",
  "make_directory",
  "move_path",
  "read_file",
  "read_process",
  "remove_path",
  "replace_in_file",
  "run_script",
  "stat_path",
  "terminate_process",
  "upload_file",
  "write_file",
  "write_stdin",
] as const;

type ToolName = (typeof ALL_TOOLS)[number];
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function structured(result: ToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

function errorText(result: ToolResult): string {
  return String(structured(result).error ?? "");
}

function externalRoot(): string | undefined {
  const value = process.env.MCP_E2E_ROOT?.trim();
  if (!value) {
    return undefined;
  }
  if (!/^\/tmp\/cokacremote-tools-e2e-[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(
      "MCP_E2E_ROOT must be an isolated /tmp/cokacremote-tools-e2e-* path",
    );
  }
  return value;
}

describe.sequential("all registered MCP tools", () => {
  let localDirectory: string | undefined;
  let testRoot: string;
  let running: RunningHttpServer | undefined;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  const exercised = new Set<ToolName>();

  const call = async (
    name: ToolName,
    arguments_: Record<string, unknown> = {},
  ): Promise<ToolResult> => {
    exercised.add(name);
    return client.callTool({ name, arguments: arguments_ });
  };

  const callOk = async (
    name: ToolName,
    arguments_: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const result = await call(name, arguments_);
    expect(result.isError, `${name} unexpectedly returned an error: ${errorText(result)}`).not.toBe(
      true,
    );
    return structured(result);
  };

  const callError = async (
    name: ToolName,
    arguments_: Record<string, unknown> = {},
  ): Promise<string> => {
    const result = await call(name, arguments_);
    expect(result.isError, `${name} unexpectedly succeeded`).toBe(true);
    expect(errorText(result)).not.toBe("");
    return errorText(result);
  };

  beforeAll(async () => {
    const externalUrl = process.env.MCP_E2E_URL?.trim();
    let endpoint: URL;
    let authToken: string;
    if (externalUrl) {
      authToken = process.env.MCP_E2E_TOKEN?.trim() ?? "";
      if (!authToken) {
        throw new Error("MCP_E2E_TOKEN is required with MCP_E2E_URL");
      }
      testRoot = externalRoot() ?? `/tmp/cokacremote-tools-e2e-${randomUUID()}`;
      endpoint = new URL(externalUrl);
    } else {
      localDirectory = await mkdtemp(path.join(os.tmpdir(), "cokacremote-all-tools-"));
      testRoot = path.join(localDirectory, "tool-root");
      authToken = "all-tools-test-secret-0123456789abcdef";
      const config = loadConfig(
        {
          MCP_AUTH_TOKEN: authToken,
          MCP_HOST: "127.0.0.1",
          MCP_DEFAULT_CWD: localDirectory,
          MCP_MAX_FILE_CHUNK_BYTES: "65536",
        },
        localDirectory,
      );
      config.port = 0;
      running = await startHttpServer(config, createServices(config));
      const address = running.httpServer.address() as AddressInfo;
      endpoint = new URL(`http://127.0.0.1:${address.port}${config.endpoint}`);
    }

    client = new Client({ name: "all-tools-e2e", version: "1.0.0" });
    transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${authToken}` } },
    });
    await client.connect(transport);
    await callOk("make_directory", {
      path: testRoot,
      recursive: true,
      mode: "0700",
    });
  }, 20_000);

  afterAll(async () => {
    if (client && testRoot) {
      await client
        .callTool({
          name: "remove_path",
          arguments: { path: testRoot, recursive: true, force: true },
        })
        .catch(() => undefined);
      await client.close().catch(() => undefined);
    }
    await running?.close();
    if (localDirectory) {
      await rm(localDirectory, { recursive: true, force: true });
    }
  });

  it("publishes the exact tool inventory and annotations", async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...ALL_TOOLS]);
    for (const tool of listed.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations).toBeDefined();
    }
  });

  it("executes, polls, writes to, times out, lists, and terminates processes", async () => {
    const completed = await callOk("exec_command", {
      cmd: "printf '%s\\n' \"$E2E_VALUE\"; pwd; printf 'stderr-ok' >&2; exit 7",
      workdir: testRoot,
      env: { E2E_VALUE: "env-ok" },
      yieldTimeMs: 3000,
    });
    expect(completed).toMatchObject({ completed: true, exitCode: 7, stderr: "stderr-ok" });
    expect(String(completed.stdout)).toContain("env-ok");
    expect(String(completed.stdout)).toContain(testRoot);
    expect(await callOk("exec_command", {
      cmd: "printf shell-ok",
      workdir: testRoot,
      shell: "/bin/sh",
      login: false,
      yieldTimeMs: 3000,
    })).toMatchObject({ completed: true, exitCode: 0, stdout: "shell-ok" });

    const bounded = await callOk("exec_command", {
      cmd: "node -e \"process.stdout.write('x'.repeat(20000))\"",
      workdir: testRoot,
      yieldTimeMs: 3000,
      maxOutputBytes: 16384,
    });
    expect(bounded).toMatchObject({ completed: true, exitCode: 0, hasMore: true });
    let boundedOutput = String(bounded.stdout);
    let boundedCursor = Number(bounded.nextSeq);
    for (let page = 0; page < 5 && bounded.hasMore === true; page += 1) {
      const next = await callOk("read_process", {
        sessionId: bounded.sessionId,
        afterSeq: boundedCursor,
        maxOutputBytes: 16384,
      });
      boundedOutput += String(next.stdout);
      boundedCursor = Number(next.nextSeq);
      bounded.hasMore = next.hasMore;
    }
    expect(boundedOutput).toBe("x".repeat(20000));

    const timedOut = await callOk("exec_command", {
      cmd: "sleep 10",
      workdir: testRoot,
      timeoutMs: 100,
      yieldTimeMs: 3000,
    });
    expect(timedOut).toMatchObject({ completed: true, timedOut: true });
    expect(String(timedOut.error)).toContain("timeout");

    const interactive = await callOk("exec_command", {
      cmd: "node -e \"process.stdin.once('data', d => { process.stdout.write(d); process.exit(0); })\"",
      workdir: testRoot,
      yieldTimeMs: 0,
    });
    expect(interactive).toMatchObject({ running: true, completed: false });
    const interactiveSession = String(interactive.sessionId);
    const written = await callOk("write_stdin", {
      sessionId: interactiveSession,
      chars: "interactive-ok\\n",
      closeStdin: true,
      yieldTimeMs: 3000,
    });
    expect(String(written.stdout)).toContain("interactive-ok");
    const read = await callOk("read_process", {
      sessionId: interactiveSession,
      afterSeq: written.nextSeq,
      waitMs: 1000,
    });
    expect(read).toMatchObject({ running: false, completed: true, exitCode: 0 });

    const script = await callOk("run_script", {
      runtime: "node",
      script:
        "process.stdin.once('data', d => { console.log(JSON.stringify({ arg: process.argv[2], env: process.env.E2E_SCRIPT, stdin: d.toString() })); process.exit(0); });",
      workdir: testRoot,
      args: ["argument-ok"],
      env: { E2E_SCRIPT: "script-env-ok" },
      stdin: "script-stdin-ok",
      yieldTimeMs: 3000,
      keepScript: true,
    });
    expect(script).toMatchObject({ completed: true, exitCode: 0 });
    expect(JSON.parse(String(script.stdout).trim())).toEqual({
      arg: "argument-ok",
      env: "script-env-ok",
      stdin: "script-stdin-ok",
    });
    expect(path.relative(os.tmpdir(), String(script.scriptPath))).toMatch(
      /^remote-dev-mcp-script-[^/]+\/script\.mjs$/,
    );
    const keptScript = await callOk("stat_path", { path: script.scriptPath });
    expect(keptScript).toMatchObject({ type: "file", mode: "0700" });
    await callOk("remove_path", {
      path: path.dirname(String(script.scriptPath)),
      recursive: true,
      force: true,
    });
    for (const request of [
      { script: "printf default-bash-ok", expected: "default-bash-ok" },
      { runtime: "bash", script: "printf bash-ok", expected: "bash-ok" },
      { runtime: "sh", script: "printf sh-ok", expected: "sh-ok" },
      { runtime: "python", script: "print('python-ok')", expected: "python-ok\n" },
      {
        runtime: "custom",
        interpreter: "/bin/sh",
        script: "printf custom-ok",
        expected: "custom-ok",
      },
    ]) {
      const runtimeResult = await callOk("run_script", {
        ...request,
        workdir: testRoot,
        yieldTimeMs: 3000,
      });
      expect(runtimeResult).toMatchObject({
        completed: true,
        exitCode: 0,
        stdout: request.expected,
      });
    }
    expect(await callError("run_script", { runtime: "custom", script: "exit 0" })).toContain(
      "interpreter is required",
    );

    const longRunning = await callOk("exec_command", {
      cmd: "node -e \"setInterval(() => {}, 1000)\"",
      workdir: testRoot,
      yieldTimeMs: 0,
    });
    const longSession = String(longRunning.sessionId);
    const processes = await callOk("list_processes");
    expect(processes.processes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: longSession, running: true }),
      ]),
    );
    await callOk("terminate_process", {
      sessionId: longSession,
      signal: "SIGTERM",
      graceMs: 1000,
    });
    const terminated = await callOk("read_process", {
      sessionId: longSession,
      waitMs: 2000,
    });
    expect(terminated).toMatchObject({ running: false, completed: true, signal: "SIGTERM" });
  }, 30_000);

  it("handles text, metadata, listings, permissions, and unified patches", async () => {
    await callOk("make_directory", {
      path: "text/nested",
      cwd: testRoot,
      recursive: true,
      mode: "0750",
    });
    expect(await callError("make_directory", {
      path: "missing-parent/child",
      cwd: testRoot,
      recursive: false,
    })).toMatch(/ENOENT|no such file/i);

    const unicodeText = "A😀한글B";
    await callOk("write_file", {
      path: "text/nested/unicode.txt",
      cwd: testRoot,
      content: unicodeText,
      fileMode: "0640",
    });
    expect(await callOk("stat_path", {
      path: "text/nested/unicode.txt",
      cwd: testRoot,
    })).toMatchObject({ type: "file", mode: "0640" });

    await callOk("chmod_path", {
      path: "text/nested/unicode.txt",
      cwd: testRoot,
      mode: "0600",
    });
    await callOk("write_file", {
      path: "text/nested/unicode.txt",
      cwd: testRoot,
      content: unicodeText,
      mode: "overwrite",
      fileMode: "0644",
    });
    expect(await callOk("stat_path", {
      path: "text/nested/unicode.txt",
      cwd: testRoot,
    })).toMatchObject({ mode: "0644" });

    let offset = 0;
    let reconstructed = "";
    for (let part = 0; part < 20; part += 1) {
      const chunk = await callOk("read_file", {
        path: "text/nested/unicode.txt",
        cwd: testRoot,
        offset,
        maxBytes: 3,
        encoding: "utf8",
      });
      reconstructed += String(chunk.content);
      const nextOffset = Number(chunk.nextOffset);
      expect(nextOffset).toBeGreaterThan(offset);
      offset = nextOffset;
      if (chunk.eof === true) {
        break;
      }
    }
    expect(reconstructed).toBe(unicodeText);

    const encoded = await callOk("read_file", {
      path: "text/nested/unicode.txt",
      cwd: testRoot,
      maxBytes: 65536,
      encoding: "base64",
    });
    expect(Buffer.from(String(encoded.content), "base64").toString("utf8")).toBe(unicodeText);
    expect(await callError("read_file", {
      path: "text",
      cwd: testRoot,
    })).toContain("not a regular file");

    expect(await callError("write_file", {
      path: "text/invalid-base64.bin",
      cwd: testRoot,
      content: "%%%not-base64%%%",
      encoding: "base64",
    })).toMatch(/base64/i);
    expect(await callError("write_file", {
      path: "text/no-parent/value.txt",
      cwd: testRoot,
      content: "must fail",
      createParents: false,
    })).toMatch(/ENOENT|no such file/i);

    await callOk("write_file", {
      path: "text/append.txt",
      cwd: testRoot,
      content: "first",
    });
    await callOk("write_file", {
      path: "text/append.txt",
      cwd: testRoot,
      content: "-second",
      mode: "append",
    });
    expect(await callOk("read_file", {
      path: "text/append.txt",
      cwd: testRoot,
    })).toMatchObject({ content: "first-second", eof: true });
    await callOk("write_file", {
      path: "text/empty.txt",
      cwd: testRoot,
      content: "",
    });
    expect(await callOk("read_file", {
      path: "text/empty.txt",
      cwd: testRoot,
      maxBytes: 1,
    })).toMatchObject({ content: "", bytesRead: 0, eof: true });

    await callOk("write_file", {
      path: "text/replace.txt",
      cwd: testRoot,
      content: "one two one\n",
    });
    expect(await callError("replace_in_file", {
      path: "text/replace.txt",
      cwd: testRoot,
      oldText: "one",
      newText: "ONE",
    })).toContain("found 2");
    await callOk("replace_in_file", {
      path: "text/replace.txt",
      cwd: testRoot,
      oldText: "one",
      newText: "ONE",
      replaceAll: true,
      expectedOccurrences: 2,
    });
    await callOk("replace_in_file", {
      path: "text/replace.txt",
      cwd: testRoot,
      oldText: "two",
      newText: "three",
      expectedOccurrences: 1,
    });
    expect(await callOk("read_file", {
      path: "text/replace.txt",
      cwd: testRoot,
    })).toMatchObject({ content: "ONE three ONE\n", eof: true });

    await callOk("write_file", {
      path: "text/.hidden",
      cwd: testRoot,
      content: "hidden",
    });
    const visible = await callOk("list_directory", {
      path: "text",
      cwd: testRoot,
      recursive: true,
      maxDepth: 8,
      includeHidden: false,
      includeMetadata: true,
    });
    expect(visible.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "nested/unicode.txt", type: "file" }),
      ]),
    );
    expect(visible.entries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: ".hidden" })]),
    );
    expect(await callOk("list_directory", {
      path: "text",
      cwd: testRoot,
      recursive: true,
      maxEntries: 2,
    })).toMatchObject({ count: 2, truncated: true });

    await callOk("exec_command", {
      cmd: "ln -s nested/unicode.txt text/unicode-link",
      workdir: testRoot,
      yieldTimeMs: 3000,
    });
    expect(await callOk("stat_path", {
      path: "text/unicode-link",
      cwd: testRoot,
    })).toMatchObject({ type: "symlink", symlinkTarget: "nested/unicode.txt" });

    await callOk("write_file", {
      path: "patch-target.txt",
      cwd: testRoot,
      content: "old\n",
    });
    const patch = [
      "diff --git a/patch-target.txt b/patch-target.txt",
      "--- a/patch-target.txt",
      "+++ b/patch-target.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    expect(await callOk("apply_patch", {
      patch,
      cwd: testRoot,
      checkOnly: true,
    })).toMatchObject({ applied: false, checkOnly: true });
    expect(await callOk("read_file", {
      path: "patch-target.txt",
      cwd: testRoot,
    })).toMatchObject({ content: "old\n" });
    expect(await callOk("apply_patch", { patch, cwd: testRoot })).toMatchObject({
      applied: true,
      checkOnly: false,
    });
    expect(await callOk("apply_patch", {
      patch,
      cwd: testRoot,
      reverse: true,
    })).toMatchObject({ applied: true });
    expect(await callOk("read_file", {
      path: "patch-target.txt",
      cwd: testRoot,
    })).toMatchObject({ content: "old\n" });
    expect(await callError("apply_patch", {
      patch: "this is not a unified patch",
      cwd: testRoot,
    })).not.toBe("");

    await callOk("make_directory", {
      path: "three-way",
      cwd: testRoot,
      recursive: true,
    });
    await callOk("write_file", {
      path: "three-way/value.txt",
      cwd: testRoot,
      content: "base\n",
    });
    await callOk("exec_command", {
      cmd: "git init -q && git config user.email e2e@example.invalid && git config user.name E2E && git add value.txt && git commit -qm base",
      workdir: path.join(testRoot, "three-way"),
      yieldTimeMs: 3000,
    });
    await callOk("write_file", {
      path: "value.txt",
      cwd: path.join(testRoot, "three-way"),
      content: "three-way-result\n",
    });
    const generatedPatch = await callOk("exec_command", {
      cmd: "git diff --binary -- value.txt",
      workdir: path.join(testRoot, "three-way"),
      yieldTimeMs: 3000,
    });
    await callOk("exec_command", {
      cmd: "git checkout -- value.txt",
      workdir: path.join(testRoot, "three-way"),
      yieldTimeMs: 3000,
    });
    expect(await callOk("apply_patch", {
      patch: generatedPatch.stdout,
      cwd: path.join(testRoot, "three-way"),
      threeWay: true,
    })).toMatchObject({ applied: true });
    expect(await callOk("read_file", {
      path: "value.txt",
      cwd: path.join(testRoot, "three-way"),
    })).toMatchObject({ content: "three-way-result\n" });
  }, 30_000);

  it("transfers, hashes, copies, moves, and removes isolated paths", async () => {
    await callOk("make_directory", {
      path: "transfer",
      cwd: testRoot,
      recursive: true,
    });
    expect(await callError("upload_file", {
      path: "transfer/invalid.bin",
      cwd: testRoot,
      dataBase64: "not@base64",
      truncate: true,
    })).toMatch(/base64/i);

    const binary = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 256));
    const first = binary.subarray(0, 333);
    const second = binary.subarray(333);
    await callOk("write_file", {
      path: "transfer/artifact.bin",
      cwd: testRoot,
      content: "stale content that must be truncated",
    });
    const firstUpload = await callOk("upload_file", {
      path: "transfer/artifact.bin",
      cwd: testRoot,
      dataBase64: first.toString("base64"),
      offset: 0,
      truncate: true,
    });
    expect(firstUpload).toMatchObject({
      bytesWritten: first.length,
      nextOffset: first.length,
      chunkSha256: createHash("sha256").update(first).digest("hex"),
    });
    await callOk("upload_file", {
      path: "transfer/artifact.bin",
      cwd: testRoot,
      dataBase64: second.toString("base64"),
      offset: first.length,
      truncate: false,
    });

    let downloaded = Buffer.alloc(0);
    let offset = 0;
    for (let part = 0; part < 20; part += 1) {
      const chunk = await callOk("download_file", {
        path: "transfer/artifact.bin",
        cwd: testRoot,
        offset,
        maxBytes: 113,
      });
      downloaded = Buffer.concat([
        downloaded,
        Buffer.from(String(chunk.dataBase64), "base64"),
      ]);
      offset = Number(chunk.nextOffset);
      if (chunk.eof === true) {
        break;
      }
    }
    expect(downloaded).toEqual(binary);
    expect(await callOk("download_file", {
      path: "transfer/artifact.bin",
      cwd: testRoot,
      offset: binary.length,
      maxBytes: 1,
    })).toMatchObject({ bytesRead: 0, eof: true, nextOffset: binary.length });
    for (const algorithm of ["sha256", "sha512", "md5"] as const) {
      expect(await callOk("hash_file", {
        path: "transfer/artifact.bin",
        cwd: testRoot,
        algorithm,
      })).toMatchObject({
        algorithm,
        digest: createHash(algorithm).update(binary).digest("hex"),
      });
    }

    await callOk("write_file", {
      path: "transfer/base64-copy.bin",
      cwd: testRoot,
      content: binary.toString("base64"),
      encoding: "base64",
    });
    expect(await callOk("hash_file", {
      path: "transfer/base64-copy.bin",
      cwd: testRoot,
    })).toMatchObject({ digest: createHash("sha256").update(binary).digest("hex") });

    await callOk("write_file", {
      path: "transfer/existing.bin",
      cwd: testRoot,
      content: "existing",
    });
    expect(await callError("copy_path", {
      sourcePath: "transfer/artifact.bin",
      destinationPath: "transfer/existing.bin",
      cwd: testRoot,
      force: false,
    })).toContain("already exists");
    expect(await callError("copy_path", {
      sourcePath: "transfer/artifact.bin",
      destinationPath: "transfer/artifact.bin",
      cwd: testRoot,
    })).toContain("must be different");
    await callOk("copy_path", {
      sourcePath: "transfer/artifact.bin",
      destinationPath: "transfer/copied.bin",
      cwd: testRoot,
      force: true,
    });
    expect(await callOk("hash_file", {
      path: "transfer/copied.bin",
      cwd: testRoot,
    })).toMatchObject({ digest: createHash("sha256").update(binary).digest("hex") });

    await callOk("make_directory", {
      path: "transfer/source-dir",
      cwd: testRoot,
      recursive: true,
    });
    await callOk("write_file", {
      path: "transfer/source-dir/value.txt",
      cwd: testRoot,
      content: "source",
    });
    await callOk("make_directory", {
      path: "transfer/destination-dir",
      cwd: testRoot,
      recursive: true,
    });
    await callOk("write_file", {
      path: "transfer/destination-dir/value.txt",
      cwd: testRoot,
      content: "destination",
    });
    expect(await callError("copy_path", {
      sourcePath: "transfer/source-dir",
      destinationPath: "transfer/destination-dir",
      cwd: testRoot,
      recursive: false,
    })).toContain("recursive=true");
    expect(await callError("copy_path", {
      sourcePath: "transfer/source-dir",
      destinationPath: "transfer/destination-dir",
      cwd: testRoot,
      recursive: true,
      force: false,
    })).toContain("already exists");
    await callOk("copy_path", {
      sourcePath: "transfer/source-dir",
      destinationPath: "transfer/destination-dir",
      cwd: testRoot,
      recursive: true,
      force: true,
    });
    expect(await callOk("read_file", {
      path: "transfer/destination-dir/value.txt",
      cwd: testRoot,
    })).toMatchObject({ content: "source" });

    await callOk("write_file", {
      path: "transfer/move-source.txt",
      cwd: testRoot,
      content: "move-source",
    });
    await callOk("write_file", {
      path: "transfer/move-destination.txt",
      cwd: testRoot,
      content: "move-destination",
    });
    expect(await callError("move_path", {
      sourcePath: "transfer/move-source.txt",
      destinationPath: "transfer/move-destination.txt",
      cwd: testRoot,
      overwrite: false,
    })).toContain("already exists");
    expect(await callOk("move_path", {
      sourcePath: "transfer/move-source.txt",
      destinationPath: "transfer/move-destination.txt",
      cwd: testRoot,
      overwrite: true,
    })).toMatchObject({ moved: true });
    expect(await callOk("read_file", {
      path: "transfer/move-destination.txt",
      cwd: testRoot,
    })).toMatchObject({ content: "move-source" });
    expect(await callOk("move_path", {
      sourcePath: "transfer/move-destination.txt",
      destinationPath: "transfer/move-destination.txt",
      cwd: testRoot,
    })).toMatchObject({ moved: false, samePath: true });

    await callOk("make_directory", {
      path: "transfer/remove-dir/nested",
      cwd: testRoot,
      recursive: true,
    });
    await callOk("write_file", {
      path: "transfer/remove-dir/nested/value.txt",
      cwd: testRoot,
      content: "remove",
    });
    expect(await callError("remove_path", {
      path: "transfer/remove-dir",
      cwd: testRoot,
      recursive: false,
      force: false,
    })).toMatch(/directory|EISDIR|recursive/i);
    await callOk("remove_path", {
      path: "transfer/remove-dir",
      cwd: testRoot,
      recursive: true,
      force: false,
    });
    expect(await callError("stat_path", {
      path: "transfer/remove-dir",
      cwd: testRoot,
    })).toMatch(/ENOENT|no such file/i);
    expect(await callOk("remove_path", {
      path: "transfer/does-not-exist",
      cwd: testRoot,
      force: true,
    })).toMatchObject({ removed: true });
  }, 30_000);

  it("exercises every published tool through MCP", () => {
    expect([...exercised].sort()).toEqual([...ALL_TOOLS]);
  });
});
