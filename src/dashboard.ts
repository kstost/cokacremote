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
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cokacremote dashboard</title><style>
:root{color-scheme:dark;font-family:Inter,Pretendard,ui-sans-serif,system-ui,sans-serif;background:#090e1a;color:#e5e7eb}*{box-sizing:border-box}body{margin:0;background:#090e1a}button,input,textarea{font:inherit}header{height:72px;padding:0 24px;border-bottom:1px solid #202b40;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:#090e1af2;backdrop-filter:blur(12px);z-index:5}.brand{font-weight:800;font-size:20px}.subtitle{color:#94a3b8;font-size:13px;margin-top:3px}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.btn{border:1px solid #334155;background:#172033;color:#e5e7eb;border-radius:9px;padding:8px 11px;cursor:pointer}.btn:hover{border-color:#60a5fa}.btn.primary{background:#1d4ed8;border-color:#3b82f6}.btn.danger{color:#fecaca;border-color:#7f1d1d;background:#2a1519}.layout{display:grid;grid-template-columns:340px minmax(0,1fr);min-height:calc(100vh - 72px)}aside{border-right:1px solid #202b40;padding:16px;overflow:auto;max-height:calc(100vh - 72px);position:sticky;top:72px}.side-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.side-title h2{font-size:15px;margin:0}.count{font-size:12px;color:#64748b}.search{width:100%;padding:10px 12px;border:1px solid #29364e;border-radius:9px;background:#0d1423;color:#e5e7eb;outline:none}.search:focus{border-color:#60a5fa}.filters{display:flex;gap:6px;margin:10px 0 14px;overflow:auto}.filter{white-space:nowrap;border:1px solid #29364e;background:#111827;color:#94a3b8;border-radius:999px;padding:5px 9px;font-size:12px;cursor:pointer}.filter.active{color:#dbeafe;border-color:#3b82f6;background:#172554}.task{padding:13px;border:1px solid #202b40;border-radius:11px;margin-bottom:9px;cursor:pointer;background:#0f1726}.task:hover,.task.active{border-color:#4b78b8;background:#111d31}.task-title{font-weight:700;font-size:13px;line-height:1.45;word-break:break-word}.task-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px}.badge{display:inline-flex;align-items:center;font-size:10px;font-weight:700;padding:3px 7px;border-radius:999px;background:#1e293b;color:#cbd5e1}.badge.ok{color:#86efac;background:#10261d}.badge.fail{color:#fca5a5;background:#2a1519}.badge.run{color:#fde68a;background:#2a2311}.badge.info{color:#93c5fd;background:#10213b}.tiny{font-size:11px;color:#64748b}.approval{border:1px solid #713f12;background:#251a0b;border-radius:11px;padding:12px;margin-bottom:12px}.approval h3{margin:0 0 5px;font-size:13px;color:#fde68a}.approval .summary-text{font-size:12px;color:#d6d3d1;word-break:break-word;margin-bottom:9px}.approval-actions{display:flex;gap:7px}.approval-actions .btn{font-size:11px;padding:6px 8px}main{padding:26px;overflow:auto;min-width:0}.empty{color:#64748b;padding:70px 20px;text-align:center}.detail-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px}.detail-title{font-size:23px;font-weight:800;line-height:1.35;margin:0}.path{color:#64748b;font:12px ui-monospace,SFMono-Regular,monospace;margin-top:6px;word-break:break-all}.health{border-radius:12px;padding:13px 15px;margin:12px 0 18px;border:1px solid #21412f;background:#0e2118}.health.fail{border-color:#6b2323;background:#271314}.health.run{border-color:#66521a;background:#241e0d}.health strong{display:block;margin-bottom:3px}.health span{font-size:12px;color:#a3b3c8}.stats{display:grid;grid-template-columns:repeat(5,minmax(110px,1fr));gap:10px;margin-bottom:18px}.stat{border:1px solid #202b40;border-radius:11px;background:#0f1726;padding:13px}.stat-label{font-size:11px;color:#64748b}.stat-value{font-size:20px;font-weight:800;margin-top:4px}.tabs{display:flex;gap:5px;border-bottom:1px solid #202b40;margin-bottom:17px;overflow:auto}.tab{border:0;background:transparent;color:#64748b;padding:10px 12px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}.tab.active{color:#dbeafe;border-bottom-color:#60a5fa}.section{margin:18px 0}.section-title{font-size:14px;margin:0 0 10px}.list{display:grid;gap:8px}.row-card{border:1px solid #202b40;background:#0f1726;border-radius:11px;padding:12px 13px}.row-head{display:flex;justify-content:space-between;gap:12px;align-items:center}.row-title{font-weight:700;font-size:12px}.command{font:12px/1.55 ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;word-break:break-word;background:#090e1a;border:1px solid #202b40;border-radius:8px;padding:10px;margin:9px 0 0}.row-meta{font-size:11px;color:#64748b;margin-top:7px;word-break:break-all}.issue{border-color:#6b2323;background:#211214}.issue .row-title{color:#fecaca}.file-main{font:12px ui-monospace,SFMono-Regular,monospace;word-break:break-all}.file-op{font-size:10px;color:#93c5fd;margin-left:8px}.raw details{border:1px solid #202b40;background:#0f1726;border-radius:9px;margin-bottom:7px}.raw summary{cursor:pointer;padding:10px 12px;font-size:12px}.raw pre{margin:0;border-top:1px solid #202b40;padding:11px;overflow:auto;font:11px/1.5 ui-monospace,SFMono-Regular,monospace;color:#94a3b8}.editor{width:100%;min-height:420px;background:#080d19;color:#dbeafe;border:1px solid #334155;border-radius:10px;padding:14px;font:13px ui-monospace,SFMono-Regular,monospace;tab-size:2}.notice{padding:10px 12px;border-radius:8px;margin:10px 0;background:#172033}.notice.error{color:#fca5a5}.notice.ok{color:#86efac}.diff{background:#080d19;border:1px solid #334155;border-radius:10px;padding:12px;overflow:auto;font:12px ui-monospace,SFMono-Regular,monospace;white-space:pre}.diff-add{color:#86efac}.diff-remove{color:#fca5a5}.policy-card{background:#0f1726;border:1px solid #202b40;border-radius:11px;padding:12px;margin:8px 0}@media(max-width:1050px){.stats{grid-template-columns:repeat(3,1fr)}}@media(max-width:760px){header{padding:0 14px}.layout{grid-template-columns:1fr}aside{position:relative;top:auto;max-height:none;border-right:0;border-bottom:1px solid #202b40}main{padding:18px 14px}.stats{grid-template-columns:repeat(2,1fr)}.detail-head{display:block}}
</style></head><body>
<header><div><div class="brand">cokacremote</div><div class="subtitle">Development task timeline · 작업 결과를 한눈에 확인합니다</div></div><div class="toolbar"><button id="policyBtn" class="btn">Safety policy</button><button id="logoutBtn" class="btn">로그아웃</button><span id="refresh" class="tiny">불러오는 중...</span></div></header>
<div class="layout"><aside><div id="approvals"></div><div class="side-title"><h2>작업 목록</h2><span id="taskCount" class="count"></span></div><input id="taskSearch" class="search" placeholder="작업 또는 명령 검색"><div class="filters"><button class="filter active" data-filter="all">전체</button><button class="filter" data-filter="active">진행중</button><button class="filter" data-filter="failed">실패</button><button class="filter" data-filter="completed">완료</button></div><div id="tasks"></div></aside><main id="detail"><div class="empty">왼쪽에서 작업을 선택하면 핵심 결과를 요약해서 보여줍니다.</div></main></div>
<script src="/dashboard/app.js" defer></script></body></html>`;

const dashboardJs = String.raw`
(function(){
  'use strict';
  var selected=null, currentTab='overview', taskCache=[], filter='all', search='';
  var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
  var fmtTime=function(v){try{return new Date(v).toLocaleString();}catch{return String(v||'');}};
  var fmtClock=function(v){try{return new Date(v).toLocaleTimeString();}catch{return '';}};
  var fmtDuration=function(ms){if(!Number.isFinite(ms)||ms<0)return '-';if(ms<1000)return Math.round(ms)+'ms';var s=Math.round(ms/1000);if(s<60)return s+'초';var m=Math.floor(s/60);s=s%60;if(m<60)return m+'분 '+s+'초';var h=Math.floor(m/60);m=m%60;return h+'시간 '+m+'분';};
  var elapsed=function(t){var a=Date.parse(t.startedAt),b=Date.parse(t.endedAt||new Date().toISOString());return Number.isFinite(a)&&Number.isFinite(b)?Math.max(0,b-a):0;};
  var api=async function(path,options){var r=await fetch(path,Object.assign({cache:'no-store'},options||{}));if(r.status===401){location.href='/dashboard/login';throw new Error('로그인이 필요합니다.');}if(!r.ok)throw new Error(await r.text());return r.json();};
  var cmdState=function(c){if(c.timedOut)return {key:'fail',label:'TIMEOUT'};if(c.exitCode===undefined)return {key:'run',label:'RUNNING'};if(c.exitCode===0)return {key:'ok',label:'SUCCESS'};return {key:'fail',label:c.exitCode===null?'STOPPED':'EXIT '+c.exitCode};};
  var taskFailed=function(t){return (t.commands||[]).some(function(c){return c.timedOut||c.exitCode!==undefined&&c.exitCode!==0;});};
  var taskState=function(t){if(t.status==='active')return {key:'run',label:'진행중'};if(taskFailed(t))return {key:'fail',label:'실패'};return {key:'ok',label:'완료'};};
  var issueEvents=function(events){return events.filter(function(e){return e.event==='tool.failed'||e.event==='process.idle_timeout'||e.event==='process.completed'&&(e.timedOut===true||e.error||typeof e.exitCode==='number'&&e.exitCode!==0);});};
  var humanEvent=function(e){if(e.event==='task.started')return '작업 시작';if(e.event==='task.completed')return '작업 완료';if(e.event==='tool.started')return '도구 실행 · '+(e.toolName||'');if(e.event==='tool.completed')return '도구 완료 · '+(e.toolName||'');if(e.event==='tool.failed')return '도구 실패 · '+(e.toolName||'');if(e.event==='process.started')return '명령 시작';if(e.event==='process.completed')return '명령 종료';if(e.event==='process.idle_timeout')return '명령 유휴 타임아웃';if(e.event==='file.changed')return '파일 변경 · '+(e.operation||'');return e.event;};
  var issueText=function(e){if(e.error)return String(e.error);if(e.timedOut)return '실행 시간이 초과되었습니다.';if(typeof e.exitCode==='number')return '명령이 exit code '+e.exitCode+' 로 종료되었습니다.';return humanEvent(e);};
  var copyButton=function(text){return '<button class="btn copy" data-copy="'+esc(encodeURIComponent(text))+'">복사</button>';};
  var bindCopies=function(){document.querySelectorAll('[data-copy]').forEach(function(b){b.onclick=async function(ev){ev.stopPropagation();try{await navigator.clipboard.writeText(decodeURIComponent(b.dataset.copy||''));var old=b.textContent;b.textContent='복사됨';setTimeout(function(){b.textContent=old;},900);}catch{}};});};

  function taskHtml(t){var state=taskState(t), failed=(t.commands||[]).filter(function(c){return cmdState(c).key==='fail';}).length;return '<div class="task '+(selected===t.taskId?'active':'')+'" data-id="'+esc(t.taskId)+'"><div class="task-title">'+esc(t.title)+'</div><div class="task-meta"><span class="badge '+state.key+'">'+state.label+'</span>'+(t.automatic?'<span class="badge info">AUTO</span>':'')+'<span class="tiny">명령 '+(t.commands||[]).length+'</span>'+(failed?'<span class="tiny">실패 '+failed+'</span>':'')+'<span class="tiny">'+esc(fmtTime(t.startedAt))+'</span></div></div>';}
  function matchesTask(t){var q=search.trim().toLowerCase();if(q){var hay=(t.title+' '+(t.cwd||'')+' '+(t.commands||[]).map(function(c){return c.command;}).join(' ')).toLowerCase();if(!hay.includes(q))return false;}if(filter==='active')return t.status==='active';if(filter==='failed')return taskFailed(t);if(filter==='completed')return t.status==='completed'&&!taskFailed(t);return true;}
  async function loadTasks(){try{var d=await api('/dashboard/api/tasks');taskCache=d.tasks||[];var shown=taskCache.filter(matchesTask);document.getElementById('taskCount').textContent=shown.length+' / '+taskCache.length;document.getElementById('tasks').innerHTML=shown.map(taskHtml).join('')||'<div class="empty" style="padding:28px 8px">조건에 맞는 작업이 없습니다.</div>';document.querySelectorAll('.task[data-id]').forEach(function(e){e.onclick=function(){selected=e.dataset.id;currentTab='overview';loadTasks();loadDetail();};});document.getElementById('refresh').textContent='업데이트 '+new Date().toLocaleTimeString();}catch(e){document.getElementById('refresh').textContent='업데이트 실패';}}
  async function loadApprovals(){try{var d=await api('/dashboard/api/approvals');var pending=d.approvals.filter(function(a){return !a.approvedAt&&!a.consumedAt;});document.getElementById('approvals').innerHTML=pending.length?'<div class="approval"><h3>승인 대기 '+pending.length+'건</h3>'+pending.map(function(a){return '<div class="summary-text"><b>'+esc(a.toolName)+'</b><br>'+esc(a.summary)+'</div><div class="approval-actions"><button class="btn primary" data-approve="'+esc(a.approvalId)+'">1회 승인</button><button class="btn danger" data-deny="'+esc(a.approvalId)+'">거부</button></div>';}).join('<hr style="border:0;border-top:1px solid #713f12;margin:12px 0">')+'</div>':'';document.querySelectorAll('[data-approve]').forEach(function(b){b.onclick=async function(){await api('/dashboard/api/approvals/'+b.dataset.approve+'/approve',{method:'POST'});loadApprovals();};});document.querySelectorAll('[data-deny]').forEach(function(b){b.onclick=async function(){await api('/dashboard/api/approvals/'+b.dataset.deny+'/deny',{method:'POST'});loadApprovals();};});}catch{}}

  function commandRows(t){if(!(t.commands||[]).length)return '<div class="empty">실행된 명령이 없습니다.</div>';return '<div class="list">'+t.commands.map(function(c,i){var st=cmdState(c);return '<div class="row-card"><div class="row-head"><div class="row-title">명령 #'+(i+1)+'</div><div><span class="badge '+st.key+'">'+st.label+'</span> '+copyButton(c.command||'')+'</div></div><pre class="command">'+esc(c.command||'')+'</pre>'+(c.cwd?'<div class="row-meta">cwd · '+esc(c.cwd)+'</div>':'')+'</div>';}).join('')+'</div>';}
  function fileRows(t,events){var changes=events.filter(function(e){return e.event==='file.changed'&&e.path;});var seen=new Map();changes.forEach(function(e){seen.set(String(e.path),e.operation||'changed');});(t.filesChanged||[]).forEach(function(p){if(!seen.has(p))seen.set(p,'changed');});if(!seen.size)return '<div class="empty">변경된 파일이 없습니다.</div>';return '<div class="list">'+Array.from(seen.entries()).map(function(pair){return '<div class="row-card"><span class="file-main">'+esc(pair[0])+'</span><span class="file-op">'+esc(pair[1])+'</span></div>';}).join('')+'</div>';}
  function issueRows(issues){if(!issues.length)return '<div class="health"><strong>문제 없음</strong><span>기록된 오류나 타임아웃이 없습니다.</span></div>';return '<div class="list">'+issues.map(function(e){return '<div class="row-card issue"><div class="row-head"><div class="row-title">'+esc(humanEvent(e))+'</div><span class="tiny">'+esc(fmtTime(e.timestamp))+'</span></div><div class="row-meta" style="color:#fca5a5">'+esc(issueText(e))+'</div>'+(e.command?'<pre class="command">'+esc(e.command)+'</pre>':'')+'</div>';}).join('')+'</div>';}
  function rawRows(events){if(!events.length)return '<div class="empty">이벤트가 없습니다.</div>';return '<div class="raw">'+events.slice().reverse().map(function(e){var copy=Object.assign({},e);delete copy.seq;delete copy.timestamp;delete copy.event;return '<details><summary>#'+esc(e.seq)+' · '+esc(humanEvent(e))+' <span class="tiny">'+esc(fmtClock(e.timestamp))+'</span></summary><pre>'+esc(JSON.stringify(copy,null,2))+'</pre></details>';}).join('')+'</div>';}
  function overview(t,events,issues){var failed=(t.commands||[]).filter(function(c){return cmdState(c).key==='fail';}).length;var running=(t.commands||[]).filter(function(c){return cmdState(c).key==='run';}).length;var state=issues.length?'fail':t.status==='active'?'run':'ok';var msg=issues.length?'주의가 필요한 문제 '+issues.length+'건이 있습니다.':t.status==='active'?'현재 작업이 진행 중입니다.':'오류 없이 작업이 종료되었습니다.';var recent=events.slice(-6).reverse();return '<div class="health '+(state==='ok'?'':state)+'"><strong>'+(state==='fail'?'확인 필요':state==='run'?'진행 중':'정상 완료')+'</strong><span>'+esc(msg)+'</span></div><div class="stats"><div class="stat"><div class="stat-label">상태</div><div class="stat-value">'+esc(taskState(t).label)+'</div></div><div class="stat"><div class="stat-label">소요 시간</div><div class="stat-value">'+esc(fmtDuration(elapsed(t)))+'</div></div><div class="stat"><div class="stat-label">명령</div><div class="stat-value">'+(t.commands||[]).length+'</div></div><div class="stat"><div class="stat-label">실패 / 실행중</div><div class="stat-value">'+failed+' / '+running+'</div></div><div class="stat"><div class="stat-label">변경 파일</div><div class="stat-value">'+(t.filesChanged||[]).length+'</div></div></div>'+(issues.length?'<div class="section"><h3 class="section-title">문제 요약</h3>'+issueRows(issues)+'</div>':'')+'<div class="section"><h3 class="section-title">명령 결과</h3>'+commandRows({commands:(t.commands||[]).slice(0,5)})+'</div>'+(t.commands.length>5?'<div class="tiny" style="margin-top:-10px">전체 '+t.commands.length+'개 명령은 Commands 탭에서 확인할 수 있습니다.</div>':'')+'<div class="section"><h3 class="section-title">최근 활동</h3><div class="list">'+recent.map(function(e){return '<div class="row-card"><div class="row-head"><span class="row-title">'+esc(humanEvent(e))+'</span><span class="tiny">'+esc(fmtClock(e.timestamp))+'</span></div></div>';}).join('')+'</div></div>';}
  function tabBar(t,issues){return '<div class="tabs"><button class="tab '+(currentTab==='overview'?'active':'')+'" data-tab="overview">Overview</button><button class="tab '+(currentTab==='commands'?'active':'')+'" data-tab="commands">Commands <span class="badge">'+(t.commands||[]).length+'</span></button><button class="tab '+(currentTab==='files'?'active':'')+'" data-tab="files">Files <span class="badge">'+(t.filesChanged||[]).length+'</span></button><button class="tab '+(currentTab==='issues'?'active':'')+'" data-tab="issues">Issues <span class="badge '+(issues.length?'fail':'')+'">'+issues.length+'</span></button><button class="tab '+(currentTab==='raw'?'active':'')+'" data-tab="raw">Raw events</button></div>';}
  async function loadDetail(){if(!selected)return;try{var pair=await Promise.all([api('/dashboard/api/tasks/'+encodeURIComponent(selected)),api('/dashboard/api/tasks/'+encodeURIComponent(selected)+'/events')]);var t=pair[0],events=pair[1].events||[],issues=issueEvents(events);var state=taskState(t);var body=currentTab==='commands'?commandRows(t):currentTab==='files'?fileRows(t,events):currentTab==='issues'?issueRows(issues):currentTab==='raw'?rawRows(events):overview(t,events,issues);document.getElementById('detail').innerHTML='<div class="detail-head"><div><h1 class="detail-title">'+esc(t.title)+'</h1><div class="path">'+esc(t.cwd||'작업 경로 정보 없음')+'</div></div><div><span class="badge '+state.key+'">'+state.label+'</span>'+(t.automatic?' <span class="badge info">AUTO SESSION</span>':'')+'</div></div>'+tabBar(t,issues)+'<div id="tabBody">'+body+'</div>';document.querySelectorAll('[data-tab]').forEach(function(b){b.onclick=function(){currentTab=b.dataset.tab;loadDetail();};});bindCopies();}catch(e){document.getElementById('detail').innerHTML='<div class="empty">작업 상세 정보를 불러오지 못했습니다.<br>'+esc(String(e))+'</div>';}}

  async function loadPolicy(){try{var d=await api('/dashboard/api/policy');var text=JSON.stringify(d.policy||{version:1},null,2);document.getElementById('detail').innerHTML='<div class="detail-head"><div><h1 class="detail-title">Safety policy</h1><div class="path">Mode: '+esc(d.mode)+' · '+esc(d.file||'policy file 미설정')+'</div></div></div><div id="policyNotice"></div><textarea id="policyEditor" class="editor">'+esc(text)+'</textarea><div class="toolbar" style="margin-top:10px"><button id="validatePolicy" class="btn">검증</button><button id="savePolicy" class="btn primary">저장 & 즉시 반영</button><button id="reloadPolicy" class="btn">파일에서 다시 읽기</button></div><div class="section"><h3 class="section-title">변경 이력</h3><div id="policyHistory" class="tiny">불러오는 중...</div></div>';var note=function(m,c){document.getElementById('policyNotice').innerHTML='<div class="notice '+c+'">'+esc(m)+'</div>';};var loadHistory=async function(){try{var h=await api('/dashboard/api/policy/history');var verify=h.verification||{};document.getElementById('policyHistory').innerHTML='<div class="notice '+(verify.integrity?'ok':'error')+'">Audit chain: '+(verify.integrity?'verified':'BROKEN')+' · chained '+esc(verify.chainedEntries||0)+' · legacy '+esc(verify.legacyEntries||0)+'</div>'+(h.history.length?h.history.map(function(x){return '<div class="policy-card"><b>'+esc(x.action)+'</b> · '+esc(fmtTime(x.timestamp))+'<div class="row-meta">policy '+esc(x.sha256.slice(0,16))+' · '+esc(x.revisionId)+'</div><div class="toolbar" style="margin-top:8px"><button class="btn" data-diff="'+esc(x.revisionId)+'">현재와 비교</button><button class="btn" data-rollback="'+esc(x.revisionId)+'">이 버전으로 롤백</button></div><div data-diff-output="'+esc(x.revisionId)+'"></div></div>';}).join(''):'이력이 없습니다.');document.querySelectorAll('[data-diff]').forEach(function(b){b.onclick=async function(){var out=document.querySelector('[data-diff-output="'+b.dataset.diff+'"]');try{var x=await api('/dashboard/api/policy/diff/'+b.dataset.diff);out.innerHTML='<div class="diff">'+x.diff.map(function(l){return '<span class="'+(l.type==='add'?'diff-add':l.type==='remove'?'diff-remove':'')+'">'+esc(l.type==='add'?'+ '+l.line:l.type==='remove'?'- '+l.line:'  '+l.line)+'</span>';}).join(String.fromCharCode(10))+'</div>';}catch(e){out.textContent=String(e);}};});document.querySelectorAll('[data-rollback]').forEach(function(b){b.onclick=async function(){if(!confirm('이 정책 버전으로 롤백할까요?'))return;try{await api('/dashboard/api/policy/rollback/'+b.dataset.rollback,{method:'POST'});loadPolicy();}catch(e){note(String(e),'error');}};});}catch(e){document.getElementById('policyHistory').textContent='이력을 불러오지 못했습니다.';}};loadHistory();document.getElementById('validatePolicy').onclick=async function(){try{var policy=JSON.parse(document.getElementById('policyEditor').value);await api('/dashboard/api/policy/validate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(policy)});note('정책이 유효합니다.','ok');}catch(e){note(String(e),'error');}};document.getElementById('savePolicy').onclick=async function(){try{var policy=JSON.parse(document.getElementById('policyEditor').value);await api('/dashboard/api/policy',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(policy)});note('저장하고 즉시 반영했습니다.','ok');loadHistory();}catch(e){note(String(e),'error');}};document.getElementById('reloadPolicy').onclick=async function(){try{await api('/dashboard/api/policy/reload',{method:'POST'});loadPolicy();}catch(e){note(String(e),'error');}};}catch(e){document.getElementById('detail').innerHTML='<div class="empty">'+esc(String(e))+'</div>';}}

  document.getElementById('logoutBtn').onclick=async function(){await fetch('/dashboard/logout',{method:'POST'});location.href='/dashboard/login';};
  document.getElementById('policyBtn').onclick=function(){selected=null;loadTasks();loadPolicy();};
  document.getElementById('taskSearch').oninput=function(e){search=e.target.value||'';loadTasks();};
  document.querySelectorAll('[data-filter]').forEach(function(b){b.onclick=function(){filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(function(x){x.classList.toggle('active',x===b);});loadTasks();};});
  loadApprovals();loadTasks();setInterval(function(){loadApprovals();loadTasks();if(selected)loadDetail();},3000);
})();
`;
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

  app.get(`${base}/app.js`, (_request, response) => {
    response.type("application/javascript").set("Cache-Control", "no-store").send(dashboardJs);
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
