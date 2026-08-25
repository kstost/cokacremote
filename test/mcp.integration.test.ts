import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices, type McpServices } from "../src/mcp-server.js";

interface JsonRpcResponse {
  result?: {
    tools?: Array<{ name: string }>;
    structuredContent?: Record<string, unknown>;
  };
}

describe("remote development MCP server", () => {
  let temporaryDirectory: string;
  let config: AppConfig;
  let services: McpServices;
  let running: RunningHttpServer;
  let endpoint: URL;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "remote-dev-mcp-http-test-"));
    config = loadConfig(
      {
        MCP_AUTH_TOKEN: "integration-secret-0123456789abcdef",
        MCP_HOST: "127.0.0.1",
        MCP_DEFAULT_CWD: temporaryDirectory,
        MCP_MAX_FILE_CHUNK_BYTES: "65536",
      },
      temporaryDirectory,
    );
    config.port = 0;
    services = createServices(config);
    running = await startHttpServer(config, services);
    const address = running.httpServer.address() as AddressInfo;
    endpoint = new URL(`http://127.0.0.1:${address.port}${config.endpoint}`);
  });

  afterAll(async () => {
    await running.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("rejects unauthenticated MCP initialization", async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("authenticates MCP requests before parsing their JSON body", async () => {
    const unauthenticated = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(unauthenticated.status).toBe(401);

    const authenticated = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer integration-secret-0123456789abcdef",
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(authenticated.status).toBe(400);
  });

  it("lists tools and executes script and file workflows", async () => {
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: {
        headers: { Authorization: "Bearer integration-secret-0123456789abcdef" },
      },
    });
    await client.connect(transport);
    try {
      expect(transport.sessionId).toBeUndefined();
      expect(client.getServerVersion()).toMatchObject({
        name: "cokacremote",
        version: "0.1.0",
      });
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "exec_command",
          "run_script",
          "write_stdin",
          "read_file",
          "write_file",
          "apply_patch",
          "upload_file",
          "download_file",
        ]),
      );

      const scriptResult = await client.callTool({
        name: "run_script",
        arguments: {
          runtime: "node",
          script: "console.log(6 * 7)",
          yieldTimeMs: 2000,
        },
      });
      expect(scriptResult.isError).not.toBe(true);
      expect(scriptResult.structuredContent).toMatchObject({
        completed: true,
        exitCode: 0,
        stdout: "42\n",
      });

      const writeResult = await client.callTool({
        name: "write_file",
        arguments: { path: "hello.txt", content: "hello MCP\n" },
      });
      expect(writeResult.isError).not.toBe(true);

      const readResult = await client.callTool({
        name: "read_file",
        arguments: { path: "hello.txt" },
      });
      expect(readResult.structuredContent).toMatchObject({
        content: "hello MCP\n",
        eof: true,
      });
    } finally {
      await transport.terminateSession();
      await client.close();
    }
  });

  it("handles every tool call as an independent stateless request", async () => {
    const post = async (
      body: unknown,
      additionalHeaders: Record<string, string> = {},
    ): Promise<Response> =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer integration-secret-0123456789abcdef",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...additionalHeaders,
        },
        body: JSON.stringify(body),
      });

    const initializeResponse = await post({
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "stateless-test", version: "1" },
      },
    });
    expect(initializeResponse.status).toBe(200);
    expect(initializeResponse.headers.get("content-type")).toContain("application/json");
    expect(initializeResponse.headers.get("mcp-session-id")).toBeNull();
    expect(initializeResponse.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const listResponse = await post(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/list",
        params: {},
      },
      { "mcp-session-id": "stale-session-from-the-previous-deployment" },
    );
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as JsonRpcResponse;
    expect(listed.result?.tools?.map((tool) => tool.name)).toContain("exec_command");

    const startResponse = await post({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "exec_command",
        arguments: {
          cmd: "node -e \"setTimeout(() => console.log('stateless-ok'), 100)\"",
          yieldTimeMs: 0,
        },
      },
    });
    expect(startResponse.status).toBe(200);
    const started = (await startResponse.json()) as JsonRpcResponse;
    const sessionId = started.result?.structuredContent?.sessionId;
    expect(sessionId).toEqual(expect.any(String));
    expect(started.result?.structuredContent).toMatchObject({
      running: true,
      completed: false,
    });

    const readResponse = await post({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "read_process",
        arguments: { sessionId, waitMs: 3000 },
      },
    });
    expect(readResponse.status).toBe(200);
    const read = (await readResponse.json()) as JsonRpcResponse;
    expect(read.result?.structuredContent?.stdout).toContain("stateless-ok");
    const nextSeq = read.result?.structuredContent?.nextSeq;
    expect(nextSeq).toEqual(expect.any(Number));

    const completionResponse = await post({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "read_process",
        arguments: { sessionId, afterSeq: nextSeq, waitMs: 3000 },
      },
    });
    expect(completionResponse.status).toBe(200);
    const completion = (await completionResponse.json()) as JsonRpcResponse;
    expect(completion.result?.structuredContent).toMatchObject({
      running: false,
      completed: true,
      exitCode: 0,
    });

    const getResponse = await fetch(endpoint, {
      headers: {
        authorization: "Bearer integration-secret-0123456789abcdef",
        accept: "text/event-stream",
      },
    });
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");

    const healthResponse = await fetch(new URL("/health", endpoint));
    expect(await healthResponse.json()).toMatchObject({
      status: "ok",
      transportMode: "stateless-json",
      activeMcpSessions: 0,
      activeMcpRequests: 0,
    });
  });
});
