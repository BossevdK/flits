'use strict';
// Nep-telefoon: doet zich voor als Android-toestel en stuurt een aanbod naar de Windows-app (voor handmatig testen).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Flits } = require('../src/core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flits-phone-'));
const settings = { id: crypto.randomUUID(), deviceName: 'Pixel van Bosse', saveDir: path.join(tmp, 'in'), trusted: [], autoAcceptAll: true };
const f = new Flits({ dataDir: path.join(tmp, 'tls'), getSettings: () => settings, port: 54555, type: 'android' });
const file = path.join(tmp, 'vakantiefoto.jpg');
fs.writeFileSync(file, crypto.randomBytes(60 * 1024 * 1024));

f.start().then(() => {
  console.log('nep-telefoon draait');
  const sendAfter = Number(process.argv[2]) || 5000;
  setTimeout(() => {
    const peer = [...f.peers.values()][0];
    if (!peer) { console.log('geen pc gevonden'); return; }
    f.sendFiles(peer.id, [file]);
    console.log('aanbod verstuurd');
  }, sendAfter);
});
setTimeout(() => { f.stop(); process.exit(0); }, 120000);
