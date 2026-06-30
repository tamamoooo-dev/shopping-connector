// dev.mjs — local development server (NOT part of the deployed Worker).
//
// Cloudflare Workers run on Web APIs (fetch/Request/Response/URL/crypto), all of
// which are global in Node 18+. This tiny adapter turns the same Worker module
// into a Node HTTP server so the connector can be verified locally with zero
// dependencies (no wrangler, no npm install). The Worker code is unchanged and
// deploys to Cloudflare as-is.
//
//   node dev.mjs        ->  http://localhost:8787

import http from 'node:http';
import worker from './src/index.js';

const PORT = process.env.PORT || 8787;

http
  .createServer(async (req, res) => {
    const request = new Request(`http://localhost:${PORT}${req.url}`, {
      method: req.method,
      headers: req.headers,
    });
    try {
      const response = await worker.fetch(request);
      const body = await response.text();
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  })
  .listen(PORT, () => {
    console.log(`shopping-connector (node dev) -> http://localhost:${PORT}`);
    console.log(`try: http://localhost:${PORT}/search?provider=panda&q=milk`);
  });
