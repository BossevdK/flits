'use strict';
// Controleert de logica waarmee Flits ontdekt welk programma poort 53317 vasthoudt (zelfde code als in main.js).
const { execFileSync } = require('child_process');
const PORT = Number(process.argv[2]) || 53317;
const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
const line = out.split(/\r?\n/).find((l) => /LISTENING/i.test(l) && new RegExp(`:${PORT}\\s`).test(l));
if (!line) { console.log('niemand luistert op', PORT); process.exit(0); }
const pid = Number(line.trim().split(/\s+/).pop());
const t = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
console.log('poort', PORT, '->', pid, (t.match(/^"([^"]+)"/) || [])[1]);
