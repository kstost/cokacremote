import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Request, Response } from "express";

import { tokensEqual } from "./auth.js";
import type { AppConfig } from "./config.js";

export const OAUTH_SCOPES = ["mcp:tools"] as const;

interface StoredToken {
  type: "access" | "refresh" | "used_refresh";
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource: string;
  grantId?: string;
}

interface PersistedOAuthState {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  tokens: Record<string, StoredToken>;
}

interface AuthorizationCodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
}

type RefreshResult =
  | { status: "invalid" }
  | { status: "invalid_scope" }
  | { status: "ok"; tokens: OAuthTokens };

function emptyState(): PersistedOAuthState {
  return { version: 1, clients: {}, tokens: {} };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

const LOOPBACK_REDIRECT_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SUPPORTED_CLIENT_AUTH_METHODS = new Set(["none", "client_secret_post"]);
const SUPPORTED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);

function clientMetadataProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Client metadata must be an object";
  }
  const client = value as Partial<OAuthClientInformationFull>;
  if (!Array.isArray(client.redirect_uris) || client.redirect_uris.length === 0) {
    return "At least one redirect_uri is required";
  }
  for (const redirectUri of client.redirect_uris) {
    if (typeof redirectUri !== "string") {
      return "Every redirect_uri must be an absolute URL";
    }
    let parsed: URL;
    try {
      parsed = new URL(redirectUri);
    } catch {
      return "Every redirect_uri must be an absolute URL";
    }
    const isLoopback = LOOPBACK_REDIRECT_HOSTS.has(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
      return "Every redirect_uri must use HTTPS or HTTP on a loopback host";
    }
    if (parsed.hash || parsed.username || parsed.password) {
      return "redirect_uris must not contain fragments or user credentials";
    }
  }

  if (
    client.token_endpoint_auth_method !== undefined &&
    typeof client.token_endpoint_auth_method !== "string"
  ) {
    return "token_endpoint_auth_method must be a string";
  }
  const authMethod = client.token_endpoint_auth_method ?? "client_secret_post";
  if (!SUPPORTED_CLIENT_AUTH_METHODS.has(authMethod)) {
    return `Unsupported token_endpoint_auth_method: ${authMethod}`;
  }

  if (
    client.grant_types !== undefined &&
    (!Array.isArray(client.grant_types) ||
      !client.grant_types.every((grantType) => typeof grantType === "string"))
  ) {
    return "grant_types must be an array of strings";
  }
  const grantTypes = client.grant_types ?? ["authorization_code"];
  if (
    grantTypes.length === 0 ||
    !grantTypes.includes("authorization_code") ||
    !grantTypes.every((grantType) => SUPPORTED_GRANT_TYPES.has(grantType))
  ) {
    return "grant_types must contain authorization_code and may contain refresh_token";
  }

  if (
    client.response_types !== undefined &&
    (!Array.isArray(client.response_types) ||
      !client.response_types.every((responseType) => typeof responseType === "string"))
  ) {
    return "response_types must be an array of strings";
  }
  const responseTypes = client.response_types ?? ["code"];
  if (responseTypes.length !== 1 || responseTypes[0] !== "code") {
    return "Only the code response_type is supported";
  }

  if (client.scope !== undefined && typeof client.scope !== "string") {
    return "scope must be a string";
  }
  const scopes = client.scope?.split(/\s+/).filter(Boolean) ?? [];
  if (!scopes.every((scope) => OAUTH_SCOPES.includes(scope as (typeof OAUTH_SCOPES)[number]))) {
    return "Only the mcp:tools scope is supported";
  }
  return undefined;
}

function isStoredToken(value: unknown): value is StoredToken {
  if (!value || typeof value !== "object") {
    return false;
  }
  const token = value as Partial<StoredToken>;
  return (
    (token.type === "access" || token.type === "refresh" || token.type === "used_refresh") &&
    typeof token.clientId === "string" &&
    Array.isArray(token.scopes) &&
    token.scopes.every((scope) => typeof scope === "string") &&
    typeof token.expiresAt === "number" &&
    typeof token.resource === "string" &&
    (token.grantId === undefined || typeof token.grantId === "string") &&
    (token.type !== "used_refresh" || typeof token.grantId === "string")
  );
}

function parseState(value: string): PersistedOAuthState {
  const parsed = JSON.parse(value) as Partial<PersistedOAuthState>;
  if (
    parsed.version !== 1 ||
    !parsed.clients ||
    typeof parsed.clients !== "object" ||
    Array.isArray(parsed.clients) ||
    !parsed.tokens ||
    typeof parsed.tokens !== "object" ||
    Array.isArray(parsed.tokens) ||
    !Object.values(parsed.tokens).every(isStoredToken)
  ) {
    throw new Error("Invalid OAuth state file format");
  }
  return parsed as PersistedOAuthState;
}

class PersistentOAuthStore implements OAuthRegisteredClientsStore {
  private state = emptyState();
  private loadPromise: Promise<void> | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateFile: string,
    private readonly accessTokenTtlSeconds: number,
    private readonly refreshTokenTtlSeconds: number,
  ) {}

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= (async () => {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const noFollowFlag = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
        handle = await open(this.stateFile, constants.O_RDONLY | noFollowFlag);
        const info = await handle.stat();
        if (!info.isFile()) {
          throw new Error("OAuth state path must be a regular file");
        }
        if (typeof process.geteuid === "function" && info.uid !== process.geteuid()) {
          throw new Error("OAuth state file must be owned by the service user");
        }
        if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
          throw new Error("OAuth state file permissions must not grant group or other access");
        }
        this.state = parseState(await handle.readFile("utf8"));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return;
        }
        if (code === "ELOOP") {
          throw new Error("OAuth state file must not be a symbolic link", { cause: error });
        }
        throw error;
      } finally {
        await handle?.close();
      }
    })();
    await this.loadPromise;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [hash, token] of Object.entries(this.state.tokens)) {
      if (token.expiresAt <= now) {
        delete this.state.tokens[hash];
      }
    }
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.stateFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryFile = `${this.stateFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporaryFile, `${JSON.stringify(this.state, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryFile, this.stateFile);
    } catch (error) {
      await unlink(temporaryFile).catch(() => undefined);
      throw error;
    }
  }

  private async mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    await this.ensureLoaded();
    const pending = this.mutationQueue.then(async () => {
      const snapshot = structuredClone(this.state);
      try {
        this.pruneExpired();
        const result = await operation();
        await this.persist();
        return result;
      } catch (error) {
        this.state = snapshot;
        throw error;
      }
    });
    this.mutationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    await this.ensureLoaded();
    await this.mutationQueue;
    const client = this.state.clients[clientId];
    if (!client || client.client_id !== clientId || clientMetadataProblem(client)) {
      return undefined;
    }
    return client;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const supplied = client as Partial<OAuthClientInformationFull>;
    const registered: OAuthClientInformationFull = {
      ...client,
      token_endpoint_auth_method:
        client.token_endpoint_auth_method ?? "client_secret_post",
      grant_types: client.grant_types ?? ["authorization_code"],
      response_types: client.response_types ?? ["code"],
      client_id: supplied.client_id || randomUUID(),
      client_id_issued_at: supplied.client_id_issued_at || Math.floor(Date.now() / 1000),
    };
    const problem = clientMetadataProblem(registered);
    if (problem) {
      throw new InvalidClientMetadataError(problem);
    }
    return this.mutate(() => {
      this.state.clients[registered.client_id] = registered;
      return registered;
    });
  }

  async issueTokenPair(
    clientId: string,
    scopes: string[],
    resource: string,
    issueRefreshToken = true,
  ): Promise<OAuthTokens> {
    return this.mutate(() =>
      this.issueTokenPairWithoutPersist(
        clientId,
        scopes,
        resource,
        randomUUID(),
        issueRefreshToken,
      ),
    );
  }

  private issueTokenPairWithoutPersist(
    clientId: string,
    scopes: string[],
    resource: string,
    grantId: string,
    issueRefreshToken = true,
  ): OAuthTokens {
    const accessToken = randomToken();
    const now = Date.now();
    this.state.tokens[tokenHash(accessToken)] = {
      type: "access",
      clientId,
      scopes,
      expiresAt: now + this.accessTokenTtlSeconds * 1000,
      resource,
      grantId,
    };
    const tokens: OAuthTokens = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.accessTokenTtlSeconds,
      scope: scopes.join(" "),
    };
    if (issueRefreshToken) {
      const refreshToken = randomToken();
      this.state.tokens[tokenHash(refreshToken)] = {
        type: "refresh",
        clientId,
        scopes,
        expiresAt: now + this.refreshTokenTtlSeconds * 1000,
        resource,
        grantId,
      };
      tokens.refresh_token = refreshToken;
    }
    return tokens;
  }

  private revokeGrantWithoutPersist(grantId: string, preserveReplayEvidence = false): void {
    for (const [hash, token] of Object.entries(this.state.tokens)) {
      if (
        token.grantId === grantId &&
        !(preserveReplayEvidence && token.type === "used_refresh")
      ) {
        delete this.state.tokens[hash];
      }
    }
  }

  async rotateRefreshToken(
    refreshToken: string,
    clientId: string,
    resource: string,
    requestedScopes: string[] | undefined,
  ): Promise<RefreshResult> {
    return this.mutate(() => {
      const hash = tokenHash(refreshToken);
      const current = this.state.tokens[hash];
      if (
        !current ||
        current.clientId !== clientId ||
        current.resource !== resource ||
        current.expiresAt <= Date.now()
      ) {
        return { status: "invalid" };
      }
      if (current.type === "used_refresh") {
        this.revokeGrantWithoutPersist(current.grantId!, true);
        return { status: "invalid" };
      }
      if (current.type !== "refresh") {
        return { status: "invalid" };
      }
      const scopes = requestedScopes ?? current.scopes;
      if (!scopes.every((scope) => current.scopes.includes(scope))) {
        return { status: "invalid_scope" };
      }
      const grantId = current.grantId ?? randomUUID();
      this.state.tokens[hash] = { ...current, type: "used_refresh", grantId };
      return {
        status: "ok",
        tokens: this.issueTokenPairWithoutPersist(clientId, scopes, resource, grantId),
      };
    });
  }

  async getAccessToken(token: string): Promise<StoredToken | undefined> {
    await this.ensureLoaded();
    await this.mutationQueue;
    const stored = this.state.tokens[tokenHash(token)];
    if (!stored || stored.type !== "access" || stored.expiresAt <= Date.now()) {
      return undefined;
    }
    const client = this.state.clients[stored.clientId];
    if (!client || clientMetadataProblem(client)) {
      return undefined;
    }
    return stored;
  }

  async revoke(token: string, clientId: string): Promise<void> {
    await this.mutate(() => {
      const hash = tokenHash(token);
      const stored = this.state.tokens[hash];
      if (stored?.clientId === clientId) {
        if (stored.grantId) {
          this.revokeGrantWithoutPersist(stored.grantId);
        } else {
          delete this.state.tokens[hash];
        }
      }
    });
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hiddenInput(name: string, value: string | undefined): string {
  return value === undefined
    ? ""
    : `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function renderAuthorizationPage(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  invalidKey: boolean,
): string {
  const clientName = client.client_name || "MCP 클라이언트";
  let redirectHost = params.redirectUri;
  try {
    redirectHost = new URL(params.redirectUri).host;
  } catch {
    // The SDK already validates this URL before calling the provider.
  }
  const fields = [
    hiddenInput("client_id", client.client_id),
    hiddenInput("redirect_uri", params.redirectUri),
    hiddenInput("response_type", "code"),
    hiddenInput("code_challenge", params.codeChallenge),
    hiddenInput("code_challenge_method", "S256"),
    hiddenInput("scope", params.scopes?.join(" ")),
    hiddenInput("state", params.state),
    hiddenInput("resource", params.resource?.href),
  ].join("\n");

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>cokacremote 승인</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1020; color: #e8ecf5; }
    main { width: min(440px, calc(100vw - 40px)); padding: 28px; border: 1px solid #2a3550; border-radius: 16px; background: #121a2d; box-shadow: 0 20px 70px #0008; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    p { color: #b8c1d8; line-height: 1.55; }
    .warning { padding: 12px; border-radius: 10px; background: #3c2316; color: #ffd8bd; }
    .error { color: #ff9f9f; font-weight: 650; }
    label { display: block; margin: 20px 0 8px; font-weight: 650; }
    input[type=password] { box-sizing: border-box; width: 100%; padding: 12px; border: 1px solid #52617d; border-radius: 9px; background: #0b1020; color: white; font: inherit; }
    button { width: 100%; margin-top: 16px; padding: 12px; border: 0; border-radius: 9px; background: #5b8cff; color: white; font: inherit; font-weight: 700; cursor: pointer; }
    small { display: block; margin-top: 14px; color: #8390aa; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <h1>cokacremote 연결 승인</h1>
    <p><strong>${escapeHtml(clientName)}</strong>이 이 서버의 MCP 도구 사용 권한을 요청했습니다.</p>
    <p class="warning">승인하면 연결된 MCP 클라이언트가 이 서버에서 root 권한으로 명령을 실행하고 파일을 변경할 수 있습니다.</p>
    ${invalidKey ? '<p class="error">인증키가 올바르지 않습니다.</p>' : ""}
    <form method="post" action="/authorize" autocomplete="off">
      ${fields}
      <label for="access_key">MCP 인증키</label>
      <input id="access_key" name="access_key" type="password" required autofocus autocomplete="current-password">
      <button type="submit">승인하고 MCP 클라이언트로 돌아가기</button>
    </form>
    <small>콜백 대상: ${escapeHtml(redirectHost)} · 범위: ${escapeHtml(params.scopes?.join(" ") || OAUTH_SCOPES.join(" "))}</small>
  </main>
</body>
</html>`;
}

export class RemoteDevOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PersistentOAuthStore;
  readonly issuerUrl: URL;
  readonly resourceUrl: URL;
  private readonly authorizationCodes = new Map<string, AuthorizationCodeRecord>();

  constructor(private readonly config: AppConfig) {
    if (!config.oauthIssuerUrl || !config.oauthResourceUrl || !config.oauthApprovalKey) {
      throw new Error("OAuth configuration is incomplete");
    }
    this.issuerUrl = new URL(config.oauthIssuerUrl);
    this.resourceUrl = new URL(config.oauthResourceUrl);
    this.clientsStore = new PersistentOAuthStore(
      config.oauthStateFile,
      config.oauthAccessTokenTtlSeconds,
      config.oauthRefreshTokenTtlSeconds,
    );
  }

  private validateResource(resource: URL | undefined): string {
    if (!resource || resource.href !== this.resourceUrl.href) {
      throw new InvalidTargetError(`resource must be ${this.resourceUrl.href}`);
    }
    return resource.href;
  }

  private validateScopes(scopes: string[] | undefined): string[] {
    const requested = scopes && scopes.length > 0 ? [...new Set(scopes)] : [...OAUTH_SCOPES];
    if (!requested.every((scope) => OAUTH_SCOPES.includes(scope as (typeof OAUTH_SCOPES)[number]))) {
      throw new InvalidScopeError("Only the mcp:tools scope is supported");
    }
    return requested;
  }

  private pruneAuthorizationCodes(): void {
    const now = Date.now();
    for (const [code, record] of this.authorizationCodes) {
      if (record.expiresAt <= now) {
        this.authorizationCodes.delete(code);
      }
    }
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    response: Response,
  ): Promise<void> {
    if (!(client.grant_types ?? ["authorization_code"]).includes("authorization_code")) {
      throw new UnauthorizedClientError("Client is not authorized for authorization_code");
    }
    const resource = this.validateResource(params.resource);
    const scopes = this.validateScopes(params.scopes);
    const request = response.req as Request;
    const accessKey =
      request.method === "POST" && typeof request.body?.access_key === "string"
        ? request.body.access_key
        : undefined;

    const redirectOrigin = new URL(params.redirectUri).origin;
    response.set({
      "Content-Security-Policy":
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; base-uri 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });

    if (!accessKey || !tokensEqual(accessKey, this.config.oauthApprovalKey!)) {
      response
        .status(accessKey ? 401 : 200)
        .type("html")
        .send(renderAuthorizationPage(client, { ...params, scopes, resource: new URL(resource) }, Boolean(accessKey)));
      return;
    }

    this.pruneAuthorizationCodes();
    const code = randomToken();
    this.authorizationCodes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource,
      scopes,
      expiresAt: Date.now() + this.config.oauthAuthorizationCodeTtlSeconds * 1000,
    });

    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state !== undefined) {
      target.searchParams.set("state", params.state);
    }
    response.redirect(303, target.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    this.pruneAuthorizationCodes();
    const record = this.authorizationCodes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.pruneAuthorizationCodes();
    const record = this.authorizationCodes.get(authorizationCode);
    if (
      !record ||
      record.clientId !== client.client_id ||
      record.redirectUri !== redirectUri ||
      record.resource !== this.validateResource(resource)
    ) {
      throw new InvalidGrantError("Invalid authorization code binding");
    }
    this.authorizationCodes.delete(authorizationCode);
    try {
      return await this.clientsStore.issueTokenPair(
        client.client_id,
        record.scopes,
        record.resource,
        client.grant_types?.includes("refresh_token") ?? false,
      );
    } catch (error) {
      if (record.expiresAt > Date.now() && !this.authorizationCodes.has(authorizationCode)) {
        this.authorizationCodes.set(authorizationCode, record);
      }
      throw error;
    }
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (!client.grant_types?.includes("refresh_token")) {
      throw new UnauthorizedClientError("Client is not authorized for refresh_token");
    }
    const resourceValue = this.validateResource(resource);
    const requestedScopes = scopes ? this.validateScopes(scopes) : undefined;
    const result = await this.clientsStore.rotateRefreshToken(
      refreshToken,
      client.client_id,
      resourceValue,
      requestedScopes,
    );
    if (result.status === "invalid_scope") {
      throw new InvalidScopeError("Refresh scope exceeds the original grant");
    }
    if (result.status === "invalid") {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    return result.tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = await this.clientsStore.getAccessToken(token);
    if (!stored || stored.resource !== this.resourceUrl.href) {
      throw new InvalidGrantError("Invalid or expired access token");
    }
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: Math.floor(stored.expiresAt / 1000),
      resource: new URL(stored.resource),
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    await this.clientsStore.revoke(request.token, client.client_id);
  }
}
