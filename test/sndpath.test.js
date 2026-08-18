// sndpath.test.js -- SND_PATH is a list, and an empty entry is not one.
//
// WHY THIS EXISTS. Both the extension and the real-Snd gate built the variable
// as `dir + path.delimiter + (process.env.SND_PATH ?? '')`. With SND_PATH unset
// -- the normal case -- that is "…/scheme:" with a trailing colon. Snd took the
// whole string as ONE directory named "…/scheme:", and load answered
//
//   ("~A: ~A ~S" "load" "No such file or directory" "snd-vscode-s7-parity-overlay.scm")
//
// for a file sitting in that very directory. Nine ops were silently missing
// from every session, in the product as well as the gate.
//
// The whole diagnosis was one field in one event frame:
//   "loadPath":["/Users/…/snd-vscode/scheme:", …]
// A trailing colon, visible only because the frame was printed. Three rounds
// went by before it was, because the runner discarded event frames.
//
// So the shape of the value is pinned here, in the cheap place, rather than
// discovered again from a load error two layers away.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

/** The expression both call sites now use. */
function sndPath(directory, inherited) {
  return [directory, inherited].filter(Boolean).join(path.delimiter);
}

test('an unset SND_PATH leaves no trailing delimiter', () => {
  const value = sndPath('/ext/scheme', undefined);
  assert.equal(value, '/ext/scheme');
  assert.ok(
    !value.endsWith(path.delimiter),
    'Snd reads the whole value as one directory name, colon included'
  );
});

test('an empty SND_PATH is the same as an unset one', () => {
  assert.equal(sndPath('/ext/scheme', ''), '/ext/scheme');
});

test('an inherited SND_PATH is kept, after ours', () => {
  // Ours first: the bridge's own directory should win over whatever a user's
  // environment points at.
  assert.equal(
    sndPath('/ext/scheme', '/usr/local/share/snd'),
    `/ext/scheme${path.delimiter}/usr/local/share/snd`
  );
});

test('no entry of the result is empty', () => {
  for (const inherited of [undefined, '', '/a', `/a${path.delimiter}/b`]) {
    const entries = sndPath('/ext/scheme', inherited).split(path.delimiter);
    assert.deepEqual(
      entries.filter(entry => entry.length === 0),
      [],
      `empty entry from inherited ${JSON.stringify(inherited)}`
    );
  }
});

test('both call sites use the joining form', () => {
  // The bug was written twice, three weeks apart, in two files. A test that
  // only pins the helper would not have noticed the second one.
  const fs = require('node:fs');
  for (const file of ['src/sndProcess.ts', 'tools/run-real-snd-tests.mjs']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    // Comments in both files QUOTE the broken expression in order to explain
    // it. Strip them, or this test fails on its own documentation.
    const code = source
      .split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    const site = /SND_PATH:[\s\S]{0,220}?,\n/.exec(source);
    assert.ok(site, `${file} no longer sets SND_PATH`);
    assert.ok(
      !/SND_PATH:\s*path\.dirname\([^)]*\)\s*\+\s*path\.delimiter/.test(site[0]),
      `${file} concatenates a delimiter instead of joining — this is the bug ` +
        'that hid the parity overlay'
    );
    // The joining may live in the helper rather than at the call site --
    // sndProcess.ts delegates to loadSearchPath, which has to build the value
    // for two platforms. What must stay true is that SOMETHING joins and
    // NOTHING concatenates, anywhere in the file.
    assert.ok(
      /\.join\((?:path|p)\.delimiter\)/.test(code) ||
        /loadSearchPath/.test(site[0]),
      `${file} neither joins its SND_PATH entries nor delegates to loadSearchPath`
    );
    assert.ok(
      !/\+\s*path\.delimiter|path\.delimiter\s*\+/.test(code),
      `${file} concatenates path.delimiter somewhere — that is the original bug`
    );
  }
});
