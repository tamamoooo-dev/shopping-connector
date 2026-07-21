// ops/ui.js — the Operations Console's inline UI. One self-contained HTML
// document (no external assets — the CSP in console.js allows none): the
// console must load instantly on a phone on hotel wifi.
//
// Mobile-first, one-handed: bottom tab bar, large touch targets, cards, and a
// single /api/overview read painting the whole dashboard. Served only by
// handleOps() behind authentication.

export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Brochure Engine Ops</title>
<style>
:root{
  --bg:#0b1220;--card:#111a2e;--card2:#16223c;--line:#22304f;
  --text:#e6ecf7;--mut:#8ea0bf;--acc:#4f8ef7;
  --ok:#22c55e;--warn:#f59e0b;--bad:#ef4444;--unk:#64748b;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0}
body{font:15px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  background:var(--bg);color:var(--text);min-height:100vh;
  padding-bottom:calc(66px + env(safe-area-inset-bottom))}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;
  padding:12px 16px;padding-top:calc(12px + env(safe-area-inset-top));
  background:rgba(11,18,32,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
header h1{font-size:16px;margin:0;font-weight:700;letter-spacing:.3px}
#healthChip{margin-left:auto;font-size:12px;font-weight:700;padding:4px 10px;
  border-radius:999px;background:var(--card2);border:1px solid var(--line)}
main{padding:14px;max-width:640px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
  padding:14px;margin-bottom:12px}
.card h2{font-size:13px;margin:0 0 10px;color:var(--mut);text-transform:uppercase;letter-spacing:.8px}
.row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:none}
.dot{width:10px;height:10px;border-radius:50%;flex:none}
.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}
.dot.warn{background:var(--warn)}.dot.unk{background:var(--unk)}
.badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;margin-left:auto;flex:none}
.b-ok{background:rgba(34,197,94,.15);color:var(--ok)}
.b-bad{background:rgba(239,68,68,.15);color:var(--bad)}
.b-warn{background:rgba(245,158,11,.15);color:var(--warn)}
.b-unk{background:rgba(100,116,139,.2);color:#9fb0c8}
.bar{height:8px;border-radius:99px;background:var(--card2);overflow:hidden;margin-top:6px}
.bar i{display:block;height:100%;border-radius:99px}
.mut{color:var(--mut);font-size:12px}
button{font:inherit;border:none;border-radius:12px;padding:13px;cursor:pointer;
  font-weight:700;background:var(--card2);color:var(--text);width:100%}
button:active{transform:scale(.98)}
button.primary{background:var(--acc);color:#fff}
button.danger{background:var(--bad);color:#fff}
button.ghost{background:transparent;border:1px solid var(--line)}
button:disabled{opacity:.5}
.btnGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.btnGrid .wide{grid-column:1/-1}
input[type=text],input[type=password]{font:inherit;width:100%;padding:13px;
  border-radius:12px;border:1px solid var(--line);background:var(--card2);color:var(--text)}
label.chk{display:flex;align-items:center;gap:10px;padding:10px 4px;border-bottom:1px solid var(--line);font-size:14px}
label.chk:last-child{border-bottom:none}
input[type=checkbox]{width:20px;height:20px;accent-color:var(--acc)}
nav{position:fixed;left:0;right:0;bottom:0;display:flex;z-index:6;
  background:rgba(11,18,32,.96);backdrop-filter:blur(8px);
  border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
nav button{flex:1;background:none;border-radius:0;padding:10px 0 8px;font-size:11px;
  color:var(--mut);display:flex;flex-direction:column;align-items:center;gap:3px;font-weight:600}
nav button.active{color:var(--acc)}
nav button i{font-style:normal;font-size:18px;line-height:1}
.view{display:none}.view.active{display:block}
.confRing{width:120px;height:120px;border-radius:50%;margin:6px auto 10px;display:flex;
  align-items:center;justify-content:center}
.confRing>div{background:var(--card);border-radius:50%;width:94px;height:94px;display:flex;
  flex-direction:column;align-items:center;justify-content:center;font-size:26px;font-weight:800}
.confRing span{font-size:10px;color:var(--mut);font-weight:600}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:20;display:none;
  align-items:flex-end;justify-content:center}
.overlay.open{display:flex}
.sheet{background:var(--card);border-radius:18px 18px 0 0;padding:18px;width:100%;
  max-width:640px;max-height:84vh;overflow:auto;border:1px solid var(--line);
  padding-bottom:calc(18px + env(safe-area-inset-bottom))}
.sheet h3{margin:0 0 8px}
#toast{position:fixed;left:50%;transform:translateX(-50%);bottom:86px;z-index:30;
  background:#1e293b;border:1px solid var(--line);color:var(--text);padding:10px 16px;
  border-radius:12px;font-size:13px;display:none;max-width:88vw}
#login{max-width:360px;margin:16vh auto 0;padding:0 20px}
.spin{display:inline-block;width:14px;height:14px;border:2px solid var(--mut);
  border-top-color:transparent;border-radius:50%;animation:sp 1s linear infinite;vertical-align:-2px}
@keyframes sp{to{transform:rotate(360deg)}}
pre{background:var(--card2);padding:10px;border-radius:10px;overflow-x:auto;font-size:12px;margin:8px 0}
.stepline{display:flex;gap:8px;align-items:center;padding:6px 0;font-size:14px}
h4.sec{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.8px;margin:14px 0 6px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px}
.kpi{background:var(--card2);border-radius:10px;padding:8px 6px;text-align:center}
.kpi b{display:block;font-size:16px}
.kpi span{font-size:10px;color:var(--mut)}
.errCard{border-left:3px solid var(--bad);padding-left:10px;margin:8px 0}
/* --- Operations Center additions --------------------------------------------- */
.seg{display:flex;gap:4px;background:var(--card2);border-radius:10px;padding:3px;margin-bottom:10px}
.seg button{flex:1;padding:8px;border-radius:8px;font-size:13px;font-weight:700;background:transparent;color:var(--mut)}
.seg button.on{background:var(--acc);color:#fff}
.chips{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;margin:2px 0 10px;-webkit-overflow-scrolling:touch}
.chip{flex:none;width:auto;padding:6px 11px;border-radius:999px;font-size:12px;font-weight:600;
  background:var(--card2);color:var(--mut);border:1px solid var(--line)}
.chip.on{background:rgba(79,142,247,.16);color:var(--acc);border-color:var(--acc)}
.insRow{display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line);cursor:pointer}
.insRow:last-child{border-bottom:none}
.insRow .thumb{width:42px;height:42px;border-radius:8px;object-fit:cover;background:var(--card2);flex:none}
.insRow .meta{min-width:0;flex:1}
.insRow b{font-size:13px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmp{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0}
.cmp .col{background:var(--card2);border-radius:10px;padding:10px}
.cmp .col h5{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--mut)}
.cmp .col .val{font-size:14px;word-break:break-word}
.cmp .col .val.diff{color:var(--warn);font-weight:700}
.imgWrap{text-align:center;margin:8px 0}
.imgWrap img{max-width:100%;max-height:220px;border-radius:10px;border:1px solid var(--line)}
.stage{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)}
.stage:last-child{border-bottom:none}
.stage .arrow{color:var(--mut);text-align:center;font-size:12px;padding:1px 0}
.stage .info{min-width:0;flex:1}
.stage .info b{font-size:14px}
.qgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}
.kvline{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:6px 0;border-bottom:1px solid var(--line)}
.kvline:last-child{border-bottom:none}
.kvline b{text-align:right}
.progGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:4px 0 10px}
.tag{display:inline-block;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;background:var(--card2);color:var(--mut);margin-left:6px}
.tag.run{background:rgba(34,197,94,.16);color:var(--ok)}
</style>
</head>
<body>

<div id="login" style="display:none">
  <div class="card">
    <h2 style="text-transform:none;font-size:16px;color:var(--text)">Brochure Engine Ops</h2>
    <p class="mut">Administrator access only.</p>
    <input type="password" id="tok" placeholder="Admin token (OPS_TOKEN)" autocomplete="current-password">
    <div style="height:10px"></div>
    <button class="primary" id="loginBtn">Sign in</button>
    <p class="mut" id="loginErr" style="color:var(--bad);display:none"></p>
  </div>
</div>

<div id="app" style="display:none">
<header>
  <h1>Engine Ops</h1>
  <span id="healthChip">…</span>
</header>
<main>

  <section class="view active" id="v-home">
    <div class="card" style="text-align:center">
      <h2>System Confidence</h2>
      <div class="confRing" id="confRing"><div><span class="spin"></span></div></div>
      <div id="confParts" style="text-align:left"></div>
    </div>
    <div class="card"><h2>Subsystems</h2><div id="subsys"><span class="spin"></span></div></div>
    <div class="card"><h2>Scheduler</h2><div id="sched"><span class="spin"></span></div></div>
  </section>

  <section class="view" id="v-stores">
    <div class="card"><h2>Stores · Coverage</h2><div id="storeList"><span class="spin"></span></div></div>
  </section>

  <section class="view" id="v-vision">
    <div class="card">
      <h2>Vision Progress <span id="workerTag" class="tag">…</span></h2>
      <div id="visionProg"><span class="spin"></span></div>
      <div id="drainLive" style="display:none;margin-top:8px">
        <div class="bar"><i id="drainBar" style="width:0;background:var(--acc)"></i></div>
        <div class="mut" id="drainStat" style="margin-top:4px"></div>
      </div>
      <div class="btnGrid" style="margin-top:10px">
        <button class="primary" id="drainLiveBtn">▶ Run Drain (live)</button>
        <button class="ghost" id="drainStopBtn" disabled>Stop</button>
      </div>
    </div>

    <div class="card">
      <h2>Background Vision <span id="vjTag" class="tag">idle</span></h2>
      <div class="mut" style="margin-bottom:8px">Drains the queue to empty on the server — safe to close this page; it keeps running. For backfills, maintenance, and recovery.</div>
      <div id="vjPanel"><span class="mut">No job yet.</span></div>
      <div class="btnGrid" style="margin-top:10px">
        <button class="primary" id="vjStartBtn">▶ Run Vision (background)</button>
        <button class="ghost" id="vjStopBtn" disabled>Stop</button>
      </div>
    </div>

    <div class="card">
      <h2>Inspector</h2>
      <div class="seg">
        <button data-ins="offer" class="on">Offer</button>
        <button data-ins="registry">Registry</button>
      </div>
      <div id="insOffer">
        <input type="text" id="insQ" placeholder="Search offers (OCR / vision name)…">
        <div class="chips" id="insChips">
          <span class="chip on" data-f="all">all</span>
          <span class="chip" data-f="vision-enriched">vision enriched</span>
          <span class="chip" data-f="ocr-fallback">OCR fallback</span>
          <span class="chip" data-f="unresolved">unresolved</span>
          <span class="chip" data-f="deferred">deferred</span>
          <span class="chip" data-f="reviewed">reviewed</span>
          <span class="chip" data-f="low-confidence">low confidence</span>
          <span class="chip" data-f="missing-product">missing productId</span>
        </div>
        <div id="insList"><span class="mut">Search or pick a filter above.</span></div>
      </div>
      <div id="insRegistry" style="display:none">
        <input type="text" id="regQ" placeholder="Search by productId, name, or brand…">
        <div style="height:10px"></div>
        <div id="regList"><span class="mut">Type to search the registry.</span></div>
      </div>
    </div>

    <div class="card">
      <h2>Queue Monitor</h2>
      <div id="queueOut"><span class="spin"></span></div>
      <div class="btnGrid" style="margin-top:10px">
        <button id="qResolveBtn">Resolve Backlog</button>
        <button id="qReopenBtn">Re-open Deferred</button>
      </div>
    </div>
  </section>

  <section class="view" id="v-ops">
    <div class="card">
      <h2>Manual Operations</h2>
      <div class="btnGrid">
        <button class="primary wide" data-op="repair">🔧 Repair Unhealthy Stores</button>
        <button data-op="all">Run All Stores</button>
        <button data-op="retry-failed">Retry Failed</button>
        <button data-op="offers">Offers Only</button>
        <button data-op="brochures">Brochures Only</button>
        <button data-op="selected">Run Selected</button>
        <button id="verifyBtn">Verify Coverage</button>
        <button id="enrichBtn">Vision Drain</button>
        <button id="resolveBtn">Resolve Queue</button>
        <button id="maintainBtn">Repair Registry</button>
        <button class="danger wide" id="healBtn">⚠ Emergency Heal</button>
      </div>
      <label class="chk" style="border:none;margin-top:8px">
        <input type="checkbox" id="notifyChk"> Send notification when done
      </label>
    </div>
    <div class="card"><h2>Select Stores</h2><div id="storeChecks"><span class="spin"></span></div></div>
    <div class="card" id="opsReportCard" style="display:none"><h2>Last Run Report</h2><div id="opsReport"></div></div>
  </section>

  <section class="view" id="v-more">
    <div class="card"><h2>Pipeline Health</h2><div id="pipeOut"><span class="spin"></span></div></div>
    <div class="card"><h2>Cron Monitor</h2><div id="cronOut"><span class="spin"></span></div></div>
    <div class="card"><h2>Diagnostics · Latency</h2><div id="diag2Out"><span class="spin"></span></div></div>
    <div class="card">
      <h2>Self Test</h2>
      <button class="primary" id="selftestBtn">Run Self Test</button>
      <div id="selftestOut" style="margin-top:10px"></div>
    </div>
    <div class="card"><h2>Diagnostics</h2><div id="diagOut"><span class="spin"></span></div></div>
    <div class="card"><h2>Audit Timeline</h2><div id="auditOut"><span class="spin"></span></div></div>
    <div class="card"><button class="ghost" id="logoutBtn">Sign out</button></div>
  </section>

</main>
<nav>
  <button data-v="home" class="active"><i>◉</i>Home</button>
  <button data-v="stores"><i>▤</i>Stores</button>
  <button data-v="vision"><i>◎</i>Vision</button>
  <button data-v="ops"><i>▶</i>Ops</button>
  <button data-v="more"><i>≡</i>More</button>
</nav>
</div>

<div class="overlay" id="ovl"><div class="sheet" id="sheet"></div></div>
<div id="toast"></div>

<script>
"use strict";
var BASE = "/__ops/api/";
var $ = function (s) { return document.querySelector(s); };
var esc = function (s) {
  return String(s == null ? "—" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
};

function toast(msg, bad) {
  var t = $("#toast");
  t.textContent = msg;
  t.style.borderColor = bad ? "var(--bad)" : "var(--line)";
  t.style.display = "block";
  clearTimeout(t._h);
  t._h = setTimeout(function () { t.style.display = "none"; }, 4200);
}

function api(path, opts) {
  opts = opts || {};
  if (opts.body) {
    opts.method = "POST";
    opts.headers = { "content-type": "application/json" };
    opts.body = JSON.stringify(opts.body);
  }
  return fetch(BASE + path, opts).then(function (r) {
    return r.json().catch(function () { return { error: "bad response" }; }).then(function (j) {
      if (r.status === 401 && path !== "login") { showLogin(); throw new Error("unauthorized"); }
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      return j;
    });
  });
}

/* ---------- auth ---------- */
function showLogin() { $("#app").style.display = "none"; $("#login").style.display = "block"; }
function showApp() { $("#login").style.display = "none"; $("#app").style.display = "block"; loadOverview(); loadMore(); }
$("#loginBtn").onclick = function () {
  var b = $("#loginBtn"); b.disabled = true;
  api("login", { body: { token: $("#tok").value } }).then(function () {
    $("#tok").value = ""; showApp();
  }).catch(function (e) {
    var el = $("#loginErr"); el.textContent = e.message; el.style.display = "block";
  }).finally(function () { b.disabled = false; });
};
$("#tok").addEventListener("keydown", function (e) { if (e.key === "Enter") $("#loginBtn").click(); });
$("#logoutBtn").onclick = function () { api("logout", { body: {} }).finally(showLogin); };

/* ---------- tabs + live poller ---------- */
var POLL = null;
function stopPoll() { if (POLL) { clearInterval(POLL); POLL = null; } }
function startPoll(fn, ms) {
  stopPoll();
  fn();
  POLL = setInterval(function () { if (!document.hidden) fn(); }, ms);
}
document.addEventListener("visibilitychange", function () {
  // Refresh immediately on return so a backgrounded tab isn't left stale.
  if (!document.hidden && POLL && $("#v-vision").classList.contains("active")) loadProgress();
});

document.querySelectorAll("nav button").forEach(function (b) {
  b.onclick = function () {
    document.querySelectorAll("nav button").forEach(function (x) { x.classList.remove("active"); });
    document.querySelectorAll(".view").forEach(function (x) { x.classList.remove("active"); });
    b.classList.add("active");
    $("#v-" + b.dataset.v).classList.add("active");
    stopPoll();
    if (b.dataset.v === "home" || b.dataset.v === "stores") loadOverview();
    if (b.dataset.v === "vision") { loadQueue(); loadVisionJob(); startPoll(function () { loadProgress(); loadVisionJob(); }, 5000); }
    if (b.dataset.v === "more") { loadMore(); loadMoreOps(); }
  };
});

/* ---------- shared render helpers ---------- */
var STATUS_COLOR = { OK: "var(--ok)", LOW_COVERAGE: "var(--warn)", STALE: "var(--warn)", NO_FLYER: "var(--bad)", FAIL: "var(--bad)" };
var STATUS_BADGE = { OK: "b-ok", LOW_COVERAGE: "b-warn", STALE: "b-warn", NO_FLYER: "b-bad", FAIL: "b-bad" };
function statusBadge(s) {
  var cls = STATUS_BADGE[s] || (s === "PASS" ? "b-ok" : s === "FAIL" ? "b-bad" : s === "UNCONFIGURED" || s === "UNKNOWN" ? "b-unk" : "b-warn");
  return '<span class="badge ' + cls + '">' + esc(s).replace("_", " ") + "</span>";
}
function scoreColor(p) { return p == null ? "var(--unk)" : p >= 90 ? "var(--ok)" : p >= 70 ? "var(--warn)" : "var(--bad)"; }
function ago(iso) {
  if (!iso) return "never";
  var t = Date.parse(iso);
  if (isNaN(t)) return String(iso);
  var s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return Math.round(s) + "s ago";
  if (s < 5400) return Math.round(s / 60) + "m ago";
  if (s < 172800) return (s / 3600).toFixed(1) + "h ago";
  return Math.round(s / 86400) + "d ago";
}
function ms(v) { return v == null ? "—" : v >= 10000 ? (v / 1000).toFixed(1) + "s" : v + "ms"; }

/* ---------- overview (Home + Stores) ---------- */
var OVERVIEW = null;
function loadOverview() {
  return api("overview").then(function (o) {
    OVERVIEW = o;
    renderHome(o);
    renderStores(o);
  }).catch(function (e) { if (e.message !== "unauthorized") toast(e.message, true); });
}

function renderHome(o) {
  var conf = o.confidence;
  var col = scoreColor(conf.score);
  $("#healthChip").textContent = "Health " + o.healthPct + "%";
  $("#healthChip").style.color = scoreColor(o.healthPct);
  var ring = $("#confRing");
  ring.style.background = "conic-gradient(" + col + " " + conf.score * 3.6 + "deg, var(--card2) 0)";
  ring.innerHTML = "<div><b style='color:" + col + "'>" + conf.score + "%</b><span>confidence</span></div>";
  $("#confParts").innerHTML = conf.components.map(function (c) {
    var cc = scoreColor(c.score);
    return '<div class="row" style="display:block">' +
      '<div style="display:flex;justify-content:space-between;font-size:13px"><span>' + esc(c.label) +
      ' <span class="mut">· ' + c.weight + '%</span></span><b style="color:' + cc + '">' +
      (c.score == null ? "n/a" : c.score + "%") + "</b></div>" +
      '<div class="bar"><i style="width:' + (c.score || 0) + "%;background:" + cc + '"></i></div>' +
      '<div class="mut">' + esc(c.detail) + "</div></div>";
  }).join("");

  $("#subsys").innerHTML = o.checks.map(function (x) {
    var d = x.status === "PASS" ? "ok" : x.status === "FAIL" ? "bad" : "unk";
    return '<div class="row"><span class="dot ' + d + '"></span><span>' + esc(x.name) +
      (x.detail ? ' <span class="mut">· ' + esc(x.detail) + "</span>" : "") + "</span>" + statusBadge(x.status) + "</div>";
  }).join("");

  var s = o.scheduler;
  $("#sched").innerHTML =
    s.crons.map(function (c) {
      return '<div class="row"><span>' + esc(c.name) + ' <span class="mut">' + esc(c.cron) + '</span></span>' +
        '<span class="mut" style="margin-left:auto">next ' + (c.nextRun ? ago(c.nextRun).replace(" ago", "").replace("-", "") + " → " + esc(c.nextRun.slice(0, 16).replace("T", " ")) + "Z" : "—") + "</span></div>";
    }).join("") +
    '<div class="row"><span>Last run</span><span class="mut" style="margin-left:auto">' +
    (s.lastRuns[0] ? esc(s.lastRuns[0].action) + " · " + ago(s.lastRuns[0].ts) : "none recorded") + "</span>" +
    statusBadge(s.healthy === null ? "UNKNOWN" : s.healthy ? "PASS" : "FAIL") + "</div>";
}

function renderStores(o) {
  $("#storeList").innerHTML = o.stores.map(function (r) {
    var col = STATUS_COLOR[r.status];
    return '<div class="row" style="display:block;cursor:pointer" data-store="' + esc(r.store) + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:center"><b>' + esc(r.label) + "</b>" + statusBadge(r.status) + "</div>" +
      '<div class="mut">' + r.currentFlyers + " flyers · " + r.hotspots + " hotspots · " + r.clickable + " clickable · " + r.offers + " offers" +
      " · ingest " + ago(r.lastOkAt || r.lastDetectedAt) + (r.lastOkMs ? " (" + ms(r.lastOkMs) + ")" : "") + "</div>" +
      (r.lastError ? '<div class="mut" style="color:var(--bad)">' + esc(r.lastError) + "</div>" : "") +
      '<div class="bar"><i style="width:' + (r.coverage || 0) + "%;background:" + col + '"></i></div>' +
      '<div style="display:flex;justify-content:space-between"><span class="mut">coverage</span><b style="color:' + col + '">' +
      (r.coverage == null ? "n/a" : r.coverage + "%") + "</b></div></div>";
  }).join("") || '<span class="mut">No providers registered</span>';
  document.querySelectorAll("#storeList [data-store]").forEach(function (el) {
    el.onclick = function () { openStore(el.dataset.store); };
  });
  $("#storeChecks").innerHTML = o.stores.slice().sort(function (a, b) { return a.store < b.store ? -1 : 1; }).map(function (r) {
    return '<label class="chk"><input type="checkbox" value="' + esc(r.store) + '"> ' + esc(r.label) +
      ' <span class="mut" style="margin-left:auto">' + esc(r.status).replace("_", " ") + "</span></label>";
  }).join("");
}

/* ---------- store inspector (bottom sheet) ---------- */
function openSheet(html) { $("#sheet").innerHTML = html; $("#ovl").classList.add("open"); }
$("#ovl").addEventListener("click", function (e) { if (e.target === this) this.classList.remove("open"); });

function openStore(id) {
  openSheet('<span class="spin"></span>');
  api("store?id=" + encodeURIComponent(id)).then(function (s) {
    openSheet(
      '<h3>' + esc(s.label) + " " + statusBadge(s.status) + "</h3>" +
      '<div class="kpis">' +
      '<div class="kpi"><b>' + s.hotspots + "</b><span>hotspots</span></div>" +
      '<div class="kpi"><b>' + s.clickable + "</b><span>clickable</span></div>" +
      '<div class="kpi"><b>' + s.offers + "</b><span>offers</span></div>" +
      '<div class="kpi"><b style="color:' + STATUS_COLOR[s.status] + '">' + (s.coverage == null ? "n/a" : s.coverage + "%") + "</b><span>coverage</span></div>" +
      "</div>" +
      '<h4 class="sec">Current flyers</h4>' +
      (s.flyers.length ? s.flyers.map(function (f) {
        return '<div class="row" style="display:block"><b>' + esc(f.edition) + "</b>" +
          '<div class="mut">flyer ' + esc(f.flyerRef) + " · " + esc(f.sourceType) + " · valid to " + esc(f.validTo) +
          " · " + f.hotspots + " spots / " + f.clickable + " clickable</div>" +
          '<div class="mut">detected ' + ago(f.detectedAt) + " · " + esc(f.id) + "</div></div>";
      }).join("") : '<span class="mut">none held</span>') +
      '<h4 class="sec">Ingest runs</h4>' +
      (s.runs.length ? s.runs.map(function (r) {
        return '<div class="row"><span class="dot ' + (r.ok ? "ok" : "bad") + '"></span><div style="min-width:0"><b>' + esc(r.action) + "</b> <span class='mut'>· " + esc(r.origin) + "</span>" +
          '<div class="mut">' + ago(r.ts) + " · " + ms(r.elapsed_ms) + (r.error ? ' · <span style="color:var(--bad)">' + esc(r.error) + "</span>" : "") + "</div></div>" +
          statusBadge(r.ok ? "PASS" : "FAIL") + "</div>";
      }).join("") : '<span class="mut">none recorded</span>') +
      '<h4 class="sec">Edition history</h4>' +
      (s.history.length ? "<pre>" + s.history.map(function (h) {
        return esc(h.edition) + (h.current ? "  (current)" : h.pruned ? "  (pruned)" : "");
      }).join("\\n") + "</pre>" : '<span class="mut">none</span>') +
      '<div style="height:8px"></div><button class="primary" id="runOneBtn">Run ingest for this store</button>'
    );
    $("#runOneBtn").onclick = function () {
      $("#ovl").classList.remove("open");
      confirmAndRun($("#runOneBtn"), { op: "store", stores: [s.store] }, "Run " + s.label,
        "Triggers a live brochure + offers ingest for " + s.label + " through the production pipeline. Continue?", false);
    };
  }).catch(function (e) { openSheet('<p style="color:var(--bad)">' + esc(e.message) + "</p>"); });
}

/* ---------- operations ---------- */
function confirmSheet(title, msg, danger, typed) {
  return new Promise(function (res) {
    openSheet(
      "<h3>" + esc(title) + "</h3><p class='mut'>" + esc(msg) + "</p>" +
      (typed ? '<input type="text" id="typedC" placeholder="Type ' + typed + ' to confirm" autocapitalize="characters"><div style="height:10px"></div>' : "") +
      '<div class="btnGrid"><button class="ghost" id="cNo">Cancel</button>' +
      '<button class="' + (danger ? "danger" : "primary") + '" id="cYes">Confirm</button></div>'
    );
    var close = function (v) { $("#ovl").classList.remove("open"); res(v); };
    $("#cNo").onclick = function () { close(false); };
    $("#cYes").onclick = function () {
      if (typed && $("#typedC").value.trim() !== typed) { toast("Type " + typed + " to confirm", true); return; }
      close(true);
    };
  });
}

function selectedStores() {
  return Array.prototype.slice.call(document.querySelectorAll("#storeChecks input:checked"))
    .map(function (x) { return x.value; });
}

function renderReport(r) {
  $("#opsReportCard").style.display = "block";
  var html = '<div class="row"><b>' + esc(r.action) + "</b>" + statusBadge(r.ok ? "PASS" : "FAIL") + "</div>";
  if (r.nothingToDo) {
    html += '<div class="mut">' + esc(r.message) + "</div>";
  } else if (r.action === "ops:enrich") {
    html += '<div class="mut">queue: ' + esc(r.pending) + " · batches: " + esc(r.batches) +
      " · enriched: " + esc(r.enriched) + " · remaining: " + (r.remaining == null ? "n/a" : esc(r.remaining)) +
      " · elapsed: " + ms(r.elapsedMs) + "</div>";
  } else {
    html += '<div class="mut">stores: ' + (r.targets || []).length + " · elapsed: " + ms(r.elapsedMs) +
      (r.verification && r.verification.coverage != null ? " · avg coverage: " + r.verification.coverage + "%" : "") + "</div>";
  }
  if (r.steps) {
    html += '<h4 class="sec">Pipeline</h4>' + r.steps.map(function (s) {
      return '<div class="stepline"><span class="dot ' + (s.ok ? "ok" : "bad") + '"></span>' + esc(s.name) +
        '<span class="mut" style="margin-left:auto">' + ms(s.elapsedMs) + "</span></div>" +
        (!s.ok ? '<div class="mut" style="color:var(--bad)">' + esc(typeof s.detail === "string" ? s.detail : JSON.stringify(s.detail)) + "</div>" : "");
    }).join("");
  }
  if (r.fanout && r.fanout.length) {
    var bad = r.fanout.filter(function (s) { return !s.ok; });
    if (bad.length) {
      html += '<h4 class="sec">Dispatch failures</h4>' + bad.map(function (s) {
        return '<div class="mut" style="color:var(--bad)">' + esc(s.store) + ": " + esc(s.error) + "</div>";
      }).join("");
    }
  }
  var v = r.verification;
  if (v && v.lines && v.lines.length) {
    html += '<h4 class="sec">Verification</h4>' + v.lines.map(function (x) {
      return '<div class="row"><span class="dot ' + (x.pass ? "ok" : "bad") + '"></span><div><b>' + esc(x.label || x.store) + "</b>" +
        '<div class="mut">hotspots ' + esc(x.hotspots) + " · clickable " + esc(x.clickable) + " · offers " + esc(x.offers) +
        " · coverage " + (x.coverage == null ? "n/a" : x.coverage + "%") + "</div></div>" +
        statusBadge(x.pass ? "PASS" : x.status) + "</div>";
    }).join("");
  }
  if (r.health) {
    html += '<div class="row"><span>Final health</span><b style="margin-left:auto;color:' + scoreColor(r.health.confidence) + '">' +
      r.health.healthPct + "% health · " + r.health.confidence + "% confidence</b></div>";
  }
  $("#opsReport").innerHTML = html;
  $("#opsReportCard").scrollIntoView({ behavior: "smooth" });
}

function confirmAndRun(btn, body, title, msg, danger, typed, path) {
  confirmSheet(title, msg, danger, typed).then(function (okc) {
    if (!okc) return;
    btn.disabled = true;
    var old = btn.textContent;
    btn.innerHTML = '<span class="spin"></span>';
    body.notify = $("#notifyChk").checked;
    body.confirm = typed || true;
    api(path || "run", { body: body }).then(function (r) {
      renderReport(r);
      toast(r.ok ? (r.nothingToDo ? r.message : "Done — verification passed") : "Completed with failures", !r.ok);
      loadOverview();
      loadMore();
    }).catch(function (e) { toast(e.message, true); })
      .finally(function () { btn.disabled = false; btn.textContent = old; });
  });
}

var OP_LABELS = {
  repair: ["Repair Unhealthy Stores", "Detects stores with failed ingests, missing/stale flyers or weak coverage, and re-runs the production pipeline for ONLY those stores."],
  all: ["Run All Stores", "Triggers the full brochure + offers ingest for EVERY registered store via the scheduler fan-out."],
  "retry-failed": ["Retry Failed", "Re-runs only the stores whose last ingest failed or that hold no flyer."],
  offers: ["Offers Only", "Re-ingests structured offers (no brochure downloads). Uses selected stores, or all when none selected."],
  brochures: ["Brochures Only", "Re-ingests brochures (no offers pull). Uses selected stores, or all when none selected."],
  selected: ["Run Selected", "Full ingest for the stores ticked below."]
};

document.querySelectorAll("[data-op]").forEach(function (b) {
  b.onclick = function () {
    var op = b.dataset.op;
    var body = { op: op };
    var sel = selectedStores();
    if (op === "selected") {
      if (!sel.length) { toast("Tick at least one store below", true); return; }
      body.stores = sel;
    } else if ((op === "offers" || op === "brochures") && sel.length) {
      body.stores = sel;
    }
    var n = body.stores ? body.stores.length + " selected store(s)" : op === "all" ? "ALL stores" : "auto-detected stores";
    confirmAndRun(b, body, OP_LABELS[op][0], OP_LABELS[op][1] + " Target: " + n + ".", false);
  };
});

$("#enrichBtn").onclick = function () {
  confirmAndRun($("#enrichBtn"), {},
    "Vision Drain",
    "Developer tool: runs one enrichment drain NOW (up to 4 batches of 15, resolution included) — the exact code the 10/30/50 cron fires. Normal coverage is autonomous; use this for testing or exceptional catch-up.",
    false, null, "enrich");
};

$("#verifyBtn").onclick = function () {
  var b = $("#verifyBtn"); b.disabled = true;
  var body = selectedStores().length ? { stores: selectedStores() } : {};
  api("verify", { body: body }).then(function (r) { renderReport(r); })
    .catch(function (e) { toast(e.message, true); })
    .finally(function () { b.disabled = false; });
};

$("#healBtn").onclick = function () {
  confirmAndRun($("#healBtn"), {},
    "Emergency Heal",
    "Runs the COMPLETE production repair pipeline on all stores: verify, brochure + offers ingest fan-out, coverage validation, hotspot validation, notification, final verification.",
    true, "HEAL", "heal");
};

/* ---------- More tab ---------- */
function loadMore() {
  api("diagnostics").then(function (d) {
    var errCard = function (label, e) {
      if (!e) return '<div class="mut">' + label + ": none 🎉</div>";
      return '<div class="errCard"><b>' + label + "</b> · " + esc(e.action) + ' <span class="mut">· ' + ago(e.ts) + "</span>" +
        '<div class="mut" style="color:var(--bad)">' + esc(e.error || "failed") + "</div></div>";
    };
    var c = d.counts;
    $("#diagOut").innerHTML =
      errCard("Latest error", d.latestError) +
      errCard("Previous error", d.previousError) +
      '<div class="row"><span>Current flyers held</span><b style="margin-left:auto">' + c.currentFlyers + "</b></div>" +
      (c.offers ? '<div class="row"><span>Offers (current / total)</span><b style="margin-left:auto">' + c.offers.current + " / " + c.offers.total + "</b></div>" : "") +
      (c.priceHistory ? '<div class="row"><span>Price history</span><b style="margin-left:auto">' + c.priceHistory.identities + " ids · " + c.priceHistory.points + " pts</b></div>" : "");
  }).catch(function () {});
  api("audit?limit=30").then(function (a) {
    $("#auditOut").innerHTML = (a.runs || []).map(function (r) {
      return '<div class="row"><span class="dot ' + (r.ok ? "ok" : "bad") + '"></span><div style="min-width:0"><b>' + esc(r.action) + "</b>" +
        ' <span class="mut">· ' + esc(r.origin) + (r.store ? " · " + esc(r.store) : r.stores ? " · " + r.stores + " stores" : "") + "</span>" +
        '<div class="mut">' + ago(r.ts) + " · " + ms(r.elapsed_ms) +
        (r.coverage != null ? " · coverage " + r.coverage + "%" : "") +
        (r.offers != null ? " · " + r.offers + " offers" : "") + "</div>" +
        (r.error ? '<div class="mut" style="color:var(--bad)">' + esc(r.error) + "</div>" : "") + "</div>" +
        statusBadge(r.ok ? "PASS" : "FAIL") + "</div>";
    }).join("") || '<span class="mut">No runs recorded yet</span>';
  }).catch(function () {});
}

$("#selftestBtn").onclick = function () {
  var b = $("#selftestBtn"); b.disabled = true;
  $("#selftestOut").innerHTML = '<span class="spin"></span>';
  api("selftest", { body: {} }).then(function (r) {
    $("#selftestOut").innerHTML =
      '<div class="mut" style="margin-bottom:6px">completed in ' + ms(r.elapsedMs) + " · health " + r.healthPct + "% · confidence " + r.confidence.score + "%</div>" +
      r.checks.map(function (x) {
        var d = x.status === "PASS" ? "ok" : x.status === "FAIL" ? "bad" : "unk";
        return '<div class="row"><span class="dot ' + d + '"></span>' + esc(x.name) +
          (x.detail ? ' <span class="mut">· ' + esc(x.detail) + "</span>" : "") + statusBadge(x.status) + "</div>";
      }).join("");
    loadOverview();
  }).catch(function (e) { $("#selftestOut").innerHTML = '<span style="color:var(--bad)">' + esc(e.message) + "</span>"; })
    .finally(function () { b.disabled = false; });
};

/* ---------- Vision tab: Progress (§1) ---------- */
function kpiBox(v, l) { return '<div class="kpi"><b>' + esc(v) + "</b><span>" + esc(l) + "</span></div>"; }
function kvl(l, v) { return '<div class="kvline"><span class="mut">' + esc(l) + '</span><b dir="auto">' + esc(v) + "</b></div>"; }
function tsShort(iso) { return iso ? esc(iso.slice(0, 16).replace("T", " ")) + "Z" : "—"; }
function norm(s) { return String(s == null ? "" : s).trim().toLowerCase(); }
function fmtDur(h) {
  if (h == null) return "n/a";
  if (h < 1) return Math.round(h * 60) + "m";
  if (h < 48) return h.toFixed(1) + "h";
  return Math.round(h / 24) + "d";
}
function loadProgress() { return api("progress").then(renderProgress).catch(function () {}); }
function renderProgress(p) {
  var tag = $("#workerTag");
  tag.textContent = p.worker === "running" ? "running" : "idle";
  tag.className = "tag" + (p.worker === "running" ? " run" : "");
  $("#visionProg").innerHTML =
    '<div class="progGrid">' +
      kpiBox(p.offers.current, "current offers") +
      kpiBox(p.enriched, "enriched") +
      kpiBox(p.remaining, "remaining") +
      kpiBox(p.coverage == null ? "n/a" : p.coverage + "%", "coverage") +
      kpiBox(p.registryProducts, "registry products") +
      kpiBox(p.sightings, "sightings") +
    "</div>" +
    '<div class="bar"><i style="width:' + (p.coverage || 0) + "%;background:" + scoreColor(p.coverage) + '"></i></div>' +
    '<div style="height:8px"></div>' +
    kvl("Servable / declined", p.servable + " / " + p.declined) +
    kvl("Enrichment rate", p.rate == null ? "—" : p.rate + " offers/hr") +
    kvl("Est. time remaining", fmtDur(p.etaHours)) +
    kvl("Queue depth", p.queueDepth) +
    kvl("Last enrich cron", p.lastCron ? ago(p.lastCron.ts) : "never") +
    kvl("Next enrich cron", p.nextCron ? tsShort(p.nextCron) : "—") +
    providerLimitHtml(p.providerLimit);
}

/* live client-driven drain — one batch per call, real progress (§1) */
var drainStop = false, drainBusy = false;
$("#drainLiveBtn").onclick = function () {
  confirmSheet("Run Vision Drain (live)",
    "Runs the enrichment drain one batch at a time from here with live progress — identical code to the enrich cron. Safe to stop anytime.",
    false).then(function (ok) { if (ok) runLiveDrain(); });
};
$("#drainStopBtn").onclick = function () { drainStop = true; };
function runLiveDrain() {
  if (drainBusy) return;
  drainBusy = true; drainStop = false;
  $("#drainLive").style.display = "block";
  $("#drainLiveBtn").disabled = true; $("#drainStopBtn").disabled = false;
  var t0 = Date.now(), total = null, processed = 0, batch = 0;
  function finish(msg) {
    drainBusy = false;
    $("#drainLiveBtn").disabled = false; $("#drainStopBtn").disabled = true;
    $("#drainStat").innerHTML += " — " + esc(msg);
    toast("Drain " + msg);
    loadProgress(); loadQueue();
  }
  function step() {
    if (drainStop) { finish("stopped"); return; }
    api("enrich", { body: { batches: 1, confirm: true } }).then(function (r) {
      batch += 1;
      if (r.nothingToDo) { finish("queue empty"); return; }
      if (total == null) total = r.pending || 0;
      var rem = r.remaining == null ? total : r.remaining;
      processed = Math.max(processed, total - rem);
      var pct = total ? Math.min(100, Math.round((processed / total) * 100)) : 100;
      var el = (Date.now() - t0) / 1000;
      var rate = processed > 0 ? processed / (el / 3600) : 0;
      var etaH = rate > 0 && rem > 0 ? rem / rate : 0;
      $("#drainBar").style.width = pct + "%";
      $("#drainStat").innerHTML = "batch " + batch + " · " + processed + "/" + total +
        " (" + pct + "%) · " + Math.round(el) + "s · ETA " + (etaH ? fmtDur(etaH) : "~");
      loadProgress();
      if (rem > 0 && batch < 40) step(); else finish("done");
    }).catch(function (e) { finish(e.message || "error"); });
  }
  step();
}

/* ---------- Vision tab: Background Manual Vision job (§2) ---------- */
function providerLimitHtml(pl) {
  if (!pl) return "";
  var bits = [];
  if (pl.status != null) bits.push("HTTP " + pl.status);
  if (pl.remaining != null) bits.push("remaining " + pl.remaining);
  if (pl.limit != null) bits.push("limit " + pl.limit);
  if (pl.retryAfter != null) bits.push("retry-after " + pl.retryAfter + "s");
  var resume = "";
  if (pl.retryAfter != null && pl.observedAt) {
    resume = kvl("Auto-resume ~", tsShort(new Date(Date.parse(pl.observedAt) + pl.retryAfter * 1000).toISOString()));
  }
  return '<div style="height:8px"></div>' +
    '<div class="mut" style="margin-bottom:4px">⏳ Provider rate limit (Mistral free tier) — waiting, then resuming automatically.</div>' +
    kvl("Signal", bits.join(" · ") || "seen") + resume +
    '<div class="mut" style="margin-top:4px">Exact account quota lives in Mistral Admin Console → Limits.</div>';
}
function loadVisionJob() { return api("vision/job").then(renderVisionJob).catch(function () {}); }
function renderVisionJob(r) {
  var j = r && r.job;
  var st = j ? j.status : "idle";
  var tag = $("#vjTag");
  tag.textContent = st;
  tag.className = "tag" + (st === "running" ? " run" : "");
  $("#vjStartBtn").disabled = st === "running";
  $("#vjStopBtn").disabled = st !== "running";
  if (!j) { $("#vjPanel").innerHTML = '<span class="mut">No job yet.</span>'; return; }
  var total = j.total || 0, processed = j.processed || 0;
  var pct = total ? Math.min(100, Math.round((processed / total) * 100)) : (st === "done" ? 100 : 0);
  var barCol = st === "error" ? "var(--bad)" : st === "done" ? "var(--ok)" : "var(--acc)";
  $("#vjPanel").innerHTML =
    '<div class="bar"><i style="width:' + pct + "%;background:" + barCol + '"></i></div>' +
    '<div style="height:8px"></div>' +
    kvl("Status", st) +
    kvl("Processed", processed + " / " + total + " (" + pct + "%)") +
    kvl("Enriched / declined", (j.enriched || 0) + " / " + (j.declined || 0)) +
    kvl("Failed (skipped)", j.failed || 0) +
    kvl("Remaining", j.remaining == null ? "—" : j.remaining) +
    kvl("Batches (hops)", j.hops || 0) +
    kvl("Started", j.started_at ? ago(j.started_at) : "—") +
    (j.finished_at ? kvl("Finished", ago(j.finished_at)) : "") +
    (j.last_error ? kvl("Last error", j.last_error) : "") +
    providerLimitHtml(j.provider_limit);
}
$("#vjStartBtn").onclick = function () {
  confirmSheet("Run Vision (background)",
    "Drains the Vision queue to empty as a server-side job — you can close this page and it keeps going. Intended for backfills, maintenance, and recovery.",
    false).then(function (ok) {
      if (!ok) return;
      api("vision/start", { body: { confirm: true, scope: "all" } }).then(function (r) {
        if (r.nothingToDo) toast("Vision queue empty");
        else if (r.alreadyRunning) toast("A job is already running");
        else toast("Vision job started");
        loadVisionJob();
      }).catch(function (e) { toast(e.message || "error", true); });
    });
};
$("#vjStopBtn").onclick = function () {
  api("vision/stop", { body: {} }).then(function () { toast("Stopping…"); loadVisionJob(); })
    .catch(function (e) { toast(e.message || "error", true); });
};

/* ---------- Vision tab: Inspector (§2/§3) ---------- */
$("#v-vision").querySelectorAll(".seg button").forEach(function (b) {
  b.onclick = function () {
    $("#v-vision").querySelectorAll(".seg button").forEach(function (x) { x.classList.remove("on"); });
    b.classList.add("on");
    var reg = b.dataset.ins === "registry";
    $("#insOffer").style.display = reg ? "none" : "block";
    $("#insRegistry").style.display = reg ? "block" : "none";
  };
});
var insFilter = "all", insQTimer;
$("#insChips").querySelectorAll(".chip").forEach(function (c) {
  c.onclick = function () {
    $("#insChips").querySelectorAll(".chip").forEach(function (x) { x.classList.remove("on"); });
    c.classList.add("on"); insFilter = c.dataset.f; loadInspector();
  };
});
$("#insQ").addEventListener("input", function () { clearTimeout(insQTimer); insQTimer = setTimeout(loadInspector, 300); });
function insBadge(it) {
  if (it.s_match_band) return statusBadge(String(it.s_match_band).toUpperCase());
  if (it.e_servable) return '<span class="badge b-ok">vision</span>';
  if (it.e_enriched_at != null) return '<span class="badge b-warn">ocr</span>';
  return '<span class="badge b-unk">raw</span>';
}
function loadInspector() {
  $("#insList").innerHTML = '<span class="spin"></span>';
  var q = $("#insQ").value.trim();
  api("inspector?filter=" + encodeURIComponent(insFilter) + "&q=" + encodeURIComponent(q)).then(function (d) {
    if (!d.items.length) { $("#insList").innerHTML = '<span class="mut">No offers match.</span>'; return; }
    $("#insList").innerHTML = d.items.map(function (it) {
      var name = it.e_name || it.o_name || it.e_name_ar || it.o_name_ar || it.id;
      return '<div class="insRow" data-id="' + esc(it.id) + '">' +
        (it.image_url ? '<img class="thumb" src="' + esc(it.image_url) + '" loading="lazy" alt="">' : '<div class="thumb"></div>') +
        '<div class="meta"><b dir="auto">' + esc(name) + "</b>" +
        '<div class="mut">' + esc(it.store) + (it.price != null ? " · " + esc(it.price) + " " + esc(it.currency || "") : "") +
        (it.e_corroboration != null ? " · cor " + esc(it.e_corroboration) : "") + "</div></div>" +
        insBadge(it) + "</div>";
    }).join("");
    $("#insList").querySelectorAll(".insRow").forEach(function (r) { r.onclick = function () { openInspect(r.dataset.id); }; });
  }).catch(function (e) { $("#insList").innerHTML = '<span style="color:var(--bad)">' + esc(e.message) + "</span>"; });
}
function openInspect(id) {
  openSheet('<span class="spin"></span>');
  api("inspect?id=" + encodeURIComponent(id)).then(function (d) {
    openSheet(renderInspect(d));
    var pb = $("#openProdBtn"); if (pb) pb.onclick = function () { openProduct(pb.dataset.pid); };
  }).catch(function (e) { openSheet('<p style="color:var(--bad)">' + esc(e.message) + "</p>"); });
}
function cmpCol(title, name, nameAr, ident, diff) {
  return '<div class="col"><h5>' + esc(title) + "</h5>" +
    '<div class="val' + (diff ? " diff" : "") + '" dir="auto">' + esc(name || nameAr || "—") + "</div>" +
    (name && nameAr ? '<div class="val" dir="auto" style="font-size:12px;color:var(--mut)">' + esc(nameAr) + "</div>" : "") +
    (ident ? '<div class="mut" style="margin-top:6px">id ' + esc(ident.id) + "</div>" : "") + "</div>";
}
function renderInspect(d) {
  var o = d.offer, ocr = d.ocr, vis = d.vision, s = d.sighting, p = d.product;
  var diff = !!vis && (norm(ocr.name) !== norm(vis.name) || norm(ocr.nameAr) !== norm(vis.nameAr));
  var h = '<h3 dir="auto">' + esc((vis && vis.name) || ocr.name || o.id) + "</h3>";
  if (o.imageUrl) h += '<div class="imgWrap"><img src="' + esc(o.imageUrl) + '" alt=""></div>';
  h += '<div class="cmp">' +
    cmpCol("OCR read", ocr.name, ocr.nameAr, ocr.identity, false) +
    cmpCol("Vision read", vis ? vis.name : null, vis ? vis.nameAr : null, vis ? vis.identity : null, diff) +
    "</div>";
  if (vis) {
    h += kvl("Vision brand / size", [vis.brand, vis.size].filter(Boolean).join(" · ") || "—") +
      kvl("Confidence / corroboration", (vis.confidence == null ? "—" : vis.confidence) + " / " + (vis.corroboration == null ? "—" : vis.corroboration)) +
      kvl("Servable", vis.servable ? "yes" : "no — OCR fallback") +
      kvl("Mint verdict", vis.mintVerdict || "unresolved");
  } else {
    h += '<div class="mut">No vision enrichment stored for this offer.</div>';
  }
  h += '<h4 class="sec">Registry</h4>';
  if (p) {
    h += kvl("productId", p.id) +
      kvl("Display", [p.displayName, p.displayNameAr].filter(Boolean).join(" · ") || "—") +
      kvl("Brand / family", [p.brandSlug, p.family].filter(Boolean).join(" · ") || "—") +
      kvl("Match band", s ? s.matchBand : "—") +
      kvl("Match score", s && s.matchScore != null ? s.matchScore : "—") +
      '<div style="height:8px"></div><button class="ghost" id="openProdBtn" data-pid="' + esc(p.id) + '">Open product ▸</button>';
  } else {
    h += '<div class="mut">No registry sighting — this offer has not been resolved into a product.</div>';
  }
  h += '<h4 class="sec">Offer</h4>' +
    kvl("Offer id", o.id) + kvl("Store · region", o.store + " · " + o.region) +
    kvl("Price", o.price != null ? o.price + " " + (o.currency || "") : "—") +
    kvl("Valid to", o.validTo || "—") +
    (o.sourceUrl ? '<div style="height:6px"></div><a href="' + esc(o.sourceUrl) + '" target="_blank" rel="noreferrer" class="mut">flyer source ↗</a>' : "");
  return h;
}

var regQTimer;
$("#regQ").addEventListener("input", function () { clearTimeout(regQTimer); regQTimer = setTimeout(loadRegSearch, 300); });
function loadRegSearch() {
  var q = $("#regQ").value.trim();
  if (!q) { $("#regList").innerHTML = '<span class="mut">Type to search the registry.</span>'; return; }
  $("#regList").innerHTML = '<span class="spin"></span>';
  api("productsearch?q=" + encodeURIComponent(q)).then(function (d) {
    if (!d.products.length) { $("#regList").innerHTML = '<span class="mut">No products match.</span>'; return; }
    $("#regList").innerHTML = d.products.map(function (p) {
      return '<div class="insRow" data-id="' + esc(p.id) + '"><div class="meta"><b dir="auto">' +
        esc(p.display_name || p.display_name_ar || p.id) + "</b>" +
        '<div class="mut">' + esc(p.id) + " · " + esc(p.brand_slug || p.brand_text || "no brand") +
        " · " + esc(p.sightings) + " sightings</div></div>" +
        statusBadge(String(p.status || "active").toUpperCase()) + "</div>";
    }).join("");
    $("#regList").querySelectorAll(".insRow").forEach(function (r) { r.onclick = function () { openProduct(r.dataset.id); }; });
  }).catch(function (e) { $("#regList").innerHTML = '<span style="color:var(--bad)">' + esc(e.message) + "</span>"; });
}
function openProduct(id) {
  openSheet('<span class="spin"></span>');
  api("product?id=" + encodeURIComponent(id)).then(function (d) { openSheet(renderProduct(d)); })
    .catch(function (e) { openSheet('<p style="color:var(--bad)">' + esc(e.message) + "</p>"); });
}
function renderProduct(d) {
  var p = d.product;
  var h = '<h3 dir="auto">' + esc(p.display_name || p.display_name_ar || p.id) + " " +
    statusBadge(String(p.status || "active").toUpperCase()) + "</h3>";
  h += kvl("productId", p.id) + kvl("Kind", p.kind) +
    kvl("Brand", [p.brand_slug, p.brand_text].filter(Boolean).join(" · ") || "—") +
    kvl("Family / category", [p.family, p.category].filter(Boolean).join(" · ") || "—") +
    kvl("Size", p.size_unit ? (p.size_total || "") + p.size_unit + (p.size_pack > 1 ? " ×" + p.size_pack : "") : "—") +
    kvl("Sightings", p.sightings) +
    kvl("Seen", ago(p.first_seen) + " → " + ago(p.last_seen)) +
    (p.review_flag ? kvl("Review flag", p.review_flag) : "") +
    (d.mergedLosers.length ? kvl("Merged from", d.mergedLosers.length + " product(s)") : "");
  h += '<h4 class="sec">Sightings (' + d.sightings.length + ")</h4>";
  h += d.sightings.length ? d.sightings.map(function (s) {
    return '<div class="row" style="display:block">' +
      '<div style="display:flex;justify-content:space-between;align-items:center"><b>' + esc(s.store) + " · " + esc(s.week) + "</b>" +
      statusBadge(String(s.matchBand || "").toUpperCase()) + "</div>" +
      '<div class="mut">' + (s.price != null ? esc(s.price) : "?") + " · score " + (s.matchScore == null ? "—" : esc(s.matchScore)) +
      " · cor " + (s.corroboration == null ? "—" : esc(s.corroboration)) + " · " + ago(s.resolvedAt) + "</div>" +
      (s.enrichment ? '<div class="mut" dir="auto">vision: ' + esc(s.enrichment.name || s.enrichment.nameAr || "—") +
        (s.enrichment.mintVerdict ? " [" + esc(s.enrichment.mintVerdict) + "]" : "") + "</div>" : "") + "</div>";
  }).join("") : '<span class="mut">none</span>';
  return h;
}

/* ---------- Vision tab: Queue Monitor (§4) ---------- */
function loadQueue() { return api("queue").then(renderQueue).catch(function () {}); }
function renderQueue(q) {
  var r = q.resolution;
  $("#queueOut").innerHTML =
    '<div class="qgrid">' +
      kpiBox(q.vision.queued, "vision queue") +
      kpiBox(r.unresolved, "unresolved") +
      kpiBox(r.minted, "minted") +
    "</div><div style='height:8px'></div>" +
    kvl("Deferred (total)", r.deferred) +
    kvl("· declined", r.declined) +
    kvl("· low corroboration", r.low_corroboration) +
    kvl("· too few tokens", r.too_few_tokens) +
    kvl("· or-deal", r.or_deal) +
    kvl("Bands auto / review / created", (q.bands.auto || 0) + " / " + (q.bands.review || 0) + " / " + (q.bands.created || 0));
}
$("#qResolveBtn").onclick = function () {
  var b = $("#qResolveBtn");
  confirmSheet("Resolve Backlog", "Resolves every stored-but-unresolved enrichment into the registry (D1-only, no vision calls).", false).then(function (ok) {
    if (!ok) return;
    b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    api("resolve", { body: { confirm: true } }).then(function (r) {
      toast("Resolved: attached " + r.attached + " · created " + r.created + " · deferred " + r.deferred);
      loadQueue(); loadProgress();
    }).catch(function (e) { toast(e.message, true); })
      .finally(function () { b.disabled = false; b.textContent = "Resolve Backlog"; });
  });
};
$("#qReopenBtn").onclick = function () {
  var b = $("#qReopenBtn"); b.disabled = true;
  api("inspector?filter=deferred&limit=200").then(function (d) {
    var ids = d.items.map(function (x) { return x.id; });
    if (!ids.length) { toast("No deferred offers to re-open"); return; }
    confirmSheet("Re-open " + ids.length + " deferred",
      "Un-stamps the resolution verdict on the " + ids.length + " currently-deferred offers so the drain re-resolves them, then resolves now.",
      false).then(function (ok) {
      if (!ok) return;
      b.innerHTML = '<span class="spin"></span>';
      api("reopen", { body: { ids: ids, confirm: true } }).then(function (r) {
        var res = r.resolution || {};
        toast("Re-opened " + r.reopened + " · attached " + (res.attached || 0) + " · created " + (res.created || 0));
        loadQueue(); loadProgress();
      }).catch(function (e) { toast(e.message, true); })
        .finally(function () { b.disabled = false; b.textContent = "Re-open Deferred"; });
    });
  }).catch(function (e) { toast(e.message, true); b.disabled = false; });
};

/* ---------- Ops tab §8: registry maintenance ---------- */
$("#resolveBtn").onclick = function () {
  confirmAndRun($("#resolveBtn"), {}, "Resolve Queue",
    "Drains the registry resolution backlog (D1-only, no vision calls) — the manual twin of the enrich cron's resolution post-step.",
    false, null, "resolve");
};
$("#maintainBtn").onclick = function () {
  confirmAndRun($("#maintainBtn"), {}, "Repair Registry",
    "Runs registry maintenance: dormancy sweep, conservative consolidation, and dangling-sighting healing (D1-only).",
    false, null, "maintain");
};

/* ---------- More tab: Pipeline / Cron / Diagnostics (§5–§7) ---------- */
function loadMoreOps() {
  api("pipeline").then(renderPipeline).catch(function () {});
  api("crons").then(renderCrons).catch(function () {});
  api("diagnostics2").then(renderDiag2).catch(function () {});
}
function stageDot(st) { return st === "healthy" ? "ok" : st === "fail" ? "bad" : "warn"; }
function renderPipeline(d) {
  $("#pipeOut").innerHTML = d.stages.map(function (s, i) {
    return '<div class="stage"><span class="dot ' + stageDot(s.status) + '"></span>' +
      '<div class="info"><b>' + esc(s.name) + '</b> <span class="mut">· ' + esc(s.throughput) + "</span>" +
      '<div class="mut">' + esc(s.detail || "") + (s.lastAt ? " · " + ago(s.lastAt) : "") + "</div></div></div>" +
      (i < d.stages.length - 1 ? '<div class="arrow">↓</div>' : "");
  }).join("");
}
function detailSummary(o) {
  try {
    return Object.keys(o).filter(function (k) { return o[k] != null && typeof o[k] !== "object"; })
      .map(function (k) { return k + " " + o[k]; }).join(" · ");
  } catch (e) { return ""; }
}
function renderCrons(d) {
  $("#cronOut").innerHTML = d.crons.map(function (c) {
    var last = c.last;
    return '<div class="row" style="display:block">' +
      '<div style="display:flex;justify-content:space-between;align-items:center"><b>' + esc(c.name) +
      ' <span class="mut">' + esc(c.cron) + "</span></b>" +
      (last ? statusBadge(last.ok ? "PASS" : "FAIL") : '<span class="badge b-unk">no runs</span>') + "</div>" +
      '<div class="mut">last ' + (last ? ago(last.ts) + " · " + ms(last.elapsedMs) : "never") +
      " · next " + (c.nextRun ? tsShort(c.nextRun) : "—") + "</div>" +
      (last && last.error ? '<div class="mut" style="color:var(--bad)">' + esc(last.error) + "</div>" : "") +
      (last && last.detail ? '<div class="mut">' + esc(detailSummary(last.detail)) + "</div>" : "") + "</div>";
  }).join("");
}
function renderDiag2(d) {
  var L = d.latency;
  $("#diag2Out").innerHTML =
    kvl("D1 probe", ms(d.probes.d1)) +
    kvl("KV probe", ms(d.probes.kv)) +
    kvl("Ingest latency (avg)", ms(L.ingest)) +
    kvl("Vision batch latency (avg)", ms(L.vision)) +
    kvl("Resolve latency (avg)", ms(L.resolve)) +
    kvl("Watch-check latency (avg)", ms(L.watches)) +
    kvl("Queue age (oldest waiting)", d.queueAgeMs == null ? "—" : ago(new Date(Date.now() - d.queueAgeMs).toISOString()).replace(" ago", "")) +
    '<h4 class="sec">Not instrumented</h4>' +
    d.notInstrumented.map(function (x) { return '<div class="mut">' + esc(x) + " — no Worker runtime API</div>"; }).join("");
}

/* boot: probe an authed endpoint to decide login vs app */
api("overview").then(function (o) {
  OVERVIEW = o;
  $("#login").style.display = "none";
  $("#app").style.display = "block";
  renderHome(o);
  renderStores(o);
  loadMore();
}).catch(function () { showLogin(); });
</script>
</body>
</html>`;
