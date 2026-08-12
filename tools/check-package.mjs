// check-package.mjs -- what the user installs, checked at the artefact.
//
// WHY THIS EXISTS. Everything between src/ and the installed extension rests on
// two ignore files, and in one session four faults of that exact shape got
// through, each found only by opening the package by hand:
//
//   - `s7` in .gitignore matched at every level, so third-party/s7 -- the two
//     sources the s7 gate builds the interpreter FROM -- was excluded, and a
//     fresh clone failed one node test on a missing file.
//   - `examples/**` in .vscodeignore excluded examples/vscode-ui.scm, the one
//     example the Motif layer's documentation tells the reader to load. It was
//     installed nowhere and documented everywhere.
//   - .gitignore and .github/** were not excluded, so the package shipped the
//     project's own ignore rules and a CI workflow to every user.
//   - a compiled out/wavogramView.js still carried a fixed bug because the
//     package was built from a stale out/ -- src/ was right, the artefact was
//     not.
//
// Every one of those was visible in `unzip -l` and invisible to tsc, to the
// node tests and to the s7 tests. So this gate builds the package and looks
// inside it. It is the only check in the project that examines the thing that
// actually ships.
//
// Run: node tools/check-package.mjs   (skips if vsce is not installed)

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Files the extension cannot work without. Each is here because something
// referenced it: the bridge is loaded by sndProcess, the UI layer before
// ~/.snd, the overlay by the bridge itself, the example by the README.
const REQUIRED = [
  'extension/package.json',
  'extension/out/extension.js',
  'extension/scheme/snd-vscode.scm',
  'extension/scheme/snd-vscode-ui.scm',
  'extension/scheme/snd-vscode-s7-parity-overlay.scm',
  'extension/examples/vscode-ui.scm',
  'extension/data/snd-index.json',
  'extension/LICENSE.txt',
  // The marketplace icon has to BE in the package. Unlike the README's
  // screenshots, which the gallery fetches over their raw.githubusercontent
  // URLs, this one is read out of the vsix -- so a package.json naming an icon
  // that was excluded shows the grey placeholder and says nothing about why.
  'extension/icon.png',
];

// Patterns that must NOT appear. Sources and tests are not wrong to ship, only
// pointless; the ignore files and CI workflow are the project's own business
// and say nothing to a user.
const FORBIDDEN = [
  { pattern: /^extension\/src\//, why: 'TypeScript sources' },
  { pattern: /^extension\/test\//, why: 'tests' },
  { pattern: /^extension\/tools\//, why: 'build tools' },
  { pattern: /^extension\/third-party\//, why: 'the s7 sources, which are for the gate' },
  { pattern: /\.ts$/, why: 'TypeScript' },
  { pattern: /\.map$/, why: 'source maps' },
  { pattern: /^extension\/\.git/, why: "the project's own ignore rules" },
  { pattern: /^extension\/\.github\//, why: 'the CI workflow' },
  { pattern: /^extension\/node_modules\//, why: 'node_modules' },
  { pattern: /^extension\/\.build\//, why: "Snd's unpacked source tree" },
  { pattern: /^extension\/s7$/, why: 'the s7 binary the gate builds for itself' },
  { pattern: /\.vsix$/, why: 'an older package' },
  { pattern: /\.DS_Store$/, why: 'a Finder file' },
];

// Compiled output has to be NEWER than the source it came from. src/ being
// right is not the same as the package being right, and a forgotten compile
// between the two is invisible everywhere else.
function stalest() {
  const newest = dir =>
    fs
      .readdirSync(path.join(root, dir))
      .filter(name => name.endsWith(dir === 'src' ? '.ts' : '.js'))
      .map(name => fs.statSync(path.join(root, dir, name)).mtimeMs)
      .reduce((a, b) => Math.max(a, b), 0);
  if (!fs.existsSync(path.join(root, 'out'))) return 'out/ does not exist — run npm run compile';
  const source = newest('src');
  const compiled = newest('out');
  if (source > compiled) {
    return `src/ is newer than out/ by ${Math.round((source - compiled) / 1000)} s ` +
      '— the package would be built from stale JavaScript';
  }
  return undefined;
}

const staleness = stalest();
if (staleness) {
  console.error(`FAIL the package carries what the user needs: ${staleness}`);
  process.exit(1);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'snd-vscode-package-'));
const target = path.join(temporary, 'gate.vsix');

// --no-dependencies: the extension has no runtime dependencies, and letting
// vsce resolve them turns a 2 s check into a network call.
const built = spawnSync(
  'npx',
  ['--no-install', 'vsce', 'package', '--no-dependencies', '--target', 'darwin-arm64', '-o', target],
  { cwd: root, encoding: 'utf8' }
);

if (built.status !== 0) {
  const text = `${built.stdout ?? ''}${built.stderr ?? ''}`;
  if (/not found|could not determine executable|ENOENT|missing packages|canceled/i.test(text)) {
    console.log('skip the package carries what the user needs: vsce is not installed');
    fs.rmSync(temporary, { recursive: true, force: true });
    process.exit(0);
  }
  console.error(`FAIL the package carries what the user needs: vsce failed\n${text.trim()}`);
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exit(1);
}

const listed = spawnSync('unzip', ['-Z1', target], { encoding: 'utf8' });
if (listed.status !== 0) {
  console.error('FAIL the package carries what the user needs: cannot read the vsix');
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exit(1);
}
const entries = listed.stdout.trim().split(/\r?\n/);

const problems = [];
for (const required of REQUIRED) {
  if (!entries.includes(required)) problems.push(`missing: ${required}`);
}
for (const { pattern, why } of FORBIDDEN) {
  const hits = entries.filter(entry => pattern.test(entry));
  if (hits.length > 0) {
    problems.push(`should not ship ${why}: ${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ` (+${hits.length - 3})` : ''}`);
  }
}

// A binary is the point of the bundle on macOS, so its absence is worth saying
// out loud rather than discovering after installing.
const binaries = entries.filter(entry => /^extension\/bin\/[^/]+\/snd$/.test(entry));
if (binaries.length === 0) {
  problems.push('no Snd binary under bin/ — the package will fall back to PATH');
}

// THE ICON, declared and sized. It arrived as a 1254x1254, 3.3 MB PNG that
// package.json did not mention at all: the gallery would have shown the grey
// placeholder while the file rode along in every download. Both halves are
// checkable here and nowhere else -- tsc has no opinion about PNGs, and the
// gallery only tells you by looking wrong.
{
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!manifest.icon) {
    problems.push('package.json names no icon — the gallery shows a placeholder');
  } else {
    const icon = path.join(root, manifest.icon);
    if (!fs.existsSync(icon)) {
      problems.push(`package.json names ${manifest.icon}, which is not there`);
    } else {
      const bytes = fs.statSync(icon).size;
      // The header is enough: width and height are big-endian at offset 16.
      const header = fs.readFileSync(icon).subarray(0, 24);
      const width = header.readUInt32BE(16);
      const height = header.readUInt32BE(20);
      if (width !== height) problems.push(`${manifest.icon} is ${width}x${height}, not square`);
      if (width < 128) problems.push(`${manifest.icon} is ${width}px; 128 is the minimum`);
      if (bytes > 512 * 1024) {
        problems.push(
          `${manifest.icon} is ${Math.round(bytes / 1024)} KB — an icon in every download`
        );
      }
    }
  }
}

fs.rmSync(temporary, { recursive: true, force: true });

const gate = 'the package carries what the user needs';
if (problems.length > 0) {
  console.error(`FAIL ${gate}:\n${problems.map(line => `     ${line}`).join('\n')}`);
  process.exit(1);
}
console.log(`ok   ${gate} (${entries.length} entries, ${binaries.join(', ')})`);
