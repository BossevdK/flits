'use strict';
// Downloadt bestanden van het internet in stukken over meerdere verbindingen tegelijk
// (elke verbinding haalt een ander stuk), zodat één trage verbinding de snelheid niet bepaalt.
// - Afgeronde stukken worden onthouden: pauzeren en later (ook na het sluiten van Flits) verdergaan kan.
// - Valt een verbinding weg, dan pakken de andere verbindingen haar stuk over.
// Ondersteunt de server geen stukken, dan wordt het bestand gewoon in één keer gedownload (zonder hervatten).
const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CONNECTIONS = 8;
const MAX_CONNECTIONS = 16;
const MIN_PIECE = 1024 * 1024;
const MAX_PIECE = 8 * 1024 * 1024;
const MAX_REDIRECTS = 8;
const MAP_CELLS = 96;
const MAX_PIECE_TRIES = 6; // zo vaak mag één stuk mislukken voordat de download stopt
const WORKER_STRIKES = 3; // zo vaak mag één verbinding achter elkaar mislukken voordat ze stopt
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const LIVE = ['starting', 'active'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanName(raw) {
  let n = String(raw || '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim();
  if (n.length > 120) { const ext = path.extname(n).slice(0, 12); n = n.slice(0, 120 - ext.length) + ext; }
  if (!n) n = 'download';
  if (RESERVED.test(n)) n = '_' + n;
  return n;
}

function nameFrom(res, url) {
  const cd = String(res.headers['content-disposition'] || '');
  let m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (m) { try { return cleanName(decodeURIComponent(m[1].trim())); } catch (_) { /* naar volgende */ } }
  m = /filename\s*=\s*"?([^";]+)"?/.exec(cd);
  if (m) return cleanName(m[1].trim());
  try { return cleanName(decodeURIComponent(path.posix.basename(new URL(url).pathname))); } catch (_) { return 'download'; }
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p) || fs.existsSync(p + '.part'); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

// GET met omleidingen; geeft de response terug met .finalUrl.
function request(url, headers, depth = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('Dat is geen geldige link')); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error('Alleen http- en https-links werken'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers: { 'User-Agent': 'Flits', 'Accept-Encoding': 'identity', Accept: '*/*', ...headers }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (depth >= MAX_REDIRECTS) return reject(new Error('Te veel omleidingen'));
        return resolve(request(new URL(res.headers.location, u).toString(), headers, depth + 1));
      }
      res.finalUrl = u.toString();
      res.req = req;
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('De server reageert niet')));
    req.on('error', reject);
  });
}

class Downloader extends EventEmitter {
  constructor({ getDir, stateFile }) {
    super();
    this.getDir = getDir;
    this.stateFile = stateFile || null;
    this.jobs = new Map();
    this._saveTimer = null;
    this._load();
  }

  list() { return [...this.jobs.values()].map((j) => this._view(j)); }

  _view(j) {
    return {
      id: j.id, url: j.url, name: j.name, size: j.size, done: j.done, speed: j.speed, status: j.status, error: j.error,
      connections: j.connections, path: j.path, resumable: !!j.pieces, map: j.map, slots: j.slots,
    };
  }

  _emit(j) { this.emit('job', this._view(j)); }

  // ---------- onthouden tussen sessies ----------
  _load() {
    if (!this.stateFile) return;
    let data;
    try { data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (_) { return; }
    for (const s of (data && data.jobs) || []) {
      try {
        if (!s || !s.id || !s.url || !s.part || !Array.isArray(s.pieces) || !fs.existsSync(s.part)) continue;
        const j = this._newJob(s.url, s.want);
        Object.assign(j, { id: s.id, name: s.name, path: s.path, part: s.part, size: s.size, tag: s.tag || '', pieces: s.pieces });
        j.have = new Uint8Array(s.pieces.length);
        for (const i of s.doneIdx || []) if (i >= 0 && i < j.have.length) j.have[i] = 2;
        for (const [i, b] of s.partial || []) if (i >= 0 && i < j.have.length && j.have[i] !== 2 && b > 0 && b < j.pieces[i][1] - j.pieces[i][0] + 1) j.partial.set(i, b);
        j.done = j.pieces.reduce((a, p, i) => a + (j.have[i] === 2 ? p[1] - p[0] + 1 : (j.partial.get(i) || 0)), 0);
        j.status = 'paused';
        j.map = this._map(j);
        this.jobs.set(j.id, j);
      } catch (_) { /* kapotte regel overslaan */ }
    }
  }

  _saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._saveNow(); }, 1000);
  }

  _saveNow() {
    if (!this.stateFile) return;
    clearTimeout(this._saveTimer); this._saveTimer = null;
    const jobs = [];
    for (const j of this.jobs.values()) {
      if (!j.pieces || !j.part || j.finished || j.status === 'cancelled' || j.status === 'done') continue;
      const doneIdx = [];
      j.have.forEach((v, i) => { if (v === 2) doneIdx.push(i); });
      jobs.push({ id: j.id, url: j.url, name: j.name, path: j.path, part: j.part, size: j.size, tag: j.tag, want: j.want, pieces: j.pieces, doneIdx, partial: [...j.partial].filter(([i]) => j.have[i] !== 2) });
    }
    try {
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, jobs }));
      fs.renameSync(tmp, this.stateFile);
    } catch (_) { /* geen schrijfrechten: dan werkt hervatten na herstart niet */ }
  }

  // Bij afsluiten van Flits: alles bewaren, een lopende download gaat de volgende keer verder met "Hervatten".
  shutdown() { this._saveNow(); }

  // ---------- opdrachten ----------
  _newJob(url, connections) {
    const want = Math.min(MAX_CONNECTIONS, Math.max(1, Math.round(Number(connections)) || DEFAULT_CONNECTIONS));
    return {
      id: crypto.randomUUID(), url: String(url || '').trim(), name: '', size: 0, done: 0, speed: 0, status: 'starting', error: null,
      connections: 0, want, path: null, part: null, tag: '', pieces: null, have: null, partial: new Map(), map: '', slots: [],
      reqs: new Set(), fd: null, stop: null, gen: 0, finished: false, timer: null, slotBytes: [],
    };
  }

  add(url, connections) {
    const j = this._newJob(url, connections);
    this.jobs.set(j.id, j);
    this._emit(j);
    this._run(j);
    return j.id;
  }

  pause(id) {
    const j = this.jobs.get(id);
    if (!j || !LIVE.includes(j.status) || !j.pieces) return;
    j.stop = 'pause';
    this._abortRequests(j);
  }

  resume(id) {
    const j = this.jobs.get(id);
    if (!j || LIVE.includes(j.status) || j.finished) return;
    if (!j.pieces) { j.done = 0; try { if (j.part) fs.unlinkSync(j.part); } catch (_) { /* weg */ } }
    this._run(j);
  }

  cancel(id) {
    const j = this.jobs.get(id);
    if (!j) return;
    if (LIVE.includes(j.status)) { j.stop = 'cancel'; this._abortRequests(j); return; }
    if (j.status === 'done' || j.status === 'cancelled') return;
    j.status = 'cancelled'; j.speed = 0;
    if (j.part) fs.unlink(j.part, () => {});
    this._saveNow();
    this._emit(j);
  }

  clearFinished() {
    for (const [id, j] of this.jobs) {
      if (LIVE.includes(j.status) || j.status === 'paused') continue;
      if (j.status === 'error' && j.part) fs.unlink(j.part, () => {});
      this.jobs.delete(id);
    }
    this._saveNow();
  }

  _abortRequests(j) {
    for (const r of j.reqs) { try { r.destroy(); } catch (_) { /* al weg */ } }
    j.reqs.clear();
  }

  _stopped(j, gen) { return !!j.stop || j.gen !== gen; }

  _track(j, res) {
    const r = res.req || res;
    j.reqs.add(r);
    res.on('close', () => j.reqs.delete(r));
  }

  // ---------- uitvoeren ----------
  async _run(j) {
    const gen = ++j.gen;
    j.status = 'starting'; j.error = null; j.stop = null; j.speed = 0;
    this._emit(j);
    try {
      await this._exec(j, gen);
    } catch (e) {
      if (!j.stop) { j.status = 'error'; j.error = String((e && e.message) || e); }
    } finally {
      this._finish(j, gen);
    }
  }

  _finish(j, gen) {
    if (j.gen !== gen) return;
    clearInterval(j.timer); j.timer = null;
    this._abortRequests(j);
    if (j.fd !== null) { try { fs.closeSync(j.fd); } catch (_) { /* al dicht */ } j.fd = null; }
    j.speed = 0; j.slots = j.slots.map((s) => (s < 0 ? -1 : 0));
    if (j.stop === 'cancel') {
      j.status = 'cancelled';
      if (j.part) fs.unlink(j.part, () => {});
    } else if (j.stop === 'pause') {
      j.status = 'paused';
    } else if (j.status === 'error') {
      if (!j.pieces && j.part) fs.unlink(j.part, () => {}); // zonder stukken is er niets om mee verder te gaan
    }
    j.stop = null;
    j.map = this._map(j);
    this._saveNow();
    this._emit(j);
  }

  _resetLayout(j) {
    j.pieces = null; j.have = null; j.partial = new Map(); j.done = 0; j.map = '';
    try { if (j.part) fs.unlinkSync(j.part); } catch (_) { /* weg */ }
  }

  _layout(j, total) {
    const piece = Math.max(MIN_PIECE, Math.min(MAX_PIECE, Math.ceil(total / (j.want * 4))));
    j.pieces = [];
    for (let at = 0; at < total; at += piece) j.pieces.push([at, Math.min(total, at + piece) - 1]);
    j.have = new Uint8Array(j.pieces.length);
    j.partial = new Map();
    j.done = 0;
  }

  async _exec(j, gen) {
    const probe = await request(j.url, { Range: 'bytes=0-0' });
    if (this._stopped(j, gen)) { probe.resume(); return; }
    if (probe.statusCode !== 200 && probe.statusCode !== 206) { probe.resume(); throw new Error(`De server antwoordde met ${probe.statusCode}`); }
    const range = /\/(\d+)$/.exec(String(probe.headers['content-range'] || ''));
    const parted = probe.statusCode === 206 && !!range;
    const total = parted ? Number(range[1]) : Number(probe.headers['content-length']) || 0;
    const tag = String(probe.headers.etag || probe.headers['last-modified'] || '');

    // Verdergaan mag alleen als het nog hetzelfde bestand is; anders opnieuw beginnen.
    if (j.pieces && !(parted && total === j.size && (!j.tag || !tag || j.tag === tag) && j.part && fs.existsSync(j.part))) this._resetLayout(j);
    if (!j.path) {
      const dir = this.getDir();
      fs.mkdirSync(dir, { recursive: true });
      j.path = uniquePath(dir, nameFrom(probe, probe.finalUrl));
      j.name = path.basename(j.path);
      j.part = j.path + '.part';
    }
    j.size = total; j.tag = tag;
    j.status = 'active';

    let lastDone = j.done;
    let lastSlots = [];
    j.timer = setInterval(() => {
      j.speed = (j.done - lastDone) * 2; lastDone = j.done;
      j.slots = j.slotBytes.map((b, i) => (j.slots[i] < 0 ? -1 : (b - (lastSlots[i] || 0)) * 2));
      lastSlots = [...j.slotBytes];
      j.map = this._map(j);
      this._emit(j);
    }, 500);

    if (parted && total > 0) {
      probe.resume();
      if (!j.pieces) this._layout(j, total);
      j.fd = fs.openSync(j.part, j.done > 0 ? 'r+' : 'w');
      await this._runParts(j, probe.finalUrl, gen);
    } else {
      j.fd = fs.openSync(j.part, 'w');
      await this._runSingle(j, probe, gen);
    }
    if (this._stopped(j, gen)) return;
    if (j.size && j.done !== j.size) throw new Error('Download is niet compleet');
    clearInterval(j.timer); j.timer = null;
    fs.closeSync(j.fd); j.fd = null;
    fs.renameSync(j.part, j.path);
    j.finished = true; j.status = 'done'; j.speed = 0; j.map = '';
  }

  async _runSingle(j, res, gen) {
    j.connections = 1; j.slots = [0]; j.slotBytes = [0];
    this._emit(j);
    this._track(j, res);
    let pos = 0;
    try {
      for await (const c of res) {
        if (this._stopped(j, gen)) return;
        fs.writeSync(j.fd, c, 0, c.length, pos);
        pos += c.length; j.done += c.length; j.slotBytes[0] += c.length;
      }
    } catch (e) { if (!this._stopped(j, gen)) throw e; }
  }

  async _runParts(j, url, gen) {
    const queue = [];
    j.have.forEach((v, i) => { if (v !== 2) queue.push(i); });
    const tries = new Map();
    j.connections = Math.min(j.want, queue.length);
    j.slots = Array(j.connections).fill(0);
    j.slotBytes = Array(j.connections).fill(0);
    this._emit(j);
    let fatal = null;
    let lastError = null;

    // Een stuk dat half binnen was gaat verder waar het stopte (j.partial onthoudt hoeveel er al staat).
    const fetchPiece = async (idx, slot) => {
      const [from, to] = j.pieces[idx];
      let pos = from + (j.partial.get(idx) || 0);
      if (pos > to) return true;
      const res = await request(url, { Range: `bytes=${pos}-${to}` });
      this._track(j, res);
      if (res.statusCode !== 206) { res.resume(); throw new Error(`De server weigerde een stuk (${res.statusCode})`); }
      for await (const c of res) {
        if (this._stopped(j, gen)) return false;
        fs.writeSync(j.fd, c, 0, c.length, pos);
        pos += c.length; j.done += c.length; j.slotBytes[slot] += c.length;
        j.partial.set(idx, pos - from);
      }
      if (pos !== to + 1) throw new Error('Stuk is niet compleet');
      j.partial.delete(idx);
      return true;
    };

    const worker = async (slot) => {
      let strikes = 0;
      while (!fatal && !this._stopped(j, gen)) {
        const idx = queue.shift();
        if (idx === undefined) break;
        j.have[idx] = 1;
        try {
          if (await fetchPiece(idx, slot)) { j.have[idx] = 2; strikes = 0; this._saveSoon(); } else { j.have[idx] = 0; }
        } catch (e) {
          j.have[idx] = 0;
          if (this._stopped(j, gen)) return;
          lastError = e;
          if (e && e.syscall === 'write') { fatal = e; return; } // schijf vol of niet beschrijfbaar: stoppen heeft geen zin
          const n = (tries.get(idx) || 0) + 1;
          tries.set(idx, n);
          if (n >= MAX_PIECE_TRIES) { fatal = e; return; }
          queue.push(idx); // een andere verbinding mag het stuk overnemen
          if (++strikes >= WORKER_STRIKES) { j.slots[slot] = -1; return; } // deze verbinding geeft het op, de rest gaat door
          await sleep(300 * strikes);
        }
      }
    };

    await Promise.all(Array.from({ length: j.connections }, (_, slot) => worker(slot)));
    if (this._stopped(j, gen)) return;
    if (fatal) throw fatal;
    if (queue.length) throw lastError || new Error('Alle verbindingen zijn weggevallen');
  }

  // Compacte kaart van de stukken: 0 = nog niet, 1 = bezig of gedeeltelijk, 2 = binnen.
  _map(j) {
    if (!j.have || !j.have.length) return '';
    const n = j.have.length;
    const cells = Math.min(n, MAP_CELLS);
    let out = '';
    for (let c = 0; c < cells; c++) {
      const a = Math.floor((c * n) / cells); const b = Math.floor(((c + 1) * n) / cells);
      let done = 0; let any = 0;
      for (let i = a; i < b; i++) { if (j.have[i] === 2) done++; if (j.have[i] > 0) any++; }
      out += done === b - a ? '2' : any ? '1' : '0';
    }
    return out;
  }
}

module.exports = { Downloader, cleanName, nameFrom };
