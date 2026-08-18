// windowsload.test.js -- -l takes a NAME on Windows, never a path.
//
// WHY THIS EXISTS. Snd splits the -l argument on ':' as a path-list
// separator. Every absolute Windows path carries a drive colon, so
//
//   ./snd -noglob -noinit -l C:/tmp/t.scm
//   can't load C:/tmp/t.scm: Invalid argument
//
// while `-l t.scm` from that directory prints PING -- same file, readable
// either way, and no spaces in the failing path, so it is not quoting.
// Verified against Snd 26 under MSYS2/UCRT64, 17 August 2026.
//
// The trap is the MESSAGE: a missing file says exactly the same thing,
// because the failure happens before the file is opened. A gate that waits
// for a bridge which was never loaded therefore reports "Snd did not become
// ready in 20 s" and looks for all the world like a dead binary or a buffering
// problem. That cost an evening of guessing across two machines.
//
// So the rule is pinned here rather than rediscovered: on win32 the basename
// goes on the command line, and every directory that -l must search goes into
// SND_PATH.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { commandLine, loadArgument, loadSearchPath } = require('../out/sndProcess.js');

const WIN_EXT = 'C:\\Users\\Someone\\.vscode\\extensions\\snd-vscode\\scheme';
const WIN_HOME = 'C:\\Users\\Someone';

function windowsOptions(extra = {}) {
  return {
    command: 'snd.exe',
    args: [],
    cwd: 'C:\\work',
    bridgePath: `${WIN_EXT}\\snd-vscode.scm`,
    uiBridgePath: `${WIN_EXT}\\snd-vscode-ui.scm`,
    initFiles: [`${WIN_HOME}\\.snd_s7`],
    mode: 'nogui',
    platform: 'win32',
    ...extra,
  };
}

test('no -l argument on Windows contains a colon', () => {
  const { args } = commandLine(windowsOptions());
  const loaded = args.filter((_, i) => args[i - 1] === '-l');
  assert.ok(loaded.length >= 3, 'expected the ui bridge, an init file and the bridge');
  for (const argument of loaded) {
    assert.ok(
      !argument.includes(':'),
      `Snd splits on ':' -- ${argument} would be torn at the drive letter`
    );
    assert.equal(argument, path.win32.basename(argument), `${argument} is not a bare name`);
  }
});

test('the bridge is still loaded LAST', () => {
  const { args } = commandLine(windowsOptions());
  assert.equal(args[args.length - 2], '-l');
  assert.equal(args[args.length - 1], 'snd-vscode.scm');
});

test('elsewhere the full path is kept', () => {
  const { args } = commandLine({
    ...windowsOptions(),
    platform: 'darwin',
    bridgePath: '/ext/scheme/snd-vscode.scm',
    uiBridgePath: '/ext/scheme/snd-vscode-ui.scm',
    initFiles: ['/Users/someone/.snd_s7'],
  });
  assert.ok(args.includes('/ext/scheme/snd-vscode.scm'));
  assert.ok(args.includes('/Users/someone/.snd_s7'));
});

test('loadArgument only rewrites on win32', () => {
  assert.equal(loadArgument('darwin')('/a/b/c.scm'), '/a/b/c.scm');
  assert.equal(loadArgument('linux')('/a/b/c.scm'), '/a/b/c.scm');
  assert.equal(loadArgument('win32')('C:\\a\\b\\c.scm'), 'c.scm');
  assert.equal(loadArgument('win32')('C:/a/b/c.scm'), 'c.scm');
});

test('SND_PATH carries every directory the basenames need', () => {
  const value = loadSearchPath({
    bridgePath: `${WIN_EXT}\\snd-vscode.scm`,
    uiBridgePath: `${WIN_EXT}\\snd-vscode-ui.scm`,
    initFiles: [`${WIN_HOME}\\.snd_s7`],
    platform: 'win32',
  });
  const entries = value.split(';');
  assert.ok(entries.includes(WIN_EXT), 'the extension scheme directory is missing');
  assert.ok(entries.includes(WIN_HOME), "the user's home is missing -- .snd_s7 lives there");
  assert.equal(new Set(entries).size, entries.length, 'a directory is listed twice');
});

test('an unset SND_PATH leaves no trailing separator', () => {
  for (const platform of ['win32', 'darwin']) {
    const value = loadSearchPath({
      bridgePath: platform === 'win32' ? `${WIN_EXT}\\snd-vscode.scm` : '/ext/scheme/b.scm',
      platform,
      inherited: undefined,
    });
    const delimiter = platform === 'win32' ? ';' : ':';
    assert.ok(
      !value.endsWith(delimiter),
      `Snd reads the whole value as one directory name, ${delimiter} included`
    );
  }
});

test('an inherited SND_PATH is appended, not dropped', () => {
  const value = loadSearchPath({
    bridgePath: '/ext/scheme/b.scm',
    platform: 'darwin',
    inherited: '/home/someone/scm',
  });
  assert.deepEqual(value.split(':'), ['/ext/scheme', '/home/someone/scm']);
});

test('elsewhere SND_PATH stays just the bridge directory', () => {
  const value = loadSearchPath({
    bridgePath: '/ext/scheme/snd-vscode.scm',
    uiBridgePath: '/ext/scheme/snd-vscode-ui.scm',
    initFiles: ['/Users/someone/.snd_s7'],
    platform: 'darwin',
  });
  assert.equal(value, '/ext/scheme');
});
