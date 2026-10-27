'use strict';
(() => {
  const api = window.flits;
  const $ = (id) => document.getElementById(id);

  const ICONS = {
    phone: '<svg viewBox="0 0 24 24"><path d="M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm4 17.2a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2ZM8 5v10h8V5H8Z"/></svg>',
    laptop: '<svg viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 0 1 1 1v9H3V6a1 1 0 0 1 1-1Zm-2 11h20v1.5a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 17.5V16Z"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M12 3 5.5 9.5l1.4 1.4L11 6.8V17h2V6.8l4.1 4.1 1.4-1.4L12 3ZM5 19v2h14v-2H5Z"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="m12 17 6.5-6.5-1.4-1.4L13 13.2V3h-2v10.2L6.9 9.1l-1.4 1.4L12 17ZM5 19v2h14v-2H5Z"/></svg>',
    text: '<svg viewBox="0 0 24 24"><path d="M4 5h16v2H4V5Zm0 4h16v2H4V9Zm0 4h10v2H4v-2Zm0 4h7v2H4v-2Z"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M12 2 1 21h22L12 2Zm1 14h-2v-2h2v2Zm0-4h-2V9h2v3Z"/></svg>',
  };

  const state = { settings: null, peers: [], transfers: new Map(), downloads: new Map(), ips: [], port: 53317, offers: [] };

  // ---------- hulpjes ----------
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v; // alleen vaste, eigen SVG-teksten
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  }

  function fmtSize(b) {
    if (b < 1024) return b + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
    return (b >= 100 ? b.toFixed(0) : b.toFixed(1)) + ' ' + u[i];
  }

  function fmtEta(sec) {
    if (!isFinite(sec) || sec < 0) return '';
    if (sec < 60) return Math.ceil(sec) + ' s';
    if (sec < 3600) return Math.ceil(sec / 60) + ' min';
    return Math.floor(sec / 3600) + ' u ' + Math.ceil((sec % 3600) / 60) + ' min';
  }

  function fmtAgo(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'zojuist';
    if (s < 3600) return Math.floor(s / 60) + ' min geleden';
    if (s < 86400) return Math.floor(s / 3600) + ' u geleden';
    return new Date(ts).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
  }

  const nFiles = (n) => (n === 1 ? '1 bestand' : n + ' bestanden');

  function toast(msg, bad) {
    const t = el('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
    $('toasts').append(t);
    setTimeout(() => t.remove(), bad ? 5000 : 2800);
  }

  async function call(promise, okMsg) {
    const r = await promise;
    if (r && r.ok === false) { toast(r.error || 'Er ging iets mis', true); return null; }
    if (okMsg) toast(okMsg);
    return r ? r.value : null;
  }

  // ---------- apparaten ----------
  function renderDevices() {
    const box = $('devices');
    box.replaceChildren();
    if (!state.peers.length) {
      box.append(el('div', { class: 'empty' },
        el('div', { class: 'radar' }, el('i'), el('i'), el('i'), el('b')),
        el('h3', {}, 'Zoeken naar apparaten…'),
        el('p', {}, 'Open Flits op je telefoon. Het verschijnt hier vanzelf zodra jullie op hetzelfde wifi zitten.'),
        el('ul', {},
          el('li', {}, 'Zitten beide apparaten op hetzelfde wifi-netwerk?'),
          el('li', {}, 'Laat Windows Firewall Flits toe op privénetwerken.'),
          el('li', {}, 'Lukt het niet? Voeg de telefoon toe met het IP-adres.'))));
      return;
    }
    for (const p of state.peers) box.append(deviceCard(p));
  }

  function deviceCard(p) {
    const isPhone = p.type === 'android' || p.type === 'ios';
    const card = el('div', { class: 'device', tabindex: '0', 'data-id': p.id, role: 'group', 'aria-label': p.name },
      el('div', { class: 'device-top' },
        el('div', { class: 'avatar', html: isPhone ? ICONS.phone : ICONS.laptop }),
        el('div', { style: 'min-width:0' },
          el('div', { class: 'device-name', title: p.name }, p.name),
          el('div', { class: 'device-sub' }, (isPhone ? 'Telefoon' : 'Computer') + ' · ' + p.ip))),
      el('div', { class: 'device-actions' },
        el('button', { class: 'btn primary', onclick: async () => { await call(api.pick(p.id, false)); } }, 'Bestanden'),
        el('button', { class: 'btn', onclick: async () => { await call(api.pick(p.id, true)); } }, 'Map'),
        el('button', { class: 'btn', onclick: () => textDialog(p) }, 'Tekst')));

    let depth = 0;
    card.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; card.classList.add('drag'); });
    card.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    card.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; card.classList.remove('drag'); } });
    card.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation();
      depth = 0; card.classList.remove('drag'); $('drop-overlay').classList.add('hidden');
      if (e.dataTransfer.files.length) await call(api.sendDropped(p.id, e.dataTransfer.files));
    });
    return card;
  }

  // slepen over het hele venster
  let winDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); winDepth++; $('drop-overlay').classList.toggle('hidden', !!document.querySelector('.device')); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { if (--winDepth <= 0) { winDepth = 0; $('drop-overlay').classList.add('hidden'); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); winDepth = 0; $('drop-overlay').classList.add('hidden');
    if (hasFiles(e) && !state.peers.length) toast('Geen apparaat gevonden om naartoe te sturen', true);
  });

  // ---------- activiteit ----------
  function allItems() {
    const items = new Map();
    for (const h of state.history) items.set(h.id, h);
    for (const t of state.transfers.values()) items.set(t.id, t);
    return [...items.values()].sort((a, b) => (b.startedAt || b.finishedAt || 0) - (a.startedAt || a.finishedAt || 0));
  }

  function renderActivity() {
    const box = $('activity');
    const items = allItems();
    box.replaceChildren();
    $('btn-clear').classList.toggle('hidden', !items.some((i) => !['waiting', 'active'].includes(i.status)));
    if (!items.length) {
      box.append(el('div', { class: 'quiet' }, 'Nog niets verstuurd of ontvangen. Sleep bestanden op een apparaat om te beginnen.'));
      return;
    }
    for (const t of items.slice(0, 30)) box.append(itemRow(t));
  }

  function itemRow(t) {
    const incoming = t.dir === 'in';
    const live = t.status === 'waiting' || t.status === 'active';
    const bad = t.status === 'error' || t.status === 'declined' || t.status === 'cancelled';
    const isText = t.text != null && !t.files.length;
    const title = isText
      ? (incoming ? 'Tekst van ' : 'Tekst naar ') + t.peer.name
      : (t.files.length === 1 ? t.files[0].name : nFiles(t.files.length)) + (incoming ? ' van ' : ' naar ') + t.peer.name;

    let sub; let subBad = false;
    const total = t.total || t.files.reduce((a, f) => a + f.size, 0);
    if (t.status === 'waiting') sub = incoming ? 'Wacht op jouw antwoord' : 'Wachten tot ' + t.peer.name + ' accepteert…';
    else if (t.status === 'active') {
      const left = t.speed > 0 ? (total - t.done) / t.speed : NaN;
      sub = `${fmtSize(t.done)} van ${fmtSize(total)}` + (t.speed > 0 ? ` · ${fmtSize(t.speed)}/s` : '') + (left ? ` · nog ${fmtEta(left)}` : '');
    } else if (t.status === 'done') sub = (isText ? 'Tekst' : fmtSize(total)) + ' · ' + (incoming ? 'ontvangen ' : 'verstuurd ') + fmtAgo(t.finishedAt || Date.now());
    else if (t.status === 'declined') { sub = incoming ? 'Geweigerd' : t.peer.name + ' heeft geweigerd'; subBad = true; }
    else if (t.status === 'cancelled') { sub = 'Geannuleerd'; subBad = true; }
    else { sub = t.error || 'Mislukt'; subBad = true; }

    const pct = total ? Math.min(100, (t.done / total) * 100) : 0;
    const actions = el('div', { class: 'item-actions' });
    if (live) actions.append(el('button', { class: 'chip-btn', onclick: () => api.cancel(t.id) }, 'Annuleren'));
    if (t.status === 'done' && incoming && isText) actions.append(el('button', { class: 'chip-btn', onclick: async () => { await api.copy(t.text); toast('Gekopieerd'); } }, 'Kopiëren'));
    if (t.status === 'done' && incoming && !isText && t.savedPaths && t.savedPaths.length) {
      actions.append(el('button', { class: 'chip-btn', onclick: () => api.openPath(t.savedPaths[0]) }, 'Openen'));
      actions.append(el('button', { class: 'chip-btn', onclick: () => api.showPath(t.savedPaths[0]) }, 'Map'));
    }

    return el('div', { class: 'item ' + (incoming ? 'in ' : '') + (bad ? 'bad' : '') },
      el('div', { class: 'badge', html: bad ? ICONS.warn : isText ? ICONS.text : incoming ? ICONS.down : ICONS.up }),
      el('div', { style: 'min-width:0' },
        el('div', { class: 'item-title', title }, title),
        el('div', { class: 'item-sub' + (subBad ? ' bad' : '') }, sub),
        live && el('div', { class: 'bar' + (t.status === 'waiting' ? ' wait' : '') }, el('div', { style: `width:${pct}%` }))),
      actions,
      isText && t.status === 'done' && el('div', { class: 'textbox' }, t.text));
  }

  // ---------- downloaden van internet ----------
  function renderDownloads() {
    const box = $('downloads');
    const jobs = [...state.downloads.values()].reverse();
    box.replaceChildren();
    $('btn-dl-clear').classList.toggle('hidden', !jobs.some((j) => !['starting', 'active'].includes(j.status)));
    for (const j of jobs.slice(0, 20)) {
      const live = j.status === 'starting' || j.status === 'active';
      const bad = j.status === 'error' || j.status === 'cancelled';
      const title = j.name || j.url;
      let sub; let subBad = false;
      if (j.status === 'starting') sub = 'Verbinden…';
      else if (j.status === 'active') {
        const left = j.speed > 0 && j.size ? (j.size - j.done) / j.speed : NaN;
        sub = (j.size ? `${fmtSize(j.done)} van ${fmtSize(j.size)}` : fmtSize(j.done)) + (j.speed > 0 ? ` · ${fmtSize(j.speed)}/s` : '')
          + (j.connections > 1 ? ` · ${j.connections} verbindingen` : '') + (left ? ` · nog ${fmtEta(left)}` : '');
      } else if (j.status === 'done') sub = fmtSize(j.size || j.done) + ' · klaar';
      else if (j.status === 'cancelled') { sub = 'Geannuleerd'; subBad = true; }
      else { sub = j.error || 'Mislukt'; subBad = true; }
      const pct = j.size ? Math.min(100, (j.done / j.size) * 100) : 0;
      const actions = el('div', { class: 'item-actions' });
      if (live) actions.append(el('button', { class: 'chip-btn', onclick: () => api.cancelDownload(j.id) }, 'Annuleren'));
      if (j.status === 'done') {
        actions.append(el('button', { class: 'chip-btn', onclick: () => api.openPath(j.path) }, 'Openen'));
        actions.append(el('button', { class: 'chip-btn', onclick: () => api.showPath(j.path) }, 'Map'));
      }
      box.append(el('div', { class: 'item in ' + (bad ? 'bad' : '') },
        el('div', { class: 'badge', html: bad ? ICONS.warn : ICONS.down }),
        el('div', { style: 'min-width:0' },
          el('div', { class: 'item-title', title }, title),
          el('div', { class: 'item-sub' + (subBad ? ' bad' : '') }, sub),
          live && el('div', { class: 'bar' + (j.status === 'starting' ? ' wait' : '') }, el('div', { style: `width:${pct}%` }))),
        actions));
    }
  }

  // ---------- dialogen ----------
  function openModal(content, onClose) {
    const back = el('div', { class: 'backdrop', role: 'dialog', 'aria-modal': 'true' }, el('div', { class: 'modal' }, content));
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey);
    $('modal-root').append(back);
    return { close, back };
  }

  function textDialog(peer) {
    const ta = el('textarea', { placeholder: 'Plak of typ hier een tekst of link…', 'aria-label': 'Tekst' });
    const m = openModal([
      el('h3', {}, 'Tekst naar ' + peer.name),
      el('p', { class: 'sub' }, 'Handig voor een link, een wachtwoord of een notitie.'),
      el('label', { class: 'field' }, ta),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => m.close() }, 'Annuleren'),
        el('button', { class: 'btn primary', onclick: async () => {
          const ok = await call(api.sendText(peer.id, ta.value));
          if (ok) m.close();
        } }, 'Versturen')),
    ]);
    ta.focus();
  }

  function addDialog() {
    const inp = el('input', { type: 'text', placeholder: 'Bijvoorbeeld 192.168.1.23', 'aria-label': 'IP-adres' });
    const m = openModal([
      el('h3', {}, 'Apparaat toevoegen'),
      el('p', { class: 'sub' }, 'Open Flits op de telefoon: daar staat bovenin het IP-adres. Typ dat hier in.'),
      el('label', { class: 'field' }, inp),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => m.close() }, 'Annuleren'),
        el('button', { class: 'btn primary', onclick: submit }, 'Toevoegen')),
    ]);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    inp.focus();
    async function submit() {
      const list = await call(api.addPeer(inp.value));
      if (list) { state.peers = list; renderDevices(); toast('Apparaat toegevoegd'); m.close(); }
    }
  }

  function updateLine() {
    const u = state.update || {};
    if (u.status === 'checking') return 'Controleren…';
    if (u.status === 'uptodate') return 'Je hebt de nieuwste versie.';
    if (['available', 'downloading', 'restarting'].includes(u.status)) return 'Er is een nieuwe versie, zie het hoofdscherm.';
    if (u.status === 'error' && !u.version) return u.error;
    return 'Flits werkt zichzelf bij vanaf GitHub.';
  }

  function settingsDialog() {
    const s = state.settings;
    const name = el('input', { type: 'text', value: s.deviceName, maxlength: '40', 'aria-label': 'Naam van deze pc' });
    const dirIn = el('input', { type: 'text', value: s.saveDir, readonly: true, 'aria-label': 'Opslagmap' });
    const sw = (key, label, help) => {
      const cb = el('input', { type: 'checkbox', role: 'switch' });
      cb.checked = !!s[key];
      cb.addEventListener('change', async () => {
        const v = await call(api.setSettings({ [key]: cb.checked }));
        if (v) Object.assign(state.settings, v);
      });
      return el('div', { class: 'setting' }, el('div', {}, label, el('small', {}, help)), el('span', { class: 'switch' }, cb, el('i')));
    };
    const m = openModal([
      el('h3', {}, 'Instellingen'),
      el('p', { class: 'sub' }, 'Versie ' + s.version),
      el('label', { class: 'field' }, el('span', {}, 'Naam van deze pc (zo zien anderen je)'), name),
      el('label', { class: 'field' }, el('span', {}, 'Ontvangen bestanden komen in'),
        el('div', { class: 'pathline' }, dirIn, el('button', { class: 'btn', onclick: async () => {
          const v = await call(api.pickDir());
          if (v) { state.settings = v; dirIn.value = v.saveDir; }
        } }, 'Wijzig'))),
      sw('autoAcceptAll', 'Alles automatisch accepteren', 'Minder veilig: iedereen op je netwerk kan dan bestanden sturen.'),
      sw('minimizeToTray', 'Op de achtergrond blijven', 'Sluiten verbergt Flits bij de klok, zodat je altijd kunt ontvangen.'),
      sw('startWithWindows', 'Starten met Windows', 'Flits staat dan klaar zodra je pc aan gaat.'),
      el('div', { class: 'setting' },
        el('div', {}, 'Versie ' + s.version, el('small', { id: 'upd-line' }, updateLine())),
        el('button', { class: 'btn', onclick: () => api.checkUpdate() }, 'Controleer')),
      el('div', { class: 'setting' },
        el('div', {}, 'Vertrouwde apparaten', el('small', {}, s.trustedCount ? s.trustedCount + ' apparaat(en) mogen zonder vragen sturen.' : 'Nog geen. Kies bij een verzoek “Altijd toestaan”.')),
        s.trustedCount ? el('button', { class: 'btn', onclick: async () => {
          const v = await call(api.setSettings({ forgetTrusted: true }), 'Vergeten');
          if (v) { state.settings = v; m.close(); }
        } }, 'Vergeet') : null),
      el('div', { class: 'row', style: 'margin-top:14px' },
        el('button', { class: 'btn primary', onclick: () => m.close() }, 'Klaar')),
    ], async () => {
      const n = name.value.trim();
      if (n && n !== state.settings.deviceName) {
        const v = await call(api.setSettings({ deviceName: n }));
        if (v) { state.settings = v; renderHero(); }
      }
    });
  }

  // ---------- binnenkomende verzoeken ----------
  let offerModal = null;
  function showNextOffer() {
    if (offerModal || !state.offers.length) return;
    const o = state.offers[0];
    const total = o.files.reduce((a, f) => a + f.size, 0);
    const isText = !o.files.length;
    const remember = el('input', { type: 'checkbox' });
    const answer = async (accept) => {
      state.offers.shift();
      const m = offerModal; offerModal = null; m.close();
      await api.respond(o.id, accept, accept && remember.checked);
      showNextOffer();
    };
    offerModal = openModal([
      el('h3', {}, o.peer.name + ' wil iets sturen'),
      el('p', { class: 'sub' }, isText ? 'Een stukje tekst' : nFiles(o.files.length) + ' · ' + fmtSize(total)),
      isText
        ? el('div', { class: 'preview' }, o.text.length > 600 ? o.text.slice(0, 600) + '…' : o.text)
        : el('ul', { class: 'filelist' }, o.files.slice(0, 50).map((f) => el('li', {}, el('span', { title: f.name }, f.name), el('span', {}, fmtSize(f.size)))),
            o.files.length > 50 ? el('li', {}, el('span', {}, '… en ' + (o.files.length - 50) + ' meer'), el('span')) : null),
      el('label', { class: 'check' }, remember, 'Altijd toestaan van dit apparaat'),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => answer(false) }, 'Weigeren'),
        el('button', { class: 'btn primary', onclick: () => answer(true) }, 'Accepteren')),
    ], () => {
      if (offerModal) { // weggeklikt zonder knop = weigeren
        offerModal = null; state.offers.shift(); api.respond(o.id, false, false); showNextOffer();
      }
    });
  }

  // ---------- updates ----------
  function renderUpdate() {
    const u = state.update;
    const box = $('update');
    const show = u && ['available', 'downloading', 'restarting', 'error'].includes(u.status) && u.version;
    box.classList.toggle('hidden', !show);
    if (!show) return;
    box.replaceChildren();
    const row = el('div', { class: 'update-card' });
    row.append(el('div', { style: 'min-width:0;flex:1' },
      el('div', { class: 'update-title' }, 'Nieuwe versie ' + u.version + ' beschikbaar'),
      u.status === 'available' && u.notes ? el('div', { class: 'item-sub' }, u.notes.split('\n')[0]) : null,
      u.status === 'downloading' ? el('div', { class: 'item-sub' }, 'Downloaden… ' + Math.round((u.progress || 0) * 100) + '%') : null,
      u.status === 'restarting' ? el('div', { class: 'item-sub' }, 'Flits start zo opnieuw op…') : null,
      u.status === 'error' ? el('div', { class: 'item-sub bad' }, u.error) : null,
      u.status === 'downloading' ? el('div', { class: 'bar' }, el('div', { style: `width:${Math.round((u.progress || 0) * 100)}%` })) : null));
    if (u.status === 'available' || u.status === 'error') {
      row.append(el('button', { class: 'btn primary big', onclick: async () => { await call(api.installUpdate()); } }, u.status === 'error' ? 'Opnieuw' : 'Nu bijwerken'));
    }
    if (u.status === 'error') row.append(el('button', { class: 'btn big', onclick: () => api.updatePage() }, 'Handmatig'));
    box.append(row);
  }

  // ---------- opbouw ----------
  function renderHero() {
    $('me-name').textContent = state.settings.deviceName;
    const ip = state.ips[0];
    $('me-hint').textContent = ip ? `Dit apparaat: ${ip}` : 'Geen netwerk gevonden';
  }

  function upsertTransfer(t) {
    state.transfers.set(t.id, t);
    // afgeronde items verhuizen vanzelf mee via de geschiedenis in de hoofdproces
    const hIdx = state.history.findIndex((h) => h.id === t.id);
    if (hIdx >= 0 && !['waiting', 'active'].includes(t.status)) state.history[hIdx] = { ...state.history[hIdx], ...t };
    renderActivity();
  }

  async function init() {
    const s = await api.state();
    state.settings = s.settings; state.peers = s.peers; state.ips = s.ips; state.port = s.port; state.history = s.history;
    for (const t of s.active) state.transfers.set(t.id, t);
    state.offers.push(...s.offers);
    state.update = s.update;
    api.onUpdate((u) => { state.update = u; renderUpdate(); const l = document.getElementById('upd-line'); if (l) l.textContent = updateLine(); });
    renderUpdate();
    for (const j of await api.downloads()) state.downloads.set(j.id, j);
    renderDownloads();
    api.onDownload((j) => { state.downloads.set(j.id, j); renderDownloads(); });
    $('dl-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('dl-url');
      const id = await call(api.download(input.value));
      if (id) input.value = '';
    });
    $('btn-dl-clear').addEventListener('click', async () => {
      await api.clearDownloads();
      for (const [id, j] of state.downloads) if (!['starting', 'active'].includes(j.status)) state.downloads.delete(id);
      renderDownloads();
    });
    renderHero(); renderDevices(); renderActivity();

    api.onPeers((list) => { state.peers = list; renderDevices(); });
    api.onTransfer((t) => {
      // ontvangen bestanden: pad voor "Openen" komt pas na afloop mee via de geschiedenis
      if (t.status === 'done' && t.dir === 'in' && t.files.length) {
        setTimeout(async () => { const st = await api.state(); state.history = st.history; renderActivity(); }, 250);
      }
      upsertTransfer(t);
    });
    api.onOffer((o) => { state.offers.push(o); showNextOffer(); });
    api.onOfferClosed((id) => {
      const i = state.offers.findIndex((o) => o.id === id);
      if (i < 0) return;
      if (i === 0 && offerModal) { const m = offerModal; offerModal = null; state.offers.shift(); m.close(); showNextOffer(); }
      else state.offers.splice(i, 1);
    });

    showNextOffer();

    $('btn-settings').addEventListener('click', settingsDialog);
    $('btn-add').addEventListener('click', addDialog);
    $('btn-open-dir').addEventListener('click', () => api.openSaveDir());
    $('btn-clear').addEventListener('click', async () => {
      await api.clearHistory();
      state.history = []; for (const [id, t] of state.transfers) if (!['waiting', 'active'].includes(t.status)) state.transfers.delete(id);
      renderActivity();
    });
    setInterval(renderActivity, 30000); // "zojuist" -> "5 min geleden"
  }

  init();
})();
