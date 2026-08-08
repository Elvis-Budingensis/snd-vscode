// make-index.mjs
//
// Generates data/snd-index.json from the Snd sources.
//
// WHY A STATIC INDEX AT ALL, when the running session has a better one.
// Because reading is a real use.  Opening a .scm file from a year ago to
// find out what it did should not require booting Snd and claiming the
// audio device.  With no session the extension has nothing to offer for
// hover and completion, and "nothing" is indistinguishable from "broken".
//
// It is generated rather than typed in, and generated from the sources
// rather than hand-maintained, for the reason inf-snd.el shows: its list
// of names was written for Snd 10.3 and is still that list.  A generated
// file at least says which Snd version it belongs to.
//
// Usage:
//   node tools/make-index.mjs /path/to/snd-26.5
//   SND_SOURCE=/path/to/snd-26.5 node tools/make-index.mjs

import * as fs from 'fs';
import * as path from 'path';

const source = process.argv[2] ?? process.env.SND_SOURCE;
if (!source) {
  console.error('usage: node tools/make-index.mjs /path/to/snd-source');
  process.exit(2);
}

const xrefPath = path.join(source, 'snd-xref.c');
if (!fs.existsSync(xrefPath)) {
  console.error(`snd-xref.c not found in ${source}`);
  process.exit(2);
}

const text = fs.readFileSync(xrefPath, 'utf8');

// snd-xref.c holds several tables. Only help_names is a list of names one
// can complete; the others are topics and cross references, whose entries
// contain spaces ("additive synthesis") and are not symbols.
const start = text.indexOf('help_names[');
if (start < 0) {
  console.error('help_names table not found — has snd-xref.c changed?');
  process.exit(1);
}
const open = text.indexOf('{', start);
const close = text.indexOf('};', open);
const body = text.slice(open + 1, close);

const names = new Set();
for (const match of body.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
  const name = match[1];
  // Entries with a space are index topics, not callable names. Keeping
  // them would offer "additive synthesis" as a completion, which cannot
  // be typed into code.
  if (!name || name.includes(' ')) continue;
  names.add(name);
}

// The s7 core is not in Snd's index but is half of what one writes in a
// Snd file. The names come out of s7.c's own definitions, so this stays
// in step with the s7 that Snd was built with.
const s7Names = new Set();
const s7Path = path.join(source, 's7.c');
if (fs.existsSync(s7Path)) {
  const s7Text = fs.readFileSync(s7Path, 'utf8');
  // Two patterns, because s7.c registers its builtins two ways. The
  // s7_define_* calls are the visible ones; the bulk goes through the
  // defun macros defined around line 102400, and matching only the former
  // yields five names out of a thousand -- which looks like a working
  // index right up to the moment someone types `for-each`.
  for (const match of s7Text.matchAll(
    /s7_define_(?:safe_|semisafe_|typed_|unsafe_|constant|variable)[A-Za-z_]*\s*\(\s*sc\s*,\s*"((?:[^"\\]|\\.)+)"/g
  )) {
    s7Names.add(match[1]);
  }
  for (const match of s7Text.matchAll(
    /(?:^|=|\s)(?:unsafe_|semisafe_|bool_)?defun\s*\(\s*"((?:[^"\\]|\\.)+)"/gm
  )) {
    s7Names.add(match[1]);
  }
}

// snd-strings.h, for the CONSTANTS.
//
// help_names covers the functions and variables one can ask for help
// about; it does NOT cover fourier-transform, blackman2-window,
// graph-as-sonogram and the other seven hundred names that are values
// rather than things to call. Those are exactly what the dialog panels
// declare, so without them the gate that checks those declarations has
// nothing to check against.
// Three headers, not one, and each for a reason: snd-strings.h has the
// editor's own names, clm-strings.h has CLM's -- which is where the fft
// windows live, all thirty-seven of them -- and sndlib-strings.h has the
// mus-* header and sample types. A dialog that offers a header type is
// reading the third file's world, and the index has to reach that far or
// the gate that checks the dialogs cannot see them.
const constantNames = new Set();
for (const header of ['snd-strings.h', 'clm-strings.h', 'sndlib-strings.h']) {
  const headerPath = path.join(source, header);
  if (!fs.existsSync(headerPath)) continue;
  const headerText = fs.readFileSync(headerPath, 'utf8');
  for (const match of headerText.matchAll(/#define\s+S_[A-Za-z_0-9]+\s+"((?:[^"\\]|\\.)+)"/g)) {
    const name = match[1];
    if (!name.includes(' ')) constantNames.add(name);
  }
}

// NAMES BUILT BY CONCATENATION IN THE C SOURCE.
//
// Not every Snd name is a #define in a header. Some are assembled at the
// point of registration:
//
//   Xen_define_typed_procedure(S_define_envelope "-1", g_define_envelope_w, ...)
//
// -- snd-env.c. That gives a real, callable `define-envelope-1`, which the
// macro `define-envelope` expands into, and which appears in no string table
// at all. Without this pass the index says it does not exist and the gate
// that checks every name the bridge calls rejects a name that is right there
// in the build.
const suffixNames = new Set();
{
  const defines = new Map();
  for (const header of ['snd-strings.h', 'clm-strings.h', 'sndlib-strings.h']) {
    const headerPath = path.join(source, header);
    if (!fs.existsSync(headerPath)) continue;
    const text = fs.readFileSync(headerPath, 'utf8');
    for (const match of text.matchAll(/#define\s+(S_[A-Za-z_0-9]+)\s+"((?:[^"\\]|\\.)+)"/g)) {
      defines.set(match[1], match[2]);
    }
  }
  for (const file of fs.readdirSync(source).filter(name => name.endsWith('.c'))) {
    const text = fs.readFileSync(path.join(source, file), 'utf8');
    // S_something "suffix" -- only a genuine suffix, never a separate word,
    // so that S_foo "a comment" cannot invent a name.
    for (const match of text.matchAll(/(S_[A-Za-z_0-9]+)\s+"([A-Za-z0-9?!*<>=+/-]+)"/g)) {
      const base = defines.get(match[1]);
      if (!base) continue;
      suffixNames.add(base + match[2]);
    }
  }
}

const version =
  /#define SND_VERSION\s+"([^"]+)"/.exec(
    fs.existsSync(path.join(source, 'snd.h'))
      ? fs.readFileSync(path.join(source, 'snd.h'), 'utf8')
      : ''
  )?.[1] ?? path.basename(source);

const entries = [
  ...[...names].map(name => ({ name, source: 'snd' })),
  ...[...constantNames]
    .filter(name => !names.has(name))
    .map(name => ({ name, source: 'snd-constant' })),
  ...[...suffixNames]
    .filter(name => !names.has(name) && !constantNames.has(name))
    .map(name => ({ name, source: 'snd-suffix' })),
  ...[...s7Names]
    .filter(name => !names.has(name) && !constantNames.has(name))
    .map(name => ({ name, source: 's7' })),
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const outputDirectory = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, 'snd-index.json');
fs.writeFileSync(
  outputPath,
  JSON.stringify(
    {
      generatedFrom: path.basename(source),
      sndVersion: version,
      note:
        'Names from snd-xref.c (help_names) and s7.c. Fallback for hover and ' +
        'completion without a running session; the live symbol table of a ' +
        'session is always preferred.',
      entries,
    },
    null,
    1
  ) + '\n'
);

console.log(
  `${outputPath}: ${entries.length} names ` +
    `(${names.size} from help_names, ${constantNames.size} from snd-strings.h, ` +
    `${suffixNames.size} built by concatenation, ` +
    `${entries.length - names.size - [...constantNames].filter(n => !names.has(n)).length} from s7), ` +
    `Snd ${version}`
);
