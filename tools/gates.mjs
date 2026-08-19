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
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  // EVERY scheme file, not just snd-vscode.scm.  The parity overlay defines
  // nine ops in a file of its own, and a gate that reads one filename saw
  // none of them: the coverage number stayed green while the newest and least
  // exercised code in the project was outside it.  A gate whose scope is a
  // literal filename silently narrows every time the project grows a file.
  const opFiles = fs
    .readdirSync(path.join(root, 'scheme'))
    .filter(name => name.endsWith('.scm') && name !== 'test-bridge.scm')
    .sort();
  const bridge = opFiles
    .map(name => fs.readFileSync(path.join(root, 'scheme', name), 'utf8'))
    .join('\n');
  const tests = fs.readFileSync(path.join(root, 'scheme', 'test-bridge.scm'), 'utf8');
  const ops = [...bridge.matchAll(/\(sv-define-op\s+([a-z-]+)/g)].map(match => match[1]);
  // Ops that only make sense against a real audio device or a real file.
  // Named here rather than silently skipped, so the list is a decision and
  // not an omission.
  const needsRealSnd = new Set(['stop', 'open', 'close', 'save', 'load', 'select',
                               'cursor', 'undo', 'redo', 'edits', 'apropos',
                               // writes a file; a stub would only test the stub
                               'saveselection']);
  // Whitespace after the quoted op can be a space or a newline.  A long
  // request laid out over two lines is still the same exercised operation.
  const untested = ops.filter(
    op => !needsRealSnd.has(op) && !(new RegExp(`'${op}\\s`)).test(tests)
  );
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
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const name of banned) {
      // A CALL, not a mention. The panels legitimately carry these names as
      // data -- an action in a key table, a tooltip saying which Snd function
      // a button stands for -- and that is the good case: the panel sends a
      // NAME and the bridge decides what it means. What must not appear is
      // Scheme being built here, which always looks like `(name`.
      //
      // The gate previously matched the bare name and fired twice on
      // documentation: once on a tooltip, once on a key table. A rule that
      // punishes the thing it is meant to encourage gets switched off.
      const call = new RegExp(`\\(\\s*${name.replace(/[?*]/g, '\\$&')}[\\s)]`);
      if (call.test(text)) {
        fail(gate, `${file.name} builds a call to ${name} — edits belong in Snd`);
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
  const bridgeFiles = ['snd-vscode.scm', 'snd-vscode-ui.scm'];
  const bridges = bridgeFiles.map(name =>
    fs.readFileSync(path.join(root, 'scheme', name), 'utf8')
  );
  const bridge = bridges.join('\n');
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
    // Names either half of the bridge defines itself, and s7 forms that are
    // not Snd's.  The UI vocabulary lives in a separate file because it is
    // loaded before ~/.snd; treating it as foreign here would make every
    // intentional call across that internal boundary look like a typo.
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
    // AND NAMES CALLED DIRECTLY, which every pattern above misses because all
    // four are quoted forms. load-from-path was called plainly --
    // (load-from-path "…") -- and does not exist in Snd's s7 at all. It failed on
    // the first day, the catch around it turned the failure into an event nobody
    // reads, and the parity overlay silently never loaded: nine ops missing from
    // a session that looked healthy. The gate meant to catch invented names could
    // not see it, because it only looked inside quotes.
    //
    // THIS PART READS THE FORMS instead of matching text, and that is not
    // over-engineering -- it is the fourth attempt. Patterns cannot tell a call
    // from a binding: `(peak (sv-arg …))` as the second clause of a let* looks
    // exactly like a call to `peak`. Three regex versions reported between 35
    // and 200 words of English prose and local variables alongside the one real
    // answer, and a gate nobody can read is worse than no gate.
    const forms = (() => {
      const tokens = [];
      let i = 0;
      while (i < bridge.length) {
        const c = bridge[i];
        if (c === ';') { while (i < bridge.length && bridge[i] !== '\n') i++; continue; }
        if (c === '"') {
          i++;
          while (i < bridge.length && bridge[i] !== '"') i += bridge[i] === '\\' ? 2 : 1;
          i++; tokens.push({ atom: '""' }); continue;
        }
        if (c === '#' && bridge[i + 1] === '\\') { i += 3; tokens.push({ atom: '#char' }); continue; }
        if (c === '(') { tokens.push('('); i++; continue; }
        if (c === ')') { tokens.push(')'); i++; continue; }
        if (/\s/.test(c)) { i++; continue; }
        let j = i;
        while (j < bridge.length && !/[\s()";]/.test(bridge[j])) j++;
        tokens.push({ atom: bridge.slice(i, j) }); i = j;
      }
      // Unbalanced parens are the reader's problem, not this gate's: return what
      // parsed and let tsc and the s7 tests speak to broken syntax.
      let pos = 0;
      const read = () => {
        const out = [];
        while (pos < tokens.length) {
          const token = tokens[pos++];
          if (token === '(') out.push(read());
          else if (token === ')') return out;
          // A quote prefix wraps the NEXT form, and the tokenizer sees it as its
          // own atom. Without this the bridge's quoted observer table -- rows
          // like (snd-error-hook snderror (message)) -- reads as calls to
          // message and to every hook name in it.
          else if (token.atom === "'" || token.atom === '`') {
            const next = pos < tokens.length && tokens[pos] === '(' ? (pos++, read()) : tokens[pos++]?.atom;
            out.push(['quote', next]);
          } else out.push(token.atom);
        }
        return out;
      };
      return read();
    })();

    const BINDERS = new Set(['let', 'let*', 'letrec', 'letrec*', 'do', 'let-temporarily']);
    const called = new Set();
    const bound = new Set();
    // define* and lambda* write an optional parameter as (name default), so a
    // parameter list holds both strings and pairs. Reading only the strings left
    // nineteen of them looking like calls -- (activate #f) in a parameter list is
    // indistinguishable from a call to activate unless you know where you are.
    const bindParameters = params => {
      if (typeof params === 'string') { bound.add(params.replace(/^:/, '')); return; }
      if (!Array.isArray(params)) return;
      for (const p of params) {
        if (typeof p === 'string') bound.add(p.replace(/^:/, ''));
        else if (Array.isArray(p) && typeof p[0] === 'string') bound.add(p[0]);
      }
    };
    const walk = node => {
      if (!Array.isArray(node)) return;
      const head = node[0];
      // A case clause's head is a list of DATUMS, not a call: ((meter) 'meter)
      // reads exactly like calling meter. Four of these were the last false
      // positives left.
      // Quoted data is data. Skipping only the head of a quote form and then
      // walking into it anyway was the whole of the remaining noise: the
      // observer table's rows read as calls to every hook name in them.
      if (head === 'quote') return;
      if (head === 'case') {
        walk(node[1]);
        for (const clause of node.slice(2)) {
          if (Array.isArray(clause)) for (const body of clause.slice(1)) walk(body);
        }
        return;
      }
      if (typeof head === 'string') {
        if (BINDERS.has(head)) {
          // (let name ((a 1) (b 2)) …) or (let ((a 1)) …)
          const bindings = Array.isArray(node[1]) ? node[1] : node[2];
          if (typeof node[1] === 'string') bound.add(node[1]);
          if (Array.isArray(bindings)) {
            for (const binding of bindings) {
              if (Array.isArray(binding) && typeof binding[0] === 'string') bound.add(binding[0]);
              else if (typeof binding === 'string') bound.add(binding);
            }
          }
        } else if (head === 'lambda' || head === 'lambda*') {
          bindParameters(node[1]);
        } else if (head === 'define' || head === 'define*') {
          const target = node[1];
          if (Array.isArray(target)) bindParameters(target.slice(1));
        } else if (head !== 'quote') {
          called.add(head);
        }
      }
      for (const child of node) walk(child);
    };
    walk(forms);

    // The Scheme and s7 vocabulary the bridge legitimately calls plainly. A list
    // rather than a pattern, because telling language from library by shape is
    // the mistake this whole block is a correction of.
    const s7Vocabulary = new Set([
      'define', 'define*', 'defined?', 'let', 'let*', 'letrec', 'lambda', 'lambda*',
      'if', 'cond', 'case', 'when', 'unless', 'begin', 'do', 'and', 'or', 'not',
      'set!', 'quote', 'apply', 'map', 'for-each', 'catch', 'error', 'dilambda',
      'setter', 'car', 'cdr', 'caar', 'cadr', 'cdar', 'cddr', 'caddr', 'cdddr',
      'cadddr', 'cons', 'list', 'append', 'reverse', 'length', 'list-ref',
      'list-tail', 'list->string', 'list->vector', 'string->list', 'vector->list',
      'assoc', 'member', 'memq', 'null?', 'pair?', 'list?', 'symbol?', 'string?',
      'number?', 'integer?', 'real?', 'boolean?', 'char?', 'vector?', 'procedure?',
      'let?', 'eq?', 'eqv?', 'equal?', 'string=?', 'string<?', 'string-ref',
      'string-length', 'string-append', 'string-copy', 'string->number',
      'number->string', 'string->symbol', 'symbol->string', 'substring',
      'string-position', 'format', 'display', 'write', 'write-char', 'newline',
      'read', 'read-line', 'read-char', 'char-ready?', 'char=?', 'char->integer',
      'integer->char', 'eof-object?', 'open-input-string', 'with-output-to-string',
      'flush-output-port', 'load', 'provide', 'require', 'exit', 'getenv',
      'file-exists?', 'make-hash-table', 'make-vector', 'vector', 'vector-ref',
      'vector-set!', 'vector-length', 'make-float-vector', 'float-vector?',
      'float-vector-ref', 'float-vector-set!', 'make-hook', 'hook-push',
      'hook-remove', 'hook-functions', 'arity', 'inlet', 'varlet', 'cutlet',
      'rootlet', 'curlet', 'object->string', 'gensym', 'sort!', 'copy', 'fill!',
      'abs', 'min', 'max', 'floor', 'ceiling', 'round', 'truncate', 'exact',
      'inexact', 'exact->inexact', 'expt', 'sqrt', 'exp', 'log', 'sin', 'cos',
      'tan', 'atan', 'quotient', 'remainder', 'modulo', 'nan?', 'infinite?',
      'even?', 'odd?', 'zero?', 'positive?', 'negative?', 'reverse!', 'list-set!',
      'let-temporarily', 'symbol', 'values', 'call-with-exit', 'string-upcase',
      'string-downcase', 'hash-table-ref', 'hash-table-set!', 'else',
    ]);
    for (const name of called) {
      if (bound.has(name) || ours.has(name)) continue;
      if (name.startsWith('sv-') || name.startsWith('svp-') || name.startsWith('vscode-')) continue;
      if (s7Vocabulary.has(name) || index.has(name)) continue;
      if (/^[-0-9:*'#]/.test(name) || name.length < 4) continue;
      unknown.add(name);
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
      if (/:[a-z-]+/.test(statement)) return;
      // A call with ONE argument is the object alone, which is legitimate:
      // "play plays an object. The object can be a string, a sound object or
      // index, a mix, a region, the selection object ...". The rule being
      // enforced is that anything AFTER the object must be named, not that
      // there must be something after it. Without this distinction the gate
      // pushes one towards adding a keyword that means nothing here, which is
      // worse than the mistake it was written to catch.
      const call = new RegExp(`\\(\\(symbol->value '${name}\\)([^)]*)\\)`).exec(statement);
      const args = call ? call[1].trim() : 'unknown';
      // `return` and not `continue`: this is a forEach callback, not a loop.
      if (args === '' || !/\s/.test(args)) return;
      problems.push(`${name} at line ${index + 1} with more than an object and no keywords`);
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

// --- gate 5m: envelopes are applied by Snd, in one edit ------------------
//
// env-channel, env-channel-with-base and env-selection each put ONE entry in
// the edit history. Walking the samples and scaling each would put thousands
// in and make undo useless -- the same rule as the panels not editing, and
// the same temptation, because the loop is three lines and looks harmless.
{
  const gate = 'envelopes go through Snd, in one edit';
  const bridge = fs.readFileSync(path.join(root, 'scheme', 'snd-vscode.scm'), 'utf8');
  const op = /sv-define-op applyenvelope[\s\S]*?(?=\(sv-define-op)/.exec(bridge);
  if (!op) {
    fail(gate, 'the applyenvelope op is gone');
  } else if (!/env-channel|env-selection/.test(op[0])) {
    fail(gate, "it no longer calls Snd's envelope functions");
  } else if (/set-samples|float-vector->channel|do \(\(i 0/.test(op[0])) {
    fail(gate, 'it walks the samples itself');
  } else if (!/sv-breakpoints/.test(op[0])) {
    // Breakpoints are read as numbers, never evaluated: an envelope that goes
    // through eval is an eval op with a friendlier name.
    fail(gate, 'breakpoints are no longer parsed as numbers');
  } else {
    pass(gate);
  }
}

// --- gate 5n: release readiness ----------------------------------------
//
// Only run when RELEASE=1. These are things that must be true before the
// extension is published and that are merely noise during development --
// a gate that fails every day for a reason nobody is acting on today is a
// gate people learn to read past.
if (process.env.RELEASE === '1') {
  const gate = 'ready to publish';
  const problems = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  // GPL-3.0 says the full text must accompany the program.
  if (!fs.existsSync(path.join(root, 'COPYING'))) {
    problems.push(
      'COPYING is missing — curl -o COPYING https://www.gnu.org/licenses/gpl-3.0.txt'
    );
  }
  for (const field of ['repository', 'bugs', 'homepage', 'publisher', 'license']) {
    if (!manifest[field]) problems.push(`package.json has no ${field}`);
  }
  // A version still at 0.0.x, or a CHANGELOG whose top entry does not match
  // the manifest, means the release notes describe something else.
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  if (!changelog.includes(manifest.version)) {
    problems.push(`CHANGELOG.md does not mention version ${manifest.version}`);
  }
  if (/unreleased/i.test(changelog.split('\n').slice(0, 6).join(' '))) {
    problems.push('the top CHANGELOG entry still says "unreleased"');
  }
  // vsce refuses a README that is only a stub, and a missing icon is a grey
  // square in the marketplace.
  if (!fs.existsSync(path.join(root, 'README.md'))) problems.push('README.md is missing');

  // A .vsix carrying every platform's binary makes a Linux user download a
  // macOS one. VS Code has platform-specific packages for exactly this, and
  // the moment there is more than one binary the untargeted script is wrong.
  // 'snd.exe' TOO. Looking only for 'snd' meant Windows did not count as a
  // binary at all: with bin/darwin-arm64/snd and bin/win32-x64/snd.exe present,
  // this saw one platform, skipped the whole check, and the win32 package went
  // out carrying 4.5 MB of macOS Snd -- the exact thing the note above warns of.
  const binaries = fs.existsSync(path.join(root, 'bin'))
    ? fs.readdirSync(path.join(root, 'bin')).filter(name =>
        ['snd', 'snd.exe'].some(binary =>
          fs.existsSync(path.join(root, 'bin', name, binary))
        )
      )
    : [];
  if (binaries.length > 1) {
    const targeted = Object.keys(manifest.scripts).filter(name =>
      name.startsWith('package:')
    );
    for (const platform of binaries) {
      if (!targeted.includes(`package:${platform}`)) {
        problems.push(`bin/${platform} has no package:${platform} script (vsce --target)`);
      }
    }
  }
  // And the binaries must actually be in the package.
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  if (/^bin\/?\*?\*?$/m.test(ignore)) {
    problems.push('.vscodeignore excludes bin/ — the bundled Snd would not ship');
  }

  if (problems.length > 0) fail(gate, '\n     ' + problems.join('\n     '));
  else pass(gate);
}

// --- gate 5o: every panel script runs -----------------------------------
//
// A webview script that throws stops there: every listener after the throw is
// never attached, nothing is drawn, and there is no message anywhere -- the
// console belongs to a webview nobody has open. It looks exactly like a panel
// with nothing to draw.
//
// The envelope editor lost a dropdown to Bill's three buttons and kept the
// line that wired an onchange onto it. One dead line, and the panel silently
// stopped rendering; it was reported as "the envelopes are not shown", which
// sent the search to the envelope code.
{
  const gate = 'every panel script runs against a stand-in DOM';
  const result = spawnSync('node', ['tools/check-panels.mjs'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    fail(gate, '\n' + ((result.stdout ?? '') + (result.stderr ?? '')).trim());
  } else {
    const panels = (result.stdout ?? '').split('\n').filter(line => line.startsWith('ok')).length;
    pass(`${gate} (${panels} panels)`);
  }
}

// --- gate 5p: availability is not the same as procedure? ----------------
//
// s7's procedure? is #f for a macro, and Snd defines define-envelope as one
// (snd-env.c, HAVE_SCHEME branch: a macro wrapping define-envelope-1). A
// bridge that tests procedure? reports "not available in this Snd build" for
// a name that works in the REPL two lines away -- a wrong answer that blames
// the build, which is worse than no answer.
{
  const gate = 'availability accepts macros, not only procedures';
  const bridge = fs.readFileSync(path.join(root, 'scheme', 'snd-vscode.scm'), 'utf8');
  const have = /\(define \(sv-have\? name\)[\s\S]*?\n\n/.exec(bridge);
  if (!have) {
    fail(gate, 'sv-have? is gone');
  } else if (!/macro\?/.test(have[0])) {
    fail(gate, 'sv-have? still tests procedure? alone -- macros will report as missing');
  } else {
    pass(gate);
  }
}

// --- gate 5q: events carry indices, not objects -------------------------
//
// A hook argument is whatever Snd passes it, and Snd passes objects:
// after-open-hook a sound, mark-hook a mark. Sent as they are they encode as
// "#<sound 1>" -- a string where the panels expect a number, so nothing
// follows a newly opened sound. The ops learned this on day one; the event
// path had never needed it, because until the hooks arrived it only carried
// numbers Snd had already reduced.
{
  const gate = 'events carry indices, not Snd objects';
  const bridge = fs.readFileSync(path.join(root, 'scheme', 'snd-vscode.scm'), 'utf8');
  const code = bridge.replace(/;[^\n]*/g, '');
  const problems = [];
  // Every hook argument goes through sv-wire.
  const argument = /\(define \(sv-hook-argument env name\)[\s\S]*?\n\n/.exec(code);
  if (!argument || !/sv-wire/.test(argument[0])) {
    problems.push('sv-hook-argument does not normalise its value');
  }
  // And the hand-written emits do too: (sv-event 'opened (list 'snd snd)) is
  // the shape that was wrong.
  for (const match of code.matchAll(/\(sv-event '(\w+) \(list ([\s\S]*?)\)\)/g)) {
    // The field VALUE, whatever follows 'snd up to the next field or the end.
    // Matching on a trailing character was the first attempt and missed the
    // real case exactly: in `(list 'snd snd)` there is nothing after `snd`,
    // because the capture stops at the paren. The check has to look at the
    // value, not at its neighbourhood.
    const value = /'snd\s+([^\s)]+)/.exec(match[2]);
    if (!value) continue;
    const bare = value[1];
    if (bare === '(sv-wire' || /^\d+$/.test(bare)) continue;
    // A variable that was normalised WHERE IT WAS SET is fine, and requiring
    // the conversion at the emit instead would be cargo cult: sv-play-snd is
    // assigned as (sv-snd-index snd) and carries an integer from then on. So
    // the rule is that the value must be reduced SOMEWHERE, and the assignment
    // is checked for it — a name that is never assigned an index is the thing
    // to complain about.
    const assigned = new RegExp(
      `\\(set! ${bare.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&')} \\((?:sv-wire|sv-snd-index)`
    );
    if (!assigned.test(code)) {
      problems.push(`the ${match[1]} event sends 'snd as ${bare}, never reduced to an index`);
    }
  }
  // integer? first, or integers go through sound->integer, which refuses them.
  const wire = /\(define \(sv-wire value\)[\s\S]*?\n\n/.exec(code);
  if (!wire) {
    problems.push('sv-wire is gone');
  } else {
    // The FIRST predicate must be integer?. Comparing two indexOf results was
    // the obvious way and wrong: a term that is not found returns -1, and every
    // position is greater than -1, so the check fired on correct code. Which is
    // the same shape as the bug it guards -- a comparison that is true for the
    // wrong reason.
    const first = /\(cond \(\((\w+\??) value\)/.exec(wire[0]);
    if (!first || first[1] !== 'integer?') {
      problems.push(`sv-wire asks ${first ? first[1] : 'something else'} before integer?`);
    }
  }
  if (problems.length > 0) fail(gate, problems.join('; '));
  else pass(gate);
}

// --- gate 6: tsc ------------------------------------------------------
{
  const gate = 'tsc';
  // NOT `spawnSync('npx', ...)`. On Windows npx is npx.cmd, and spawn without
  // a shell cannot start a .cmd -- the call comes back with a non-zero status
  // and NEITHER stdout NOR stderr, so this gate reports "FAIL tsc:" followed
  // by nothing at all while `npx tsc -p ./` by hand compiles cleanly. Running
  // the compiler's own entry point through the node we are already in needs no
  // shell, no .cmd lookup and no PATH.
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', './'], { cwd: root, encoding: 'utf8' });
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

// --- gate 9: the bridge in a real Snd -------------------------------
//
// Plain s7 catches everything around the calls and deliberately stubs Snd's
// signatures.  This last gate starts the actual bundled build, so a renamed
// function, a changed dilambda setter, or an object shape from another Snd
// version cannot pass merely because the stub says it should.
{
  const gate = 'real Snd integration';
  const result = spawnSync('node', ['tools/run-real-snd-tests.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90000,
  });
  if (result.status === 2) {
    console.log(`skip ${gate}:`);
    const detail = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
    for (const line of detail.split('\n')) console.log(`     ${line}`);
  } else if (result.status !== 0) {
    fail(gate, '\n' + (result.stdout ?? '') + (result.stderr ?? ''));
  } else {
    const checks = /(\d+) real-Snd checks/.exec(result.stdout ?? '');
    pass(`${gate} (${checks ? checks[1] : '?'} checks)`);
  }
}

// --- last gate: the package itself --------------------------------------
//
// Everything above reads sources. This one builds the VSIX and looks inside it,
// because four faults in one session lived in the gap between the two: an
// ignore rule that matched at every level, an exclude that swallowed the one
// documented example, ignore files shipped to users, and a package built from a
// stale out/. Each was plain in `unzip -l` and invisible to every other check
// here.
//
// It runs last because it is the slowest, and it skips rather than fails when
// vsce is absent: a contributor without it should still get a full run of
// everything that reads sources.
{
  const gate = 'the package carries what the user needs';
  const result = spawnSync('node', ['tools/check-package.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
  });
  const output = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
  if (output.startsWith('skip')) {
    console.log(output);
  } else if (result.status !== 0) {
    fail(gate, '\n' + output.replace(/^FAIL[^:]*:\s*/, ''));
  } else {
    console.log(output);
  }
}

console.log(failures === 0 ? '\nall gates passed' : `\n${failures} gate(s) failed`);
process.exit(failures === 0 ? 0 : 1);
