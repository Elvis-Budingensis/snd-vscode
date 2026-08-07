// gates.mjs -- npm run gates
//
// Four gates, in order of how quickly they fail: structural checks on the
// sources, the TypeScript compiler, the node tests, the s7 tests.
//
// The structural gates are the ones worth explaining.  Each of them
// enforces a decision that is right in this project and invisible in the
// code -- the kind of thing that gets undone six months later by someone
// (including me) writing the obvious thing instead of the correct one.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
let failures = 0;

function fail(gate, message) {
  failures++;
  console.error(`FAIL ${gate}: ${message}`);
}

function pass(gate) {
  console.log(`ok   ${gate}`);
}

function sources(directory, extension) {
  const full = path.join(root, directory);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter(name => name.endsWith(extension))
    .map(name => ({ name: path.join(directory, name), text: fs.readFileSync(path.join(full, name), 'utf8') }));
}

// --- gate 1: no JSON.stringify where Scheme is built ------------------
//
// The bug clamps-vscode spent a session on, from the other side: JSON and
// Scheme escape sets overlap just enough (\n, \t, \\, \") that the mistake
// survives every ASCII test and shows up on the first umlaut or the first
// control character. There is exactly one right way here and it is called
// schemeString.
{
  const gate = 'no JSON.stringify inside Scheme text';
  let clean = true;
  for (const file of sources('src', '.ts')) {
    const lines = file.text.split('\n');
    lines.forEach((line, index) => {
      if (line.includes('//')) return; // a comment about it is fine
      if (!line.includes('JSON.stringify')) return;
      // Only flag it where the result lands in Scheme: inside a template
      // string that also carries parens, which is what a form looks like.
      if (/`[^`]*\(/.test(line) || /\$\{JSON\.stringify/.test(line)) {
        fail(gate, `${file.name}:${index + 1} builds Scheme with JSON.stringify`);
        clean = false;
      }
    });
  }
  if (clean) pass(gate);
}

// --- gate 2: frames leave on stderr, nothing else ---------------------
//
// The one decision the whole protocol rests on. A (display ...) added to
// the bridge for debugging goes to stdout and merely looks untidy; a
// (format *stderr* ...) added for debugging lands in the frame channel and
// corrupts the next answer.
{
  const gate = 'the bridge writes to *stderr* only through sv-emit';
  const bridge = fs.readFileSync(path.join(root, 'scheme', 'snd-vscode.scm'), 'utf8');
  const writes = [...bridge.matchAll(/\*stderr\*/g)].length;
  // Three: the format in sv-emit, its flush, and the let-temporarily that
  // captures an op's error output.
  if (writes > 3) {
    fail(gate, `*stderr* appears ${writes} times; only sv-emit may write there`);
  } else {
    pass(gate);
  }
}

// --- gate 3: every op is reachable and tested ------------------------
{
  const gate = 'every op in the bridge is exercised by the s7 tests';
  const bridge = fs.readFileSync(path.join(root, 'scheme', 'snd-vscode.scm'), 'utf8');
  const tests = fs.readFileSync(path.join(root, 'scheme', 'test-bridge.scm'), 'utf8');
  const ops = [...bridge.matchAll(/\(sv-define-op\s+([a-z-]+)/g)].map(match => match[1]);
  // Ops that only make sense against a real audio device or a real file.
  // Named here rather than silently skipped, so the list is a decision and
  // not an omission.
  const needsRealSnd = new Set(['stop', 'open', 'close', 'save', 'load', 'select',
                               'cursor', 'undo', 'redo', 'edits', 'apropos',
                               // writes a file; a stub would only test the stub
                               'saveselection']);
  const untested = ops.filter(op => !needsRealSnd.has(op) && !tests.includes(`'${op} `));
  if (untested.length > 0) {
    fail(gate, `no test for: ${untested.join(', ')}`);
  } else {
    pass(gate);
  }
}

// --- gate 4: no browser storage in the webviews ----------------------
//
// localStorage does not work in a VS Code webview. Code that uses it looks
// correct, runs in a browser, and fails only in the product.
{
  const gate = 'webviews keep their state in the extension';
  let clean = true;
  for (const file of sources('src', '.ts')) {
    for (const banned of ['localStorage', 'sessionStorage', 'indexedDB']) {
      if (file.text.includes(banned)) {
        fail(gate, `${file.name} uses ${banned}`);
        clean = false;
      }
    }
  }
  if (clean) pass(gate);
}

// --- gate 5: the panels do not edit ----------------------------------
//
// Every edit belongs in Snd, through Scheme, so that there is ONE edit
// history and it is the one that gets saved. A panel that edits builds a
// second one that disagrees.
//
// The Edit buttons in the waveform panel are not an exception to this: they
// send an ACTION NAME, and the bridge decides what that name is. Which is
// also why the bridge keeps a whitelist rather than running what it is
// sent -- a generic "run this edit function" op would be eval with a
// different name, and then a button could carry anything.
{
  const gate = 'the panels do not carry their own edit operations';
  const banned = ['delete-samples', 'insert-samples', 'scale-channel', 'src-channel', 'set-samples',
                  'delete-selection', 'scale-selection-by'];
  let clean = true;
  for (const file of sources('src', '.ts')) {
    if (!/View\.ts$/.test(file.name)) continue;
    // A tooltip that NAMES the Snd function is documentation and one of the
    // better things the panels do -- it lets a setting found by clicking be
    // written into a script. So the ban is on the name appearing anywhere
    // BUT a title attribute; stripping them first is what keeps this gate
    // from punishing the thing it is meant to encourage.
    // Comments too, and for the same reason as the tooltips: the paragraph
    // above these buttons explains why the panel sends an action NAME
    // instead of `(delete-selection)`, and it has to be able to say the
    // thing it is ruling out. Gate 1 already strips comments for exactly
    // this reason; doing it in only one of the two was the inconsistency.
    const text = file.text
      .replace(/title="[^"]*"/g, 'title=""')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const name of banned) {
      if (text.includes(name)) {
        fail(gate, `${file.name} calls ${name} — edits belong in Snd`);
        clean = false;
      }
    }
  }
  if (clean) pass(gate);
}

// --- gate 5b: dialog writes use (set! (f) v) ---------------------------
//
// These accessors are dilambdas. (set! f v) REPLACES the accessor with the
// value, after which the variable is gone for the rest of the session --
// silently, with the panel still showing what it believes it set. There is
// one place in the bridge that writes them and it must build the paren
// form.
{
  const gate = 'variables are written as (set! (f) v)';
  const bridge = fs.readFileSync(path.join(root, 'scheme', 'snd-vscode.scm'), 'utf8');
  const setvar = /sv-define-op setvar[\s\S]*?(?=\(sv-define-op|\(define \(sv-var-takes)/.exec(bridge);
  if (!setvar) {
    fail(gate, 'setvar not found in the bridge');
  } else if (!setvar[0].includes('"(set! (" name')) {
    fail(gate, 'setvar no longer builds the paren form');
  } else {
    pass(gate);
  }
}

// --- gate 5c: no enum integers written down ---------------------------
//
// fourier-transform is an integer in Snd, and writing that integer here
// would work until Snd inserts a transform in the middle of its list --
// after which every panel is one entry off, still looks correct, and sets
// the wrong window on a spectrum nobody can check by eye.
{
  const gate = 'enum options are symbols, resolved from the build';
  const registry = fs.readFileSync(path.join(root, 'src', 'sndVariables.ts'), 'utf8');
  const bad = [];
  for (const match of registry.matchAll(/symbol:\s*'([^']+)'/g)) {
    // Sizes and sample rates are genuinely numbers, not constants.
    if (/^\d+$/.test(match[1]) && Number(match[1]) < 128) bad.push(match[1]);
    if (/-window$|transform$|^graph-|^normalize|^mus-/.test(match[1]) && /^\d/.test(match[1])) {
      bad.push(match[1]);
    }
  }
  if (bad.length > 0) fail(gate, `numeric constant written down: ${bad.join(', ')}`);
  else pass(gate);
}

// --- gate 5d: edits are a whitelist, not a passthrough ----------------
{
  const gate = 'the edit op resolves names against a list';
  const bridge = fs.readFileSync(path.join(root, 'scheme', 'snd-vscode.scm'), 'utf8');
  // `edit` without the space also matches `edits`, the edit-history op,
  // which has no whitelist and never did. The gate was reading the wrong
  // op and failing an unchanged one -- the kind of false alarm that gets a
  // gate switched off.
  const op = /sv-define-op edit \(params\)[\s\S]*?(?=\(sv-define-op)/.exec(bridge);
  if (!op) {
    fail(gate, 'the edit op is gone');
  } else if (!op[0].includes('assoc action sv-edit-actions')) {
    fail(gate, 'the edit op no longer looks its action up in sv-edit-actions');
  } else if (/eval-string|string->symbol\s+action/.test(op[0])) {
    fail(gate, 'the edit op turns its argument into code');
  } else {
    pass(gate);
  }
}

// --- gate 5e: the channel hooks are never treated as globals ----------
//
// edit-hook, undo-hook and after-edit-hook are FUNCTIONS of (snd chn) that
// return a hook. Handing one to hook-functions stops this file LOADING --
// not one request, the whole file -- after which the serving loop does not
// exist, Snd falls through to its own repl.scm, and that tries to compile
// libc_s7.c in the current directory. One wrong hook, four screens of
// unrelated-looking failure. It happened.
{
  const gate = 'channel hooks are installed per channel';
  const bridge = fs.readFileSync(path.join(root, 'scheme', 'snd-vscode.scm'), 'utf8');
  if (!/sv-channel-hook-names\s+'\(edit-hook undo-hook after-edit-hook\)/.test(bridge)) {
    fail(gate, 'the list of channel hooks is gone or changed');
  } else if (/hook-functions \(symbol->value '(after-edit|edit|undo)-hook\)/.test(bridge)) {
    fail(gate, 'a channel hook is being passed to hook-functions as a global');
  } else if (!/sv-watched-channels/.test(bridge)) {
    fail(gate, 'nothing prevents installing the same channel watch twice');
  } else {
    pass(gate);
  }
}

// --- gate 5f: eval-string always names its environment -----------------
//
// eval-string evaluates in the CURRENT environment. Inside a handler that is
// the handler, so a (define ...) from the editor lands in a closure that is
// discarded when the request finishes -- the definition appears to succeed
// and the next request reports the name as unbound. It reads as if Snd
// forgot it, which sends one looking at the session and the process instead
// of at the missing argument.
{
  const gate = 'eval-string is always given (rootlet)';
  const bridge = fs.readFileSync(path.join(root, 'scheme', 'snd-vscode.scm'), 'utf8');
  const bare = [];
  const lines = bridge.split('\n');
  lines.forEach((line, index) => {
    if (line.trim().startsWith(';')) return;
    for (const match of line.matchAll(/\(eval-string\s+([^)]*)\)?/g)) {
      // The environment may be on the same line or, for a long form, the
      // call may span lines -- so the check is on the statement, not the
      // line: look ahead one line for the closing environment.
      const context = line + ' ' + (lines[index + 1] ?? '');
      if (!/rootlet/.test(context)) bare.push(`${index + 1}: ${line.trim()}`);
      void match;
    }
  });
  if (bare.length > 0) {
    fail(gate, `eval-string without an environment:\n     ${bare.join('\n     ')}`);
  } else {
    pass(gate);
  }
}

// --- gate 5g: sounds cross the wire as integers ------------------------
//
// (sounds) and (selected-sound) return sound OBJECTS. They print as
// "#<sound 1>", so a JSON writer falling back to object->string sends that
// string, it comes back as 'snd, and Snd rejects it three requests later
// with a message that never mentions (sounds). The panel meanwhile drew
// nothing, which looked like a broken canvas. Cost an evening.
{
  const gate = 'sound objects are normalised to indices';
  const bridge = fs.readFileSync(path.join(root, 'scheme', 'snd-vscode.scm'), 'utf8');
  if (!/sv-snd-index/.test(bridge)) {
    fail(gate, 'sv-snd-index is gone');
  } else if (!/\(inlet 'index \(sv-snd-index s\)/.test(bridge)) {
    fail(gate, 'the sounds op reports raw sound objects again');
  } else if (!/sound->integer/.test(bridge)) {
    fail(gate, 'nothing converts a sound object');
  } else if (!/eq\? key 'snd/.test(bridge)) {
    fail(gate, 'incoming sound arguments are no longer normalised in sv-arg');
  } else if (!/\(cond \(\(integer\? s\) s\)/.test(bridge)) {
    // sound? asks "does this refer to an open sound", so it says #t for the
    // INDEX too. Testing it before the type predicate sends every integer
    // into sound->integer, which rejects it -- and then nothing is
    // clickable, from a fix for the opposite confusion.
    fail(gate, 'sv-snd-index no longer checks integer? first');
  } else if (!/\(cond \(\(number\? value\)/.test(bridge)) {
    fail(gate, 'sv-var-encode no longer checks number? before sound?');
  } else {
    pass(gate);
  }
}

// --- gate 5h: edits that take a position are given one ------------------
//
// From Snd's reference: "The Edit:Insert selection menu choice is essentially
// (insert-selection (cursor))". Called with no arguments, beg is 0 -- so
// "insert at cursor" pastes at the start of the file, silently, wherever the
// cursor was. delete, reverse and smooth genuinely take nothing, which is
// why the mistake was invisible in the other buttons.
{
  const gate = 'position-taking edits are given the cursor';
  const bridge = fs.readFileSync(path.join(root, 'scheme', 'snd-vscode.scm'), 'utf8');
  const table = /sv-edit-actions[\s\S]*?\)\)\)/.exec(bridge);
  if (!table) {
    fail(gate, 'the edit action table is gone');
  } else if (!/"insert"\s+'insert-selection\s+#t #t/.test(table[0])) {
    fail(gate, 'insert-selection is no longer marked as taking a position');
  } else if (!/"mix"\s+'mix-selection\s+#t #t/.test(table[0])) {
    fail(gate, 'mix-selection is no longer marked as taking a position');
  } else if (!/takes-position[\s\S]*?symbol->value 'cursor/.test(bridge)) {
    fail(gate, 'nothing passes the cursor to the position-taking edits');
  } else {
    pass(gate);
  }
}

// --- gate 5i: the playhead is throttled --------------------------------
//
// play-hook fires per DAC buffer. dac-size defaults to 256 frames, which at
// 44100 is 172 calls a second, each one a JSON frame down a pipe -- on the
// audio path. Snd's own note about cursor-update-interval is that too small a
// value causes audible clicks during playback.
{
  const gate = 'the playhead is throttled to cursor-update-interval';
  const bridge = fs.readFileSync(path.join(root, 'scheme', 'snd-vscode.scm'), 'utf8');
  if (!/cursor-update-interval/.test(bridge)) {
    fail(gate, "the interval is no longer taken from Snd's own setting");
  } else if (!/sv-play-emitted/.test(bridge)) {
    fail(gate, 'nothing throttles the position events');
  } else if (!/sv-play-hooks-installed/.test(bridge)) {
    fail(gate, 'nothing prevents installing the play hooks twice');
  } else {
    pass(gate);
  }
}

// --- gate 5j: every Snd name the bridge calls exists -------------------
//
// The gate I should have had from the start. I invented
// set-selection-position -- it looks like the old-style name, and Snd does
// have a few of those, so it read as plausible. The call failed, the error
// went into a frame the panel rendered at the bottom of a tall page, and
// dragging simply appeared to do nothing. Two rounds of looking in the wrong
// place.
//
// data/snd-index.json holds 2000+ names from Snd's own headers, so every
// name the bridge reaches for can be checked against the real thing without
// a running Snd. This is the cheapest gate in the file and would have caught
// the most expensive mistake.
{
  const gate = 'every Snd name the bridge calls exists';
  const bridge = fs.readFileSync(path.join(root, 'scheme', 'snd-vscode.scm'), 'utf8');
  let index;
  try {
    index = new Set(
      JSON.parse(fs.readFileSync(path.join(root, 'data', 'snd-index.json'), 'utf8')).entries.map(
        entry => entry.name
      )
    );
  } catch {
    index = undefined;
  }
  if (!index || index.size < 500) {
    console.log(`skip ${gate}: no index — run npm run index -- /path/to/snd-source`);
  } else {
    // Names the bridge defines itself, and s7 forms that are not Snd's.
    // The character class allows CAPITALS. Snd has min-dB, and a
    // lowercase-only class silently truncated it to "min-d" -- so the gate
    // reported a name that does not exist because it had invented it by
    // cutting one off. A checker that mangles its input is worse than none:
    // it produces failures with no cause to find.
    const NAME = '[A-Za-z0-9?!*<>=+/-]+';
    const ours = new Set(
      [...bridge.matchAll(new RegExp(`\\(define\\*?\\s+\\(?(${NAME})`, 'g'))].map(
        match => match[1]
      )
    );
    const unknown = new Set();
    const patterns = [
      new RegExp(`\\(symbol->value\\s+'(${NAME})\\)`, 'g'),
      new RegExp(`sv-require\\s+'(${NAME})`, 'g'),
      new RegExp(`sv-have\\?\\s+'(${NAME})`, 'g'),
      new RegExp(`defined\\?\\s+'(${NAME})`, 'g'),
    ];
    for (const pattern of patterns) {
      for (const match of bridge.matchAll(pattern)) {
        const name = match[1];
        if (ours.has(name) || name.startsWith('sv-')) continue;
        if (!index.has(name)) unknown.add(name);
      }
    }
    if (unknown.size > 0) {
      fail(gate, `not in Snd's own index: ${[...unknown].join(', ')}`);
    } else {
      pass(gate);
    }
  }
}

// --- gate 5k: keyword-based Snd functions are called with keywords ------
//
// Three mistakes of this exact shape in one session:
//   save-selection -- positional, so the filename went where a keyword
//     belonged and the file was written under Snd's default name elsewhere
//   play -- positional, so the end sample landed on :edit-position and Snd
//     answered "no such edpos: 88200, current edit: 1", a message about the
//     edit history for a mistake about argument names
//   insert-selection / mix-selection -- the opposite: positional arguments
//     omitted, so beg defaulted to 0 and pastes landed at the start of the
//     file
//
// Snd's newer API is keyword-based, and the positional form is the old style
// that mostly still works -- which is exactly what makes guessing it
// tempting and wrong. The list below is from the documented signatures; it is
// maintained by hand, and that is a smaller cost than a fourth repeat.
{
  const gate = 'keyword-based Snd functions are called with keywords';
  const bridge = fs.readFileSync(path.join(root, 'scheme', 'snd-vscode.scm'), 'utf8');
  const keywordFunctions = [
    'play',
    'save-selection',
    'save-sound-as',
    'new-sound',
    'open-raw-sound',
  ];
  const problems = [];
  const lines = bridge.split('\n');
  for (const name of keywordFunctions) {
    const pattern = new RegExp(`\\(\\(symbol->value '${name}\\)`);
    lines.forEach((line, index) => {
      if (line.trim().startsWith(';')) return;
      if (!pattern.test(line)) return;
      // The call may wrap; look at this line and the next two.
      const statement = lines.slice(index, index + 3).join(' ');
      if (!/:[a-z-]+/.test(statement)) {
        problems.push(`${name} at line ${index + 1} without keywords`);
      }
    });
  }
  if (problems.length > 0) fail(gate, problems.join('; '));
  else pass(gate);
}

// --- gate 5l: no stray copies of source files in the project root -------
//
// Downloading individual files puts them in the root next to the folders they
// belong in: waveformView.ts beside src/waveformView.ts, gates.mjs beside
// tools/gates.mjs. Nothing loads them, so editing one has no effect
// whatsoever -- the change simply does not happen, and the obvious conclusion
// is that the code is broken rather than that the file is ignored. tsc does
// not complain either: rootDir is src, so it never looks.
{
  const gate = 'no stray copies of source files in the project root';
  const owned = new Map();
  for (const directory of ['src', 'tools', 'scheme', 'test']) {
    const full = path.join(root, directory);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) owned.set(name, directory);
  }
  const strays = fs
    .readdirSync(root)
    .filter(name => owned.has(name) && fs.statSync(path.join(root, name)).isFile());
  if (strays.length > 0) {
    fail(
      gate,
      `these are ignored copies of files that live elsewhere — delete them:\n     ` +
        strays.map(name => `${name}  (the real one is ${owned.get(name)}/${name})`).join('\n     ')
    );
  } else {
    pass(gate);
  }
}

// --- gate 6: tsc ------------------------------------------------------
{
  const gate = 'tsc';
  const result = spawnSync('npx', ['tsc', '-p', './'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    fail(gate, '\n' + (result.stdout || '') + (result.stderr || ''));
  } else {
    pass(gate);
  }
}

// --- gate 7: node tests ----------------------------------------------
{
  const gate = 'node tests';
  // The files, listed explicitly.
  //
  // `node --test test/` treats every .js under test/ as a test file, so the
  // vscode stub is reported as a failure. `node --test 'test/*.test.js'`
  // fixes that on Node 22, where --test expands globs -- and fails on Node 20,
  // where the pattern is passed through as a filename. Which is how this gate
  // came to report "FAIL node tests:" with nothing after the colon on a
  // machine where every test passes.
  //
  // Enumerating the files needs no feature of any Node version.
  const testFiles = fs
    .readdirSync(path.join(root, 'test'))
    .filter(name => name.endsWith('.test.js'))
    .map(name => path.join('test', name));
  const result = spawnSync('node', ['--test', ...testFiles], { cwd: root, encoding: 'utf8' });
  // THE EXIT CODE IS THE CONTRACT, not the wording of the report.
  //
  // node --test uses the TAP reporter on some versions and the spec reporter
  // on others, so the summary reads "# pass 105" here and "ℹ pass 105" there.
  // Requiring the first spelling turned a run where all 105 tests passed and
  // node exited 0 into "FAIL node tests: no test output to show — node --test
  // exited 0", which is a gate contradicting itself in a single line.
  //
  // The count is nice to print, so both spellings are read — but it decides
  // nothing.
  // No marker character at all in the pattern. It is "# pass" with the TAP
  // reporter, "ℹ pass" with the spec reporter, and plain "i pass" once the
  // ℹ has been through a terminal that dropped it. Three spellings of the
  // same number is enough evidence that the marker is not part of the
  // contract.
  const summary = /\bpass (\d+)[\s\S]*?\bfail (\d+)/.exec(result.stdout ?? '');
  const failed = summary ? summary[2] !== '0' : false;
  if (result.status !== 0 || failed) {
    // The failing lines if there are any, and otherwise EVERYTHING. A gate
    // that reports a failure with no detail sends one looking at the tests
    // when the fault is in how they were invoked -- which is exactly what
    // happened here.
    const failures = (result.stdout ?? '')
      .split('\n')
      .filter(line => /^not ok|error:/.test(line))
      .join('\n');
    fail(
      gate,
      '\n' +
        (failures ||
          `no test output to show — node --test exited ${result.status}\n` +
            (result.stdout ?? '').slice(-1500) +
            (result.stderr ?? '').slice(-1500))
    );
  } else {
    pass(summary ? `${gate} (${summary[1]} checks)` : gate);
  }
}

// --- gate 8: s7 tests -------------------------------------------------
{
  const gate = 's7 tests';
  const result = spawnSync('node', ['tools/run-scheme-tests.mjs'], { cwd: root, encoding: 'utf8' });
  if (result.status === 2) {
    // No s7 available. NOT counted as a pass: a gate that reports ok without
    // running is the failure mode this whole file exists to avoid.
    //
    // And the script's own output is shown, not swallowed. It says which
    // directories it looked in, whether a source tree was incomplete, and
    // what the compiler said if a build was attempted and failed -- all of
    // which was being thrown away behind the word "skip", leaving a message
    // that names a file to go and read instead of the reason.
    console.log(`skip ${gate}:`);
    const detail = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
    for (const line of detail.split('\n')) console.log(`     ${line}`);
  } else if (result.status !== 0) {
    fail(gate, '\n' + (result.stdout ?? '') + (result.stderr ?? ''));
  } else {
    const checks = /(\d+) checks, (\d+) failures/.exec(result.stdout ?? '');
    pass(`${gate} (${checks ? checks[1] : '?'} checks)`);
  }
}

console.log(failures === 0 ? '\nall gates passed' : `\n${failures} gate(s) failed`);
process.exit(failures === 0 ? 0 : 1);
