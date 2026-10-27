'use strict';
// Trage testserver voor het handmatig bekijken van de downloadmanager: node test/slowserver.js, link: http://127.0.0.1:8099/trage
const http = require('http');
const crypto = require('crypto');
const data = crypto.randomBytes(80 * 1024 * 1024);
http.createServer((req, res) => {
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const a = m ? Number(m[1]) : 0; const b = m && m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
  res.writeHead(m ? 206 : 200, { 'Content-Length': b - a + 1, ETag: '"v1"', 'Content-Disposition': 'attachment; filename="testbestand.bin"', ...(m ? { 'Content-Range': `bytes ${a}-${b}/${data.length}` } : {}) });
  let at = a;
  const tick = () => { if (res.destroyed || at > b) return; const e = Math.min(b + 1, at + 32768); res.write(data.subarray(at, e)); at = e; if (at > b) res.end(); else setTimeout(tick, 30); };
  tick();
}).listen(8099, '127.0.0.1');
