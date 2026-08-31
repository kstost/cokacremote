import express, { type Express, type Request, type Response } from "express";
import type { AppConfig } from "./config.js";
import type { TaskJournal } from "./task-journal.js";
import type { SafetyPolicy } from "./safety-policy.js";
import { loadSafetyPolicyFile, parseSafetyPolicyFile, saveSafetyPolicyFile } from "./safety-policy-file.js";
import { diffSafetyPolicies, SafetyPolicyAudit } from "./safety-policy-audit.js";
import { clearDashboardCookie, createDashboardAuth, createDashboardLoginLimiter, dashboardCookie, hasDashboardSession, redirectToDashboardLogin, verifyDashboardCredentials } from "./dashboard-auth.js";

type Middleware = (request: Request, response: Response, next: () => void) => void;

function loginHtml(failed = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>cokacremote login</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#0b1020;color:#e5e7eb}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px}.login{width:min(420px,100%);background:#111827;border:1px solid #24304a;border-radius:16px;padding:28px}.brand{font-weight:800;font-size:24px;margin-bottom:6px}.muted{color:#94a3b8;margin-bottom:22px}.field{display:block;margin:14px 0 6px;color:#cbd5e1;font-size:13px}input{width:100%;padding:12px 13px;border-radius:9px;border:1px solid #334155;background:#080d19;color:#e5e7eb;font:inherit}button{width:100%;margin-top:18px;padding:12px;border:1px solid #3b82f6;background:#2563eb;color:white;border-radius:9px;font-weight:700;cursor:pointer}.error{margin-top:14px;color:#fca5a5;background:#2a1519;padding:10px 12px;border-radius:8px}</style></head><body><form class="login" method="post" action="/dashboard/login"><div class="brand">cokacremote</div><div class="muted">Dashboard sign in</div><label class="field" for="username">Username</label><input id="username" name="username" autocomplete="username" required autofocus><label class="field" for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button>${failed ? '<div class="error">Invalid username or password.</div>' : ''}</form></body></html>`;
}

const dashboardHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cokacremote tasks</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#0b1020;color:#e5e7eb}*{box-sizing:border-box}body{margin:0}header{padding:22px 28px;border-bottom:1px solid #24304a;display:flex;justify-content:space-between;align-items:center}.brand{font-weight:800;font-size:20px}.muted{color:#94a3b8}.layout{display:grid;grid-template-columns:minmax(260px,360px) 1fr;min-height:calc(100vh - 70px)}aside{border-right:1px solid #24304a;padding:16px}.task{padding:14px;border:1px solid #24304a;border-radius:12px;margin-bottom:10px;cursor:pointer;background:#111827}.task:hover,.task.active{border-color:#60a5fa}.task h3{margin:0 0 7px;font-size:15px}.badge{font-size:11px;padding:3px 7px;border-radius:99px;background:#1e293b}.active-status{color:#86efac}.completed-status{color:#93c5fd}main{padding:24px;overflow:auto}.empty{color:#64748b;padding:40px;text-align:center}.summary{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0 24px}.card{background:#111827;border:1px solid #24304a;border-radius:12px;padding:12px 16px}.timeline{border-left:2px solid #24304a;margin-left:10px;padding-left:20px}.event{position:relative;margin:0 0 16px;background:#111827;border:1px solid #24304a;border-radius:10px;padding:12px}.event:before{content:'';position:absolute;width:10px;height:10px;border-radius:50%;background:#60a5fa;left:-26px;top:17px}.event.failed:before{background:#f87171}.event.completed:before{background:#4ade80}.event-head{display:flex;justify-content:space-between;gap:16px}.event-name{font-weight:700}.meta{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;color:#94a3b8;margin-top:7px;white-space:pre-wrap;word-break:break-word}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.btn{border:1px solid #334155;background:#1e293b;color:#e5e7eb;border-radius:8px;padding:8px 11px;cursor:pointer}.btn:hover{border-color:#60a5fa}.editor{width:100%;min-height:460px;background:#080d19;color:#dbeafe;border:1px solid #334155;border-radius:10px;padding:14px;font:13px ui-monospace,SFMono-Regular,monospace;tab-size:2}.notice{padding:10px 12px;border-radius:8px;margin:10px 0;background:#172033}.notice.error{color:#fca5a5}.notice.ok{color:#86efac}.diff{background:#080d19;border:1px solid #334155;border-radius:10px;padding:12px;overflow:auto;font:12px ui-monospace,SFMono-Regular,monospace;white-space:pre}.diff-add{color:#86efac}.diff-remove{color:#fca5a5}.integrity-ok{color:#86efac}.integrity-bad{color:#fca5a5}@media(max-width:760px){.layout{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid #24304a}main{padding:16px}}
</style></head><body><header><div><div class="brand">cokacremote</div><div class="muted">Development task timeline</div></div><div class="toolbar"><button id="policyBtn" class="btn">Safety policy</button><button id="logoutBtn" class="btn">Sign out</button><span id="refresh" class="muted">refreshing...</span></div></header><div class="layout"><aside><div id="approvals"></div><div id="tasks"></div></aside><main id="detail"><div class="empty">Select a task to inspect its timeline.</div></main></div>
<script>
let selected=null;const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,options){const r=await fetch(path,{cache:'no-store',...(options||{})});if(!r.ok)throw new Error(await r.text());return r.json()}
async function loadPolicy(){try{const d=await api('/dashboard/api/policy');const text=JSON.stringify(d.policy??{version:1},null,2);document.getElementById('detail').innerHTML='<h2>Safety policy</h2><div class="muted">Mode: '+esc(d.mode)+' · '+esc(d.file||'no policy file configured')+'</div><div id="policyNotice"></div><textarea id="policyEditor" class="editor">'+esc(text)+'</textarea><div class="toolbar" style="margin-top:10px"><button id="validatePolicy" class="btn">Validate</button><button id="savePolicy" class="btn">Save & reload</button><button id="reloadPolicy" class="btn">Reload from disk</button></div><h3>History</h3><div id="policyHistory" class="muted">Loading...</div>';const note=(m,c)=>document.getElementById('policyNotice').innerHTML='<div class="notice '+c+'">'+esc(m)+'</div>';const loadHistory=async()=>{try{const h=await api('/dashboard/api/policy/history');document.getElementById('policyHistory').innerHTML='<div class="notice '+(h.verification.integrity?'integrity-ok':'integrity-bad')+'">Audit chain: '+(h.verification.integrity?'verified':'BROKEN')+' · chained '+esc(h.verification.chainedEntries)+' · legacy '+esc(h.verification.legacyEntries)+(h.verification.reason?' · '+esc(h.verification.reason):'')+'</div>'+(h.history.length?h.history.map(x=>'<div class="card" style="margin:8px 0"><b>'+esc(x.action)+'</b> · '+esc(new Date(x.timestamp).toLocaleString())+'<div class="meta">policy '+esc(x.sha256.slice(0,16))+' · chain '+esc((x.entryHash||'legacy').slice(0,16))+' · '+esc(x.revisionId)+'</div><button class="btn" data-diff="'+esc(x.revisionId)+'">Diff vs current</button> <button class="btn" data-rollback="'+esc(x.revisionId)+'">Rollback to this</button><div data-diff-output="'+esc(x.revisionId)+'"></div></div>').join(''):'No policy history yet.');document.querySelectorAll('[data-diff]').forEach(b=>b.onclick=async()=>{const out=document.querySelector('[data-diff-output="'+b.dataset.diff+'"]');try{const d=await api('/dashboard/api/policy/diff/'+b.dataset.diff);out.innerHTML='<div class="diff">'+d.diff.map(l=>'<span class="'+(l.type==='add'?'diff-add':l.type==='remove'?'diff-remove':'')+'">'+esc(l.type==='add'?'+ '+l.line:l.type==='remove'?'- '+l.line:'  '+l.line)+'</span>').join('\n')+'</div>'}catch(e){out.textContent=String(e)}});document.querySelectorAll('[data-rollback]').forEach(b=>b.onclick=async()=>{if(!confirm('Rollback safety policy to this revision?'))return;try{await api('/dashboard/api/policy/rollback/'+b.dataset.rollback,{method:'POST'});await loadPolicy()}catch(e){note(String(e),'error')}})}catch(e){document.getElementById('policyHistory').textContent='Failed to load history.'}};loadHistory();document.getElementById('validatePolicy').onclick=async()=>{try{const policy=JSON.parse(document.getElementById('policyEditor').value);await api('/dashboard/api/policy/validate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(policy)});note('Policy is valid.','ok')}catch(e){note(String(e),'error')}};document.getElementById('savePolicy').onclick=async()=>{try{const policy=JSON.parse(document.getElementById('policyEditor').value);await api('/dashboard/api/policy',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(policy)});note('Saved and reloaded. New requests use this policy immediately.','ok');loadHistory()}catch(e){note(String(e),'error')}};document.getElementById('reloadPolicy').onclick=async()=>{try{await api('/dashboard/api/policy/reload',{method:'POST'});await loadPolicy()}catch(e){note(String(e),'error')}}}catch(e){document.getElementById('detail').innerHTML='<div class="empty">'+esc(String(e))+'</div>'}}
function taskHtml(t){return '<div class="task '+(selected===t.taskId?'active':'')+'" data-id="'+esc(t.taskId)+'"><h3>'+esc(t.title)+'</h3><span class="badge '+esc(t.status)+'-status">'+esc(t.status)+'</span> <span class="muted">'+esc(new Date(t.startedAt).toLocaleString())+'</span></div>'}
async function loadApprovals(){try{const d=await api('/dashboard/api/approvals');const pending=d.approvals.filter(a=>!a.approvedAt&&!a.consumedAt);document.getElementById('approvals').innerHTML=pending.length?'<h3>Approvals</h3>'+pending.map(a=>'<div class="task"><h3>'+esc(a.toolName)+'</h3><div class="muted">'+esc(a.summary)+'</div><button data-approve="'+esc(a.approvalId)+'">Approve once</button> <button data-deny="'+esc(a.approvalId)+'">Deny</button></div>').join(''):'';document.querySelectorAll('[data-approve]').forEach(b=>b.onclick=async()=>{await fetch('/dashboard/api/approvals/'+b.dataset.approve+'/approve',{method:'POST'});loadApprovals()});document.querySelectorAll('[data-deny]').forEach(b=>b.onclick=async()=>{await fetch('/dashboard/api/approvals/'+b.dataset.deny+'/deny',{method:'POST'});loadApprovals()})}catch(e){}}
async function loadTasks(){try{const d=await api('/dashboard/api/tasks');document.getElementById('tasks').innerHTML=d.tasks.map(taskHtml).join('')||'<div class="empty">No tasks yet.</div>';document.querySelectorAll('.task').forEach(e=>e.onclick=()=>{selected=e.dataset.id;loadTasks();loadDetail()});document.getElementById('refresh').textContent='updated '+new Date().toLocaleTimeString()}catch(e){document.getElementById('refresh').textContent='error'}}
async function loadDetail(){if(!selected)return;try{const [t,x]=await Promise.all([api('/dashboard/api/tasks/'+selected),api('/dashboard/api/tasks/'+selected+'/events')]);const events=x.events.map(e=>{const copy={...e};delete copy.seq;delete copy.timestamp;delete copy.event;return '<div class="event '+(e.event.includes('failed')?'failed':e.event.includes('completed')?'completed':'')+'"><div class="event-head"><span class="event-name">#'+e.seq+' '+esc(e.event)+'</span><span class="muted">'+esc(new Date(e.timestamp).toLocaleTimeString())+'</span></div><div class="meta">'+esc(JSON.stringify(copy,null,2))+'</div></div>'}).join('');document.getElementById('detail').innerHTML='<h2>'+esc(t.title)+'</h2><div class="muted">'+esc(t.cwd||'')+'</div><div class="summary"><div class="card">Status <b>'+esc(t.status)+'</b></div><div class="card">Commands <b>'+t.commands.length+'</b></div><div class="card">Files <b>'+t.filesChanged.length+'</b></div><div class="card">Events <b>'+t.eventCount+'</b></div></div><div class="timeline">'+events+'</div>'}catch(e){document.getElementById('detail').innerHTML='<div class="empty">Failed to load task.</div>'}}
document.getElementById('logoutBtn').onclick=async()=>{await fetch('/dashboard/logout',{method:'POST'});location.href='/dashboard/login'};document.getElementById('policyBtn').onclick=()=>{selected=null;loadTasks();loadPolicy()};loadApprovals();loadTasks();setInterval(()=>{loadApprovals();loadTasks();if(selected)loadDetail()},3000);
</script></body></html>`;

export function registerDashboard(app: Express, config: AppConfig, journal: TaskJournal, safetyPolicy: SafetyPolicy, authenticate: Middleware, parseJson: Middleware): void {
  const base = "/dashboard";
  const policyAudit = new SafetyPolicyAudit(config.safetyPolicyFile);
  const dashboardAuth = createDashboardAuth(config, authenticate);
  const loginLimiter = createDashboardLoginLimiter();
  const parseLogin = express.urlencoded({ extended: false, limit: "8kb" });

  app.get(`${base}/login`, (request, response) => {
    if (!config.dashboardUsername || !config.dashboardPassword) { response.status(404).type("text").send("Dashboard account login is not configured"); return; }
    if (hasDashboardSession(config, request)) { response.redirect(302, base); return; }
    response.type("html").send(loginHtml(request.query.error === "1"));
  });
  app.post(`${base}/login`, parseLogin, (request, response) => {
    if (!config.dashboardUsername || !config.dashboardPassword) { response.status(404).send("Dashboard account login is not configured"); return; }
    if (loginLimiter.blocked(request)) { response.status(429).type("html").send(loginHtml(true)); return; }
    const username = typeof request.body?.username === "string" ? request.body.username : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!verifyDashboardCredentials(config, username, password)) {
      loginLimiter.fail(request);
      response.redirect(303, `${base}/login?error=1`);
      return;
    }
    loginLimiter.success(request);
    response.setHeader("Set-Cookie", dashboardCookie(config));
    response.redirect(303, base);
  });
  app.post(`${base}/logout`, (_request, response) => {
    response.setHeader("Set-Cookie", clearDashboardCookie(config));
    response.status(204).end();
  });

  app.get(base, (request, response, next) => {
    if (config.dashboardUsername && config.dashboardPassword && !hasDashboardSession(config, request) && !request.header("authorization")) {
      redirectToDashboardLogin(response);
      return;
    }
    dashboardAuth(request, response, next);
  }, (_request, response) => response.type("html").send(dashboardHtml));
  app.get(`${base}/api/tasks`, dashboardAuth, async (_request, response) => response.json({ tasks: await journal.listTasks(100) }));
  app.get(`${base}/api/approvals`, dashboardAuth, (_request, response) => response.json({ mode: safetyPolicy.mode, approvals: safetyPolicy.list() }));
  app.post(`${base}/api/approvals/:approvalId/approve`, dashboardAuth, (request, response) => {
    try { response.json(safetyPolicy.approve(String(request.params.approvalId ?? ""))); }
    catch (error) { response.status(404).json({ error: error instanceof Error ? error.message : "Approval not found" }); }
  });
  app.post(`${base}/api/approvals/:approvalId/deny`, dashboardAuth, (request, response) => {
    try { response.json({ denied: true, approval: safetyPolicy.deny(String(request.params.approvalId ?? "")) }); }
    catch (error) { response.status(404).json({ error: error instanceof Error ? error.message : "Approval not found" }); }
  });
  app.get(`${base}/api/policy`, dashboardAuth, (_request, response) => {
    response.json({ mode: safetyPolicy.mode, file: config.safetyPolicyFile, editable: Boolean(config.safetyPolicyFile), policy: safetyPolicy.policyFile });
  });
  app.post(`${base}/api/policy/validate`, dashboardAuth, parseJson, (request, response) => {
    try { response.json({ valid: true, policy: parseSafetyPolicyFile(request.body) }); }
    catch (error) { response.status(400).json({ valid: false, error: error instanceof Error ? error.message : "Invalid policy" }); }
  });
  app.put(`${base}/api/policy`, dashboardAuth, parseJson, async (request, response) => {
    if (!config.safetyPolicyFile) { response.status(409).json({ error: "MCP_SAFETY_POLICY_FILE is not configured" }); return; }
    try {
      const policy = parseSafetyPolicyFile(request.body);
      await saveSafetyPolicyFile(config.safetyPolicyFile, policy);
      safetyPolicy.reload(policy);
      const revision = await policyAudit.record("save", policy);
      response.json({ saved: true, reloaded: true, policy, revision });
    } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : "Failed to save policy" }); }
  });
  app.post(`${base}/api/policy/reload`, dashboardAuth, async (_request, response) => {
    if (!config.safetyPolicyFile) { response.status(409).json({ error: "MCP_SAFETY_POLICY_FILE is not configured" }); return; }
    try {
      const policy = loadSafetyPolicyFile(config.safetyPolicyFile);
      safetyPolicy.reload(policy);
      const revision = policy ? await policyAudit.record("reload", policy) : undefined;
      response.json({ reloaded: true, policy, revision });
    } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : "Failed to reload policy" }); }
  });
  app.get(`${base}/api/policy/history`, dashboardAuth, async (_request, response) => {
    try { response.json({ history: await policyAudit.list(100), verification: await policyAudit.verify() }); }
    catch (error) { response.status(500).json({ error: error instanceof Error ? error.message : "Failed to read policy history" }); }
  });
  app.get(`${base}/api/policy/diff/:revisionId`, dashboardAuth, async (request, response) => {
    try {
      const revisionId = String(request.params.revisionId ?? "");
      const target = await policyAudit.get(revisionId);
      if (!target) { response.status(404).json({ error: "Policy revision not found" }); return; }
      const current = safetyPolicy.policyFile ?? { version: 1 as const };
      response.json({ revisionId, fromSha256: target.sha256, diff: diffSafetyPolicies(target.policy, current) });
    } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : "Failed to diff policy" }); }
  });
  app.post(`${base}/api/policy/rollback/:revisionId`, dashboardAuth, async (request, response) => {
    if (!config.safetyPolicyFile) { response.status(409).json({ error: "MCP_SAFETY_POLICY_FILE is not configured" }); return; }
    try {
      const revisionId = String(request.params.revisionId ?? "");
      const target = await policyAudit.get(revisionId);
      if (!target) { response.status(404).json({ error: "Policy revision not found" }); return; }
      const policy = parseSafetyPolicyFile(target.policy);
      await saveSafetyPolicyFile(config.safetyPolicyFile, policy);
      safetyPolicy.reload(policy);
      const revision = await policyAudit.record("rollback", policy, revisionId);
      response.json({ rolledBack: true, policy, revision, sourceRevision: target });
    } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : "Failed to rollback policy" }); }
  });
  app.get(`${base}/api/tasks/:taskId`, dashboardAuth, async (request, response) => {
    const taskId = String(request.params.taskId ?? "");
    const task = await journal.getTask(taskId);
    if (!task) { response.status(404).json({ error: "Task not found" }); return; }
    response.json(task);
  });
  app.get(`${base}/api/tasks/:taskId/events`, dashboardAuth, async (request, response) => {
    try {
      const afterSeq = Math.max(0, Number(request.query.afterSeq) || 0);
      const taskId = String(request.params.taskId ?? "");
      const events = await journal.getTaskEvents(taskId, afterSeq, 1000);
      response.json({ events, nextSeq: events.at(-1)?.seq ?? afterSeq });
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : "Task not found" });
    }
  });
}
