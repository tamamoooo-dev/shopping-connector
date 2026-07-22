// identityDebug.js — development-only interactive Identity Builder inspection.
// Returns null outside its path and whenever ctx.isDevelopment !== true, so the
// route falls through to the normal production 404 and exposes no diagnostics.

import { buildIdentityCandidate, normalizeIdentityMode } from './identityBuilder.js';

export const IDENTITY_DEBUG_PATH = '/__dev/identity-builder';

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Identity Builder Debug</title>
  <style>
    :root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#101418;color:#e8edf2}
    body{max-width:1100px;margin:0 auto;padding:24px}h1{font:700 24px system-ui;margin:0 0 6px}.mut{color:#9eabb8;margin-bottom:20px}
    .bar{display:flex;gap:10px;align-items:center;margin:12px 0}select,button,textarea{font:inherit;color:inherit;background:#182028;border:1px solid #344250;border-radius:8px}
    select,button{padding:9px 12px}button{background:#1769aa;cursor:pointer}textarea{box-sizing:border-box;width:100%;min-height:210px;padding:12px;resize:vertical}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}section{background:#151b21;border:1px solid #29343f;border-radius:10px;padding:14px}h2{font:650 15px system-ui;margin:0 0 10px}
    pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;color:#cfe4f7}@media(max-width:760px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <h1>Identity Builder Debug</h1>
  <div class="mut">Development only. Pure normalization; no storage, Registry, prices, or product IDs.</div>
  <label for="input">Structured extraction input</label>
  <textarea id="input">{
  "brand": "Sadia",
  "productName": "Tender Chicken Breasts",
  "arabicName": "صدور دجاج طري",
  "size": "6×200 ml",
  "confidence": 0.92
}</textarea>
  <div class="bar"><label>Mode <select id="mode"><option>strict</option><option>relaxed</option></select></label><button id="build">Build candidate</button><span id="status"></span></div>
  <div class="grid">
    <section><h2>Identity candidate</h2><pre id="candidate">—</pre></section>
    <section><h2>Normalized fields</h2><pre id="normalized">—</pre></section>
    <section><h2>Size / package / count</h2><pre id="parsed">—</pre></section>
    <section><h2>Family / cut / processing / variety</h2><pre id="classified">—</pre></section>
    <section><h2>Validation</h2><pre id="validation">—</pre></section>
    <section><h2>Full diagnostics and processing time</h2><pre id="diagnostics">—</pre></section>
  </div>
  <script>
    const $=s=>document.querySelector(s), show=(id,v)=>$(id).textContent=JSON.stringify(v,null,2);
    async function build(){
      $('#status').textContent='Building…';
      try{
        const input=JSON.parse($('#input').value);
        const response=await fetch('${IDENTITY_DEBUG_PATH}/build?mode='+encodeURIComponent($('#mode').value),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
        const result=await response.json(); if(!response.ok)throw new Error(result.error||('HTTP '+response.status));
        show('#candidate',result.identityCandidate); show('#normalized',result.diagnostics.normalizedValues);
        show('#parsed',result.diagnostics.parsingDecisions); show('#classified',result.diagnostics.classificationDecisions);
        show('#validation',{validationResult:result.diagnostics.validationResult,rejectedFields:result.diagnostics.rejectedFields,unresolvedFields:result.diagnostics.unresolvedFields});
        show('#diagnostics',result.diagnostics); $('#status').textContent='Done in '+result.diagnostics.processingTimeMs+' ms';
      }catch(error){$('#status').textContent=error.message;}
    }
    $('#build').addEventListener('click',build); build();
  </script>
</body>
</html>`;

function headers(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  };
}

export async function handleIdentityBuilderDebug(request, ctx = {}) {
  const url = new URL(request.url);
  if (url.pathname !== IDENTITY_DEBUG_PATH && url.pathname !== `${IDENTITY_DEBUG_PATH}/build`) return null;
  if (ctx.isDevelopment !== true) return null;
  if (url.pathname === IDENTITY_DEBUG_PATH && request.method === 'GET') {
    return new Response(HTML, { headers: headers('text/html; charset=utf-8') });
  }
  if (url.pathname === `${IDENTITY_DEBUG_PATH}/build` && request.method === 'POST') {
    let input;
    try {
      input = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Request body must be JSON.' }), { status: 400, headers: headers('application/json; charset=utf-8') });
    }
    const mode = normalizeIdentityMode(url.searchParams.get('mode') || ctx.identityNormalizationMode);
    return new Response(JSON.stringify(buildIdentityCandidate(input, { mode })), { headers: headers('application/json; charset=utf-8') });
  }
  return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: headers('application/json; charset=utf-8') });
}
