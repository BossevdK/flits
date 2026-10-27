'use strict';
// Downloadt bestanden van het internet in stukken over meerdere verbindingen tegelijk
// (elke verbinding haalt een ander stuk), zodat één trage verbinding de snelheid niet bepaalt.
// Ondersteunt de server geen stukken, dan wordt het bestand gewoon in één keer gedownload.
const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONNECTIONS = 8;
const MIN_PIECE = 1024 * 1024;
const MAX_REDIRECTS = 8;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

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
  constructor({ getDir }) {
    super();
    this.getDir = getDir;
    this.jobs = new Map();
  }

  list() { return [...this.jobs.values()].map((j) => this._view(j)); }

  _view(j) {
    return { id: j.id, url: j.url, name: j.name, size: j.size, done: j.done, speed: j.speed, status: j.status, error: j.error, connections: j.connections, path: j.path };
  }

  _emit(j) { this.emit('job', this._view(j)); }

  add(url) {
    const j = { id: crypto.randomUUID(), url: String(url || '').trim(), name: '', size: 0, done: 0, speed: 0, status: 'starting', error: null, connections: 0, path: null, reqs: new Set(), fd: null, cancelled: false };
    this.jobs.set(j.id, j);
    this._emit(j);
    this._run(j).catch((e) => this._fail(j, e));
    return j.id;
  }

  cancel(id) {
    const j = this.jobs.get(id);
    if (!j || !['starting', 'active'].includes(j.status)) return;
    j.cancelled = true;
    j.status = 'cancelled';
    this._cleanup(j, true);
    this._emit(j);
  }

  remove(id) {
    const j = this.jobs.get(id);
    if (!j) return;
    if (['starting', 'active'].includes(j.status)) this.cancel(id);
    this.jobs.delete(id);
  }

  clearFinished() {
    for (const [id, j] of this.jobs) if (!['starting', 'active'].includes(j.status)) this.jobs.delete(id);
  }

  _cleanup(j, removeFile) {
    clearInterval(j.timer);
    j.speed = 0;
    for (const r of j.reqs) { try { r.destroy(); } catch (_) { /* al weg */ } }
    j.reqs.clear();
    if (j.fd !== null) { try { fs.closeSync(j.fd); } catch (_) { /* al dicht */ } j.fd = null; }
    if (removeFile && j.part) fs.unlink(j.part, () => {});
  }

  _fail(j, e) {
    if (j.cancelled || j.status === 'error' || j.status === 'done') return;
    j.status = 'error';
    j.error = String((e && e.message) || e);
    this._cleanup(j, true);
    this._emit(j);
  }

  _track(j, res) { j.reqs.add(res.req || res); res.on('close', () => j.reqs.delete(res.req || res)); }

  async _run(j) {
    const probe = await request(j.url, { Range: 'bytes=0-0' });
    if (j.cancelled) { probe.resume(); return; }
    if (probe.statusCode !== 200 && probe.statusCode !== 206) { probe.resume(); throw new Error(`De server antwoordde met ${probe.statusCode}`); }
    const dir = this.getDir();
    fs.mkdirSync(dir, { recursive: true });
    j.name = nameFrom(probe, probe.finalUrl);
    j.path = uniquePath(dir, j.name);
    j.name = path.basename(j.path);
    j.part = j.path + '.part';
    const range = /\/(\d+)$/.exec(String(probe.headers['content-range'] || ''));
    const parted = probe.statusCode === 206 && range;
    j.size = parted ? Number(range[1]) : Number(probe.headers['content-length']) || 0;
    j.status = 'active';
    j.fd = fs.openSync(j.part, 'w');
    let last = 0;
    j.timer = setInterval(() => {
      j.speed = (j.done - last) / 0.5; last = j.done;
      this._emit(j);
    }, 500);
    if (parted && j.size > 0) {
      probe.resume();
      await this._runParts(j, probe.finalUrl);
    } else {
      await this._runSingle(j, probe);
    }
    if (j.cancelled) return;
    if (j.size && j.done !== j.size) throw new Error('Download is niet compleet');
    clearInterval(j.timer);
    fs.closeSync(j.fd); j.fd = null;
    fs.renameSync(j.part, j.path);
    j.status = 'done'; j.speed = 0;
    this._emit(j);
  }

  async _runSingle(j, res) {
    j.connections = 1;
    this._emit(j);
    this._track(j, res);
    let pos = 0;
    try {
      for await (const c of res) {
        if (j.cancelled) return;
        fs.writeSync(j.fd, c, 0, c.length, pos);
        pos += c.length; j.done += c.length;
      }
    } catch (e) { if (!j.cancelled) throw e; }
  }

  async _runParts(j, url) {
    const piece = Math.max(MIN_PIECE, Math.ceil(j.size / (CONNECTIONS * 4)));
    const queue = [];
    for (let at = 0; at < j.size; at += piece) queue.push([at, Math.min(j.size, at + piece) - 1]);
    j.connections = Math.min(CONNECTIONS, queue.length);
    this._emit(j);
    let failed = null;
    const fetchPiece = async ([from, to], attempt = 0) => {
      let got = 0;
      try {
        const res = await request(url, { Range: `bytes=${from}-${to}` });
        this._track(j, res);
        if (res.statusCode !== 206) { res.resume(); throw new Error(`De server stopte met stukken (${res.statusCode})`); }
        let pos = from;
        for await (const c of res) {
          if (j.cancelled) return;
          fs.writeSync(j.fd, c, 0, c.length, pos);
          pos += c.length; got += c.length; j.done += c.length;
        }
        if (pos !== to + 1) throw new Error('Stuk is niet compleet');
      } catch (e) {
        j.done -= got;
        if (j.cancelled) return;
        if (attempt >= 2) throw e;
        return fetchPiece([from, to], attempt + 1);
      }
    };
    const worker = async () => {
      for (let p = queue.shift(); p && !failed && !j.cancelled; p = queue.shift()) {
        try { await fetchPiece(p); } catch (e) { failed = failed || e; for (const r of j.reqs) r.destroy(); }
      }
    };
    await Promise.all(Array.from({ length: j.connections }, worker));
    if (failed) throw failed;
  }
}

module.exports = { Downloader, cleanName, nameFrom };
