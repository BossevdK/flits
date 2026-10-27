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
let ranged = 0; let open = 0; let flaky = 0; let served = 0;
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
  if (u.pathname === '/trage' || u.pathname === '/beperkt' || u.pathname === '/wispelturig') {
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'Content-Length': data.length, ETag: '"v1"' }); return res.end(data); }
    const a = Number(m[1]); const b = m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
    if (u.pathname === '/beperkt') { // maximaal 3 verbindingen tegelijk
      if (open >= 3) { res.writeHead(429); return res.end(); }
    }
    if (u.pathname === '/wispelturig' && a === 0 && b > 0 && flaky++ < 3) { req.socket.destroy(); return; } // eerste stuk valt 3 keer weg
    res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1, ETag: '"v1"' });
    open++; res.on('close', () => { open--; });
    let at = a;
    const tick = () => {
      if (res.destroyed || at > b) return;
      const end = Math.min(b + 1, at + 32 * 1024);
      served += end - at;
      res.write(data.subarray(at, end)); at = end;
      if (at > b) res.end(); else setTimeout(tick, u.pathname === '/trage' ? 25 : 2);
    };
    return tick();
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
  ok(j.status === 'done' && path.basename(j.path) === 'big file.bin', 'omleiding gevolgd, bestandsnaam uit de link ' + j.status + ' ' + j.error);
  ok(fs.readFileSync(j.path).equals(data), 'bestand identiek na 8 stukken tegelijk');
  ok(ranged > 8 && dl.jobs.get(j.id).connections === 8, `stukken apart opgehaald (${ranged} verzoeken, 8 verbindingen)`);

  j = await waitDone(dl, dl.add(base + '/go', 16));
  ok(j.connections === 16, 'schuif op 16 geeft 16 verbindingen');
  j = await waitDone(dl, dl.add(base + '/go', 99));
  ok(j.connections === 16, 'meer dan 16 wordt begrensd');
  j = await waitDone(dl, dl.add(base + '/go', 3));
  ok(j.connections === 3 && fs.readFileSync(j.path).equals(data), 'schuif op 3 geeft 3 verbindingen, bestand identiek');
  j = await waitDone(dl, dl.add(base + '/go'));
  ok(path.basename(j.path) === 'big file (4).bin', 'nummer achter de naam telt door');

  j = await waitDone(dl, dl.add(base + '/norange'));
  ok(j.status === 'done' && j.connections === 1 && fs.readFileSync(j.path).equals(data), 'server zonder stukken: gewoon in één keer');
  ok(path.dirname(j.path) === dir && !/[:?]/.test(path.basename(j.path)), 'gevaarlijke bestandsnaam wordt veilig gemaakt: ' + path.basename(j.path));

  j = await waitDone(dl, dl.add(base + '/bestaatniet'));
  ok(j.status === 'error', 'foutmelding bij 404: ' + j.error);
  j = await waitDone(dl, dl.add('ftp://x/y'));
  ok(j.status === 'error', 'alleen http(s)-links');

  // pauzeren en verdergaan, ook na "herstart" van Flits
  const stateFile = path.join(tmp, 'downloads.json');
  const dl2 = new Downloader({ getDir: () => dir, stateFile });
  served = 0;
  const pid = dl2.add(base + '/trage', 8);
  for (let i = 0; i < 200 && dl2.jobs.get(pid).done < data.length * 0.3; i++) await sleep(50);
  dl2.pause(pid);
  await sleep(400);
  let pj = dl2.jobs.get(pid);
  const partFile = pj.path + '.part';
  ok(pj.status === 'paused' && fs.existsSync(partFile) && pj.done > 0 && pj.done < data.length, 'pauzeren: status gepauzeerd, half bestand blijft staan (' + Math.round((pj.done / data.length) * 100) + '%)');
  const doneBefore = pj.done; const servedBefore = served;
  const dl3 = new Downloader({ getDir: () => dir, stateFile }); // alsof Flits opnieuw is gestart
  const rj = dl3.jobs.get(pid);
  ok(rj && rj.status === 'paused' && rj.done === doneBefore, 'na herstart staat de download er nog, met dezelfde voortgang');
  dl3.resume(pid);
  const fin = await waitDone(dl3, pid);
  ok(fin.status === 'done' && fs.readFileSync(fin.path).equals(data), 'verdergaan levert een identiek bestand op');
  ok(served - servedBefore < data.length - doneBefore + 3 * 1024 * 1024, `niet opnieuw begonnen: na het hervatten nog maar ${((served - servedBefore) / 1048576).toFixed(1)} MB opgehaald van ${(data.length / 1048576).toFixed(1)} MB`);
  ok(!fs.existsSync(partFile) && !JSON.parse(fs.readFileSync(stateFile, 'utf8')).jobs.length, 'half bestand en bewaarde gegevens zijn opgeruimd');

  // veranderd bestand op de server: opnieuw beginnen in plaats van een kapot bestand maken
  const cj = dl3.add(base + '/wispelturig', 4);
  const wj = await waitDone(dl3, cj);
  ok(wj.status === 'done' && fs.readFileSync(wj.path).equals(data), 'een verbinding valt 3 keer weg: de rest neemt het stuk over');

  const bj = await waitDone(dl3, dl3.add(base + '/beperkt', 8));
  ok(bj.status === 'done' && fs.readFileSync(bj.path).equals(data), 'server staat maar 3 verbindingen toe: Flits past zich aan en slaagt toch');
  ok(bj.slots.some((x) => x < 0), 'verbindingen die het opgaven worden als weggevallen getoond');
  ok(typeof pj.map === 'string', 'pixelkaart is een tekenreeks');

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
