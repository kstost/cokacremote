import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createMcpServer, createServices } from "../src/mcp-server.js";

async function withClient<T>(
  env: NodeJS.ProcessEnv,
  operation: (client: Client) => Promise<T> | T,
): Promise<T> {
  const config = loadConfig(env, "/tmp");
  const server = createMcpServer(config, createServices(config));
  const client = new Client({ name: "tool-metadata-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await operation(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function listTools(env: NodeJS.ProcessEnv) {
  return withClient(env, async (client) => (await client.listTools()).tools);
}

describe("tool authentication metadata", () => {
  it("advertises the OAuth scope on every tool when OAuth is enabled", async () => {
    const tools = await listTools({
      MCP_OAUTH_ENABLED: "true",
      MCP_OAUTH_APPROVAL_KEY: "approval-key",
      MCP_PUBLIC_URL: "https://mcp.example.com",
      MCP_OAUTH_ISSUER: "https://mcp.example.com",
      MCP_OAUTH_RESOURCE: "https://mcp.example.com/mcp",
    });

    expect(tools).toHaveLength(20);
    for (const tool of tools) {
      expect(tool._meta, tool.name).toEqual({
        securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }],
      });
    }
  });

  it("does not infer noauth from the internal authentication bypass", async () => {
    const tools = await listTools({ MCP_ALLOW_NO_AUTH: "true" });

    expect(tools).toHaveLength(20);
    for (const tool of tools) {
      expect(tool._meta, tool.name).toBeUndefined();
    }
  });

  it("does not mislabel static bearer authentication as noauth or OAuth", async () => {
    const tools = await listTools({ MCP_AUTH_TOKEN: "static-secret" });

    expect(tools).toHaveLength(20);
    for (const tool of tools) {
      expect(tool._meta, tool.name).toBeUndefined();
    }
  });
});

describe("client-facing metadata accuracy", () => {
  it("does not mislabel the MCP service origin as an implementation website", async () => {
    const serverInfo = await withClient(
      {
        MCP_AUTH_TOKEN: "static-secret",
        MCP_PUBLIC_URL: "https://mcp.example.com",
      },
      (client) => client.getServerVersion(),
    );

    expect(serverInfo).toMatchObject({ name: "cokacremote", version: "0.1.0" });
    expect(serverInfo?.websiteUrl).not.toBe("https://mcp.example.com");
  });

  it("describes every tool and every input field", async () => {
    const tools = await listTools({ MCP_AUTH_TOKEN: "static-secret" });

    expect(tools).toHaveLength(20);
    for (const tool of tools) {
      expect(tool.title?.trim().length, tool.name).toBeGreaterThan(0);
      expect(tool.description?.trim().length, tool.name).toBeGreaterThan(0);
      for (const [fieldName, schema] of Object.entries(
        tool.inputSchema.properties ?? {},
      )) {
        const description = (schema as { description?: unknown }).description;
        expect(
          typeof description === "string" ? description.trim().length : 0,
          `${tool.name}.${fieldName}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("describes process timing, session, polling, and escalation semantics exactly", async () => {
    const tools = await listTools({ MCP_AUTH_TOKEN: "static-secret" });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const execCommand = byName.get("exec_command")!;
    const runScript = byName.get("run_script")!;
    const writeStdin = byName.get("write_stdin")!;
    const terminateProcess = byName.get("terminate_process")!;

    expect(execCommand.description).toContain("always returns a process session ID");
    expect(writeStdin.description).toContain("greater than afterSeq");
    expect(terminateProcess.description).toContain("SIGINT and SIGTERM");

    for (const tool of [execCommand, runScript]) {
      const properties = tool.inputSchema.properties as Record<
        string,
        { description?: string }
      >;
      expect(properties.timeoutMs?.description).toContain("sending SIGTERM");
      expect(properties.timeoutMs?.description).toContain("sent SIGKILL");
      expect(properties.timeoutMs?.description).not.toContain("Maximum runtime");
      expect(properties.yieldTimeMs?.description).toContain("wait for");
      expect(properties.yieldTimeMs?.description).toContain("to exit");
    }
  });
});
