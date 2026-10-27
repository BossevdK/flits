'use strict';
// Zelftest: twee Flits-instanties op één pc sturen bestanden en tekst naar elkaar.
// Draaien: node test/selftest.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Flits } = require('../src/core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flits-test-'));
const mk = (name, port, extra = {}) => {
  const settings = { id: crypto.randomUUID(), deviceName: name, saveDir: path.join(tmp, name + '-ontvangen'), trusted: [], autoAcceptAll: false, ...extra };
  const f = new Flits({ dataDir: path.join(tmp, name + '-data'), getSettings: () => settings, port, discoveryPort: 54010 });
  return { f, settings };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000, what = 'conditie') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  throw new Error('time-out: ' + what);
};
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let failed = 0;
const ok = (c, msg) => { console.log((c ? 'OK    ' : 'FOUT  ') + msg); if (!c) failed++; };

(async () => {
  const A = mk('A', 54001);
  const B = mk('B', 54002, { autoAcceptAll: true });
  await A.f.start();
  await B.f.start();

  await until(() => A.f.peers.size === 1 && B.f.peers.size === 1, 8000, 'apparaten vinden elkaar');
  ok(true, 'apparaten vinden elkaar via UDP');

  // bestand van 25 MB + klein bestand + map
  const big = path.join(tmp, 'groot.bin');
  fs.writeFileSync(big, crypto.randomBytes(25 * 1024 * 1024));
  const small = path.join(tmp, 'klein.txt');
  fs.writeFileSync(small, 'hallo wereld');
  const dir = path.join(tmp, 'mapje');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'in submap');

  const bId = [...A.f.peers.keys()][0];
  let received = null;
  B.f.on('received', (t) => { received = t; });
  const t0 = Date.now();
  const tid = A.f.sendFiles(bId, [big, small, dir]);
  await until(() => received, 20000, 'bestanden ontvangen');
  const dt = (Date.now() - t0) / 1000;
  ok(sha(big) === sha(received.savedPaths[0] || path.join(B.settings.saveDir, 'groot.bin')) || sha(big) === sha(path.join(B.settings.saveDir, 'groot.bin')), `groot bestand identiek (${(25 / dt).toFixed(0)} MB/s)`);
  ok(fs.readFileSync(path.join(B.settings.saveDir, 'klein.txt'), 'utf8') === 'hallo wereld', 'klein bestand identiek');
  ok(fs.readFileSync(path.join(B.settings.saveDir, 'mapje', 'sub', 'a.txt'), 'utf8') === 'in submap', 'mapstructuur behouden');
  await until(() => A.f.transfers.get(tid).status === 'done', 3000, 'afzender klaar');
  ok(true, 'afzender meldt klaar');

  // zelfde bestand opnieuw: krijgt "(1)"
  received = null;
  A.f.sendFiles(bId, [small]);
  await until(() => received, 5000, 'tweede ontvangst');
  ok(fs.existsSync(path.join(B.settings.saveDir, 'klein (1).txt')), 'dubbele naam krijgt (1)');

  // tekst
  let txt = null;
  B.f.on('text-received', (t) => { txt = t; });
  A.f.sendText(bId, 'een link: https://voorbeeld.nl');
  await until(() => txt, 5000, 'tekst ontvangen');
  ok(txt.text === 'een link: https://voorbeeld.nl', 'tekst aangekomen');

  // weigeren (B vraagt nu toestemming)
  B.settings.autoAcceptAll = false;
  B.f.once('offer', (o) => setTimeout(() => B.f.respondOffer(o.id, false, false), 100));
  const tid2 = A.f.sendFiles(bId, [small]);
  await until(() => A.f.transfers.get(tid2).status === 'declined', 5000, 'geweigerd');
  ok(true, 'weigeren werkt');

  // accepteren en onthouden
  B.f.once('offer', (o) => setTimeout(() => B.f.respondOffer(o.id, true, true), 100));
  B.f.once('trust', (id) => B.settings.trusted.push(id));
  received = null;
  A.f.sendFiles(bId, [small]);
  await until(() => received, 5000, 'geaccepteerd');
  ok(B.settings.trusted.length === 1, 'apparaat onthouden na accepteren');

  // annuleren tijdens versturen
  const tid3 = A.f.sendFiles(bId, [big]);
  await until(() => A.f.transfers.get(tid3).done > 1024 * 1024, 5000, 'begonnen');
  A.f.cancel(tid3);
  await sleep(600);
  ok(A.f.transfers.get(tid3).status === 'cancelled', 'afzender kan annuleren');
  const leftovers = fs.readdirSync(B.settings.saveDir).filter((n) => /^groot \(/.test(n));
  ok(leftovers.length === 0, 'half bestand is opgeruimd bij de ontvanger');

  // afzender trekt aanvraag in terwijl de ontvanger nog moet kiezen
  B.settings.trusted.length = 0;
  let closed = false;
  B.f.once('offer', () => {});
  B.f.once('offer-closed', () => { closed = true; });
  const tid4 = A.f.sendFiles(bId, [small]);
  await until(() => B.f.pendingOffers.size === 1, 5000, 'aanvraag staat open');
  A.f.cancel(tid4);
  await until(() => closed && B.f.pendingOffers.size === 0, 5000, 'aanvraag ingetrokken');
  ok(true, 'afzender kan aanvraag intrekken voordat de ontvanger kiest');

  A.f.stop(); B.f.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} test(s) mislukt` : '\nAlles geslaagd');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FOUT: ' + e.stack); process.exit(1); });
