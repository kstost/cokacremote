import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const AUTH_SECRET = "test-auth-secret-0123456789abcdef";
const OAUTH_SECRET = "test-oauth-secret-0123456789abcdef";

describe("loadConfig", () => {
  it("requires authentication unless explicitly disabled", () => {
    expect(() => loadConfig({}, "/tmp")).toThrow("MCP_AUTH_TOKEN is required");
    expect(loadConfig({ MCP_ALLOW_NO_AUTH: "true" }, "/tmp").allowNoAuth).toBe(true);
  });

  it("rejects weak and example authentication secrets", () => {
    expect(() => loadConfig({ MCP_AUTH_TOKEN: "short-secret" }, "/tmp")).toThrow(
      "MCP_AUTH_TOKEN must be at least 32 characters",
    );
    expect(() =>
      loadConfig({ MCP_AUTH_TOKEN: "replace-with-a-long-random-token" }, "/tmp"),
    ).toThrow("must not be an example placeholder");
    expect(() =>
      loadConfig(
        {
          MCP_OAUTH_ENABLED: "true",
          MCP_OAUTH_APPROVAL_KEY: "short-oauth-secret",
          MCP_PUBLIC_URL: "https://mcp.example.com",
        },
        "/tmp",
      ),
    ).toThrow("MCP_OAUTH_APPROVAL_KEY must be at least 32 characters");
  });

  it("loads full-access host settings", () => {
    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: AUTH_SECRET,
        MCP_PORT: "4321",
        MCP_DEFAULT_CWD: "/",
        MCP_ALLOWED_HOSTS: "mcp.example.com,localhost",
      },
      "/tmp",
    );

    expect(config).toMatchObject({
      port: 4321,
      defaultCwd: "/",
      trustProxyHops: 0,
      authToken: AUTH_SECRET,
      allowedHosts: ["mcp.example.com", "localhost"],
    });
  });

  it("rejects partial integers and ports outside the valid range", () => {
    for (const value of ["3000oops", "3000.9", "70000"]) {
      expect(() =>
        loadConfig({ MCP_AUTH_TOKEN: AUTH_SECRET, MCP_PORT: value }, "/tmp"),
      ).toThrow("MCP_PORT must be an integer between 1 and 65535");
    }
    expect(
      loadConfig({ MCP_AUTH_TOKEN: AUTH_SECRET, MCP_PORT: " 4321 " }, "/tmp").port,
    ).toBe(4321);
  });

  it("requires public HTTPS metadata when OAuth is enabled", () => {
    expect(() =>
      loadConfig({ MCP_AUTH_TOKEN: AUTH_SECRET, MCP_OAUTH_ENABLED: "true" }, "/tmp"),
    ).toThrow("MCP_OAUTH_ISSUER is required");

    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: AUTH_SECRET,
        MCP_OAUTH_ENABLED: "true",
        MCP_PUBLIC_URL: "https://mcp.example.com",
        MCP_OAUTH_STATE_FILE: "/tmp/oauth-state.json",
      },
      "/tmp",
    );
    expect(config).toMatchObject({
      oauthEnabled: true,
      oauthApprovalKey: AUTH_SECRET,
      oauthIssuerUrl: "https://mcp.example.com/",
      oauthResourceUrl: "https://mcp.example.com/mcp",
      oauthStateFile: "/tmp/oauth-state.json",
    });
  });

  it("supports OAuth-only authentication with a separate approval key", () => {
    const config = loadConfig(
      {
        MCP_OAUTH_ENABLED: "true",
        MCP_OAUTH_APPROVAL_KEY: OAUTH_SECRET,
        MCP_PUBLIC_URL: "https://mcp.example.com",
        MCP_TRUST_PROXY_HOPS: "1",
      },
      "/tmp",
    );

    expect(config).toMatchObject({
      authToken: undefined,
      oauthApprovalKey: OAUTH_SECRET,
      trustProxyHops: 1,
    });
    expect(() =>
      loadConfig(
        {
          MCP_OAUTH_ENABLED: "true",
          MCP_PUBLIC_URL: "https://mcp.example.com",
        },
        "/tmp",
      ),
    ).toThrow("MCP_OAUTH_APPROVAL_KEY");
  });

  it("rejects unsafe proxy trust and OAuth URL settings", () => {
    expect(() =>
      loadConfig({ MCP_AUTH_TOKEN: AUTH_SECRET, MCP_TRUST_PROXY_HOPS: "17" }, "/tmp"),
    ).toThrow("MCP_TRUST_PROXY_HOPS must be an integer between 0 and 16");
    expect(() =>
      loadConfig(
        {
          MCP_AUTH_TOKEN: AUTH_SECRET,
          MCP_OAUTH_ENABLED: "true",
          MCP_OAUTH_ISSUER: "https://user:password@mcp.example.com",
          MCP_OAUTH_RESOURCE: "https://mcp.example.com/mcp",
        },
        "/tmp",
      ),
    ).toThrow("must not contain user credentials");
  });

  it("validates optional dashboard account settings", () => {
    const config = loadConfig({
      MCP_AUTH_TOKEN: AUTH_SECRET,
      MCP_DASHBOARD_USERNAME: "admin",
      MCP_DASHBOARD_PASSWORD: "correct-horse-battery-staple",
    }, "/tmp");
    expect(config).toMatchObject({
      dashboardUsername: "admin",
      dashboardPassword: "correct-horse-battery-staple",
      dashboardSessionSecret: AUTH_SECRET,
    });
    expect(() => loadConfig({ MCP_AUTH_TOKEN: AUTH_SECRET, MCP_DASHBOARD_USERNAME: "admin" }, "/tmp")).toThrow("configured together");
    expect(() => loadConfig({ MCP_AUTH_TOKEN: AUTH_SECRET, MCP_DASHBOARD_USERNAME: "admin", MCP_DASHBOARD_PASSWORD: "short" }, "/tmp")).toThrow("at least 12 characters");
    expect(() => loadConfig({ MCP_AUTH_TOKEN: AUTH_SECRET, MCP_DASHBOARD_USERNAME: "admin", MCP_DASHBOARD_PASSWORD: "replace-with-dashboard-password" }, "/tmp")).toThrow("example placeholder");
  });
});

describe("lifecycle configuration", () => {
  it("loads lifecycle defaults and explicit overrides", () => {
    const defaults = loadConfig({ MCP_AUTH_TOKEN: "x".repeat(32) }, "/tmp");
    expect(defaults.processIdleTimeoutMs).toBe(30 * 60 * 1000);
    expect(defaults.processMaxRuntimeMs).toBe(4 * 60 * 60 * 1000);
    expect(defaults.taskJournalFile).toBeUndefined();

    const configured = loadConfig(
      {
        MCP_AUTH_TOKEN: "x".repeat(32),
        MCP_PROCESS_IDLE_TIMEOUT_MS: "1000",
        MCP_PROCESS_MAX_RUNTIME_MS: "2000",
        MCP_TASK_JOURNAL_FILE: "journal.jsonl",
      },
      "/tmp",
    );
    expect(configured.processIdleTimeoutMs).toBe(1000);
    expect(configured.processMaxRuntimeMs).toBe(2000);
    expect(configured.taskJournalFile).toBe("/tmp/journal.jsonl");
  });
});

describe("safety configuration", () => {
  it("defaults to unrestricted and accepts safe mode", () => {
    expect(loadConfig({ MCP_AUTH_TOKEN: AUTH_SECRET }, "/tmp").safetyMode).toBe("unrestricted");
    expect(loadConfig({ MCP_AUTH_TOKEN: AUTH_SECRET, MCP_SAFETY_MODE: "safe" }, "/tmp").safetyMode).toBe("safe");
    expect(loadConfig({ MCP_AUTH_TOKEN: AUTH_SECRET, MCP_SAFETY_POLICY_FILE: "policy.json" }, "/tmp/base").safetyPolicyFile).toBe("/tmp/base/policy.json");
    expect(() => loadConfig({ MCP_AUTH_TOKEN: AUTH_SECRET, MCP_SAFETY_MODE: "maybe" }, "/tmp")).toThrow("MCP_SAFETY_MODE");
  });
});
