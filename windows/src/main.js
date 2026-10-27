'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Flits, DEFAULT_PORT } = require('./core');
const { Updater, REPO } = require('./updater');
const { Downloader } = require('./downloader');

// Voor testen: andere map en poort, zodat je twee kopieën naast elkaar kunt draaien.
if (process.env.FLITS_DATA) app.setPath('userData', process.env.FLITS_DATA);
const PORT = Number(process.env.FLITS_PORT) || DEFAULT_PORT;

// De interface is eenvoudig; software-rendering voorkomt zwarte vensters en crashes van het grafische deel.
app.disableHardwareAcceleration();

// Logboek in de gegevensmap (flits.log), zodat een crash achteraf te onderzoeken is.
const logFile = () => path.join(app.getPath('userData'), 'flits.log');
function log(...parts) {
  try { fs.appendFileSync(logFile(), `${new Date().toISOString()} ${parts.join(' ')}\n`); } catch (_) { /* geen logboek is niet erg */ }
}
process.on('uncaughtException', (e) => log('uncaughtException', e && e.stack || e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.stack || e));

if (!process.env.FLITS_DATA && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
let win = null;
let tray = null;
let quitting = false;
let hintShown = false;
let core = null;
let updater = null;
let downloader = null;
let settings = null;
const history = []; // afgeronde overdrachten (nieuwste eerst)

// ---------- instellingen ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const historyFile = () => path.join(app.getPath('userData'), 'history.json');

function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch (_) { /* eerste start */ }
  settings = {
    id: s.id || crypto.randomUUID(),
    deviceName: s.deviceName || os.hostname(),
    saveDir: s.saveDir || path.join(app.getPath('downloads'), 'Flits'),
    trusted: Array.isArray(s.trusted) ? s.trusted : [],
    autoAcceptAll: !!s.autoAcceptAll,
    startWithWindows: !!s.startWithWindows,
    minimizeToTray: s.minimizeToTray !== false,
    manualHosts: Array.isArray(s.manualHosts) ? s.manualHosts : [],
  };
  try {
    const h = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    if (Array.isArray(h)) history.push(...h.slice(0, 50));
  } catch (_) { /* nog geen geschiedenis */ }
  saveSettings();
}

function saveSettings() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (_) { /* schijf vol of geen rechten: niet fataal */ }
}

function saveHistory() {
  try { fs.writeFileSync(historyFile(), JSON.stringify(history.slice(0, 50))); } catch (_) { /* negeren */ }
}

// ---------- venster ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1020, height: 700, minWidth: 760, minHeight: 540,
    backgroundColor: '#0e1016',
    title: 'Flits',
    icon: ICON,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e1016', symbolColor: '#c9cee0', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });
  // Testhulp: FLITS_SHOT=pad.png maakt na een paar seconden een schermafbeelding en sluit af.
  if (process.env.FLITS_SHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.FLITS_SHOT, img.toPNG());
      quitting = true; app.quit();
    }, Number(process.env.FLITS_SHOT_DELAY) || 4000));
  }
  win.on('close', (e) => {
    if (!quitting && settings.minimizeToTray) {
      e.preventDefault();
      win.hide();
      if (!hintShown) {
        hintShown = true;
        notify('Flits draait nog', 'Flits staat bij de klok en ontvangt nog. Kies Afsluiten bij dat pictogram om te stoppen.', showWindow);
      }
    }
  });
  win.on('unresponsive', () => log('venster reageert niet'));
  win.webContents.on('render-process-gone', (_e, d) => {
    log('renderer weg:', d.reason);
    if (!win.isDestroyed()) win.reload();
  });
  // Links in de app openen nooit in dit venster.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 20, height: 20 });
  tray = new Tray(img);
  tray.setToolTip('Flits');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Flits openen', click: showWindow },
    { label: 'Downloadmap openen', click: () => shell.openPath(settings.saveDir) },
    { type: 'separator' },
    { label: 'Afsluiten', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: false });
  if (onClick) n.on('click', onClick);
  n.show();
}

const kindLabel = (n) => (n === 1 ? '1 bestand' : `${n} bestanden`);

// ---------- kern koppelen ----------
async function startCore() {
  core = new Flits({ dataDir: path.join(app.getPath('userData'), 'tls'), getSettings: () => settings, port: PORT });
  core.on('peers', (list) => send('peers', list));
  core.on('transfer', (t) => {
    send('transfer', t);
    if (['done', 'error', 'declined', 'cancelled'].includes(t.status)) rememberTransfer(t);
  });
  core.on('offer', (t) => {
    send('offer', t);
    const what = t.files.length ? kindLabel(t.files.length) : 'een tekst';
    if (!win || !win.isVisible() || !win.isFocused()) {
      notify(`${t.peer.name} wil iets sturen`, `${what} — klik om te antwoorden`, showWindow);
    }
  });
  core.on('offer-closed', (id) => send('offer-closed', id));
  core.on('trust', (id) => { if (!settings.trusted.includes(id)) { settings.trusted.push(id); saveSettings(); } });
  core.on('received', (t) => notify('Ontvangen van ' + t.peer.name, kindLabel(t.files.length) + ' opgeslagen', () => shell.openPath(settings.saveDir)));
  core.on('text-received', (t) => notify('Tekst van ' + t.peer.name, t.text.slice(0, 120), showWindow));
  await core.start();
  for (const h of settings.manualHosts) core.addManual(h).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wie luistert er op onze poort? (naam en proces-id, via netstat en tasklist)
function findPortHolder() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    const line = out.split(/\r?\n/).find((l) => /LISTENING/i.test(l) && new RegExp(`:${PORT}\\s`).test(l));
    if (!line) return null;
    const pid = Number(line.trim().split(/\s+/).pop());
    if (!pid || pid === process.pid) return null;
    const t = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const name = (t.match(/^"([^"]+)"/) || [])[1] || 'onbekend programma';
    return { pid, name };
  } catch (e) {
    log('findPortHolder', e.message);
    return null;
  }
}

// Start de kern. Is de poort bezet (bijvoorbeeld een oude Flits die nog op de achtergrond draait), dan even
// wachten, daarna uitleggen wie de poort vasthoudt en aanbieden om dat oude proces te stoppen.
async function startWithRecovery() {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await startCore();
      return true;
    } catch (e) {
      log('start mislukt:', e.code || '', e.message);
      if (e.code !== 'EADDRINUSE') {
        dialog.showErrorBox('Flits kan niet starten', String(e.message || e));
        return false;
      }
      if (attempt < 3) { await sleep(700); continue; } // vorige Flits is misschien nog aan het afsluiten
      const holder = findPortHolder();
      const isFlits = holder && /flits/i.test(holder.name);
      if (isFlits) {
        const r = dialog.showMessageBoxSync({
          type: 'question', buttons: ['Opnieuw starten', 'Annuleren'], defaultId: 0, cancelId: 1, title: 'Flits',
          message: 'Flits draait al op de achtergrond',
          detail: 'Er draait nog een Flits-venster dat niet meer zichtbaar is. Wil je dat afsluiten en Flits opnieuw starten?\n(Loopt er nog een overdracht, kies dan Annuleren en sluit Flits via het pictogram bij de klok.)',
        });
        if (r !== 0) return false;
        try { process.kill(holder.pid); } catch (_) { /* al weg */ }
        require('child_process').spawnSync('taskkill', ['/PID', String(holder.pid), '/T', '/F'], { windowsHide: true });
        await sleep(1200);
        continue;
      }
      dialog.showErrorBox('Flits kan niet starten', holder
        ? `Poort ${PORT} wordt gebruikt door "${holder.name}" (proces ${holder.pid}). Sluit dat programma en start Flits opnieuw.`
        : `Poort ${PORT} is al in gebruik door een ander programma. Sluit dat en start Flits opnieuw.`);
      return false;
    }
  }
  return false;
}

function rememberTransfer(t) {
  const rec = {
    id: t.id, dir: t.dir, status: t.status, peer: t.peer, text: t.text,
    files: t.files.map((f) => ({ name: f.name, size: f.size })),
    total: t.total, finishedAt: t.finishedAt || Date.now(), error: t.error,
    savedPaths: core.transfers.get(t.id) ? core.transfers.get(t.id).savedPaths : [],
  };
  const i = history.findIndex((h) => h.id === t.id);
  if (i >= 0) history.splice(i, 1);
  history.unshift(rec);
  history.length = Math.min(history.length, 50);
  saveHistory();
}

const publicSettings = () => ({
  deviceName: settings.deviceName, saveDir: settings.saveDir, autoAcceptAll: settings.autoAcceptAll,
  startWithWindows: settings.startWithWindows, minimizeToTray: settings.minimizeToTray,
  trustedCount: settings.trusted.length, version: app.getVersion(),
});

function localIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// ---------- IPC ----------
function setupIpc() {
  ipcMain.handle('state', () => ({
    settings: publicSettings(), peers: core.peerList(), history,
    active: [...core.transfers.values()].filter((t) => ['waiting', 'active'].includes(t.status)).map((t) => core._view(t)),
    offers: [...core.pendingOffers.values()].map((o) => core._view(o.transfer)),
    update: updater.state,
    ips: localIps(), port: PORT,
  }));

  const guard = (fn) => async (...args) => {
    try { return { ok: true, value: await fn(...args) }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
  };

  ipcMain.handle('send:pick', guard(async (_e, peerId, folder) => {
    const r = await dialog.showOpenDialog(win, {
      title: folder ? 'Kies een map om te sturen' : 'Kies bestanden om te sturen',
      properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return core.sendFiles(peerId, r.filePaths);
  }));
  ipcMain.handle('send:paths', guard((_e, peerId, paths) => core.sendFiles(peerId, paths)));
  ipcMain.handle('send:text', guard((_e, peerId, text) => {
    if (!String(text || '').trim()) throw new Error('Niets om te sturen');
    return core.sendText(peerId, String(text));
  }));
  ipcMain.handle('offer:respond', (_e, id, accept, remember) => core.respondOffer(id, accept, remember));
  ipcMain.handle('transfer:cancel', (_e, id) => core.cancel(id));
  ipcMain.handle('open:path', (_e, p) => shell.openPath(p));
  ipcMain.handle('show:path', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('open:saveDir', () => shell.openPath(settings.saveDir));
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('history:clear', () => { history.length = 0; saveHistory(); });

  ipcMain.handle('dl:list', () => downloader.list());
  ipcMain.handle('dl:add', guard((_e, url) => {
    if (!String(url || '').trim()) throw new Error('Plak eerst een link');
    return downloader.add(url);
  }));
  ipcMain.handle('dl:cancel', (_e, id) => downloader.cancel(id));
  ipcMain.handle('dl:clear', () => downloader.clearFinished());

  ipcMain.handle('update:check', () => updater.check(true));
  ipcMain.handle('update:install', guard(async () => {
    if (await updater.install()) { quitting = true; setTimeout(() => app.quit(), 300); }
  }));
  ipcMain.handle('update:page', () => shell.openExternal(`https://github.com/${REPO}/releases/latest`));

  ipcMain.handle('peer:add', guard(async (_e, host) => {
    await core.addManual(host);
    const h = String(host).trim();
    if (!settings.manualHosts.includes(h)) { settings.manualHosts.push(h); saveSettings(); }
    return core.peerList();
  }));

  ipcMain.handle('settings:pickDir', guard(async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Kies de map voor ontvangen bestanden', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return publicSettings();
    settings.saveDir = r.filePaths[0];
    saveSettings();
    return publicSettings();
  }));

  ipcMain.handle('settings:set', guard((_e, patch) => {
    if (typeof patch.deviceName === 'string') {
      const n = patch.deviceName.trim().slice(0, 40);
      if (n) settings.deviceName = n;
    }
    if (typeof patch.autoAcceptAll === 'boolean') settings.autoAcceptAll = patch.autoAcceptAll;
    if (typeof patch.minimizeToTray === 'boolean') settings.minimizeToTray = patch.minimizeToTray;
    if (typeof patch.startWithWindows === 'boolean') {
      settings.startWithWindows = patch.startWithWindows;
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: patch.startWithWindows, args: ['--hidden'] });
    }
    if (patch.forgetTrusted) settings.trusted = [];
    saveSettings();
    core._announce();
    return publicSettings();
  }));
}

// ---------- opstarten ----------
app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* blijf draaien in de tray */ });

app.whenReady().then(async () => {
  app.setAppUserModelId('nl.flits.app');
  loadSettings();
  updater = new Updater({ currentVersion: process.env.FLITS_FAKE_VERSION || app.getVersion(), dataDir: app.getPath('userData'), packaged: app.isPackaged, exePath: app.getPath('exe') });
  updater.on('state', (s) => send('update', s));
  downloader = new Downloader({ getDir: () => app.getPath('downloads') });
  downloader.on('job', (j) => send('download', j));
  setupIpc();
  if (!(await startWithRecovery())) { app.exit(1); return; }
  createWindow();
  createTray();
  updater.startAuto();
});

app.on('will-quit', () => {
  if (core) core.stop();
  setTimeout(() => app.exit(0), 2000).unref(); // zeker weten dat er niets blijft hangen dat de poort vasthoudt
});
