import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

async function healthFor(mode: "safe" | "unrestricted") {
  const config = loadConfig({
    MCP_ALLOW_NO_AUTH: "true",
    MCP_HOST: "127.0.0.1",
    MCP_DEFAULT_CWD: process.cwd(),
    MCP_SAFETY_MODE: mode,
  }, process.cwd());
  config.port = 0;
  const running = await startHttpServer(config, createServices(config));
  try {
    const address = running.httpServer.address() as AddressInfo;
    return await (await fetch(`http://127.0.0.1:${address.port}/health`)).json() as Record<string, unknown>;
  } finally {
    await running.close();
  }
}

describe("health safety status", () => {
  it("reports safe mode without claiming unrestricted host access", async () => {
    expect(await healthFor("safe")).toMatchObject({ safetyMode: "safe", unrestrictedHostAccess: false });
  });

  it("reports unrestricted mode accurately", async () => {
    expect(await healthFor("unrestricted")).toMatchObject({ safetyMode: "unrestricted", unrestrictedHostAccess: true });
  });
});
