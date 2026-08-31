import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type { AppConfig } from "./config.js";

const COOKIE_NAME = "cokacremote_dashboard";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAX_FAILED_ATTEMPTS = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

interface FailureState { count: number; resetAt: number }

function equal(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch { result[key] = value; }
  }
  return result;
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function sessionToken(config: AppConfig, username: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ u: username, e: expiresAt }), "utf8").toString("base64url");
  return `${payload}.${sign(config.dashboardSessionSecret!, payload)}`;
}

function validSession(config: AppConfig, token: string | undefined): boolean {
  if (!token || !config.dashboardUsername || !config.dashboardSessionSecret) return false;
  const split = token.lastIndexOf(".");
  if (split <= 0) return false;
  const payload = token.slice(0, split);
  const signature = token.slice(split + 1);
  if (!equal(signature, sign(config.dashboardSessionSecret, payload))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: unknown; e?: unknown };
    return parsed.u === config.dashboardUsername && typeof parsed.e === "number" && parsed.e > Date.now();
  } catch { return false; }
}

function cookieSecure(config: AppConfig): boolean {
  return Boolean(config.publicUrl?.startsWith("https://"));
}

export function dashboardCookie(config: AppConfig): string {
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const token = sessionToken(config, config.dashboardUsername!, expiresAt);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${cookieSecure(config) ? "; Secure" : ""}`;
}

export function clearDashboardCookie(config: AppConfig): string {
  return `${COOKIE_NAME}=; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecure(config) ? "; Secure" : ""}`;
}

export function hasDashboardSession(config: AppConfig, request: Request): boolean {
  return validSession(config, parseCookies(request.header("cookie"))[COOKIE_NAME]);
}

export function createDashboardAuth(config: AppConfig, bearerAuth: RequestHandler): RequestHandler {
  return (request, response, next) => {
    if (config.dashboardUsername && config.dashboardPassword && hasDashboardSession(config, request)) {
      next();
      return;
    }
    bearerAuth(request, response, next);
  };
}

export function createDashboardLoginLimiter() {
  const failures = new Map<string, FailureState>();
  const keyFor = (request: Request) => request.ip || request.socket.remoteAddress || "unknown";
  return {
    blocked(request: Request): boolean {
      const key = keyFor(request);
      const current = failures.get(key);
      if (!current) return false;
      if (current.resetAt <= Date.now()) { failures.delete(key); return false; }
      return current.count >= MAX_FAILED_ATTEMPTS;
    },
    fail(request: Request): void {
      const key = keyFor(request);
      const now = Date.now();
      const current = failures.get(key);
      if (!current || current.resetAt <= now) failures.set(key, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
      else current.count += 1;
    },
    success(request: Request): void { failures.delete(keyFor(request)); },
  };
}

export function verifyDashboardCredentials(config: AppConfig, username: string, password: string): boolean {
  return Boolean(
    config.dashboardUsername && config.dashboardPassword &&
    equal(username, config.dashboardUsername) && equal(password, config.dashboardPassword),
  );
}

export function redirectToDashboardLogin(response: Response): void {
  response.redirect(302, "/dashboard/login");
}
