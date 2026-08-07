// run-scheme-tests.mjs
//
// Runs scheme/test-bridge.scm in a standalone s7.
//
// A standalone s7 and not Snd, deliberately.  Building Snd takes minutes
// and needs an audio stack; a gate that needs that does not get run, and a
// gate that does not get run is worse than no gate because it is still
// believed.  s7 builds from the single s7.c in Snd's own source tree in
// about twenty seconds:
//
//   gcc -O2 -o s7 s7.c -DWITH_MAIN -I. -lm -ldl
//
// What that leaves unchecked is honest to state: whether Snd's functions
// really take the arguments the bridge passes them.  The stubs in
// test-bridge.scm carry the signatures from Snd's own documentation, which
// catches a wrong argument ORDER but not a wrong Snd version.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// The project root from the SCRIPT's location, not from the current
// directory. `npm run gates` from inside .build/ sets the working directory to
// .build, and then every relative path here points one level too deep --
// .build/.build/snd-26.5, which does not exist. npm finds package.json by
// walking up; this script has to be able to do the same.
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const candidates = [
  process.env.S7,
  path.join(root, 's7'),
  path.join(root, 'tools', 's7'),
  '/usr/local/bin/s7',
  '/usr/bin/s7',
];

let s7;
for (const candidate of candidates) {
  if (candidate && fs.existsSync(candidate)) {
    s7 = candidate;
    break;
  }
}
if (!s7) {
  const found = spawnSync('which', ['s7'], { encoding: 'utf8' });
  if (found.status === 0) s7 = found.stdout.trim();
}

// Build it, rather than telling the user to.
//
// tools/build-snd.sh already left the Snd sources in .build, and s7 is one
// self-contained C file that compiles in about twenty seconds. Printing an
// instruction the script could carry out itself is how a gate ends up
// permanently skipped -- and a skipped gate is the one that was going to
// catch the next mistake in the bridge.
if (!s7) {
  const sources = [
    path.join(root, '.build', 'snd-26.5'),
    process.env.SND_SOURCE ?? '',
  ].filter(Boolean);
  for (const source of sources) {
    // BOTH files. s7.c includes s7.h, so a directory with only the .c
    // compiles for two seconds and then stops on a missing header — and the
    // failure looks like a broken compiler rather than an incomplete
    // directory.
    if (!fs.existsSync(path.join(source, 's7.c'))) continue;
    if (!fs.existsSync(path.join(source, 's7.h'))) {
      console.error(`${source} has s7.c but no s7.h — not a complete Snd source tree`);
      continue;
    }
    const target = path.join(root, 's7');
    console.error(`no s7 yet — building one from ${source}/s7.c (about 20 s)`);
    const compiler = process.env.CC || (fs.existsSync('/usr/bin/clang') ? '/usr/bin/clang' : 'cc');
    // -DUSE_SND=0, and this is not optional if tools/build-snd.sh has already
    // run in this directory.
    //
    // s7.c auto-includes mus-config.h when present ("#if __has_include
    // (\"mus-config.h\")"), and configure -- which build-snd.sh runs, right
    // here, to build Snd itself -- generates exactly that file with
    // `#define USE_SND 1`. s7.c's own main() is gated by
    // `#if WITH_MAIN && (!USE_SND)`, so once that header exists, main()
    // silently disappears from the translation unit -- not a compile error,
    // a successful compile of an object with no main. The linker then says
    // "_main" is undefined, which sounds like a toolchain problem and is
    // actually a stale generated header from a previous, unrelated build
    // step in the same directory.
    //
    // -DUSE_SND=0 on the command line wins over the header's #ifndef guard,
    // which is the whole reason that guard is spelled #ifndef and not a bare
    // #define.
    const built = spawnSync(
      compiler,
      // -O1, not -O2. s7.c is one 100,000-line file and -O2 on it takes
      // minutes on a laptop; -O1 takes seconds and the tests are not
      // compute-bound. A build step that seems to hang is a build step people
      // interrupt.
      [
        '-O1',
        '-o',
        target,
        path.join(source, 's7.c'),
        '-DWITH_MAIN',
        '-DUSE_SND=0',
        `-I${source}`,
        '-lm',
        '-ldl',
      ],
      { encoding: 'utf8' }
    );
    if (built.status === 0 && fs.existsSync(target)) {
      s7 = target;
      break;
    }
    // Say what went wrong, including the case where the compiler itself could
    // not be started — otherwise this prints an empty line and the next
    // message blames the missing binary.
    if (built.error) console.error(`could not run ${compiler}: ${built.error.message}`);
    console.error((built.stderr ?? '').slice(-1200) || '(the compiler said nothing)');
  }
}

if (!s7) {
  console.error(
    'No s7 found and none could be built. Either run tools/build-snd.sh first\n' +
      '(it leaves the sources in .build), or build one by hand:\n' +
      '  cc -O1 -o s7 /path/to/snd/s7.c -DWITH_MAIN -I/path/to/snd -lm -ldl\n' +
      'or point S7 at an existing binary.'
  );
  process.exit(2);
}

const result = spawnSync(s7, ['scheme/test-bridge.scm'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'pipe',
});

// s7 writes the load banner and our frames to stderr; the test report goes
// to stdout. Both are shown, because a failure often prints on the other
// channel than one expects.
process.stdout.write(result.stdout ?? '');
const noise = (result.stderr ?? '')
  .split('\n')
  .filter(line => line && !line.startsWith('\u001e') && !line.startsWith('s7:') && line !== 'load scheme/test-bridge.scm')
  .join('\n');
if (noise.trim()) process.stderr.write(noise + '\n');

// The report line is the contract: the harness exits non-zero on failure,
// but an s7 that dies mid-file exits 0 with no report at all, and that
// must not count as a pass.
if (!/\d+ checks, \d+ failures/.test(result.stdout ?? '')) {
  console.error('test-bridge.scm produced no report — it died before the end.');
  process.exit(1);
}
process.exit(result.status ?? 1);
