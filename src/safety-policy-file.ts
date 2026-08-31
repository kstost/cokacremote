import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
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
const PATH_TOOLS = new Set(["write_file", "replace_in_file", "apply_patch", "upload_file", "make_directory", "copy_path", "move_path", "remove_path", "chmod_path"]);

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
  for (const key of Object.keys(root)) if (!["version", "commands", "paths", "defaults"].includes(key)) throw new Error(`Safety policy contains unknown key: ${key}`);
  if (root.version !== 1) throw new Error("Safety policy version must be 1");

  const commands = root.commands === undefined ? undefined : (() => {
    if (!Array.isArray(root.commands)) throw new Error("Safety policy commands must be an array");
    return root.commands.map((raw, index) => {
      const item = asObject(raw, `commands[${index}]`);
      for (const key of Object.keys(item)) if (!["id", "pattern", "flags", "decision", "reason"].includes(key)) throw new Error(`commands[${index}] contains unknown key: ${key}`);
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
      for (const key of Object.keys(item)) if (!["id", "prefix", "tools", "decision", "reason"].includes(key)) throw new Error(`paths[${index}] contains unknown key: ${key}`);
      let tools: string[] | undefined;
      if (item.tools !== undefined) {
        if (!Array.isArray(item.tools) || item.tools.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
          throw new Error(`paths[${index}].tools must be an array of non-empty strings`);
        }
        tools = item.tools as string[];
        for (const tool of tools) if (!PATH_TOOLS.has(tool)) throw new Error(`paths[${index}].tools contains unknown mutating tool: ${tool}`);
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
    for (const key of Object.keys(raw)) if (!["unmatchedCommand", "outsideWorkspace"].includes(key)) throw new Error(`Safety policy defaults contains unknown key: ${key}`);
    defaults = {
      ...(raw.unmatchedCommand !== undefined ? { unmatchedCommand: decision(raw.unmatchedCommand, "defaults.unmatchedCommand") } : {}),
      ...(raw.outsideWorkspace !== undefined ? { outsideWorkspace: decision(raw.outsideWorkspace, "defaults.outsideWorkspace") } : {}),
    };
  }

  const ids = [...(commands ?? []).map((rule) => rule.id), ...(paths ?? []).map((rule) => rule.id)];
  if (new Set(ids).size !== ids.length) throw new Error("Safety policy rule IDs must be unique");
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

export async function saveSafetyPolicyFile(file: string, policy: SafetyPolicyFile): Promise<void> {
  const resolved = path.resolve(file);
  const validated = parseSafetyPolicyFile(policy);
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporary, resolved);
  } catch (error) {
    await import("node:fs/promises").then(({ rm }) => rm(temporary, { force: true })).catch(() => undefined);
    throw error;
  }
}
