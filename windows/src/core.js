'use strict';
// Flits-kern: apparaten vinden (UDP), bestanden ontvangen (HTTPS-server) en versturen (HTTPS-client).
// Geen Electron-afhankelijkheden, zodat dit ook los met Node te testen is.
//
// Protocol (v1)
//   Ontdekken : UDP-broadcast op poort 53318, elke 3 s: {app:"flits",v:1,id,name,type,port}
//   GET  /info                          -> {id,name,type,port}
//   POST /offer   {sender,files[],text} -> {accepted,token}   (wacht tot de gebruiker kiest)
//   PUT  /upload/<token>/<bestandId>    -> ruwe bytes als body
//   POST /cancel/<token>

const { EventEmitter } = require('events');
const https = require('https');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const selfsigned = require('selfsigned');

const DEFAULT_PORT = 53317;
const DEFAULT_DISCOVERY_PORT = 53318;
const OFFER_TIMEOUT_MS = 60000;
const PEER_TTL_MS = 10000;

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

function safeSegment(s) {
  let out = String(s).replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '_').trim();
  out = out.replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(out)) out = '_' + out;
  return out || 'bestand';
}

// "map/sub/foto.jpg" -> veilige segmenten, nooit buiten de doelmap.
function safeRelPath(name) {
  return String(name).split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..').map(safeSegment).join(path.sep) || 'bestand';
}

function uniquePath(full) {
  if (!fs.existsSync(full)) return full;
  const { dir, name, ext } = path.parse(full);
  for (let i = 1; i < 10000; i++) {
    const cand = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(dir, `${name}-${Date.now()}${ext}`);
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('te groot')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}

function httpsJson(peer, method, urlPath, body, { timeout = 15000, onReq } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      host: peer.ip, port: peer.port, path: urlPath, method, agent, timeout,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch (_) { /* leeg */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Geen reactie van het andere apparaat')));
    req.on('error', reject);
    if (onReq) onReq(req);
    if (data) req.write(data);
    req.end();
  });
}

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

class Flits extends EventEmitter {
  constructor({ dataDir, getSettings, port = DEFAULT_PORT, discoveryPort = DEFAULT_DISCOVERY_PORT, type = 'windows' }) {
    super();
    this.dataDir = dataDir;
    this.getSettings = getSettings;
    this.port = port;
    this.discoveryPort = discoveryPort;
    this.type = type;
    this.peers = new Map();       // id -> {id,name,type,ip,port,lastSeen,manual}
    this.manualHosts = new Map(); // "ip:port" -> {ip,port}
    this.transfers = new Map();   // id -> transfer
    this.pendingOffers = new Map(); // offerId -> {resolve, transfer}
    this.sessions = new Map();    // token -> sessie van een ontvangst
    this.outgoing = new Map();    // transferId -> {abort}
    this._emitTimers = new Map();
  }

  get settings() { return this.getSettings(); }
  info() { return { id: this.settings.id, name: this.settings.deviceName, type: this.type, port: this.port }; }

  // ---------- start / stop ----------
  async start() {
    this._loadCert();
    await this._startServer();
    this._startDiscovery();
    this._timers = [
      setInterval(() => this._announce(), 3000),
      setInterval(() => this._prune(), 2000),
      setInterval(() => this._pollManual(), 5000),
    ];
    this._announce();
  }

  stop() {
    (this._timers || []).forEach(clearInterval);
    try { this.udp.close(); } catch (_) { /* al dicht */ }
    try { this.server.close(); } catch (_) { /* al dicht */ }
    for (const o of this.outgoing.values()) o.abort();
  }

  _loadCert() {
    const keyFile = path.join(this.dataDir, 'tls-key.pem');
    const certFile = path.join(this.dataDir, 'tls-cert.pem');
    try {
      this.tls = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
      return;
    } catch (_) { /* nog niet gemaakt */ }
    const pems = selfsigned.generate([{ name: 'commonName', value: 'flits.local' }], {
      days: 3650, keySize: 2048, algorithm: 'sha256',
    });
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(keyFile, pems.private);
    fs.writeFileSync(certFile, pems.cert);
    this.tls = { key: pems.private, cert: pems.cert };
  }

  _startServer() {
    return new Promise((resolve, reject) => {
      this.server = https.createServer(this.tls, (req, res) => {
        this._handle(req, res).catch((e) => {
          if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
          else res.destroy();
        });
      });
      this.server.on('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => { this.server.off('error', reject); resolve(); });
    });
  }

  // ---------- apparaten vinden ----------
  _startDiscovery() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = sock;
    sock.on('error', () => { /* poort bezet: dan werkt alleen handmatig toevoegen */ });
    sock.on('message', (msg, rinfo) => {
      let m;
      try { m = JSON.parse(msg.toString('utf8')); } catch (_) { return; }
      if (!m || m.app !== 'flits' || !m.id || m.id === this.settings.id) return;
      const known = this.peers.get(m.id);
      this._upsertPeer({ id: m.id, name: String(m.name || 'Onbekend'), type: m.type || 'other', ip: rinfo.address, port: Number(m.port) || DEFAULT_PORT });
      if (!known) this._announceTo(rinfo.address); // meteen terugmelden zodat de ander ons snel ziet
    });
    sock.bind(this.discoveryPort, () => {
      try { sock.setBroadcast(true); } catch (_) { /* geen netwerk */ }
    });
  }

  _packet() {
    return Buffer.from(JSON.stringify({ app: 'flits', v: 1, ...this.info() }));
  }

  _announce() {
    if (!this.udp) return;
    const pkt = this._packet();
    for (const addr of broadcastAddresses()) {
      try { this.udp.send(pkt, this.discoveryPort, addr, () => {}); } catch (_) { /* netwerk weg */ }
    }
  }

  _announceTo(ip) {
    try { this.udp.send(this._packet(), this.discoveryPort, ip, () => {}); } catch (_) { /* negeren */ }
  }

  _upsertPeer(p) {
    const old = this.peers.get(p.id);
    const next = { ...old, ...p, lastSeen: Date.now() };
    this.peers.set(p.id, next);
    if (!old || old.name !== next.name || old.ip !== next.ip || old.port !== next.port) this._emitPeers();
  }

  _prune() {
    let changed = false;
    for (const [id, p] of this.peers) {
      if (Date.now() - p.lastSeen > PEER_TTL_MS) { this.peers.delete(id); changed = true; }
    }
    if (changed) this._emitPeers();
  }

  _emitPeers() {
    this.emit('peers', this.peerList());
  }

  peerList() {
    return [...this.peers.values()]
      .map((p) => ({ id: p.id, name: p.name, type: p.type, ip: p.ip, port: p.port, manual: !!p.manual }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Handmatig toevoegen met IP-adres (voor netwerken waar broadcast niet werkt).
  async addManual(host) {
    const [ip, portStr] = String(host).trim().split(':');
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('Geen geldig IP-adres');
    const port = Number(portStr) || DEFAULT_PORT;
    const { status, json } = await httpsJson({ ip, port }, 'GET', '/info', undefined, { timeout: 4000 }).catch(() => {
      throw new Error('Geen Flits gevonden op dit adres');
    });
    if (status !== 200 || !json || !json.id) throw new Error('Geen Flits gevonden op dit adres');
    this.manualHosts.set(`${ip}:${port}`, { ip, port });
    this._upsertPeer({ id: json.id, name: json.name, type: json.type, ip, port, manual: true });
    return this.peerList();
  }

  _pollManual() {
    for (const h of this.manualHosts.values()) {
      httpsJson(h, 'GET', '/info', undefined, { timeout: 3000 })
        .then(({ json }) => { if (json && json.id && json.id !== this.settings.id) this._upsertPeer({ id: json.id, name: json.name, type: json.type, ip: h.ip, port: h.port, manual: true }); })
        .catch(() => {});
    }
  }

  // ---------- ontvangen ----------
  async _handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/info') return sendJson(res, 200, this.info());
    if (req.method === 'POST' && p === '/offer') return this._handleOffer(req, res);

    let m = p.match(/^\/upload\/([\w-]+)\/(\d+)$/);
    if (req.method === 'PUT' && m) return this._handleUpload(req, res, m[1], Number(m[2]));

    m = p.match(/^\/cancel\/([\w-]+)$/);
    if (req.method === 'POST' && m) {
      const s = this.sessions.get(m[1]);
      if (s) this._endSession(s, 'cancelled', 'De afzender heeft geannuleerd');
      // Aanvraag intrekken terwijl de ontvanger nog moet kiezen.
      for (const [id, o] of this.pendingOffers) {
        if (o.transfer.remoteOfferId === m[1]) { this.pendingOffers.get(id).resolve({ accept: false, gone: true }); }
      }
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: 'onbekend' });
  }

  async _handleOffer(req, res) {
    const body = await readJson(req);
    const sender = body.sender || {};
    const files = Array.isArray(body.files) ? body.files : [];
    const text = typeof body.text === 'string' ? body.text.slice(0, 200000) : null;
    if (!sender.id || (!files.length && text === null)) return sendJson(res, 400, { error: 'ongeldig aanbod' });

    const cleanFiles = files.slice(0, 5000).map((f, i) => ({
      id: i,
      name: safeRelPath(f.name),
      size: Math.max(0, Number(f.size) || 0),
      done: 0,
    }));
    const transfer = {
      id: crypto.randomUUID(), dir: 'in', status: 'waiting',
      peer: { id: String(sender.id), name: String(sender.name || 'Onbekend'), type: sender.type || 'other' },
      files: cleanFiles, text,
      total: cleanFiles.reduce((a, f) => a + f.size, 0), done: 0, speed: 0,
      startedAt: Date.now(), savedPaths: [],
      remoteOfferId: typeof body.offerId === 'string' ? body.offerId : null,
    };
    this.transfers.set(transfer.id, transfer);
    this._emitTransfer(transfer, true);

    const settings = this.settings;
    const trusted = (settings.trusted || []).includes(transfer.peer.id);
    let decision;
    if (trusted || settings.autoAcceptAll) {
      decision = { accept: true };
    } else {
      decision = await new Promise((resolve) => {
        const offerId = transfer.id;
        const timer = setTimeout(() => finish({ accept: false }), OFFER_TIMEOUT_MS);
        const finish = (d) => {
          clearTimeout(timer);
          this.pendingOffers.delete(offerId);
          resolve(d);
        };
        this.pendingOffers.set(offerId, { resolve: finish, transfer });
        res.on('close', () => { if (this.pendingOffers.has(offerId)) finish({ accept: false, gone: true }); });
        this.emit('offer', this._view(transfer));
      });
    }

    if (!decision.accept) {
      transfer.status = decision.gone ? 'cancelled' : 'declined';
      this._emitTransfer(transfer, true);
      this.emit('offer-closed', transfer.id);
      if (!res.destroyed && !res.writableEnded) sendJson(res, 200, { accepted: false });
      return;
    }
    if (decision.remember && !trusted) this.emit('trust', transfer.peer.id);
    this.emit('offer-closed', transfer.id);

    if (!files.length) { // alleen tekst
      transfer.status = 'done';
      transfer.finishedAt = Date.now();
      this._emitTransfer(transfer, true);
      this.emit('text-received', this._view(transfer));
      return sendJson(res, 200, { accepted: true, token: null });
    }

    const token = crypto.randomUUID();
    const saveDir = settings.saveDir;
    fs.mkdirSync(saveDir, { recursive: true });
    const session = { token, transfer, saveDir, targets: new Map(), finished: 0, active: null, lastActivity: Date.now() };
    this.sessions.set(token, session);
    transfer.status = 'active';
    this._emitTransfer(transfer, true);
    sendJson(res, 200, { accepted: true, token });
  }

  respondOffer(offerId, accept, remember) {
    const o = this.pendingOffers.get(offerId);
    if (o) o.resolve({ accept: !!accept, remember: !!remember });
  }

  async _handleUpload(req, res, token, fileId) {
    const s = this.sessions.get(token);
    const t = s && s.transfer;
    const f = t && t.files[fileId];
    if (!s || !f) { req.resume(); return sendJson(res, 404, { error: 'onbekende sessie' }); }
    if (s.targets.has(fileId)) { req.resume(); return sendJson(res, 409, { error: 'al ontvangen' }); }

    const rel = f.name;
    const target = uniquePath(path.join(s.saveDir, rel));
    if (!path.resolve(target).startsWith(path.resolve(s.saveDir) + path.sep)) { req.resume(); return sendJson(res, 400, { error: 'ongeldig pad' }); }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    s.targets.set(fileId, target);
    f.savedAs = target;

    const out = fs.createWriteStream(target);
    s.active = { req, out, target };
    let got = 0;
    let lastSample = Date.now();
    let sampleBytes = 0;
    req.on('data', (c) => {
      got += c.length;
      f.done = got;
      t.done += c.length;
      s.lastActivity = Date.now();
      sampleBytes += c.length;
      const now = Date.now();
      if (now - lastSample >= 500) {
        t.speed = sampleBytes / ((now - lastSample) / 1000);
        lastSample = now; sampleBytes = 0;
      }
      this._emitTransfer(t);
    });
    req.pipe(out);

    const fail = (reason) => {
      try { out.destroy(); } catch (_) { /* weg */ }
      fs.unlink(target, () => {});
      if (s.ended) return;
      this._endSession(s, 'error', reason);
    };
    req.on('aborted', () => fail('Verbinding onderbroken'));
    req.on('error', () => fail('Verbinding onderbroken'));
    out.on('error', (e) => { fail('Opslaan mislukt: ' + e.message); if (!res.headersSent) sendJson(res, 500, { error: 'schrijffout' }); });
    out.on('finish', () => {
      if (s.ended) return;
      if (got !== f.size) { fail('Bestand is niet compleet'); if (!res.headersSent) sendJson(res, 400, { error: 'grootte klopt niet' }); return; }
      f.complete = true;
      s.active = null;
      s.finished++;
      t.savedPaths.push(target);
      sendJson(res, 200, { ok: true });
      if (s.finished === t.files.length) {
        t.status = 'done';
        t.finishedAt = Date.now();
        t.speed = 0;
        s.ended = true;
        this.sessions.delete(token);
        this._emitTransfer(t, true);
        this.emit('received', this._view(t));
      } else {
        this._emitTransfer(t, true);
      }
    });
  }

  _endSession(s, status, reason) {
    if (s.ended) return;
    s.ended = true;
    this.sessions.delete(s.token);
    if (s.active) {
      try { s.active.req.destroy(); s.active.out.destroy(); } catch (_) { /* weg */ }
      fs.unlink(s.active.target, () => {});
    }
    const t = s.transfer;
    t.status = status;
    t.error = reason;
    t.speed = 0;
    this._emitTransfer(t, true);
  }

  // ---------- versturen ----------
  _collectFiles(paths) {
    const out = [];
    const walk = (full, rel) => {
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        for (const n of fs.readdirSync(full)) walk(path.join(full, n), rel ? rel + '/' + n : n);
      } else if (st.isFile()) {
        out.push({ path: full, name: rel || path.basename(full), size: st.size });
      }
    };
    for (const p of paths) {
      try {
        const st = fs.statSync(p);
        walk(p, st.isDirectory() ? path.basename(p) : '');
      } catch (_) { /* onleesbaar: overslaan */ }
    }
    return out.map((f, i) => ({ ...f, id: i }));
  }

  sendFiles(peerId, paths) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Apparaat niet meer gevonden');
    const files = this._collectFiles(paths);
    if (!files.length) throw new Error('Geen bestanden om te versturen');
    return this._send(peer, files, null);
  }

  sendText(peerId, text) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Apparaat niet meer gevonden');
    return this._send(peer, [], text);
  }

  _send(peer, files, text) {
    const t = {
      id: crypto.randomUUID(), dir: 'out', status: 'waiting',
      peer: { id: peer.id, name: peer.name, type: peer.type },
      files: files.map((f) => ({ id: f.id, name: f.name, size: f.size, done: 0 })), text,
      total: files.reduce((a, f) => a + f.size, 0), done: 0, speed: 0, startedAt: Date.now(), savedPaths: [],
    };
    this.transfers.set(t.id, t);
    this._emitTransfer(t, true);
    this._run(peer, t, files, text).catch((e) => {
      if (t.status === 'cancelled') return;
      t.status = 'error';
      t.error = this._friendly(e);
      t.speed = 0;
      this._emitTransfer(t, true);
    });
    return t.id;
  }

  _friendly(e) {
    const m = String(e && e.message || e);
    if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|Geen reactie/i.test(m)) return 'Kan het andere apparaat niet bereiken. Staan beide op hetzelfde wifi?';
    if (/ECONNRESET|socket hang up/i.test(m)) return 'Verbinding onderbroken';
    return m;
  }

  async _run(peer, t, files, text) {
    const state = { aborted: false, req: null, token: null };
    this.outgoing.set(t.id, {
      abort: () => {
        state.aborted = true;
        if (state.req) state.req.destroy();
        httpsJson(peer, 'POST', '/cancel/' + (state.token || t.id), {}, { timeout: 2000 }).catch(() => {});
      },
    });
    try {
      const me = this.info();
      const offerBody = {
        offerId: t.id,
        sender: { id: me.id, name: me.name, type: me.type },
        files: files.map((f) => ({ name: f.name, size: f.size })),
      };
      if (text !== null) offerBody.text = text;
      const { status, json } = await httpsJson(peer, 'POST', '/offer', offerBody, {
        timeout: OFFER_TIMEOUT_MS + 10000,
        onReq: (r) => { state.req = r; },
      });
      state.req = null;
      if (state.aborted) return;
      if (status !== 200 || !json || !json.accepted) {
        t.status = 'declined';
        this._emitTransfer(t, true);
        return;
      }
      if (text !== null && !files.length) {
        t.status = 'done'; t.finishedAt = Date.now();
        this._emitTransfer(t, true);
        return;
      }
      state.token = json.token;
      t.status = 'active';
      this._emitTransfer(t, true);
      for (const f of files) {
        if (state.aborted) return;
        await this._uploadOne(peer, t, f, state);
      }
      if (state.aborted) return;
      t.status = 'done'; t.finishedAt = Date.now(); t.speed = 0;
      this._emitTransfer(t, true);
      this.emit('sent', this._view(t));
    } finally {
      this.outgoing.delete(t.id);
    }
  }

  _uploadOne(peer, t, f, state) {
    return new Promise((resolve, reject) => {
      const meta = t.files[f.id];
      const req = https.request({
        host: peer.ip, port: peer.port, path: `/upload/${state.token}/${f.id}`, method: 'PUT', agent,
        headers: { 'Content-Length': f.size, 'Content-Type': 'application/octet-stream' },
      }, (res) => {
        res.resume();
        res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error('De ontvanger heeft het bestand geweigerd'))));
      });
      state.req = req;
      req.on('error', (e) => reject(state.aborted ? new Error('Geannuleerd') : e));
      const rs = fs.createReadStream(f.path);
      let lastSample = Date.now();
      let sampleBytes = 0;
      rs.on('data', (c) => {
        meta.done += c.length;
        t.done += c.length;
        sampleBytes += c.length;
        const now = Date.now();
        if (now - lastSample >= 500) {
          t.speed = sampleBytes / ((now - lastSample) / 1000);
          lastSample = now; sampleBytes = 0;
        }
        this._emitTransfer(t);
      });
      rs.on('error', (e) => { req.destroy(); reject(new Error('Kan bestand niet lezen: ' + e.message)); });
      rs.pipe(req);
    });
  }

  cancel(transferId) {
    const t = this.transfers.get(transferId);
    if (!t) return;
    if (t.dir === 'out') {
      const o = this.outgoing.get(transferId);
      if (o) o.abort();
      if (t.status === 'waiting' || t.status === 'active') {
        t.status = 'cancelled'; t.speed = 0;
        this._emitTransfer(t, true);
      }
    } else {
      for (const s of this.sessions.values()) {
        if (s.transfer === t) this._endSession(s, 'cancelled', 'Geannuleerd');
      }
    }
  }

  // ---------- doorgeven aan de UI ----------
  _view(t) {
    return { ...t, files: t.files.map((f) => ({ id: f.id, name: f.name, size: f.size, done: f.done })) };
  }

  _emitTransfer(t, now = false) {
    this._emitTimers = this._emitTimers || new Map();
    if (now) {
      clearTimeout(this._emitTimers.get(t.id)); this._emitTimers.delete(t.id);
      this.emit('transfer', this._view(t));
      return;
    }
    if (this._emitTimers.has(t.id)) return;
    this._emitTimers.set(t.id, setTimeout(() => {
      this._emitTimers.delete(t.id);
      this.emit('transfer', this._view(t));
    }, 100));
  }
}

module.exports = { Flits, DEFAULT_PORT, DEFAULT_DISCOVERY_PORT };
