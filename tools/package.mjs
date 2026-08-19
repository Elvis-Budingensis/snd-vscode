// tools/package.mjs -- the one way to build a .vsix.
//
// There were two before this file: the gate built its own throwaway package to
// inspect, and package:<target> in package.json built the one that actually
// went out. They drifted, as two of anything does. The win32 package shipped
// 4.5 MB of macOS Snd because the exclusion lived in the gate and nowhere else,
// and no amount of green output said so -- the gate was checking its own work.
//
// So both call in here now. If a release is wrong, the gate is wrong too, and
// the gate is the thing that gets run.
//
// Used as a command:   node tools/package.mjs [target] [-o file.vsix]
// with the target defaulting to the running machine.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// vsce's target names are `${platform}-${arch}` for the three platforms this
// extension ships to, so the running machine can name its own package.
export const defaultTarget = () => `${process.platform}-${process.arch}`;

// NOT `npx`: on Windows npx is npx.cmd, spawn without a shell cannot start a
// .cmd, and the call returns non-zero with neither stdout nor stderr -- which
// reads as "vsce failed" and nothing else. vsce's own entry under
// process.execPath needs no shell, no .cmd lookup and no PATH.
export function findVsce() {
  return (
    [
      ['@vscode', 'vsce', 'vsce'],
      ['vsce', 'vsce'],
    ]
      .map(parts => path.join(root, 'node_modules', ...parts))
      .find(candidate => fs.existsSync(candidate)) ?? null
  );
}

// Keeping the other platforms out. vsce advertises
// --ignore-other-target-folders and it does nothing: as of 3.9.2 main.js parses
// the flag and hands it to packageCommand, which never reads it. --ignoreFile
// is real, so the ignore list is written per target: the repository's own
// .vscodeignore, plus one line per foreign bin/ directory.
export function writeIgnoreFile(target, directory) {
  const binaries = path.join(root, 'bin');
  const others = fs.existsSync(binaries)
    ? fs
        .readdirSync(binaries, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name !== target)
        .map(entry => entry.name)
    : [];
  const file = path.join(directory, 'vscodeignore');
  fs.writeFileSync(
    file,
    [
      fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8'),
      ...others.map(name => `bin/${name}/**`),
    ].join('\n')
  );
  return file;
}

// --no-dependencies: the extension has no runtime dependencies, and letting
// vsce resolve them turns a 2 s check into a network call.
export function buildVsix({ target = defaultTarget(), out, directory } = {}) {
  const vsce = findVsce();
  if (!vsce) return { vsce: null };

  const scratch = directory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'snd-vscode-package-'));
  const ignoreFile = writeIgnoreFile(target, scratch);
  const vsix = out ?? path.join(root, `snd-vscode-${target}-${version()}.vsix`);

  const built = spawnSync(
    process.execPath,
    [
      vsce,
      'package',
      '--no-dependencies',
      '--ignoreFile',
      ignoreFile,
      '--target',
      target,
      '-o',
      vsix,
    ],
    { cwd: root, encoding: 'utf8' }
  );

  return { vsce, target, vsix, built };
}

export function version() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

// --- as a command -------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIndex = args.findIndex(arg => arg === '-o' || arg === '--out');
  const out = outIndex === -1 ? undefined : args[outIndex + 1];
  const target = args.find((arg, i) => !arg.startsWith('-') && i !== outIndex + 1);

  const { vsce, vsix, built } = buildVsix({ target, out });
  if (!vsce) {
    console.error('vsce is not installed: npm install');
    process.exit(2);
  }
  if (built.status !== 0) {
    console.error(`${built.stdout ?? ''}${built.stderr ?? ''}`.trim() || 'vsce failed silently');
    process.exit(1);
  }
  console.log(vsix);
}
