// run-real-snd-tests.mjs
//
// The stubs catch protocol and argument-shape mistakes.  This gate catches
// the other class: a name, setter or return shape that differs in an actual
// Snd build.  It starts the same bundled executable the extension selects and
// speaks the real bridge protocol over stdin/stderr.

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suffix = process.platform === 'win32' ? '.exe' : '';
const candidates = [
  process.env.SND_BIN,
  path.join(root, 'bin', `${process.platform}-${process.arch}`, `snd${suffix}`),
  path.join(root, 'bin', process.platform, `snd${suffix}`),
  path.join(root, '.build', 'snd-26.5', `snd${suffix}`),
].filter(Boolean);

let executable = candidates.find(candidate => fs.existsSync(candidate));
if (!executable) {
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['snd'], {
    encoding: 'utf8',
  });
  if (found.status === 0) executable = found.stdout.trim().split(/\r?\n/)[0];
}

if (!executable) {
  console.error(`No real Snd found. Looked in:\n${candidates.map(p => `  ${p}`).join('\n')}`);
  process.exit(2);
}

const fixture = path.join(root, 'examples', 'sounds', 'oboe.snd');
const bridge = path.join(root, 'scheme', 'snd-vscode.scm');
const uiBridge = path.join(root, 'scheme', 'snd-vscode-ui.scm');
if (!fs.existsSync(fixture) || !fs.existsSync(bridge) || !fs.existsSync(uiBridge)) {
  console.error(
    'The real-Snd gate needs examples/sounds/oboe.snd and both Scheme bridge files.'
  );
  process.exit(1);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'snd-vscode-real-'));
const sound = path.join(temporary, 'oboe.snd');
const stateFile = path.join(temporary, 'saved-session.scm');
fs.copyFileSync(fixture, sound);

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

// Match the extension's significant startup order: the declarative UI has to
// exist before ~/.snd, while the transport is loaded last.  This gate uses
// -noinit for isolation, so there is no user init between the two here.
const child = spawn(executable, ['-noinit', '-l', uiBridge, sound, '-l', bridge], {
  cwd: temporary,
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');

let nextId = 1;
let buffer = '';
let diagnostics = '';
const pending = new Map();
let readyResolve;
let readyReject;
const ready = new Promise((resolve, reject) => {
  readyResolve = resolve;
  readyReject = reject;
});

function dispatch(frame) {
  if (frame.event === 'ready') {
    readyResolve(frame);
    return;
  }
  if (frame.event) return;
  const waiter = pending.get(frame.id);
  if (!waiter) return;
  pending.delete(frame.id);
  clearTimeout(waiter.timer);
  if (frame.ok === false) waiter.reject(new Error(`${frame.op}: ${frame.error}`));
  else waiter.resolve(frame.value);
}

child.stderr.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const open = buffer.indexOf('\x1e');
    if (open < 0) {
      diagnostics += buffer;
      buffer = '';
      break;
    }
    diagnostics += buffer.slice(0, open);
    const close = buffer.indexOf('\x1e', open + 1);
    if (close < 0) { buffer = buffer.slice(open); break; }
    const payload = buffer.slice(open + 1, close);
    buffer = buffer.slice(close + 1);
    try { dispatch(JSON.parse(payload)); }
    catch { diagnostics += `[unreadable frame] ${payload}\n`; }
  }
});
child.stdout.on('data', chunk => { diagnostics += chunk; });
child.on('error', error => readyReject(error));
child.on('exit', (code, signal) => {
  const error = new Error(`Snd exited early (${signal || `code ${code}`}).`);
  readyReject(error);
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
});

function request(op, params = {}) {
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for real Snd (${op})`));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`(sv ${schemeString(id)} '${op} ${inlet(params)})\n`);
  });
}

let checks = 0;
function check(condition, message) {
  checks++;
  if (!condition) throw new Error(message);
}

const startupTimer = setTimeout(() => readyReject(new Error('real Snd did not become ready in 20 s')), 20000);

try {
  const announced = await ready;
  clearTimeout(startupTimer);
  check(announced.mode === 'nogui' || announced.mode === 'gui', 'ready frame has no Snd mode');

  const status = await request('status');
  check(status.snd === true, 'status does not see a real Snd');
  check(/Snd/i.test(status.sndVersion), 'status has no Snd version');

  await request('eval', {
    code: `(begin
      (define real-ui-fired 0)
      (define real-ui-menu (add-to-main-menu "Real gate"))
      (define real-ui-item
        (add-to-menu real-ui-menu "Fire"
          (lambda () (set! real-ui-fired (+ real-ui-fired 1)))))
      #t)`,
  });
  const uiWidgets = await request('uiwidgets');
  check(Array.isArray(uiWidgets), 'real UI snapshot is not an array');
  const realMenu = uiWidgets.find(widget => widget.label === 'Real gate');
  const realItem = uiWidgets.find(widget => widget.label === 'Fire');
  check(realMenu?.kind === 'menu', 'real add-to-main-menu was not registered');
  check(realItem?.kind === 'menu-item' && realItem.parent === realMenu.id,
    'real add-to-menu lost its parent');
  await request('uiaction', { id: realItem.id, action: 'click', value: false });
  const uiCallback = await request('eval', { code: 'real-ui-fired' });
  check(uiCallback.value === '1', 'real UI callback did not run inside s7');

  const sounds = await request('sounds');
  check(Array.isArray(sounds) && sounds.length === 1, 'startup sound was not opened');
  check(sounds[0].frames > 0 && sounds[0].channels > 0, 'startup sound has no samples');
  const snd = sounds[0].index;

  const wave = await request('waveforms', { snd, start: 0, dur: 2048, columns: 64 });
  check(wave.channels.length === sounds[0].channels, 'real waveforms channel count differs');
  check(wave.channels[0].mins.length === 64, 'real waveform reduction shape differs');

  const spectrum = await request('spectrum', {
    snd, chn: 0, start: 0, size: 1024, linear: false, window: 'blackman2-window',
  });
  check(spectrum.available === true && spectrum.values.length >= 512, 'real snd-spectrum failed');

  const sonogram = await request('sonogram', {
    snd, chn: 0, start: 0, dur: 4096, columns: 12, bins: 32,
    size: 512, linear: false, window: 'blackman2-window',
  });
  check(typeof sonogram.cells === 'string' && sonogram.cells.length > 0, 'real sonogram is empty');

  const wavo = await request('wavogram', { snd, chn: 0, start: 0, traces: 8, points: 32 });
  check(wavo.traces.length === 8, 'real wavogram trace count differs');
  check(wavo.traces.every(trace => trace.length === 32), 'real wavogram trace shape differs');
  const wavoSet = await request('setwavogram', { snd, chn: 0, trace: 64, hop: 4 });
  check(wavoSet.trace === 64 && wavoSet.hop === 4, 'real wavogram setters differ');

  const header = await request('headerinfo', { snd });
  check(header.fileName === sound, 'real header belongs to a different sound');
  check(header.headerTypes.some(entry => entry.value === header.headerType), 'current header type not offered');
  check(header.sampleTypes.some(entry => entry.value === header.sampleType), 'current sample type not offered');
  // The fixture is a private temporary copy, so exercise actual public Snd
  // setters rather than merely validating a no-op.  A one-Hz rate change
  // leaves sample bytes alone, and a comment takes the public save path.
  const changedHeader = await request('editheader', {
    snd,
    headerType: header.headerType,
    sampleType: header.sampleType,
    srate: header.srate + 1,
    channels: header.channels,
    dataLocation: header.dataLocation,
    dataSize: header.dataSize,
    setLocation: false,
    setSize: false,
    comment: 'snd-vscode real gate',
  });
  check(changedHeader.srate === header.srate + 1, 'real Edit Header did not set sample rate');
  check(changedHeader.comment === 'snd-vscode real gate', 'real Edit Header did not set comment');
  check(changedHeader.commentPending === false, 'clean sound left its comment pending');
  // Restore the values before save-state, also proving that a second header
  // update re-reads and sets the actual running sound rather than local UI state.
  const restoredHeader = await request('editheader', {
    snd,
    headerType: header.headerType,
    sampleType: header.sampleType,
    srate: header.srate,
    channels: header.channels,
    dataLocation: header.dataLocation,
    dataSize: header.dataSize,
    setLocation: false,
    setSize: false,
    comment: header.comment,
  });
  check(restoredHeader.srate === header.srate, 'real Edit Header did not restore sample rate');

  await request('savestate', { file: stateFile });
  check(fs.existsSync(stateFile) && fs.statSync(stateFile).size > 0, 'real save-state wrote no program');

  console.log(`${checks} real-Snd checks, 0 failures (${path.basename(executable)})`);
  child.stdin.end();
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exit(0);
} catch (error) {
  clearTimeout(startupTimer);
  console.error(`FAIL real Snd: ${error.message}`);
  const tail = diagnostics.trim().split(/\r?\n/).slice(-30).join('\n');
  if (tail) console.error(tail);
  try { child.stdin.end(); child.kill('SIGTERM'); } catch { /* already gone */ }
  console.error(`temporary fixture kept at ${temporary}`);
  process.exit(1);
}
