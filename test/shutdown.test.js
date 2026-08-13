// shutdown.test.js -- closing the window has to end the Snd process.
//
// WHY THIS EXISTS. deactivate() used to do nothing, with a comment saying the
// process is a child and goes with the window. That is not true on POSIX: a
// child whose parent exits is reparented to launchd and carries on. And there
// is one state in which the polite path cannot reach it -- a no-GUI Snd that is
// playing does not return from play, and snd-dac.c's loop there is
//
//   while (dac_in_background(NULL) == BACKGROUND_CONTINUE) check_for_event();
//
// so it never reads stdin again and EOF means nothing to it. Six such processes
// turned up in Activity Monitor after one day, each at 100% CPU, one with 8:44
// hours of CPU time.
//
// This is checked against a real child process rather than a stub, because
// every part of it that failed was about what an operating system does: signal
// delivery, exit reporting, and whether a timer still runs while the host is
// tearing down.

const test = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');

require('./vscode-stub.js').install();

/**
 * The escalation under test, extracted so it can run against any child. It has
 * to match SndProcess.stop -- the source check at the bottom holds that.
 */
function stop(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      for (const timer of timers) clearTimeout(timer);
      resolve();
    };
    child.once('exit', finish);
    const signal = name => {
      if (child.exitCode === null) {
        try { child.kill(name); } catch { /* gone */ }
      }
    };
    try {
      child.stdin.end();
    } catch { /* gone */ }
    const timers = [
      setTimeout(() => signal('SIGINT'), 200),
      setTimeout(() => signal('SIGTERM'), 700),
      setTimeout(() => signal('SIGKILL'), 1700),
      setTimeout(finish, 2000),
    ];
  });
}

/** A process that reads stdin and exits on EOF, like the bridge does. */
function polite() {
  return cp.spawn(process.execPath, ['-e', 'process.stdin.on("end", () => process.exit(0)); process.stdin.resume();'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

/** A process that ignores EOF and the polite signals -- a Snd in the DAC loop. */
function stubborn() {
  return cp.spawn(
    process.execPath,
    [
      '-e',
      // No stdin read at all, and SIGINT/SIGTERM handled and discarded: this is
      // the shape of the failure, not an exaggeration of it.
      'process.on("SIGINT", () => {}); process.on("SIGTERM", () => {}); setInterval(() => {}, 50);',
    ],
    { stdio: ['pipe', 'ignore', 'ignore'] }
  );
}

test('a process that reads stdin exits on EOF alone', async () => {
  const child = polite();
  const started = Date.now();
  await stop(child);
  assert.equal(child.exitCode, 0, 'exited but not cleanly');
  // Well under the first signal: EOF did it, so Snd got to release the audio
  // device and ask about unsaved edits rather than being shot.
  assert.ok(Date.now() - started < 200, `took ${Date.now() - started} ms — the signal did it, not EOF`);
});

test('a process that ignores EOF and signals is still gone afterwards', async () => {
  // And GONE means reaped, not merely signalled. Resolving the moment SIGKILL
  // is sent would let restart() start a second Snd while the first still holds
  // the audio device.
  const child = stubborn();
  await stop(child);
  assert.equal(child.signalCode, 'SIGKILL', 'resolved before the kill was reaped');
});

test('the escalation resolves rather than hanging on an unkillable child', async () => {
  // The promise is what deactivate() awaits. If it can fail to settle, the
  // window hangs on close instead of the process being left behind -- trading
  // one bad outcome for another.
  const child = stubborn();
  const settled = await Promise.race([
    stop(child).then(() => 'stopped'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 4000)),
  ]);
  assert.equal(settled, 'stopped');
  try { child.kill('SIGKILL'); } catch { /* gone */ }
});

test('stop is ordered EOF, SIGINT, SIGTERM, SIGKILL', () => {
  // SIGINT BEFORE SIGTERM, which is not the usual order and is deliberate:
  // Bill's own note beside that loop in snd-dac.c is "need to be able to C-g
  // out of this", so an interrupt is the signal that gets a playing Snd out of
  // it. A reordering here would look tidier and would stop working.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'sndProcess.ts'), 'utf8');
  const body = /stop\(\): Promise<void> \{[\s\S]*?\n  \}/.exec(source);
  assert.ok(body, 'SndProcess.stop no longer returns a promise');
  const order = [...body[0].matchAll(/'(SIG[A-Z]+)'/g)].map(match => match[1]);
  assert.deepEqual(order, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  assert.ok(
    body[0].lastIndexOf('SIGKILL') < body[0].lastIndexOf('setTimeout(finish'),
    'stop resolves when SIGKILL is sent rather than when the process is reaped'
  );
  assert.ok(
    body[0].indexOf('stdin.end') < body[0].indexOf('SIGINT'),
    'stdin is closed before any signal, so a healthy Snd shuts itself down'
  );
});

test('deactivate returns the promise instead of dropping it', () => {
  // The comment it replaced said the process goes with the window. It does not,
  // and a void return means VS Code has nothing to await, so the timers above
  // never run while the host is tearing down.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const body = /export function deactivate\(\)[\s\S]*?\n\}/.exec(source);
  assert.ok(body, 'no deactivate');
  assert.ok(/Promise<void>/.test(body[0]), 'deactivate does not return a promise');
  assert.ok(/session\.stop\(\)/.test(body[0]), 'deactivate does not stop the session');
});
