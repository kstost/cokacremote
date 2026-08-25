import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";
import { RemoteDevOAuthProvider } from "../src/oauth.js";

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

describe("OAuth endpoint security boundaries", () => {
  it("does not trust spoofed forwarded IPs unless a proxy is explicitly configured", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cokacremote-auth-boundary-test-"),
    );
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = loadConfig(
      {
        MCP_OAUTH_ENABLED: "true",
        MCP_OAUTH_APPROVAL_KEY: "oauth-approval-key-0123456789abcdef",
        MCP_PUBLIC_URL: baseUrl,
        MCP_OAUTH_STATE_FILE: path.join(temporaryDirectory, "oauth-state.json"),
        MCP_HOST: "127.0.0.1",
        MCP_PORT: String(port),
        MCP_DEFAULT_CWD: temporaryDirectory,
      },
      temporaryDirectory,
    );
    const running = await startHttpServer(config, createServices(config));

    try {
      const approvalKeyAsBearer = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer oauth-approval-key-0123456789abcdef",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(approvalKeyAsBearer.status).toBe(401);

      const statuses: number[] = [];
      for (let index = 1; index <= 21; index += 1) {
        const response = await fetch(`${baseUrl}/register`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": `203.0.113.${index}`,
          },
          body: JSON.stringify({
            redirect_uris: ["https://chatgpt.com/connector/oauth/security-test"],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            client_name: `security-test-${index}`,
            scope: "mcp:tools",
          }),
        });
        statuses.push(response.status);
      }

      expect(statuses.slice(0, 20)).toEqual(Array(20).fill(201));
      expect(statuses[20]).toBe(429);
    } finally {
      await running.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rolls back failed state writes and revokes an entire token grant", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cokacremote-oauth-store-test-"),
    );
    const baseEnvironment = {
      MCP_OAUTH_ENABLED: "true",
      MCP_OAUTH_APPROVAL_KEY: "oauth-approval-key-0123456789abcdef",
      MCP_PUBLIC_URL: "http://127.0.0.1:34567",
    };
    const metadata = {
      client_id: "security-store-client",
      redirect_uris: ["https://chatgpt.com/connector/oauth/security-store-test"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "security store test",
      scope: "mcp:tools",
    };

    try {
      const blockedDirectory = path.join(temporaryDirectory, "blocked-state-directory");
      await mkdir(blockedDirectory);
      const failedProvider = new RemoteDevOAuthProvider(
        loadConfig(
          {
            ...baseEnvironment,
            MCP_OAUTH_STATE_FILE: path.join(blockedDirectory, "state.json"),
          },
          temporaryDirectory,
        ),
      );
      await expect(
        failedProvider.clientsStore.getClient(metadata.client_id),
      ).resolves.toBeUndefined();
      await rm(blockedDirectory, { recursive: true, force: true });
      await writeFile(blockedDirectory, "block state persistence");
      await expect(
        failedProvider.clientsStore.registerClient(
          metadata as Parameters<typeof failedProvider.clientsStore.registerClient>[0],
        ),
      ).rejects.toThrow();
      await expect(
        failedProvider.clientsStore.getClient(metadata.client_id),
      ).resolves.toBeUndefined();

      const stateFile = path.join(temporaryDirectory, "valid-state.json");
      const provider = new RemoteDevOAuthProvider(
        loadConfig(
          { ...baseEnvironment, MCP_OAUTH_STATE_FILE: stateFile },
          temporaryDirectory,
        ),
      );
      const client = await provider.clientsStore.registerClient(
        metadata as Parameters<typeof provider.clientsStore.registerClient>[0],
      );
      const resource = "http://127.0.0.1:34567/mcp";
      const pair = await provider.clientsStore.issueTokenPair(
        client.client_id,
        ["mcp:tools"],
        resource,
      );
      expect(pair.refresh_token).toBeTypeOf("string");

      await provider.clientsStore.revoke(pair.refresh_token!, client.client_id);

      await expect(
        provider.clientsStore.getAccessToken(pair.access_token),
      ).resolves.toBeUndefined();
      await expect(
        provider.clientsStore.rotateRefreshToken(
          pair.refresh_token!,
          client.client_id,
          resource,
          undefined,
        ),
      ).resolves.toMatchObject({ status: "invalid" });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects OAuth state files that are exposed or redirected by a symlink", async () => {
    if (process.platform === "win32") {
      return;
    }
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cokacremote-oauth-state-security-test-"),
    );
    const state = JSON.stringify({ version: 1, clients: {}, tokens: {} });
    const baseEnvironment = {
      MCP_OAUTH_ENABLED: "true",
      MCP_OAUTH_APPROVAL_KEY: "oauth-approval-key-0123456789abcdef",
      MCP_PUBLIC_URL: "http://127.0.0.1:34567",
    };

    try {
      const permissiveStateFile = path.join(temporaryDirectory, "permissive.json");
      await writeFile(permissiveStateFile, state, { mode: 0o600 });
      await chmod(permissiveStateFile, 0o644);
      const permissiveProvider = new RemoteDevOAuthProvider(
        loadConfig(
          { ...baseEnvironment, MCP_OAUTH_STATE_FILE: permissiveStateFile },
          temporaryDirectory,
        ),
      );
      await expect(permissiveProvider.clientsStore.getClient("missing")).rejects.toThrow(
        "permissions must not grant group or other access",
      );

      const targetFile = path.join(temporaryDirectory, "target.json");
      const linkedStateFile = path.join(temporaryDirectory, "linked.json");
      await writeFile(targetFile, state, { mode: 0o600 });
      await symlink(targetFile, linkedStateFile);
      const linkedProvider = new RemoteDevOAuthProvider(
        loadConfig(
          { ...baseEnvironment, MCP_OAUTH_STATE_FILE: linkedStateFile },
          temporaryDirectory,
        ),
      );
      await expect(linkedProvider.clientsStore.getClient("missing")).rejects.toThrow(
        "must not be a symbolic link",
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
