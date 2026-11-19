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
.tag.warnTag{background:rgba(245,158,11,.16);color:var(--warn)}
.warnBox{background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.38);color:var(--warn);
  border-radius:10px;padding:10px 12px;font-size:12.5px;font-weight:600;margin-bottom:10px;line-height:1.4}
.segSub{font-size:10px;font-weight:600;opacity:.75}
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
    <div class="card"><h2>Daily digest <span id="digestTag" class="tag">…</span></h2><div id="digestOut"><span class="spin"></span></div></div>
    <div class="card"><h2>Scheduler</h2><div id="sched"><span class="spin"></span></div></div>
  </section>

  <section class="view" id="v-stores">
    <div class="card"><h2>Stores · Coverage</h2><div id="storeList"><span class="spin"></span></div></div>
  </section>

  <section class="view" id="v-vision">
    <div class="card">
      <h2>Vision <span id="vrTag" class="tag">…</span></h2>
      <div class="mut" style="margin-bottom:10px">Reads each new flyer crop once for its name, brand and size. Prices always come from D4D. Haiku runs on the PC on the Claude plan; Mistral reads by itself while the PC is off or out of plan.</div>
      <div class="seg" id="vrSeg">
        <button data-mode="haiku">Haiku · PC</button>
        <button data-mode="mistral">Mistral</button>
      </div>
      <div id="visionProg" style="margin-top:10px"><span class="spin"></span></div>
      <div id="vrPanel"></div>
    </div>

    <div class="card">
      <h2>Mistral backup <span id="vmTag" class="tag">…</span></h2>
      <div class="mut" style="margin-bottom:10px">Ministral 14B reads only while the switch is on Mistral, the PC stops asking, or both Claude accounts are out for over 2 h.</div>
      <div id="vmPanel"><span class="spin"></span></div>
      <div id="vmLimit"></div>
    </div>

    <div class="card">
      <h2>Inspector</h2>
      <div class="seg" id="insSeg">
        <button data-ins="offer" class="on">Offer</button>
        <button data-ins="registry">Registry</button>
      </div>
      <div id="insOffer">
        <input type="text" id="insQ" placeholder="Search current offers by name…">
        <div class="chips" id="insChips">
          <span class="chip on" data-f="all">all</span>
          <span class="chip" data-f="vision-enriched">named</span>
          <span class="chip" data-f="ocr-fallback">no usable name</span>
          <span class="chip" data-f="missing-product">not linked to a product</span>
        </div>
        <div id="insList"><span class="mut">Search or pick a filter above.</span></div>
      </div>
      <div id="insRegistry" style="display:none">
        <input type="text" id="regQ" placeholder="Search by productId, name, or brand…">
        <div style="height:10px"></div>
        <div id="regList"><span class="mut">Type to search the registry.</span></div>
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
var METRIC_POLL = null;
function stopPoll() {
  if (POLL) { clearInterval(POLL); POLL = null; }
  if (METRIC_POLL) { clearInterval(METRIC_POLL); METRIC_POLL = null; }
}
function startPoll(fn, ms, metricFn, metricMs) {
  stopPoll();
  fn();
  POLL = setInterval(function () { if (!document.hidden) fn(); }, ms);
  if (metricFn) {
    METRIC_POLL = setInterval(function () { if (!document.hidden) metricFn(); }, metricMs);
  }
}
document.addEventListener("visibilitychange", function () {
  // Refresh immediately on return so a backgrounded tab isn't left stale.
  if (!document.hidden && POLL && $("#v-vision").classList.contains("active")) {
    loadProgress(); loadVisionReader();
  }
});

document.querySelectorAll("nav button").forEach(function (b) {
  b.onclick = function () {
    document.querySelectorAll("nav button").forEach(function (x) { x.classList.remove("active"); });
    document.querySelectorAll(".view").forEach(function (x) { x.classList.remove("active"); });
    b.classList.add("active");
    $("#v-" + b.dataset.v).classList.add("active");
    stopPoll();
    if (b.dataset.v === "home" || b.dataset.v === "stores") loadOverview();
    if (b.dataset.v === "vision") {
      // Who reads is cheap and changes by the minute; the offer counts scan
      // the working corpus, so they refresh on entry and every 10 minutes.
      loadProgress(); loadVisionModel();
      startPoll(loadVisionReader, 60000, loadProgress, 600000);
    }
    if (b.dataset.v === "more") { loadMore(); loadMoreOps(); }
  };
});

/* ---------- shared render helpers ---------- */
var STATUS_COLOR = { OK: "var(--ok)", PUBLISHING: "var(--warn)", LOW_COVERAGE: "var(--warn)", STALE: "var(--warn)", NO_FLYER: "var(--bad)", FAIL: "var(--bad)" };
var STATUS_BADGE = { OK: "b-ok", PUBLISHING: "b-warn", LOW_COVERAGE: "b-warn", STALE: "b-warn", NO_FLYER: "b-bad", FAIL: "b-bad" };
function statusBadge(s) {
  var cls = STATUS_BADGE[s] || (s === "PASS" ? "b-ok" : s === "FAIL" ? "b-bad" : s === "UNCONFIGURED" || s === "UNKNOWN" || s === "DISABLED" ? "b-unk" : "b-warn");
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
/* Time left until a FUTURE moment. ago() clamps a future time to zero, so the
   Scheduler card read "next 0s" for every cron. */
function until(iso) {
  var t = Date.parse(iso);
  if (isNaN(t)) return "";
  var s = Math.max(0, (t - Date.now()) / 1000);
  if (s < 90) return "in " + Math.round(s) + "s";
  if (s < 5400) return "in " + Math.round(s / 60) + "m";
  if (s < 172800) return "in " + (s / 3600).toFixed(1) + "h";
  return "in " + Math.round(s / 86400) + "d";
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

  renderDigest(o.digest);

  var s = o.scheduler;
  $("#sched").innerHTML =
    s.crons.map(function (c) {
      return '<div class="row"><span>' + esc(c.name) + ' <span class="mut">' + esc(c.cron) + '</span></span>' +
        '<span class="mut" style="margin-left:auto">next ' + (c.nextRun ? until(c.nextRun) + " → " + esc(c.nextRun.slice(0, 16).replace("T", " ")) + "Z" : "—") + "</span></div>";
    }).join("") +
    '<div class="row"><span>Last run</span><span class="mut" style="margin-left:auto">' +
    (s.lastRuns[0] ? esc(s.lastRuns[0].action) + " · " + ago(s.lastRuns[0].ts) : "none recorded") + "</span>" +
    statusBadge(s.healthy === null ? "UNKNOWN" : s.healthy ? "PASS" : "FAIL") + "</div>";
}

/* Home: the newest recorded daily digest (05:00 UTC). It was only reachable
   through the audit history before; the body is the digest's own text. */
function renderDigest(d) {
  var tag = $("#digestTag");
  if (!d) {
    tag.textContent = "none yet";
    tag.className = "tag";
    $("#digestOut").innerHTML = '<div class="mut">No digest recorded yet. It runs daily at 05:00 UTC (08:00 Riyadh).</div>';
    return;
  }
  var n = (d.problems || []).length;
  tag.textContent = d.healthy === false ? n + " issue" + (n === 1 ? "" : "s") : d.healthy ? "all healthy" : "recorded";
  tag.className = "tag" + (d.healthy === false ? " warnTag" : "");
  var late = Date.now() - Date.parse(d.ts) > 26 * 3600000;
  $("#digestOut").innerHTML =
    '<div class="mut" style="margin-bottom:6px">' + esc(String(d.ts).slice(0, 16).replace("T", " ")) + "Z · " + ago(d.ts) +
    (late ? ' · <b style="color:var(--warn)">no digest in the last day</b>' : "") +
    (d.push ? " · push " + esc(d.push) : "") + "</div>" +
    (d.error ? '<div class="errCard">' + esc(d.error) + "</div>" : "") +
    (d.body ? '<pre style="white-space:pre-wrap;margin:0">' + esc(d.body) + "</pre>" : '<div class="mut">No text recorded.</div>');
}

function renderStores(o) {
  $("#storeList").innerHTML = o.stores.map(function (r) {
    var col = STATUS_COLOR[r.status];
    var publication = r.publication;
    var publicationRow = publication && r.status === "PUBLISHING"
      ? '<div class="mut">publishing ' + publication.collectedPages + "/" + publication.advertisedPages + " pages" +
        (publication.progress == null ? "" : " · " + publication.progress + "%") + "</div>"
      : "";
    return '<div class="row" style="display:block;cursor:pointer" data-store="' + esc(r.store) + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:center"><b>' + esc(r.label) + "</b>" + statusBadge(r.status) + "</div>" +
      '<div class="mut">' + r.currentFlyers + " flyers · " + r.hotspots + " hotspots · " + r.clickable + " clickable" + (r.priced != null ? " (" + r.priced + " priced)" : "") + " · " + r.offers + " offers" +
      " · ingest " + ago(r.lastOkAt || r.lastDetectedAt) + (r.lastOkMs ? " (" + ms(r.lastOkMs) + ")" : "") + "</div>" +
      publicationRow +
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
          " · " + f.hotspots + " spots / " + f.clickable + " clickable" + (f.priced != null ? " (" + f.priced + " priced)" : "") + "</div>" +
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
  var noCurrent = r.source && r.source.noCurrentBrochure;
  if (noCurrent && noCurrent.length) {
    html += '<div class="warnBox" style="margin-top:8px">No current brochure advertised by the source: ' +
      esc(noCurrent.join(", ")) + ". The previous flyer remains visible as STALE until a new one is published.</div>";
  }
  var v = r.verification;
  if (v && v.publishing && v.publishing.length) {
    html += '<div class="warnBox" style="margin-top:8px">Still publishing in the background: ' + esc(v.publishing.join(", ")) +
      ". The resume cron advances each store every 2 minutes and the current flyer stays live until the new set is complete — " +
      "the Stores tab shows progress, and a store that stops moving turns FAIL.</div>";
  }
  if (v && v.lines && v.lines.length) {
    html += '<h4 class="sec">Verification</h4>' + v.lines.map(function (x) {
      var publishing = x.status === "PUBLISHING";
      return '<div class="row"><span class="dot ' + (x.pass ? "ok" : publishing ? "warn" : "bad") + '"></span><div><b>' + esc(x.label || x.store) + "</b>" +
        '<div class="mut">hotspots ' + esc(x.hotspots) + " · clickable " + esc(x.clickable) + " · offers " + esc(x.offers) +
        " · coverage " + (x.coverage == null ? "n/a" : x.coverage + "%") +
        (publishing && x.progress != null ? " · publishing " + esc(x.progress) + "%" : "") + "</div></div>" +
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
      var bg = r.verification && r.verification.publishing ? r.verification.publishing.length : 0;
      toast(r.ok
        ? (r.nothingToDo ? r.message : bg ? "Done — " + bg + " store(s) still publishing in the background" : "Done — verification passed")
        : "Completed with failures", !r.ok);
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
/* ---------- Vision tab (rebuilt 2026-11-19) ---------- */
/* Owner: "the vision ops seems to be messy with inaccurate mistral percentage
   .. keep only what matters". Three cards: Vision (who reads + the switch +
   progress), Mistral backup (each key once, in plain words), Inspector.
   Removed from the page: the live/background Mistral drains (they bypassed
   the Haiku/Mistral switch), Stage-2 verification (Haiku rows get ONE
   reading), the Queue Monitor (its registry buttons live in the Ops tab), and
   each key's "remaining %": that was the requests-per-MINUTE window at the
   key's last reply (2 a minute, so always 50% after a call), not capacity.
   The server routes are unchanged. */
function loadProgress() { return api("progress").then(renderProgress).catch(function () {}); }
function renderProgress(p) {
  if (!p || !p.offers) return;
  $("#visionProg").innerHTML =
    '<div class="progGrid" style="grid-template-columns:repeat(4,1fr)">' +
      kpiBox(p.offers.current, "current offers") +
      kpiBox(p.enriched, "named") +
      kpiBox(p.remaining, "waiting") +
      kpiBox(p.coverage == null ? "n/a" : p.coverage + "%", "coverage") +
    "</div>" +
    '<div class="bar"><i style="width:' + (p.coverage || 0) + "%;background:" + scoreColor(p.coverage) + '"></i></div>' +
    '<div style="height:8px"></div>' +
    (p.declined ? kvl("Read, no usable name", p.declined) : "") +
    kvl("Engine last checked", p.lastCron ? ago(p.lastCron.ts) : "never");
  $("#vmLimit").innerHTML = mistralLimitHtml(p.providerLimit);
}
/* The latest Mistral limit the engine saw (progress.providerLimit), shown in
   the Mistral backup card only while it is under a day old: the old card kept
   showing a finished job's 429 from the day before. */
function mistralLimitHtml(pl) {
  if (!pl || !pl.observedAt || Date.now() - Date.parse(pl.observedAt) > 86400000) return "";
  var category = pl.category;
  if (!category && Number(pl.limitRequestsMinute) === 0) category = "request_allowance_zero";
  var labels = {
    monthly_account_quota: "Monthly/account quota exhausted",
    request_rate_limit: "Short-term request rate limit",
    token_rate_limit: "Token-per-minute rate limit",
    concurrency_limit: "Concurrent request limit",
    billing_restriction: "Account/billing restriction",
    capacity_throttling: "Temporary Mistral capacity throttling",
    request_allowance_zero: "Workspace/model request allowance is zero",
    unknown_429: "Unknown Mistral HTTP 429"
  };
  var transient = category === "request_rate_limit" || category === "token_rate_limit" ||
    category === "concurrency_limit" || category === "capacity_throttling" || category === "unknown_429";
  var explanation = category === "request_allowance_zero"
    ? "This is not monthly usage exhaustion. Automatic retries are stopped; check the Workspace API rate limit or plan state in Mistral Admin."
    : category === "monthly_account_quota"
      ? "The monthly completion allowance is exhausted."
      : transient
        ? "A short-lived limit; the engine waits and retries by itself."
        : "Mistral rejected API access for this account; check billing and Workspace status.";
  return '<div class="warnBox" style="margin-top:8px">' + esc((labels[category] || labels.unknown_429) + " · " + ago(pl.observedAt) + ". " + explanation) + "</div>";
}

/* Who reads: the engine's own decision (offers/visionReader.js
   whoReadsVision), so the card never claims Haiku while Mistral reads. */
function loadVisionReader() { return api("vision/reader").then(renderVisionReader).catch(function () {}); }
function renderVisionReader(r) {
  if (!r || !r.setting) return;
  var mode = r.setting.mode;
  $("#vrSeg").querySelectorAll("button").forEach(function (b) {
    b.classList.toggle("on", b.dataset.mode === mode);
  });
  var tag = $("#vrTag");
  tag.textContent = r.reader === "haiku" ? "Haiku reading" : "Mistral reading";
  tag.className = "tag" + (mode === "haiku" && r.reader !== "haiku" ? " warnTag" : "");
  var why = {
    "chosen": "Mistral chosen here",
    "pc-off": "PC reader not asking for work — Mistral reads meanwhile",
    "pc-limited": "both Claude accounts at their limit for over 2 h — Mistral reads meanwhile",
    "pc-holding": "Claude limit ends within 2 h — new crops wait for Haiku",
    "pc-on": "PC reader is on"
  }[r.why] || r.why || "—";
  var pc = r.pc || {};
  var run = pc.last_run || null;
  var runText = run
    ? (run.published != null ? run.published + " named" : "") +
      (run.crops != null ? " of " + run.crops + " crops" : "") +
      (run.ms ? " · " + Math.round(run.ms / 1000) + " s" : "") +
      (pc.last_run_at ? " · " + ago(pc.last_run_at) : "")
    : "none yet";
  $("#vrPanel").innerHTML =
    kvl("Reading now", (r.reader === "haiku" ? "Haiku 5.5 (PC)" : "Mistral 14B") + " · " + why) +
    kvl("PC last asked", pc.seen_at ? ago(pc.seen_at) : "never") +
    kvl("Last PC run", runText) +
    (pc.limited_until && Date.parse(pc.limited_until) > Date.now()
      ? kvl("Claude limit until", tsShort(pc.limited_until)) : "") +
    (r.setting.selectedAt ? kvl("Switch changed", ago(r.setting.selectedAt) + (r.setting.selectedBy ? " · " + r.setting.selectedBy : "")) : "");
}
$("#vrSeg").querySelectorAll("button").forEach(function (b) {
  b.onclick = function () {
    var mode = b.dataset.mode;
    var msg = mode === "haiku"
      ? "Haiku on the PC reads new flyer crops, one reading each. Mistral reads only while the PC is off or out of Claude plan."
      : "Mistral reads every new flyer crop. The PC reader stops asking for work.";
    confirmSheet(mode === "haiku" ? "Read with Haiku" : "Read with Mistral", msg, false).then(function (ok) {
      if (!ok) return;
      api("vision/reader", { body: { mode: mode, confirm: true } }).then(function (r) {
        toast(mode === "haiku" ? "Haiku reads from the next check" : "Mistral reads from the next check");
        renderVisionReader(r);
      }).catch(function (e) { toast(e.message || "error", true); });
    });
  };
});

/* Mistral backup: the engine's key list (vision/model keyPools) names the
   same keys once per pool; each key is shown once, in plain words. */
var KEY_STATE = { ready: "ready", limited: "rate-limited", invalid: "invalid key", restricted: "restricted", unobserved: "not used yet" };
function loadVisionModel() { return api("vision/model").then(renderMistralBackup).catch(function () {}); }
function renderMistralBackup(r) {
  if (!r) return;
  var seen = {}, keys = [], empty = 0;
  (r.keyPools || []).forEach(function (pool) {
    (pool.keys || []).forEach(function (k) {
      if (!k || seen[k.id]) return;
      seen[k.id] = true;
      if (!k.configured) { empty += 1; return; }
      keys.push(k);
    });
  });
  var ready = keys.filter(function (k) { return k.status === "ready" || k.status === "unobserved"; }).length;
  var broken = keys.filter(function (k) { return k.status === "invalid" || k.status === "restricted"; }).length;
  var tag = $("#vmTag");
  tag.textContent = ready + " of " + keys.length + " keys usable";
  tag.className = "tag" + (broken || !ready ? " warnTag" : "");
  $("#vmPanel").innerHTML =
    kvl("Model", r.activeModel || r.defaultModel || "—") +
    keys.map(function (k) {
      return kvl(k.label || k.id, (KEY_STATE[k.status] || k.status || "—") + (k.observedAt ? " · " + ago(k.observedAt) : ""));
    }).join("") +
    (empty ? kvl("Empty key slots", empty) : "") +
    '<div class="mut" style="margin-top:6px">Names are the stored secret names; every key reads with Ministral 14B. Secrets are never shown.</div>';
}

/* ---------- Vision tab: Inspector ---------- */
/* Scoped to #insSeg, not to every .seg in the tab: the reader switch is a
   segmented control on this tab too. */
$("#insSeg").querySelectorAll("button").forEach(function (b) {
  b.onclick = function () {
    $("#insSeg").querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); });
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
function readerOf(model) { return /haiku|claude/i.test(String(model || "")) ? "Haiku" : "Mistral"; }
function insBadge(it) {
  if (it.e_servable) return '<span class="badge b-ok">' + readerOf(it.e_model) + "</span>";
  if (it.e_enriched_at != null) return '<span class="badge b-warn">no name</span>';
  return '<span class="badge b-unk">waiting</span>';
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
        '<div class="mut">' + esc(it.store) + (it.price != null ? " · " + esc(it.price) + " " + esc(it.currency || "") : "") + "</div></div>" +
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
    cmpCol("D4D text", ocr.name, ocr.nameAr, ocr.identity, false) +
    cmpCol("Vision read", vis ? vis.name : null, vis ? vis.nameAr : null, vis ? vis.identity : null, diff) +
    "</div>";
  if (vis) {
    h += kvl("Brand / size", [vis.brand, vis.size].filter(Boolean).join(" · ") || "—") +
      kvl("Read by", vis.model ? readerOf(vis.model) + " · " + vis.model : "—") +
      kvl("On cards", vis.servable ? "yes" : "no — no usable name") +
      kvl("Product link", vis.mintVerdict || "not yet");
  } else {
    h += '<div class="mut">Not read by Vision yet.</div>';
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
    h += '<div class="mut">Not linked to a product yet.</div>';
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
      " · " + ago(s.resolvedAt) + "</div>" +
      (s.enrichment ? '<div class="mut" dir="auto">vision: ' + esc(s.enrichment.name || s.enrichment.nameAr || "—") +
        (s.enrichment.mintVerdict ? " [" + esc(s.enrichment.mintVerdict) + "]" : "") + "</div>" : "") + "</div>";
  }).join("") : '<span class="mut">none</span>';
  return h;
}

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
