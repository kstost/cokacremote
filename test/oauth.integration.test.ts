import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

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

function form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

describe("OAuth 2.1 MCP authorization", () => {
  let temporaryDirectory: string;
  let stateFile: string;
  let config: AppConfig;
  let running: RunningHttpServer;
  let baseUrl: string;
  let resourceUrl: string;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "remote-dev-mcp-oauth-test-"));
    const stateDirectory = path.join(temporaryDirectory, "oauth");
    await mkdir(stateDirectory, { mode: 0o755 });
    stateFile = path.join(stateDirectory, "state.json");
    const port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;
    resourceUrl = `${baseUrl}/mcp`;
    config = loadConfig(
      {
        MCP_OAUTH_ENABLED: "true",
        MCP_OAUTH_APPROVAL_KEY: "oauth-login-secret-0123456789abcdef",
        MCP_PUBLIC_URL: baseUrl,
        MCP_OAUTH_STATE_FILE: stateFile,
        MCP_HOST: "127.0.0.1",
        MCP_PORT: String(port),
        MCP_DEFAULT_CWD: temporaryDirectory,
      },
      temporaryDirectory,
    );
    running = await startHttpServer(config, createServices(config));
  });

  afterAll(async () => {
    await running.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("discovers, authorizes with PKCE, refreshes, revokes, and calls MCP tools", async () => {
    const unauthenticated = await fetch(resourceUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "oauth-test", version: "1" },
        },
      }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );

    for (const metadataPath of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await fetch(`${baseUrl}${metadataPath}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        resource: resourceUrl,
        authorization_servers: [`${baseUrl}/`],
        scopes_supported: ["mcp:tools"],
        resource_name: "cokacremote",
      });
    }

    const metadataResponse = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(metadataResponse.status).toBe(200);
    expect(await metadataResponse.json()).toMatchObject({
      issuer: `${baseUrl}/`,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: expect.arrayContaining(["none"]),
      revocation_endpoint_auth_methods_supported: expect.arrayContaining(["none"]),
    });

    const redirectUri = "https://chatgpt.com/connector/oauth/test-callback";
    for (const invalidMetadata of [
      {
        redirect_uris: ["http://attacker.example/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
      {
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "private_key_jwt",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
      {
        redirect_uris: [],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
    ]) {
      const invalidRegistration = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invalidMetadata),
      });
      expect(invalidRegistration.status).toBe(400);
      expect(await invalidRegistration.json()).toMatchObject({
        error: "invalid_client_metadata",
      });
    }

    const defaultedRegistration = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    });
    expect(defaultedRegistration.status).toBe(201);
    expect(await defaultedRegistration.json()).toMatchObject({
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      client_secret: expect.any(String),
    });

    const registrationResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "ChatGPT OAuth integration test",
        scope: "mcp:tools",
      }),
    });
    expect(registrationResponse.status).toBe(201);
    const registered = (await registrationResponse.json()) as { client_id: string };
    expect(registered.client_id).toBeTruthy();

    const codeVerifier = randomBytes(48).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const authorizationValues = {
      client_id: registered.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      scope: "mcp:tools",
      state: "oauth-test-state",
      resource: resourceUrl,
    };

    const loginPage = await fetch(`${baseUrl}/authorize?${form(authorizationValues)}`, {
      redirect: "manual",
    });
    expect(loginPage.status).toBe(200);
    expect(loginPage.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://chatgpt.com",
    );
    expect(await loginPage.text()).toContain("MCP 인증키");

    const rejectedLogin = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ ...authorizationValues, access_key: "wrong-key" }),
      redirect: "manual",
    });
    expect(rejectedLogin.status).toBe(401);

    const approvedLogin = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        ...authorizationValues,
        access_key: "oauth-login-secret-0123456789abcdef",
      }),
      redirect: "manual",
    });
    expect(approvedLogin.status).toBe(303);
    const callback = new URL(approvedLogin.headers.get("location")!);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("oauth-test-state");
    const authorizationCode = callback.searchParams.get("code");
    expect(authorizationCode).toBeTruthy();

    const tokenResponse = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "authorization_code",
        client_id: registered.client_id,
        code: authorizationCode!,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        resource: resourceUrl,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
    expect(tokens).toMatchObject({ expires_in: 3600, scope: "mcp:tools" });

    await running.close();
    running = await startHttpServer(config, createServices(config));

    const client = new Client({ name: "oauth-integration-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === "run_script")).toBe(true);
    } finally {
      await transport.terminateSession();
      await client.close();
    }

    const refreshResponse = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: registered.client_id,
        refresh_token: tokens.refresh_token,
        resource: resourceUrl,
      }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = (await refreshResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

    await running.close();
    running = await startHttpServer(config, createServices(config));

    const replayedRefresh = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: registered.client_id,
        refresh_token: tokens.refresh_token,
        resource: resourceUrl,
      }),
    });
    expect(replayedRefresh.status).toBe(400);
    expect(await replayedRefresh.json()).toMatchObject({ error: "invalid_grant" });

    const revokedSuccessor = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "refresh_token",
        client_id: registered.client_id,
        refresh_token: refreshed.refresh_token,
        resource: resourceUrl,
      }),
    });
    expect(revokedSuccessor.status).toBe(400);
    expect(await revokedSuccessor.json()).toMatchObject({ error: "invalid_grant" });

    const revokeResponse = await fetch(`${baseUrl}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ client_id: registered.client_id, token: refreshed.access_token }),
    });
    expect(revokeResponse.status).toBe(200);

    const revokedRequest = await fetch(resourceUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${refreshed.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }),
    });
    expect(revokedRequest.status).toBe(401);

    expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(stateFile))).mode & 0o777).toBe(0o755);
    const persisted = await readFile(stateFile, "utf8");
    expect(persisted).not.toContain(tokens.access_token);
    expect(persisted).not.toContain(tokens.refresh_token);
  });
});
