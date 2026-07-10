#!/usr/bin/env bash
# ops-validate.sh — post-deployment OPERATIONAL validation of the Ops Console
# against the REAL production Worker. Not a code test: it opens the live
# console, authenticates, runs "Repair Unhealthy Stores", and verifies the
# outcome end to end. Stops (exit 1) at the first mismatch.
#
# Usage:
#   BASE=https://brochure-engine.<account>.workers.dev \
#   OPS_TOKEN=<your admin token> \
#   ./ops-validate.sh
#
# Optional:
#   INCIDENT_STORE=almadina INCIDENT_PAGE=6 INCIDENT_PAGE_CLICKABLE=20
#     — the incident-specific assertions (defaults below match the
#       2026-07 Al Madina incident expectations).

set -u
: "${BASE:?set BASE to the deployed Worker origin (https://...workers.dev)}"
: "${OPS_TOKEN:?set OPS_TOKEN to the admin token}"
INCIDENT_STORE="${INCIDENT_STORE:-almadina}"
INCIDENT_PAGE="${INCIDENT_PAGE:-6}"
INCIDENT_PAGE_CLICKABLE="${INCIDENT_PAGE_CLICKABLE:-20}"

AUTH="Authorization: Bearer $OPS_TOKEN"
JSON="content-type: application/json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() { printf 'PASS  %s\n' "$1"; }
stop() { printf 'FAIL  %s\n\nSTOPPING - mismatch found. Incident NOT closed.\n' "$1"; exit 1; }

py() { python3 -c "$1" "${@:2}"; }

echo "== 1. Console reachable =="
code=$(curl -s -o "$TMP/ui.html" -w '%{http_code}' --max-time 30 "$BASE/__ops")
[ "$code" = "200" ] && grep -q 'System Confidence' "$TMP/ui.html" \
  && pass "GET /__ops -> 200, console UI served" \
  || stop "GET /__ops -> HTTP $code (expected 200 with the console UI). Is the branch deployed and OPS_TOKEN set?"

echo "== 2. Authentication =="
bad=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer definitely-wrong" "$BASE/__ops/api/overview")
[ "$bad" = "401" ] && pass "wrong token rejected (401)" || stop "wrong token got HTTP $bad (expected 401)"
good=$(curl -s -o "$TMP/overview.json" -w '%{http_code}' -H "$AUTH" "$BASE/__ops/api/overview")
[ "$good" = "200" ] && pass "admin token accepted (200)" || stop "admin token got HTTP $good (expected 200)"

echo "== 3-4. Scheduler heartbeat + System Confidence =="
py '
import json, sys
o = json.load(open(sys.argv[1]))
sched = next(c for c in o["checks"] if c["name"] == "Scheduler")
print("      scheduler:", sched["status"], "-", sched.get("detail", ""))
if sched["status"] != "PASS": sys.exit(1)
conf = o["confidence"]
print("      confidence:", str(conf["score"]) + "%")
for c in conf["components"]:
    print("       ", c["label"] + ":", str(c["score"]) + "%", "-", c["detail"])
if not isinstance(conf["score"], int) or not (0 <= conf["score"] <= 100): sys.exit(1)
unhealthy = sorted(s["store"] for s in o["stores"] if not s["healthy"])
healthy = sorted(s["store"] for s in o["stores"] if s["healthy"])
json.dump({"unhealthy": unhealthy, "healthy": healthy}, open(sys.argv[2], "w"))
print("      unhealthy before repair:", unhealthy if unhealthy else "none")
' "$TMP/overview.json" "$TMP/before.json" \
  && pass "scheduler heartbeat PASS, confidence computed" \
  || stop "scheduler heartbeat not PASS (see detail above) - fix before validating repair"

echo "== 5-7. Run Repair Unhealthy Stores (waits for completion) =="
code=$(curl -s -o "$TMP/repair.json" -w '%{http_code}' --max-time 300 \
  -X POST -H "$AUTH" -H "$JSON" -d '{"op":"repair","confirm":true,"notify":true}' \
  "$BASE/__ops/api/run")
[ "$code" = "200" ] && pass "repair completed (HTTP 200 - the POST is synchronous)" \
  || stop "repair -> HTTP $code: $(cat "$TMP/repair.json")"

echo "== 6+12. Only unhealthy stores dispatched, no healthy store reprocessed =="
py '
import json, sys
rep = json.load(open(sys.argv[1])); before = json.load(open(sys.argv[2]))
if rep.get("nothingToDo"):
    print("      nothing to repair - every store was already healthy; steps 6-8 vacuously pass")
    sys.exit(0)
targets = sorted(rep["targets"])
print("      dispatched:", targets)
if targets != before["unhealthy"]:
    print("      MISMATCH: expected exactly", before["unhealthy"]); sys.exit(1)
if set(targets) & set(before["healthy"]):
    print("      MISMATCH: healthy store reprocessed"); sys.exit(1)
' "$TMP/repair.json" "$TMP/before.json" \
  && pass "dispatch set == pre-repair unhealthy set; healthy stores untouched" \
  || stop "repair dispatched the wrong store set (see above)"

echo "== 8. Per-store verification of every dispatched store =="
py '
import json, sys
rep = json.load(open(sys.argv[1]))
if rep.get("nothingToDo"): sys.exit(0)
bad = []
for l in rep["verification"]["lines"]:
    held = "yes" if l["status"] != "NO_FLYER" else "NO"
    verdict = "PASS" if l["pass"] else l["status"]
    print("     ", l["store"] + ": flyer held=" + held,
          "hotspots=" + str(l["hotspots"]), "clickable=" + str(l["clickable"]),
          "offers=" + str(l["offers"]), "coverage=" + str(l["coverage"]) + "%", "->", verdict)
    if not l["pass"]: bad.append(l["store"])
if bad:
    print("      still unhealthy after repair:", bad); sys.exit(1)
' "$TMP/repair.json" \
  && pass "every dispatched store verified: current flyer, hotspots, offers, clickable, coverage" \
  || stop "one or more dispatched stores did not verify healthy after repair"

echo "== 9. Incident store: $INCIDENT_STORE =="
curl -s -H "$AUTH" "$BASE/__ops/api/store?id=$INCIDENT_STORE" > "$TMP/store.json"
py '
import json, sys
s = json.load(open(sys.argv[1]))
if "error" in s:
    print("     ", s["error"]); sys.exit(1)
print("      status=" + s["status"], "hotspots=" + str(s["hotspots"]),
      "clickable=" + str(s["clickable"]), "offers=" + str(s["offers"]),
      "coverage=" + str(s["coverage"]) + "%")
ok = s["coverage"] == 100 and s["hotspots"] == s["clickable"] == s["offers"] and s["hotspots"] > 0
if not ok:
    print("      MISMATCH: expected hotspots == clickable == offers and coverage == 100%"); sys.exit(1)
flyers = [f for f in s["flyers"] if f["sourceType"] == "images"]
json.dump(flyers[0]["id"] if flyers else None, open(sys.argv[2], "w"))
' "$TMP/store.json" "$TMP/flyerid.json" \
  && pass "$INCIDENT_STORE: hotspots == clickable == offers, coverage 100%" \
  || stop "$INCIDENT_STORE store-level expectations not met (see numbers above)"

# Page-level check via the engine's own public hotspots doc (per-page spots
# joined to offers - a spot is clickable when its offerId resolves).
FLYER_ID=$(py 'import json,sys;print(json.load(open(sys.argv[1])) or "")' "$TMP/flyerid.json")
[ -n "$FLYER_ID" ] || stop "$INCIDENT_STORE holds no current image flyer to page-check"
curl -s "$BASE/brochures/hotspots?id=$FLYER_ID" > "$TMP/hotdoc.json"
py '
import json, sys
d = json.load(open(sys.argv[1])); page_no = int(sys.argv[2]); want = int(sys.argv[3])
offers = set(d.get("offers", {}).keys())
target_ok = False
print("      page  spots  clickable")
for p in d.get("pages", []):
    spots = p.get("spots", [])
    clickable = sum(1 for sp in spots if str(sp.get("offerId")) in offers)
    print("      " + str(p["index"]).rjust(4), str(len(spots)).rjust(6), str(clickable).rjust(10))
    if p["index"] == page_no:
        target_ok = (clickable == want and len(spots) == clickable)
if not target_ok:
    print("      MISMATCH: page", page_no, "expected", str(want) + "/" + str(want), "clickable"); sys.exit(1)
' "$TMP/hotdoc.json" "$INCIDENT_PAGE" "$INCIDENT_PAGE_CLICKABLE" \
  && pass "$INCIDENT_STORE page $INCIDENT_PAGE: $INCIDENT_PAGE_CLICKABLE/$INCIDENT_PAGE_CLICKABLE clickable" \
  || stop "$INCIDENT_STORE page-level hotspot expectation not met (table above)"

echo "== 10. Audit timeline =="
curl -s -H "$AUTH" "$BASE/__ops/api/audit?limit=10" > "$TMP/audit.json"
py '
import json, sys
runs = json.load(open(sys.argv[1]))["runs"]
hit = next((r for r in runs if r["action"] == "ops:repair"), None)
if not hit: sys.exit(1)
print("      newest ops:repair row: origin=" + str(hit["origin"]),
      "ok=" + str(hit["ok"]), str(hit["elapsed_ms"]) + "ms",
      "coverage=" + str(hit["coverage"]))
' "$TMP/audit.json" \
  && pass "audit timeline contains the repair operation" \
  || stop "no ops:repair row found in the audit timeline"

echo "== 11. Notification =="
echo "      The repair ran with notify:true. Check the ntfy app on your phone for"
echo "      an 'Ops repair' message (stores, failures, coverage, elapsed)."
echo "      If NTFY_TOPIC is not configured on the Worker, no push is possible -"
echo "      the console's Notifier check on the Home tab shows UNCONFIGURED."

echo
echo "ALL AUTOMATED CHECKS PASSED."
echo "If the ntfy push arrived (step 11), the incident can be declared closed."
