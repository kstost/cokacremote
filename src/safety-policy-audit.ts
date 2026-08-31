import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { parseSafetyPolicyFile, type SafetyPolicyFile } from "./safety-policy-file.js";

export type PolicyAuditAction = "save" | "reload" | "rollback";

export interface PolicyAuditEntry {
  revisionId: string;
  timestamp: string;
  action: PolicyAuditAction;
  sha256: string;
  policy: SafetyPolicyFile;
  rollbackFromRevisionId?: string;
}

export class SafetyPolicyAudit {
  readonly file: string | undefined;

  constructor(policyFile: string | undefined) {
    this.file = policyFile ? `${path.resolve(policyFile)}.history.jsonl` : undefined;
  }

  async record(action: PolicyAuditAction, policy: SafetyPolicyFile, rollbackFromRevisionId?: string): Promise<PolicyAuditEntry | undefined> {
    if (!this.file) return undefined;
    const validated = parseSafetyPolicyFile(policy);
    const canonical = JSON.stringify(validated);
    const entry: PolicyAuditEntry = {
      revisionId: randomUUID(),
      timestamp: new Date().toISOString(),
      action,
      sha256: createHash("sha256").update(canonical).digest("hex"),
      policy: validated,
      ...(rollbackFromRevisionId ? { rollbackFromRevisionId } : {}),
    };
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    return entry;
  }

  async list(limit = 100): Promise<PolicyAuditEntry[]> {
    if (!this.file) return [];
    let text: string;
    try { text = await readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries = text.split("\n").filter(Boolean).flatMap((line) => {
      try {
        const raw = JSON.parse(line) as Partial<PolicyAuditEntry>;
        if (!raw.revisionId || !raw.timestamp || !raw.action || !raw.sha256 || !raw.policy) return [];
        return [{ ...raw, policy: parseSafetyPolicyFile(raw.policy) } as PolicyAuditEntry];
      } catch { return []; }
    });
    return entries.reverse().slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  async get(revisionId: string): Promise<PolicyAuditEntry | undefined> {
    return (await this.list(1000)).find((entry) => entry.revisionId === revisionId);
  }
}
