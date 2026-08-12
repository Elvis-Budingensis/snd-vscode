// transport.test.js -- the hook's stop pattern is pinned to the real wire format.
//
// WHY THIS EXISTS. sv-transport-op recognises a stop request by matching text,
// because parsing the form inside play-hook would mean running the reader on
// the audio path. Matching text means the pattern and the serialiser have to
// agree, and the first version looked for JSON -- "op":"stop" -- which never
// appears on this pipe: requests are Scheme forms, (sv "7" 'stop (inlet)). It
// matched nothing, every line went to the queue, and stop worked only once play
// had finished on its own, which is exactly the symptom it was written to
// remove.
//
// The s7 tests passed throughout, because their fixtures were invented from the
// same wrong assumption as the pattern. A test that shares a mistake with the
// code under test cannot see it. So the fixture here comes from requestLine
// itself: if the wire format changes, this fails instead of the feature going
// quietly dead.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

require('./vscode-stub.js').install();

const { requestLine } = require('../out/bridge.js');

/** The pattern sv-transport-op actually uses, read out of the Scheme source. */
function stopPattern() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scheme', 'snd-vscode.scm'),
    'utf8'
  );
  const match = /\(define \(sv-transport-op line\)\s*\(and \(string-position "([^"]+)" line\)/.exec(
    source
  );
  assert.ok(match, 'sv-transport-op no longer has exactly one string-position pattern');
  return match[1];
}

test("the hook's stop pattern matches a real stop request", () => {
  const pattern = stopPattern();
  const line = requestLine('7', 'stop', {});
  assert.ok(
    line.includes(pattern),
    `pattern ${JSON.stringify(pattern)} is absent from ${line} — ` +
      'the hook would never see a stop, and stop during playback would ' +
      'silently wait for the sound to end'
  );
});

test('it does not match the other transport requests', () => {
  const pattern = stopPattern();
  for (const op of ['play', 'pause']) {
    assert.ok(
      !requestLine('7', op, {}).includes(pattern),
      `pattern also matches ${op}, which the hook must not act on`
    );
  }
});

test('it does not match an eval that mentions stopping', () => {
  // (stop-playing) typed in the editor arrives as an eval with Scheme in a
  // string. Running it from the hook is the thing this design refuses to do.
  const pattern = stopPattern();
  assert.ok(
    !requestLine('7', 'eval', { code: '(stop-playing)' }).includes(pattern),
    'the hook would execute editor input from the audio path'
  );
});
