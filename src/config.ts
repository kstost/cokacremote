import path from "node:path";

const MIN_AUTH_SECRET_CHARACTERS = 32;
const PLACEHOLDER_SECRET_PREFIX = "replace-with-";

export interface AppConfig {
  host: string;
  port: number;
  endpoint: string;
  publicUrl: string | undefined;
  allowedHosts: string[] | undefined;
  trustProxyHops: number;
  authToken: string | undefined;
  allowNoAuth: boolean;
  oauthEnabled: boolean;
  oauthApprovalKey: string | undefined;
  oauthIssuerUrl: string | undefined;
  oauthResourceUrl: string | undefined;
  oauthStateFile: string;
  oauthAccessTokenTtlSeconds: number;
  oauthRefreshTokenTtlSeconds: number;
  oauthAuthorizationCodeTtlSeconds: number;
  defaultCwd: string;
  defaultShell: string;
  maxRequestBody: string;
  maxOutputBytes: number;
  maxRetainedProcessOutputBytes: number;
  processRetentionMs: number;
  processIdleTimeoutMs: number;
  processMaxRuntimeMs: number;
  taskJournalFile: string | undefined;
  maxProcesses: number;
  maxFileChunkBytes: number;
  maxEditFileBytes: number;
  safetyMode: "unrestricted" | "safe";
  safetyPolicyFile: string | undefined;
  dashboardUsername: string | undefined;
  dashboardPassword: string | undefined;
  dashboardSessionSecret: string | undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const normalized = value.trim();
  const parsed = /^[+-]?\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    const range = maximum === Number.MAX_SAFE_INTEGER
      ? `greater than or equal to ${minimum}`
      : `between ${minimum} and ${maximum}`;
    throw new Error(`${name} must be an integer ${range}`);
  }
  return parsed;
}

function parseSafetyMode(value: string | undefined): "unrestricted" | "safe" {
  const mode = value?.trim().toLowerCase() || "unrestricted";
  if (mode !== "unrestricted" && mode !== "safe") {
    throw new Error("MCP_SAFETY_MODE must be 'unrestricted' or 'safe'");
  }
  return mode;
}

function validateAuthSecret(value: string | undefined, name: string): void {
  if (value === undefined) {
    return;
  }
  if (
    value.length < MIN_AUTH_SECRET_CHARACTERS ||
    value.toLowerCase().startsWith(PLACEHOLDER_SECRET_PREFIX)
  ) {
    throw new Error(
      `${name} must be at least ${MIN_AUTH_SECRET_CHARACTERS} characters and must not be an example placeholder; generate one with 'openssl rand -hex 32'`,
    );
  }
}

function normalizeEndpoint(value: string | undefined): string {
  const endpoint = value?.trim() || "/mcp";
  if (!endpoint.startsWith("/")) {
    throw new Error("MCP_ENDPOINT must start with '/'");
  }
  return endpoint.length > 1 ? endpoint.replace(/\/+$/, "") : endpoint;
}

function normalizeOAuthUrl(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required when MCP_OAUTH_ENABLED=true`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error(`${name} must use HTTPS (HTTP is allowed only for loopback tests)`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not contain user credentials`);
  }
  if (url.search || url.hash) {
    throw new Error(`${name} must not contain a query string or fragment`);
  }
  return url.href;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  processCwd = process.cwd(),
): AppConfig {
  const allowNoAuth = parseBoolean(env.MCP_ALLOW_NO_AUTH, false);
  const authToken = env.MCP_AUTH_TOKEN?.trim() || undefined;
  const oauthEnabled = parseBoolean(env.MCP_OAUTH_ENABLED, false);
  const oauthApprovalKey = oauthEnabled
    ? env.MCP_OAUTH_APPROVAL_KEY?.trim() || authToken
    : undefined;
  validateAuthSecret(authToken, "MCP_AUTH_TOKEN");
  validateAuthSecret(oauthApprovalKey, "MCP_OAUTH_APPROVAL_KEY");
  if (!allowNoAuth && !authToken && !oauthEnabled) {
    throw new Error(
      "MCP_AUTH_TOKEN is required. Set MCP_ALLOW_NO_AUTH=true only when an upstream OAuth gateway or private network authenticates callers.",
    );
  }
  if (oauthEnabled && !oauthApprovalKey) {
    throw new Error(
      "MCP_OAUTH_APPROVAL_KEY (or MCP_AUTH_TOKEN for backward compatibility) is required when OAuth is enabled",
    );
  }
  const dashboardUsername = env.MCP_DASHBOARD_USERNAME?.trim() || undefined;
  const dashboardPassword = env.MCP_DASHBOARD_PASSWORD || undefined;
  if (Boolean(dashboardUsername) !== Boolean(dashboardPassword)) {
    throw new Error("MCP_DASHBOARD_USERNAME and MCP_DASHBOARD_PASSWORD must be configured together");
  }
  if (dashboardPassword && (dashboardPassword.length < 12 || dashboardPassword.toLowerCase().startsWith(PLACEHOLDER_SECRET_PREFIX))) {
    throw new Error("MCP_DASHBOARD_PASSWORD must be at least 12 characters and must not be an example placeholder");
  }
  const dashboardSessionSecret = env.MCP_DASHBOARD_SESSION_SECRET?.trim() || authToken || oauthApprovalKey || dashboardPassword;
  if (dashboardUsername && (!dashboardSessionSecret || dashboardSessionSecret.length < 32)) {
    throw new Error("MCP_DASHBOARD_SESSION_SECRET must be at least 32 characters when no 32+ character MCP auth secret is available");
  }

  const defaultCwd = path.resolve(env.MCP_DEFAULT_CWD?.trim() || processCwd);
  const allowedHosts = env.MCP_ALLOWED_HOSTS?.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  const endpoint = normalizeEndpoint(env.MCP_ENDPOINT);
  const publicUrl = env.MCP_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined;
  const oauthIssuerUrl = oauthEnabled
    ? normalizeOAuthUrl(env.MCP_OAUTH_ISSUER?.trim() || publicUrl, "MCP_OAUTH_ISSUER")
    : undefined;
  const oauthResourceUrl = oauthEnabled
    ? normalizeOAuthUrl(
        env.MCP_OAUTH_RESOURCE?.trim() || (publicUrl ? `${publicUrl}${endpoint}` : undefined),
        "MCP_OAUTH_RESOURCE",
      )
    : undefined;

  return {
    host: env.MCP_HOST?.trim() || "0.0.0.0",
    port: parseInteger(env.MCP_PORT, 3000, "MCP_PORT", 1, 65_535),
    endpoint,
    publicUrl,
    allowedHosts: allowedHosts && allowedHosts.length > 0 ? allowedHosts : undefined,
    trustProxyHops: parseInteger(
      env.MCP_TRUST_PROXY_HOPS,
      0,
      "MCP_TRUST_PROXY_HOPS",
      0,
      16,
    ),
    authToken,
    allowNoAuth,
    oauthEnabled,
    oauthApprovalKey,
    oauthIssuerUrl,
    oauthResourceUrl,
    oauthStateFile: path.resolve(
      env.MCP_OAUTH_STATE_FILE?.trim() ||
        path.join(processCwd, ".remote-dev-mcp-oauth-state.json"),
    ),
    oauthAccessTokenTtlSeconds: parseInteger(
      env.MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      60 * 60,
      "MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
      300,
    ),
    oauthRefreshTokenTtlSeconds: parseInteger(
      env.MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      30 * 24 * 60 * 60,
      "MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
      3600,
    ),
    oauthAuthorizationCodeTtlSeconds: parseInteger(
      env.MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS,
      5 * 60,
      "MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS",
      60,
    ),
    defaultCwd,
    defaultShell:
      env.MCP_DEFAULT_SHELL?.trim() || env.SHELL?.trim() || "/bin/bash",
    maxRequestBody: env.MCP_MAX_REQUEST_BODY?.trim() || "8mb",
    maxOutputBytes: parseInteger(
      env.MCP_MAX_OUTPUT_BYTES,
      1024 * 1024,
      "MCP_MAX_OUTPUT_BYTES",
      16 * 1024,
    ),
    maxRetainedProcessOutputBytes: parseInteger(
      env.MCP_MAX_RETAINED_PROCESS_OUTPUT_BYTES,
      4 * 1024 * 1024,
      "MCP_MAX_RETAINED_PROCESS_OUTPUT_BYTES",
      64 * 1024,
    ),
    processRetentionMs: parseInteger(
      env.MCP_PROCESS_RETENTION_MS,
      60 * 60 * 1000,
      "MCP_PROCESS_RETENTION_MS",
      1000,
    ),
    processIdleTimeoutMs: parseInteger(
      env.MCP_PROCESS_IDLE_TIMEOUT_MS,
      30 * 60 * 1000,
      "MCP_PROCESS_IDLE_TIMEOUT_MS",
      0,
    ),
    processMaxRuntimeMs: parseInteger(
      env.MCP_PROCESS_MAX_RUNTIME_MS,
      4 * 60 * 60 * 1000,
      "MCP_PROCESS_MAX_RUNTIME_MS",
      0,
    ),
    taskJournalFile: env.MCP_TASK_JOURNAL_FILE?.trim()
      ? path.resolve(processCwd, env.MCP_TASK_JOURNAL_FILE.trim())
      : undefined,
    maxProcesses: parseInteger(
      env.MCP_MAX_PROCESSES,
      128,
      "MCP_MAX_PROCESSES",
      1,
    ),
    maxFileChunkBytes: parseInteger(
      env.MCP_MAX_FILE_CHUNK_BYTES,
      1024 * 1024,
      "MCP_MAX_FILE_CHUNK_BYTES",
      4096,
    ),
    safetyMode: parseSafetyMode(env.MCP_SAFETY_MODE),
    safetyPolicyFile: env.MCP_SAFETY_POLICY_FILE?.trim() ? path.resolve(processCwd, env.MCP_SAFETY_POLICY_FILE.trim()) : undefined,
    dashboardUsername,
    dashboardPassword,
    dashboardSessionSecret,
    maxEditFileBytes: parseInteger(
      env.MCP_MAX_EDIT_FILE_BYTES,
      64 * 1024 * 1024,
      "MCP_MAX_EDIT_FILE_BYTES",
      4096,
    ),
  };
}
