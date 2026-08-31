import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

describe("task dashboard", () => {
  let running: RunningHttpServer | undefined;
  let dir: string | undefined;
  afterEach(async () => { await running?.close(); running = undefined; if (dir) await rm(dir, { recursive: true, force: true }); });

  it("protects and serves task timeline APIs", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "cokacremote-dashboard-"));
    const token = "dashboard-test-secret-0123456789abcdef";
    const config = loadConfig({ MCP_AUTH_TOKEN: token, MCP_HOST: "127.0.0.1", MCP_DEFAULT_CWD: dir }, dir);
    config.port = 0;
    const services = createServices(config);
    const task = await services.taskJournal.startTask("Dashboard test", dir);
    await services.taskJournal.record("tool.started", { taskId: task.taskId, toolName: "exec_command" });
    await services.taskJournal.record("tool.completed", { taskId: task.taskId, toolName: "exec_command", durationMs: 12.3 });
    running = await startHttpServer(config, services);
    const address = running.httpServer.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/dashboard`;
    expect((await fetch(base)).status).toBe(401);
    const headers = { authorization: `Bearer ${token}` };
    const html = await fetch(base, { headers });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("Development task timeline");
    const tasks = await (await fetch(`${base}/api/tasks`, { headers })).json() as { tasks: Array<{ taskId: string }> };
    expect(tasks.tasks.some((item) => item.taskId === task.taskId)).toBe(true);
    const events = await (await fetch(`${base}/api/tasks/${task.taskId}/events`, { headers })).json() as { events: Array<{ event: string }> };
    expect(events.events.map((event) => event.event)).toEqual(["task.started", "tool.started", "tool.completed"]);
    const pending = services.safetyPolicy.request("exec_command", "sudo systemctl restart nginx");
    const approvals = await (await fetch(`${base}/api/approvals`, { headers })).json() as { approvals: Array<{ approvalId: string }> };
    expect(approvals.approvals.some((item) => item.approvalId === pending.approvalId)).toBe(true);
    const approved = await fetch(`${base}/api/approvals/${pending.approvalId}/approve`, { method: "POST", headers });
    expect(approved.status).toBe(200);
    expect(services.safetyPolicy.list().find((item) => item.approvalId === pending.approvalId)?.approvedAt).toBeTruthy();
  });
});
