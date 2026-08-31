import { readFileSync } from "node:fs";
import path from "node:path";
import type { SafetyDecision } from "./safety-policy.js";

export interface CommandPolicyRule {
  id: string;
  pattern: string;
  flags?: string;
  decision: SafetyDecision;
  reason?: string;
}

export interface PathPolicyRule {
  id: string;
  prefix: string;
  tools?: string[];
  decision: SafetyDecision;
  reason?: string;
}

export interface SafetyPolicyFile {
  version: 1;
  commands?: CommandPolicyRule[];
  paths?: PathPolicyRule[];
  defaults?: {
    unmatchedCommand?: SafetyDecision;
    outsideWorkspace?: SafetyDecision;
  };
}

const DECISIONS = new Set<SafetyDecision>(["allow", "approval-required", "deny"]);

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function decision(value: unknown, label: string): SafetyDecision {
  if (typeof value !== "string" || !DECISIONS.has(value as SafetyDecision)) {
    throw new Error(`${label} must be allow, approval-required, or deny`);
  }
  return value as SafetyDecision;
}

export function parseSafetyPolicyFile(value: unknown): SafetyPolicyFile {
  const root = asObject(value, "Safety policy");
  if (root.version !== 1) throw new Error("Safety policy version must be 1");

  const commands = root.commands === undefined ? undefined : (() => {
    if (!Array.isArray(root.commands)) throw new Error("Safety policy commands must be an array");
    return root.commands.map((raw, index) => {
      const item = asObject(raw, `commands[${index}]`);
      const pattern = requiredString(item.pattern, `commands[${index}].pattern`);
      const flags = item.flags === undefined ? "i" : requiredString(item.flags, `commands[${index}].flags`);
      try { new RegExp(pattern, flags); } catch (error) { throw new Error(`commands[${index}].pattern is invalid: ${String(error)}`); }
      return {
        id: requiredString(item.id, `commands[${index}].id`),
        pattern,
        flags,
        decision: decision(item.decision, `commands[${index}].decision`),
        ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
      };
    });
  })();

  const paths = root.paths === undefined ? undefined : (() => {
    if (!Array.isArray(root.paths)) throw new Error("Safety policy paths must be an array");
    return root.paths.map((raw, index) => {
      const item = asObject(raw, `paths[${index}]`);
      let tools: string[] | undefined;
      if (item.tools !== undefined) {
        if (!Array.isArray(item.tools) || item.tools.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
          throw new Error(`paths[${index}].tools must be an array of non-empty strings`);
        }
        tools = item.tools as string[];
      }
      return {
        id: requiredString(item.id, `paths[${index}].id`),
        prefix: requiredString(item.prefix, `paths[${index}].prefix`),
        ...(tools ? { tools } : {}),
        decision: decision(item.decision, `paths[${index}].decision`),
        ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
      };
    });
  })();

  let defaults: SafetyPolicyFile["defaults"];
  if (root.defaults !== undefined) {
    const raw = asObject(root.defaults, "Safety policy defaults");
    defaults = {
      ...(raw.unmatchedCommand !== undefined ? { unmatchedCommand: decision(raw.unmatchedCommand, "defaults.unmatchedCommand") } : {}),
      ...(raw.outsideWorkspace !== undefined ? { outsideWorkspace: decision(raw.outsideWorkspace, "defaults.outsideWorkspace") } : {}),
    };
  }

  return { version: 1, ...(commands ? { commands } : {}), ...(paths ? { paths } : {}), ...(defaults ? { defaults } : {}) };
}

export function loadSafetyPolicyFile(file: string | undefined): SafetyPolicyFile | undefined {
  if (!file) return undefined;
  const resolved = path.resolve(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`Failed to load safety policy file ${resolved}: ${String(error)}`);
  }
  return parseSafetyPolicyFile(parsed);
}
