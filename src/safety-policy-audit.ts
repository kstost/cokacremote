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
  prevEntryHash?: string;
  entryHash?: string;
}

export interface PolicyAuditVerification {
  integrity: boolean;
  chainedEntries: number;
  legacyEntries: number;
  brokenRevisionId?: string;
  reason?: string;
}

export interface PolicyDiffLine {
  type: "same" | "add" | "remove";
  line: string;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function chainPayload(entry: Omit<PolicyAuditEntry, "entryHash">): string {
  return JSON.stringify(entry);
}

function validateEntry(raw: unknown): PolicyAuditEntry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as Partial<PolicyAuditEntry>;
  if (!entry.revisionId || !entry.timestamp || !entry.action || !entry.sha256 || !entry.policy) return undefined;
  return { ...entry, policy: parseSafetyPolicyFile(entry.policy) } as PolicyAuditEntry;
}

function policyLines(policy: SafetyPolicyFile): string[] {
  return JSON.stringify(parseSafetyPolicyFile(policy), null, 2).split("\n");
}

export function diffSafetyPolicies(from: SafetyPolicyFile, to: SafetyPolicyFile): PolicyDiffLine[] {
  const a = policyLines(from);
  const b = policyLines(to);
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? 1 + dp[i + 1]![j + 1]! : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const result: PolicyDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      result.push({ type: "same", line: a[i]! }); i += 1; j += 1;
    } else if (j < b.length && (i >= a.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      result.push({ type: "add", line: b[j]! }); j += 1;
    } else {
      result.push({ type: "remove", line: a[i]! }); i += 1;
    }
  }
  return result;
}

export class SafetyPolicyAudit {
  readonly file: string | undefined;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(policyFile: string | undefined) {
    this.file = policyFile ? `${path.resolve(policyFile)}.history.jsonl` : undefined;
  }

  async record(action: PolicyAuditAction, policy: SafetyPolicyFile, rollbackFromRevisionId?: string): Promise<PolicyAuditEntry | undefined> {
    if (!this.file) return undefined;
    let recorded: PolicyAuditEntry | undefined;
    const write = this.#writeQueue.then(async () => {
      const validated = parseSafetyPolicyFile(policy);
      const canonical = JSON.stringify(validated);
      const prior = await this.#chronological();
      const previous = prior.at(-1);
      const previousHash = previous?.entryHash;
      const base: Omit<PolicyAuditEntry, "entryHash"> = {
        revisionId: randomUUID(), timestamp: new Date().toISOString(), action, sha256: hashText(canonical), policy: validated,
        ...(rollbackFromRevisionId ? { rollbackFromRevisionId } : {}), ...(previousHash ? { prevEntryHash: previousHash } : {}),
      };
      recorded = { ...base, entryHash: hashText(chainPayload(base)) };
      await appendFile(this.file!, `${JSON.stringify(recorded)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    this.#writeQueue = write.catch(() => undefined);
    await write;
    return recorded;
  }

  async list(limit = 100): Promise<PolicyAuditEntry[]> {
    return (await this.#chronological()).reverse().slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  async get(revisionId: string): Promise<PolicyAuditEntry | undefined> {
    return (await this.#chronological()).find((entry) => entry.revisionId === revisionId);
  }

  async verify(): Promise<PolicyAuditVerification> {
    const entries = await this.#chronological();
    let previousChainedHash: string | undefined;
    let chainedEntries = 0;
    let legacyEntries = 0;
    let chainStarted = false;
    for (const entry of entries) {
      if (!entry.entryHash) {
        if (chainStarted) return { integrity: false, chainedEntries, legacyEntries, brokenRevisionId: entry.revisionId, reason: "Legacy entry appears after hash chain started" };
        legacyEntries += 1;
        continue;
      }
      chainStarted = true;
      const { entryHash, ...base } = entry;
      const expected = hashText(chainPayload(base));
      if (entryHash !== expected) return { integrity: false, chainedEntries, legacyEntries, brokenRevisionId: entry.revisionId, reason: "Entry hash mismatch" };
      if (previousChainedHash && entry.prevEntryHash !== previousChainedHash) {
        return { integrity: false, chainedEntries, legacyEntries, brokenRevisionId: entry.revisionId, reason: "Previous entry hash mismatch" };
      }
      if (!previousChainedHash && entry.prevEntryHash) {
        return { integrity: false, chainedEntries, legacyEntries, brokenRevisionId: entry.revisionId, reason: "Unexpected previous entry hash at chain start" };
      }
      previousChainedHash = entryHash;
      chainedEntries += 1;
    }
    return { integrity: true, chainedEntries, legacyEntries };
  }

  async #chronological(): Promise<PolicyAuditEntry[]> {
    if (!this.file) return [];
    let text: string;
    try { text = await readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return text.split("\n").filter(Boolean).flatMap((line) => {
      try {
        const entry = validateEntry(JSON.parse(line));
        return entry ? [entry] : [];
      } catch { return []; }
    });
  }
}
