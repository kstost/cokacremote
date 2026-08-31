import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SafetyPolicyFile } from "./safety-policy-file.js";

export type SafetyMode = "unrestricted" | "safe";
export type SafetyDecision = "allow" | "approval-required" | "deny";

export interface SafetyAssessment {
  decision: SafetyDecision;
  reason?: string;
}

export interface PendingApproval {
  approvalId: string;
  toolName: string;
  summary: string;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
  consumedAt?: string;
}

const DENY_COMMANDS = [
  /(?:^|[;&|]\s*)mkfs(?:\.|\s)/i,
  /(?:^|[;&|]\s*)wipefs\b/i,
  /(?:^|[;&|]\s*)shutdown\b/i,
  /(?:^|[;&|]\s*)reboot\b/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /\brm\s+(?:-[^\s]*r[^\s]*f[^\s]*|-[^\s]*f[^\s]*r[^\s]*)\s+\/(?:\s|$)/i,
];

const APPROVAL_COMMANDS = [
  /(?:^|[;&|]\s*)sudo\b/i,
  /(?:^|[;&|]\s*)su\s/i,
  /(?:^|[;&|]\s*)systemctl\b/i,
  /(?:^|[;&|]\s*)service\b/i,
  /(?:^|[;&|]\s*)(?:apt|apt-get|dnf|yum|pacman)\b/i,
  /(?:^|[;&|]\s*)docker\s+(?:rm|rmi|system\s+prune|volume\s+rm)\b/i,
  /(?:^|[;&|]\s*)rm\s+[^\n]*-[^\s]*r/i,
  /(?:^|[;&|]\s*)chmod\s+[^\n]*(?:777|666)\b/i,
];

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class SafetyPolicy {
  readonly mode: SafetyMode;
  readonly defaultCwd: string;
  readonly #approvals = new Map<string, PendingApproval>();
  #policyFile: SafetyPolicyFile | undefined;

  constructor(mode: SafetyMode, defaultCwd: string, policyFile?: SafetyPolicyFile) {
    this.mode = mode;
    this.defaultCwd = path.resolve(defaultCwd);
    this.#policyFile = policyFile;
  }

  get policyFile(): SafetyPolicyFile | undefined {
    return this.#policyFile ? structuredClone(this.#policyFile) : undefined;
  }

  reload(policyFile: SafetyPolicyFile | undefined): void {
    this.#policyFile = policyFile ? structuredClone(policyFile) : undefined;
  }

  assessCommand(command: string): SafetyAssessment {
    if (this.mode === "unrestricted") return { decision: "allow" };
    if (DENY_COMMANDS.some((pattern) => pattern.test(command))) {
      return { decision: "deny", reason: "Command matches a destructive host-level deny rule" };
    }
    for (const rule of this.#policyFile?.commands ?? []) {
      if (new RegExp(rule.pattern, rule.flags ?? "i").test(command)) {
        return { decision: rule.decision, reason: rule.reason ?? `Matched command policy rule ${rule.id}` };
      }
    }
    if (APPROVAL_COMMANDS.some((pattern) => pattern.test(command))) {
      return { decision: "approval-required", reason: "Command can modify system-wide state or delete recursively" };
    }
    return {
      decision: this.#policyFile?.defaults?.unmatchedCommand ?? "allow",
      ...(this.#policyFile?.defaults?.unmatchedCommand ? { reason: "Safety policy default for unmatched commands" } : {}),
    };
  }

  assessPath(toolName: string, targetPath: string): SafetyAssessment {
    if (this.mode === "unrestricted") return { decision: "allow" };
    const absolute = path.resolve(targetPath);
    if (toolName === "remove_path" && absolute === "/") {
      return { decision: "deny", reason: "Removing the filesystem root is denied" };
    }
    for (const rule of this.#policyFile?.paths ?? []) {
      const expandedPrefix = rule.prefix.replaceAll("${workspace}", this.defaultCwd);
      const prefix = path.isAbsolute(expandedPrefix) ? path.resolve(expandedPrefix) : path.resolve(this.defaultCwd, expandedPrefix);
      if ((!rule.tools || rule.tools.includes(toolName)) && within(prefix, absolute)) {
        return { decision: rule.decision, reason: rule.reason ?? `Matched path policy rule ${rule.id}` };
      }
    }
    if (within(this.defaultCwd, absolute)) return { decision: "allow" };
    return {
      decision: this.#policyFile?.defaults?.outsideWorkspace ?? "approval-required",
      reason: `Write target is outside ${this.defaultCwd}`,
    };
  }

  request(toolName: string, summary: string): PendingApproval {
    this.prune();
    const approvalId = randomUUID();
    const created = Date.now();
    const approval: PendingApproval = {
      approvalId,
      toolName,
      summary,
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + 10 * 60_000).toISOString(),
    };
    this.#approvals.set(approvalId, approval);
    return { ...approval };
  }

  approve(approvalId: string): PendingApproval {
    const approval = this.#require(approvalId);
    if (approval.consumedAt) throw new Error("Approval has already been consumed");
    approval.approvedAt = new Date().toISOString();
    return { ...approval };
  }

  consume(approvalId: string | undefined, toolName: string): boolean {
    if (!approvalId) return false;
    const approval = this.#require(approvalId);
    if (approval.toolName !== toolName) throw new Error("Approval is for a different tool");
    if (!approval.approvedAt) throw new Error("Approval is still pending");
    if (approval.consumedAt) throw new Error("Approval has already been consumed");
    approval.consumedAt = new Date().toISOString();
    return true;
  }

  list(): PendingApproval[] {
    this.prune();
    return [...this.#approvals.values()].map((item) => ({ ...item })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  prune(): void {
    const now = Date.now();
    for (const [id, approval] of this.#approvals) {
      if (Date.parse(approval.expiresAt) < now || (approval.consumedAt && Date.parse(approval.consumedAt) < now - 60 * 60_000)) {
        this.#approvals.delete(id);
      }
    }
  }

  #require(approvalId: string): PendingApproval {
    this.prune();
    const approval = this.#approvals.get(approvalId);
    if (!approval) throw new Error("Unknown or expired approval");
    return approval;
  }
}

export function enforceAssessment(
  policy: SafetyPolicy,
  assessment: SafetyAssessment,
  toolName: string,
  summary: string,
  approvalId?: string,
): void {
  if (assessment.decision === "allow") return;
  if (assessment.decision === "deny") throw new Error(`Safety policy denied ${toolName}: ${assessment.reason}`);
  if (approvalId && policy.consume(approvalId, toolName)) return;
  const pending = policy.request(toolName, summary);
  throw new Error(`Safety approval required: ${assessment.reason}. approvalId=${pending.approvalId}. Approve it in /dashboard, then retry with approvalId.`);
}
