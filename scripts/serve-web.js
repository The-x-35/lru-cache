'use strict';

/*
 * serve-web.js — serve dist/ locally, the way a static host does.
 *
 * Only for checking the build before deploying; the hosted version is served
 * by the platform's own CDN and this file is not involved.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 7071);
const DIST = path.join(__dirname, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

if (!fs.existsSync(DIST)) {
  console.error('dist/ does not exist — run `npm run build` first');
  process.exit(1);
}

http.createServer((req, res) => {
  const rel = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0];
  const file = path.resolve(DIST, rel);

  // Contain path traversal: resolve, then confirm we stayed under dist/.
  if (!file.startsWith(DIST)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',   // always see the build you just made
    });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log(`static build on http://localhost:${PORT}`);
});
