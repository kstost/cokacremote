import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffSafetyPolicies, SafetyPolicyAudit } from "../src/safety-policy-audit.js";

describe("SafetyPolicyAudit", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("chains new revisions and detects entry tampering", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "cokacremote-audit-"));
    const policyFile = path.join(dir, "policy.json");
    const audit = new SafetyPolicyAudit(policyFile);
    await audit.record("save", { version: 1, defaults: { unmatchedCommand: "allow" } });
    await audit.record("reload", { version: 1, defaults: { unmatchedCommand: "deny" } });
    expect(await audit.verify()).toMatchObject({ integrity: true, chainedEntries: 2, legacyEntries: 0 });
    const historyFile = `${policyFile}.history.jsonl`;
    const lines = (await readFile(historyFile, "utf8")).trim().split("\n");
    const first = JSON.parse(lines[0]!) as { action: string };
    first.action = "rollback";
    lines[0] = JSON.stringify(first);
    await writeFile(historyFile, `${lines.join("\n")}\n`);
    expect(await audit.verify()).toMatchObject({ integrity: false, reason: "Entry hash mismatch" });
  });

  it("keeps legacy entries readable and marks them unverified", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "cokacremote-audit-"));
    const policyFile = path.join(dir, "policy.json");
    const audit = new SafetyPolicyAudit(policyFile);
    await writeFile(`${policyFile}.history.jsonl`, `${JSON.stringify({ revisionId: "legacy", timestamp: new Date().toISOString(), action: "save", sha256: "x".repeat(64), policy: { version: 1 } })}\n`);
    await audit.record("save", { version: 1, defaults: { unmatchedCommand: "allow" } });
    expect(await audit.verify()).toMatchObject({ integrity: true, chainedEntries: 1, legacyEntries: 1 });
  });

  it("creates readable line diffs", () => {
    const diff = diffSafetyPolicies({ version: 1, defaults: { unmatchedCommand: "allow" } }, { version: 1, defaults: { unmatchedCommand: "deny" } });
    expect(diff.some((line) => line.type === "remove" && line.line.includes("allow"))).toBe(true);
    expect(diff.some((line) => line.type === "add" && line.line.includes("deny"))).toBe(true);
  });
});
