// smoke-test-overlay.mjs
//
// Testet die drei reparierten Ops aus snd-vscode-s7-parity-overlay.scm
// gegen ein ECHTES Snd -- ohne snd-vscode.scm zu veraendern. Das Overlay
// wird ueber die -l-Reihenfolge mit sv-no-autostart hereingeschmuggelt:
// die Bridge laedt normal, ueberspringt wegen sv-no-autostart aber ihren
// (sv-start)-Aufruf, das Overlay definiert danach seine Ops, und ein
// letztes -l ruft (sv-start) manuell auf.
//
// Aufruf (von ueberall, z. B. aus test/):
//   SND_BIN=/pfad/zu/snd node test/smoke-test-overlay.mjs
// SND_BIN ist optional, wenn "snd" bereits im PATH ist oder unter
// bin/<platform>-<arch>/snd im Repo liegt.

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Repo-Root NICHT aus process.cwd() ableiten -- das Skript soll egal von wo
// aus laufen (z. B. "node test/smoke-test-overlay.mjs" aus dem Repo-Root,
// oder "node smoke-test-overlay.mjs" von INNERHALB test/). Stattdessen vom
// eigenen Dateipfad aus nach oben laufen, bis scheme/snd-vscode.scm
// gefunden wird. SND_VSCODE_ROOT ueberschreibt das bei Bedarf.
function findRoot() {
  if (process.env.SND_VSCODE_ROOT) return process.env.SND_VSCODE_ROOT;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'scheme', 'snd-vscode.scm'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  console.error(
    'Repo-Root nicht gefunden (kein scheme/snd-vscode.scm in einem Elternordner ' +
    'dieses Skripts). SND_VSCODE_ROOT=/pfad/zum/repo setzen.'
  );
  process.exit(1);
}

const root = findRoot();
const suffix = process.platform === 'win32' ? '.exe' : '';

function findSnd() {
  const candidates = [
    process.env.SND_BIN,
    path.join(root, 'bin', `${process.platform}-${process.arch}`, `snd${suffix}`),
    path.join(root, 'bin', process.platform, `snd${suffix}`),
    path.join(root, '.build', 'snd-26.5', `snd${suffix}`),
  ].filter(Boolean);
  let exe = candidates.find(c => fs.existsSync(c));
  if (!exe) {
    const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['snd'], { encoding: 'utf8' });
    if (found.status === 0) exe = found.stdout.trim().split(/\r?\n/)[0];
  }
  if (!exe) {
    console.error(`Kein Snd gefunden. Gesucht in:\n${candidates.map(c => `  ${c}`).join('\n')}\nSND_BIN setzen oder "snd" in PATH aufnehmen.`);
    process.exit(2);
  }
  return exe;
}

const bridge = path.join(root, 'scheme', 'snd-vscode.scm');
const uiBridge = path.join(root, 'scheme', 'snd-vscode-ui.scm');
const overlay = path.join(root, 'scheme', 'snd-vscode-s7-parity-overlay.scm');
const fixture = path.join(root, 'examples', 'sounds', 'oboe.snd');

for (const [label, file] of [['Bridge', bridge], ['UI-Bridge', uiBridge], ['Overlay', overlay], ['Test-Sound', fixture]]) {
  if (!fs.existsSync(file)) {
    console.error(`${label} nicht gefunden: ${file}`);
    process.exit(1);
  }
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'snd-vscode-overlay-smoke-'));
const sound = path.join(temp, 'oboe.snd');
fs.copyFileSync(fixture, sound);

const preScm = path.join(temp, 'pre.scm');
fs.writeFileSync(preScm, '(define sv-no-autostart #t)\n');
const startScm = path.join(temp, 'start-now.scm');
fs.writeFileSync(startScm, '(sv-start)\n');

function schemeString(text) {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 32 || code === 127) out += `\\x${code.toString(16)};`;
    else out += ch;
  }
  return out + '"';
}

function inlet(params = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    let literal;
    if (typeof value === 'string') literal = schemeString(value);
    else if (typeof value === 'boolean') literal = value ? '#t' : '#f';
    else if (typeof value === 'number' && Number.isFinite(value)) literal = String(value);
    if (literal !== undefined) parts.push(`'${key}`, literal);
  }
  return parts.length ? `(inlet ${parts.join(' ')})` : '(inlet)';
}

const executable = findSnd();
console.log(`Snd: ${executable}`);
console.log(`Temp: ${temp}`);

// Reihenfolge: UI-Bridge + Sound zuerst (wie die Extension es tut), dann
// pre.scm (setzt sv-no-autostart), dann die normale Bridge (laedt jetzt
// OHNE zu blockieren), dann das Overlay, dann start-now.scm (startet die
// Serve-Schleife manuell).
const child = spawn(executable, [
  '-noinit',
  '-l', uiBridge, sound,
  '-l', preScm,
  '-l', bridge,
  '-l', overlay,
  '-l', startScm,
], { cwd: temp, stdio: ['pipe', 'pipe', 'pipe'] });

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');

let nextId = 1;
let buf = '';
let diagnostics = '';
const pending = new Map();
let readyResolve, readyReject;
const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

function dispatch(frame) {
  if (frame.event === 'ready') { readyResolve(frame); return; }
  if (frame.event) { console.log(`[event] ${JSON.stringify(frame)}`); return; }
  const waiter = pending.get(frame.id);
  if (!waiter) return;
  pending.delete(frame.id);
  clearTimeout(waiter.timer);
  if (frame.ok === false) waiter.reject(new Error(`${frame.op}: ${frame.error}`));
  else waiter.resolve(frame.value);
}

child.stderr.on('data', chunk => {
  buf += chunk;
  for (;;) {
    const open = buf.indexOf('\x1e');
    if (open < 0) { diagnostics += buf; buf = ''; break; }
    diagnostics += buf.slice(0, open);
    const close = buf.indexOf('\x1e', open + 1);
    if (close < 0) { buf = buf.slice(open); break; }
    const payload = buf.slice(open + 1, close);
    buf = buf.slice(close + 1);
    try { dispatch(JSON.parse(payload)); }
    catch { diagnostics += `[unlesbarer Frame] ${payload}\n`; }
  }
});
child.stdout.on('data', chunk => { diagnostics += chunk; });
child.on('error', err => readyReject(err));
child.on('exit', (code, signal) => {
  const err = new Error(`Snd hat sich vorzeitig beendet (${signal || `code ${code}`}).`);
  readyReject(err);
  for (const w of pending.values()) w.reject(err);
  pending.clear();
});

function request(op, params = {}) {
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout bei ${op}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`(sv ${schemeString(id)} '${op} ${inlet(params)})\n`);
  });
}

let checks = 0, failed = 0;
function check(condition, message) {
  checks++;
  if (condition) console.log(`ok   ${message}`);
  else { failed++; console.log(`FAIL ${message}`); }
}

const startupTimer = setTimeout(() => readyReject(new Error('Snd wurde nicht in 20s bereit')), 20000);

try {
  await ready;
  clearTimeout(startupTimer);

  const caps = await request('paritycapabilities');
  check(caps && typeof caps === 'object', 'paritycapabilities antwortet ueberhaupt (Overlay ist geladen)');
  console.log('  capabilities:', JSON.stringify(caps));

  const sounds = await request('sounds');
  check(Array.isArray(sounds) && sounds.length === 1, 'Startsound ist offen');
  const snd = sounds[0].index;

  // --- mark save --------------------------------------------------------
  await request('eval', { code: '(add-mark 100 0 0)' });
  const found = await request('paritymark', { action: 'find', needle: 100, snd, chn: 0 });
  check(found && found.mark !== undefined && found.mark !== null, 'find-mark liefert eine Mark-ID');

  const markFile = path.join(temp, 'test.marks');
  const saved = await request('paritymark', { action: 'save', snd, file: markFile });
  check(saved && saved.file === markFile, 'save-marks meldet Erfolg (kein Typfehler mehr)');
  check(fs.existsSync(markFile) && fs.statSync(markFile).size > 0, 'save-marks hat tatsaechlich eine nichtleere Datei geschrieben');

  // --- mark sync ----------------------------------------------------------
  const synced = await request('paritymark', { action: 'sync', mark: found.mark, sync: 3 });
  check(synced && synced.sync === 3, 'mark-sync setzt und liest den Wert zurueck (kein "not a mark"-Fehler)');

  // --- swap-channels --------------------------------------------------------
  const before0 = await request('eval', { code: `(sample 0 ${snd} 0)` });
  const before1 = await request('eval', { code: `(sample 0 ${snd} 1)` });
  await request('parityedit', { action: 'swap-channels', snd, chn: 0, other: 1 });
  const after0 = await request('eval', { code: `(sample 0 ${snd} 0)` });
  const after1 = await request('eval', { code: `(sample 0 ${snd} 1)` });
  check(after0.value === before1.value && after1.value === before0.value,
    `swap-channels hat Kanal 0 und 1 tatsaechlich vertauscht (vorher: ${before0.value}/${before1.value}, nachher: ${after0.value}/${after1.value})`);

  console.log(`\n${checks - failed}/${checks} ok`);
  child.kill();
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  console.error('FEHLER:', err.message);
  if (diagnostics.trim()) console.error('--- stdout/unframed stderr ---\n' + diagnostics);
  child.kill();
  process.exit(1);
}
