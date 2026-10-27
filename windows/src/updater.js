'use strict';
// Werkt Flits.exe bij vanaf GitHub: zoekt de nieuwste release, downloadt Flits.exe,
// controleert grootte en sha256 en vervangt het draaiende bestand zodra Flits is afgesloten.
const { EventEmitter } = require('events');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'BossevdK/flits';
const CHECK_EVERY_MS = 6 * 3600 * 1000;

const versionParts = (v) => String(v).trim().replace(/^v/i, '').split(/[.\-+]/).map((p) => parseInt(p, 10)).filter((n) => !Number.isNaN(n));

function isNewer(remote, local) {
  const a = versionParts(remote);
  const b = versionParts(local);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0; const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

const allowedHost = (h) => h === 'github.com' || h === 'api.github.com' || h.endsWith('.github.com') || h.endsWith('.githubusercontent.com');

// GET met omleidingen (GitHub stuurt downloads door naar een andere server); alleen naar GitHub-hosts.
function get(url, depth = 0, extra = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !allowedHost(u.hostname)) return reject(new Error('Onverwachte downloadserver'));
    const req = https.get(url, { headers: { 'User-Agent': 'Flits', Accept: 'application/vnd.github+json', ...extra }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (depth > 5) return reject(new Error('Te veel omleidingen'));
        return resolve(get(new URL(res.headers.location, url).toString(), depth + 1, extra));
      }
      res.finalUrl = url;
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Geen reactie van GitHub')));
    req.on('error', reject);
  });
}

// Haalt een bestand in delen tegelijk op (meerdere verbindingen, elk een eigen stuk), zodat één trage verbinding niet de snelheid bepaalt.
// Geeft false terug als de server geen delen ondersteunt; dan moet er gewoon in één keer gedownload worden.
async function downloadParts(url, file, size, onProgress, connections = 8) {
  const probe = await get(url, 0, { Range: 'bytes=0-0', Accept: '*/*' });
  probe.resume();
  const m = /\/(\d+)$/.exec(String(probe.headers['content-range'] || ''));
  if (probe.statusCode !== 206 || !m || (size && Number(m[1]) !== size)) return false;
  const total = Number(m[1]);
  const finalUrl = probe.finalUrl;
  const fd = fs.openSync(file, 'w');
  try {
    const piece = Math.max(1 << 20, Math.ceil(total / (connections * 4)));
    const queue = [];
    for (let at = 0; at < total; at += piece) queue.push([at, Math.min(total, at + piece) - 1]);
    let done = 0;
    const fetchPiece = async ([from, to], attempt = 0) => {
      try {
        const res = await get(finalUrl, 0, { Range: `bytes=${from}-${to}`, Accept: '*/*' });
        if (res.statusCode !== 206) { res.resume(); throw new Error('Deel downloaden mislukt (' + res.statusCode + ')'); }
        let pos = from;
        for await (const c of res) { fs.writeSync(fd, c, 0, c.length, pos); pos += c.length; done += c.length; onProgress(done / total); }
        if (pos !== to + 1) throw new Error('Deel is niet compleet');
      } catch (e) {
        if (attempt >= 2) throw e;
        return fetchPiece([from, to], attempt + 1);
      }
    };
    const worker = async () => { for (let p = queue.shift(); p; p = queue.shift()) await fetchPiece(p); };
    await Promise.all(Array.from({ length: Math.min(connections, queue.length) }, worker));
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

const hashFile = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
});

class Updater extends EventEmitter {
  constructor({ currentVersion, dataDir, packaged = false, exePath = '' }) {
    super();
    this.packaged = packaged;
    this.exePath = exePath;
    this.current = currentVersion;
    this.dir = path.join(dataDir, 'updates');
    this.state = { status: 'idle', current: currentVersion };
    this.info = null;
    this.busy = false;
  }

  _set(patch) {
    this.state = { current: this.current, ...patch };
    this.emit('state', this.state);
  }

  startAuto() {
    setTimeout(() => this.check(false), 10000);
    setInterval(() => this.check(false), CHECK_EVERY_MS);
  }

  async check(manual) {
    if (this.busy) return;
    if (!manual && ['available', 'downloading'].includes(this.state.status)) return;
    this.busy = true;
    if (manual) this._set({ status: 'checking' });
    try {
      const res = await get(`https://api.github.com/repos/${REPO}/releases/latest`);
      if (res.statusCode === 404) { res.resume(); this.info = null; return this._set({ status: manual ? 'uptodate' : 'idle' }); }
      if (res.statusCode !== 200) { res.resume(); throw new Error(`GitHub antwoordde met ${res.statusCode}`); }
      const chunks = [];
      for await (const c of res) chunks.push(c);
      const o = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const tag = String(o.tag_name || '');
      const asset = (o.assets || []).find((a) => /\.exe$/i.test(a.name));
      if (!tag || !asset || !isNewer(tag, this.current)) { this.info = null; return this._set({ status: manual ? 'uptodate' : 'idle' }); }
      const digest = String(asset.digest || '').replace(/^sha256:/, '');
      this.info = { version: tag.replace(/^v/i, ''), notes: String(o.body || '').trim(), url: asset.browser_download_url, size: asset.size || 0, sha256: digest.length === 64 ? digest : null };
      this._set({ status: 'available', version: this.info.version, notes: this.info.notes.slice(0, 300) });
    } catch (e) {
      this._set(manual ? { status: 'error', error: 'Controleren mislukt: ' + (e.message || e) } : { status: 'idle' });
    } finally {
      this.busy = false;
    }
  }

  // Downloadt de nieuwe versie en start het vervangen. Geeft true terug als Flits nu moet afsluiten.
  async install() {
    if (!this.info) throw new Error('Geen update beschikbaar');
    if (!this.packaged) throw new Error('Zelf bijwerken werkt alleen in de geïnstalleerde Flits. Download de nieuwe versie van GitHub.');
    if (/[%&^!]/.test(this.exePath + this.dir)) throw new Error('Het pad van Flits bevat tekens (% & ^ !) waardoor bijwerken niet kan. Download de nieuwe versie van GitHub.');
    const info = this.info;
    this.busy = true;
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `Flits-${info.version}-Setup.exe`);
      this._set({ status: 'downloading', version: info.version, progress: 0 });
      let last = 0;
      const progress = (p) => { const now = Date.now(); if (now - last > 150) { last = now; this._set({ status: 'downloading', version: info.version, progress: Math.min(1, p) }); } };
      let parted = false;
      try { parted = await downloadParts(info.url, file, info.size, progress); } catch (_) { parted = false; }
      if (parted) {
        if (info.size && fs.statSync(file).size !== info.size) throw new Error('Download is niet compleet');
        if (info.sha256 && (await hashFile(file)) !== info.sha256.toLowerCase()) throw new Error('Controlesom klopt niet, download is beschadigd');
      } else {
      const res = await get(info.url);
      if (res.statusCode !== 200) { res.resume(); throw new Error(`Downloaden mislukt (${res.statusCode})`); }
      const total = Number(res.headers['content-length']) || info.size;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(file);
      let done = 0;
      await new Promise((resolve, reject) => {
        res.on('data', (c) => {
          hash.update(c); done += c.length;
          const now = Date.now();
          if (total && now - last > 150) { last = now; this._set({ status: 'downloading', version: info.version, progress: Math.min(1, done / total) }); }
        });
        res.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        res.pipe(out);
      });
      if (info.size && done !== info.size) throw new Error('Download is niet compleet');
      if (info.sha256 && hash.digest('hex') !== info.sha256.toLowerCase()) throw new Error('Controlesom klopt niet, download is beschadigd');
      }

      // Een klein scriptje draait de installer stil (die sluit Flits af en werkt bij) en start daarna de nieuwe versie.
      const script = path.join(this.dir, 'update.cmd');
      fs.writeFileSync(script, [
        '@echo off',
        'ping -n 3 127.0.0.1 >nul',
        `start "" /wait "${file}" /S`,
        `start "" "${this.exePath}"`,
        'exit /b 0',
      ].join('\r\n'));
      this._set({ status: 'restarting', version: info.version });
      spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    } catch (e) {
      this._set({ status: 'error', version: info.version, error: String(e.message || e) });
      throw e;
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { Updater, isNewer, REPO };
