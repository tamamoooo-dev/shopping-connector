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

/* ---------- tabs ---------- */
document.querySelectorAll("nav button").forEach(function (b) {
  b.onclick = function () {
    document.querySelectorAll("nav button").forEach(function (x) { x.classList.remove("active"); });
    document.querySelectorAll(".view").forEach(function (x) { x.classList.remove("active"); });
    b.classList.add("active");
    $("#v-" + b.dataset.v).classList.add("active");
    if (b.dataset.v === "home" || b.dataset.v === "stores") loadOverview();
    if (b.dataset.v === "more") loadMore();
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
