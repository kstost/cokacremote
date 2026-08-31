import { access, constants, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadConfig } from "./config.js";
import { loadSafetyPolicyFile } from "./safety-policy-file.js";

interface Check { name: string; ok: boolean; detail: string }
function commandCheck(name: string, command: string, args = ["--version"]): Check {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000 });
  return { name, ok: result.status === 0, detail: (result.stdout || result.stderr || "not available").trim().split("\n")[0]! };
}
async function main(): Promise<void> {
  const env = { ...process.env };
  if (!env.MCP_AUTH_TOKEN && env.MCP_OAUTH_ENABLED !== "true") env.MCP_ALLOW_NO_AUTH = "true";
  const config = loadConfig(env);
  const checks: Check[] = [
    { name: "Node.js", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version },
    commandCheck("Git", "git"), commandCheck("Bash", config.defaultShell), commandCheck("npm", "npm"), commandCheck("Python", "python3"),
  ];
  try {
    await access(config.defaultCwd, constants.R_OK | constants.W_OK);
    const probe = path.join(config.defaultCwd, `.cokacremote-doctor-${process.pid}`);
    await mkdir(probe); await writeFile(path.join(probe, "probe"), "ok"); await rm(probe, { recursive: true, force: true });
    checks.push({ name: "Default cwd", ok: true, detail: `${config.defaultCwd} (read/write)` });
  } catch (error) { checks.push({ name: "Default cwd", ok: false, detail: String(error) }); }
  checks.push({ name: "Task journal", ok: true, detail: config.taskJournalFile ?? "disabled" });
  try {
    if (config.safetyPolicyFile) loadSafetyPolicyFile(config.safetyPolicyFile);
    checks.push({ name: "Safety policy", ok: true, detail: config.safetyPolicyFile ?? `${config.safetyMode} (built-in)` });
  } catch (error) {
    checks.push({ name: "Safety policy", ok: false, detail: String(error) });
  }
  console.log("cokacremote doctor\n");
  checks.forEach((c) => console.log(`${c.ok ? "OK" : "FAIL"}  ${c.name.padEnd(14)} ${c.detail}`));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\nSTATUS: ${failed ? `UNHEALTHY (${failed} failed)` : "HEALTHY"}`);
  if (failed) process.exitCode = 1;
}
void main();
