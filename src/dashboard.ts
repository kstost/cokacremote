import type { Express, Request, Response } from "express";
import type { AppConfig } from "./config.js";
import type { TaskJournal } from "./task-journal.js";

type Middleware = (request: Request, response: Response, next: () => void) => void;

const dashboardHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cokacremote tasks</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#0b1020;color:#e5e7eb}*{box-sizing:border-box}body{margin:0}header{padding:22px 28px;border-bottom:1px solid #24304a;display:flex;justify-content:space-between;align-items:center}.brand{font-weight:800;font-size:20px}.muted{color:#94a3b8}.layout{display:grid;grid-template-columns:minmax(260px,360px) 1fr;min-height:calc(100vh - 70px)}aside{border-right:1px solid #24304a;padding:16px}.task{padding:14px;border:1px solid #24304a;border-radius:12px;margin-bottom:10px;cursor:pointer;background:#111827}.task:hover,.task.active{border-color:#60a5fa}.task h3{margin:0 0 7px;font-size:15px}.badge{font-size:11px;padding:3px 7px;border-radius:99px;background:#1e293b}.active-status{color:#86efac}.completed-status{color:#93c5fd}main{padding:24px;overflow:auto}.empty{color:#64748b;padding:40px;text-align:center}.summary{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0 24px}.card{background:#111827;border:1px solid #24304a;border-radius:12px;padding:12px 16px}.timeline{border-left:2px solid #24304a;margin-left:10px;padding-left:20px}.event{position:relative;margin:0 0 16px;background:#111827;border:1px solid #24304a;border-radius:10px;padding:12px}.event:before{content:'';position:absolute;width:10px;height:10px;border-radius:50%;background:#60a5fa;left:-26px;top:17px}.event.failed:before{background:#f87171}.event.completed:before{background:#4ade80}.event-head{display:flex;justify-content:space-between;gap:16px}.event-name{font-weight:700}.meta{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;color:#94a3b8;margin-top:7px;white-space:pre-wrap;word-break:break-word}@media(max-width:760px){.layout{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid #24304a}main{padding:16px}}
</style></head><body><header><div><div class="brand">cokacremote</div><div class="muted">Development task timeline</div></div><span id="refresh" class="muted">refreshing...</span></header><div class="layout"><aside><div id="tasks"></div></aside><main id="detail"><div class="empty">Select a task to inspect its timeline.</div></main></div>
<script>
let selected=null;const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path){const r=await fetch(path,{cache:'no-store'});if(!r.ok)throw new Error(await r.text());return r.json()}
function taskHtml(t){return '<div class="task '+(selected===t.taskId?'active':'')+'" data-id="'+esc(t.taskId)+'"><h3>'+esc(t.title)+'</h3><span class="badge '+esc(t.status)+'-status">'+esc(t.status)+'</span> <span class="muted">'+esc(new Date(t.startedAt).toLocaleString())+'</span></div>'}
async function loadTasks(){try{const d=await api('./api/tasks');document.getElementById('tasks').innerHTML=d.tasks.map(taskHtml).join('')||'<div class="empty">No tasks yet.</div>';document.querySelectorAll('.task').forEach(e=>e.onclick=()=>{selected=e.dataset.id;loadTasks();loadDetail()});document.getElementById('refresh').textContent='updated '+new Date().toLocaleTimeString()}catch(e){document.getElementById('refresh').textContent='error'}}
async function loadDetail(){if(!selected)return;try{const [t,x]=await Promise.all([api('./api/tasks/'+selected),api('./api/tasks/'+selected+'/events')]);const events=x.events.map(e=>{const copy={...e};delete copy.seq;delete copy.timestamp;delete copy.event;return '<div class="event '+(e.event.includes('failed')?'failed':e.event.includes('completed')?'completed':'')+'"><div class="event-head"><span class="event-name">#'+e.seq+' '+esc(e.event)+'</span><span class="muted">'+esc(new Date(e.timestamp).toLocaleTimeString())+'</span></div><div class="meta">'+esc(JSON.stringify(copy,null,2))+'</div></div>'}).join('');document.getElementById('detail').innerHTML='<h2>'+esc(t.title)+'</h2><div class="muted">'+esc(t.cwd||'')+'</div><div class="summary"><div class="card">Status <b>'+esc(t.status)+'</b></div><div class="card">Commands <b>'+t.commands.length+'</b></div><div class="card">Files <b>'+t.filesChanged.length+'</b></div><div class="card">Events <b>'+t.eventCount+'</b></div></div><div class="timeline">'+events+'</div>'}catch(e){document.getElementById('detail').innerHTML='<div class="empty">Failed to load task.</div>'}}
loadTasks();setInterval(()=>{loadTasks();if(selected)loadDetail()},3000);
</script></body></html>`;

export function registerDashboard(app: Express, config: AppConfig, journal: TaskJournal, authenticate: Middleware): void {
  const base = "/dashboard";
  app.get(base, authenticate, (_request, response) => response.type("html").send(dashboardHtml));
  app.get(`${base}/api/tasks`, authenticate, async (_request, response) => response.json({ tasks: await journal.listTasks(100) }));
  app.get(`${base}/api/tasks/:taskId`, authenticate, async (request, response) => {
    const taskId = String(request.params.taskId ?? "");
    const task = await journal.getTask(taskId);
    if (!task) { response.status(404).json({ error: "Task not found" }); return; }
    response.json(task);
  });
  app.get(`${base}/api/tasks/:taskId/events`, authenticate, async (request, response) => {
    try {
      const afterSeq = Math.max(0, Number(request.query.afterSeq) || 0);
      const taskId = String(request.params.taskId ?? "");
      const events = await journal.getTaskEvents(taskId, afterSeq, 1000);
      response.json({ events, nextSeq: events.at(-1)?.seq ?? afterSeq });
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : "Task not found" });
    }
  });
  void config;
}
