// Development-only Registry / Identity Candidate diagnostics. No writes.

import { readFromIdentityCandidate } from './candidate.js';
import { resolveIdentityCandidate } from './resolver.js';

export const REGISTRY_DEBUG_PATH = '/__dev/registry-candidate';

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Registry Candidate Debug</title><style>
:root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#101418;color:#e8edf2}body{max-width:1100px;margin:auto;padding:24px}h1{font:700 24px system-ui}.mut{color:#9eabb8}textarea{box-sizing:border-box;width:100%;min-height:260px;padding:12px;color:inherit;background:#182028;border:1px solid #344250;border-radius:8px}button{margin:12px 0;padding:9px 14px;color:inherit;background:#1769aa;border:0;border-radius:8px;cursor:pointer}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}section{background:#151b21;border:1px solid #29343f;border-radius:10px;padding:14px}h2{font:650 15px system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#cfe4f7}@media(max-width:760px){.grid{grid-template-columns:1fr}}
</style></head><body><h1>Registry Candidate Debug</h1><p class="mut">Development only. Read-only evaluation; no Product ID is minted and no Registry state is changed.</p><textarea id="input">{
  "identityCandidate": {
    "brand": "Sadia",
    "family": "Chicken",
    "cut": "Breast",
    "processing": "Fresh",
    "variety": null,
    "package": null,
    "size": { "value": 900, "unit": "g" },
    "count": 1
  }
}</textarea><button id="run">Evaluate</button><span id="status"></span><div class="grid"><section><h2>Identity Candidate / validation</h2><pre id="validation">—</pre></section><section><h2>Registry outcome</h2><pre id="decision">—</pre></section><section><h2>Match candidates and scores</h2><pre id="matches">—</pre></section><section><h2>Full diagnostics / processing time</h2><pre id="all">—</pre></section></div><script>
const $=s=>document.querySelector(s),show=(id,v)=>$(id).textContent=JSON.stringify(v,null,2);async function run(){try{$('#status').textContent=' Evaluating…';const r=await fetch('${REGISTRY_DEBUG_PATH}/evaluate',{method:'POST',headers:{'content-type':'application/json'},body:$('#input').value});const j=await r.json();if(!r.ok)throw new Error(j.error||('HTTP '+r.status));show('#validation',{identityCandidate:j.identityCandidate,validation:j.validation});show('#decision',{outcome:j.outcome,decisionReason:j.decisionReason,assignedProductId:j.assignedProductId,proposedProductId:j.proposedProductId});show('#matches',j.registryMatchCandidates);show('#all',j);$('#status').textContent=' Done in '+j.processingTimeMs+' ms'}catch(e){$('#status').textContent=' '+e.message}}$('#run').onclick=run;run();
</script></body></html>`;

function headers(type) {
  return {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  };
}

export async function handleRegistryCandidateDebug(request, ctx = {}) {
  const url = new URL(request.url);
  if (url.pathname !== REGISTRY_DEBUG_PATH && url.pathname !== `${REGISTRY_DEBUG_PATH}/evaluate`) return null;
  if (ctx.isDevelopment !== true) return null;
  if (url.pathname === REGISTRY_DEBUG_PATH && request.method === 'GET') {
    return new Response(HTML, { headers: headers('text/html; charset=utf-8') });
  }
  if (url.pathname !== `${REGISTRY_DEBUG_PATH}/evaluate` || request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: headers('application/json; charset=utf-8') });
  }
  if (!ctx.registryStore) {
    return new Response(JSON.stringify({ error: 'Registry unavailable.' }), { status: 503, headers: headers('application/json; charset=utf-8') });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Request body must be JSON.' }), { status: 400, headers: headers('application/json; charset=utf-8') });
  }
  const identityCandidate = body?.identityCandidate ?? body;
  const context = {
    offerId: body?.context?.offerId || 'debug:identity-candidate',
    store: body?.context?.store || 'debug',
    region: body?.context?.region || 'debug',
  };
  const validation = readFromIdentityCandidate(identityCandidate);
  const decision = await resolveIdentityCandidate(identityCandidate, context, ctx.registryStore, {
    includeDiagnostics: true,
  });
  const result = {
    identityCandidate,
    validation: {
      valid: validation.ok,
      verdict: validation.ok ? 'valid' : validation.verdict,
      errors: validation.errors || [],
    },
    registryMatchCandidates: decision.matchCandidates || [],
    matchScores: (decision.matchCandidates || []).map(({ productId, score }) => ({ productId, score })),
    decisionReason: decision.decisionReason,
    outcome: decision.registryOutcome,
    assignedProductId: decision.outcome === 'attach' ? decision.productId : null,
    proposedProductId: decision.outcome === 'review' ? decision.productId ?? null : null,
    processingTimeMs: decision.processingTimeMs,
  };
  return new Response(JSON.stringify(result), { headers: headers('application/json; charset=utf-8') });
}
