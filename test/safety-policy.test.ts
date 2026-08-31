import { describe, expect, it } from "vitest";
import { SafetyPolicy, enforceAssessment } from "../src/safety-policy.js";

describe("SafetyPolicy", () => {
  it("preserves unrestricted behavior by default", () => {
    const policy = new SafetyPolicy("unrestricted", "/workspace/app");
    expect(policy.assessCommand("sudo rm -rf /tmp/x").decision).toBe("allow");
    expect(policy.assessPath("write_file", "/etc/hosts").decision).toBe("allow");
  });

  it("allows workspace work, requires approval for risky work, and denies catastrophic commands", () => {
    const policy = new SafetyPolicy("safe", "/workspace/app");
    expect(policy.assessCommand("npm test").decision).toBe("allow");
    expect(policy.assessPath("write_file", "/workspace/app/src/a.ts").decision).toBe("allow");
    expect(policy.assessCommand("sudo systemctl restart nginx").decision).toBe("approval-required");
    expect(policy.assessPath("write_file", "/etc/nginx/nginx.conf").decision).toBe("approval-required");
    expect(policy.assessCommand("mkfs.ext4 /dev/sda").decision).toBe("deny");
    expect(policy.assessCommand("rm -rf /").decision).toBe("deny");
  });

  it("uses a human-approved approval only once", () => {
    const policy = new SafetyPolicy("safe", "/workspace/app");
    const assessment = policy.assessCommand("sudo systemctl restart nginx");
    expect(() => enforceAssessment(policy, assessment, "exec_command", "restart nginx")).toThrow(/approvalId=/);
    const pending = policy.list()[0]!;
    expect(() => policy.consume(pending.approvalId, "exec_command")).toThrow("still pending");
    policy.approve(pending.approvalId);
    expect(policy.consume(pending.approvalId, "exec_command")).toBe(true);
    expect(() => policy.consume(pending.approvalId, "exec_command")).toThrow("already been consumed");
  });
});
