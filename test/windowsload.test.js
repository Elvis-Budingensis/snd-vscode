// windowsload.test.js -- -l takes the full path, on Windows like everywhere.
//
// WHY THIS EXISTS, AND WHY IT ONCE SAID THE OPPOSITE.
//
// Snd 26 could not be given an absolute Windows path: mus_expand_filename
// prepended the working directory to any name not starting with '/', so
// `C:/tmp/t.scm` became `C:/cwd/C:/tmp/t.scm` and the answer was
//
//   can't load C:/tmp/t.scm: Invalid argument
//
// -- which is also, exactly, what a missing file says, because the failure
// happens before the file is opened. A gate waiting for a bridge that was
// never loaded reports "Snd did not become ready in 20 s" and looks like a
// dead binary. That cost an evening across two machines.
//
// The workaround was to pass the BASENAME and put the directory in SND_PATH.
// It was wrong, and this file asserted it for three days:
//
//   SND_PATH DOES NOT FEED -l. It feeds *load-path*, which s7's (load ...)
//   consults. snd_load_file (snd-xen.c) expands the -l argument against the
//   working directory, probes it, tries the source-file extensions, and gives
//   up -- *load-path* is never reached.
//
// So the basenames resolved only when cwd happened to BE the directory holding
// them. The integration gate sets exactly that cwd, so 33 checks passed
// against a mechanism that had never worked; under VS Code, with the user's
// own cwd, every session failed to load its own bridge. Green tests, dead
// product, and the tests were the reason nobody looked.
//
// Fixed upstream in Snd 26.7 (20-Aug-2026). Verified from an unrelated cwd
// with the bundled binary: full paths on -l reach {"event":"ready"}.
//
// The lesson worth keeping is not about colons. It is that a test which fixes
// the environment its subject runs in tests the environment, not the subject.

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

test('every -l argument on Windows keeps its full path', () => {
  const { args } = commandLine(windowsOptions());
  const loaded = args.filter((_, i) => args[i - 1] === '-l');
  assert.ok(loaded.length >= 3, 'expected the ui bridge, an init file and the bridge');
  for (const argument of loaded) {
    assert.ok(
      path.win32.isAbsolute(argument),
      `${argument} is not absolute -- a bare name only resolves when cwd happens to match`
    );
  }
  assert.ok(loaded.includes(`${WIN_EXT}\\snd-vscode.scm`));
  assert.ok(loaded.includes(`${WIN_HOME}\\.snd_s7`));
});

test('the bridge is still loaded LAST', () => {
  const { args } = commandLine(windowsOptions());
  assert.equal(args[args.length - 2], '-l');
  assert.equal(args[args.length - 1], `${WIN_EXT}\\snd-vscode.scm`);
});

test('elsewhere the full path is kept too', () => {
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

test('loadArgument rewrites nothing, on any platform', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.equal(loadArgument(platform)('/a/b/c.scm'), '/a/b/c.scm');
    assert.equal(loadArgument(platform)('C:\\a\\b\\c.scm'), 'C:\\a\\b\\c.scm');
    assert.equal(loadArgument(platform)('C:/a/b/c.scm'), 'C:/a/b/c.scm');
  }
});

test('the -l arguments do not depend on the working directory', () => {
  // The failure this file is about: identical arguments except for cwd used to
  // decide whether the session came up at all.
  const here = commandLine(windowsOptions({ cwd: WIN_EXT }));
  const elsewhere = commandLine(windowsOptions({ cwd: 'C:\\somewhere\\else' }));
  assert.deepEqual(here.args, elsewhere.args);
});

test('SND_PATH is the bridge directory, not a list of -l directories', () => {
  // It exists for the bridge's own (load ...) calls -- the parity overlay --
  // and the -l files name themselves in full. Adding their directories here
  // was the workaround, and it never did anything.
  const value = loadSearchPath({
    bridgePath: `${WIN_EXT}\\snd-vscode.scm`,
    uiBridgePath: `${WIN_EXT}\\snd-vscode-ui.scm`,
    initFiles: [`${WIN_HOME}\\.snd_s7`],
    platform: 'win32',
  });
  assert.equal(value, WIN_EXT);
  assert.ok(!value.includes(WIN_HOME + ';'), "the user's home has no business here");
});

test('the Windows delimiter is the semicolon', () => {
  // ':' cannot separate a list whose entries begin with drive letters. Snd
  // splits on ':' regardless (snd.c:initialize_load_path) -- patch sent
  // upstream -- but the value we hand it has to be right either way.
  const value = loadSearchPath({
    bridgePath: `${WIN_EXT}\\snd-vscode.scm`,
    platform: 'win32',
    inherited: 'D:\\other\\scm',
  });
  assert.deepEqual(value.split(';'), [WIN_EXT, 'D:\\other\\scm']);
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