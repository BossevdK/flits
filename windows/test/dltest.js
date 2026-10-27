'use strict';
// Test van de downloadmanager tegen een lokale server (met en zonder stukken, met omleiding en bestandsnaam).
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Downloader, cleanName } = require('../src/downloader');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flits-dl-'));
const data = crypto.randomBytes(20 * 1024 * 1024 + 123);
let ranged = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/go') { res.writeHead(302, { Location: '/files/big%20file.bin' }); return res.end(); }
  if (u.pathname === '/files/big%20file.bin' || u.pathname === '/files/big file.bin' || u.pathname === '/norange') {
    const canRange = u.pathname !== '/norange';
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m && canRange) {
      ranged++;
      const a = Number(m[1]); const b = m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      return res.end(data.subarray(a, b + 1));
    }
    const h = { 'Content-Length': data.length };
    if (u.pathname === '/norange') h['Content-Disposition'] = 'attachment; filename="../../evil:name?.bin"';
    res.writeHead(200, h);
    return res.end(data);
  }
  if (u.pathname === '/slow') { res.writeHead(200, { 'Content-Length': data.length }); res.write(data.subarray(0, 1000)); return; }
  res.writeHead(404); res.end();
});

let failed = 0;
const ok = (c, msg) => { console.log((c ? 'OK    ' : 'FOUT  ') + msg); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitDone = async (dl, id) => { for (let i = 0; i < 400; i++) { const j = dl.jobs.get(id); if (!['starting', 'active'].includes(j.status)) return j; await sleep(50); } throw new Error('time-out'); };

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const dir = path.join(tmp, 'dl');
  const dl = new Downloader({ getDir: () => dir });

  let j = await waitDone(dl, dl.add(base + '/go'));
  ok(j.status === 'done' && path.basename(j.path) === 'big file.bin', 'omleiding gevolgd, bestandsnaam uit de link');
  ok(fs.readFileSync(j.path).equals(data), 'bestand identiek na 8 stukken tegelijk');
  ok(ranged > 8 && dl.jobs.get(j.id).connections === 8, `stukken apart opgehaald (${ranged} verzoeken, 8 verbindingen)`);

  j = await waitDone(dl, dl.add(base + '/go'));
  ok(path.basename(j.path) === 'big file (1).bin', 'tweede keer krijgt (1) achter de naam');

  j = await waitDone(dl, dl.add(base + '/norange'));
  ok(j.status === 'done' && j.connections === 1 && fs.readFileSync(j.path).equals(data), 'server zonder stukken: gewoon in één keer');
  ok(path.dirname(j.path) === dir && !/[:?]/.test(path.basename(j.path)), 'gevaarlijke bestandsnaam wordt veilig gemaakt: ' + path.basename(j.path));

  j = await waitDone(dl, dl.add(base + '/bestaatniet'));
  ok(j.status === 'error', 'foutmelding bij 404: ' + j.error);
  j = await waitDone(dl, dl.add('ftp://x/y'));
  ok(j.status === 'error', 'alleen http(s)-links');

  const id = dl.add(base + '/slow');
  await sleep(600);
  dl.cancel(id);
  await sleep(200);
  ok(dl.jobs.get(id).status === 'cancelled' && !fs.readdirSync(dir).some((f) => f.endsWith('.part')), 'annuleren ruimt het halve bestand op');
  ok(cleanName('CON') === '_CON' && cleanName('a/b\\c') === 'a_b_c', 'gereserveerde namen en slashes worden veilig');

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} FOUT` : '\nAlles geslaagd');
  process.exit(failed ? 1 : 0);
});
