// bridge.test.js -- the protocol, without Snd.

const test = require('node:test');
const assert = require('node:assert');

const {
  RS,
  schemeString,
  inletLiteral,
  requestLine,
  splitFrames,
  parseFrame,
  readState,
  isComplete,
  splitTopLevelForms,
  enclosingForm,
  formRanges,
  zoomRange,
  panRange,
  sampleAt,
  Bridge,
} = require('../out/bridge.js');

test('schemeString escapes what the s7 reader understands', () => {
  assert.equal(schemeString('abc'), '"abc"');
  assert.equal(schemeString('a"b'), '"a\\"b"');
  assert.equal(schemeString('a\\b'), '"a\\\\b"');
  assert.equal(schemeString('a\nb'), '"a\\nb"');
  assert.equal(schemeString('a\tb'), '"a\\tb"');
});

test('schemeString uses \\xNN; and not \\uXXXX', () => {
  // The whole reason this function is not JSON.stringify: s7 does not
  // know \u, it reads it as the character u and the four digits become
  // text. The mistake survives every test with plain ASCII.
  const encoded = schemeString('a\u0001b');
  assert.equal(encoded, '"a\\x1;b"');
  assert.ok(!encoded.includes('\\u'));
});

test('schemeString leaves non-ASCII text alone', () => {
  // Umlauts and accents need no escape and must not get one: Snd reads
  // UTF-8, and \u00e4 would arrive as the letter u.
  assert.equal(schemeString('Klänge'), '"Klänge"');
});

test('a request is one line', () => {
  const line = requestLine('7', 'eval', { code: '(let ((a 1))\n  a)' });
  assert.ok(!line.includes('\n'), 'a raw newline would end the line early');
  assert.ok(line.startsWith('(sv "7" \'eval '));
});

test('inletLiteral drops undefined instead of sending #f', () => {
  // #f and "absent" mean different things on the other side: the bridge
  // falls back to its default for absent, and takes #f as an answer.
  assert.equal(inletLiteral({ a: 1, b: undefined }), "(inlet 'a 1)");
  assert.equal(inletLiteral({}), '(inlet)');
  assert.equal(inletLiteral({ ok: false }), "(inlet 'ok #f)");
  assert.equal(inletLiteral({ n: NaN }), '(inlet)');
});

test('inletLiteral carries nested UI values as Scheme lists', () => {
  assert.equal(
    inletLiteral({ value: [0, 0.5, [1, true], 'end'] }),
    `(inlet 'value (list 0 0.5 (list 1 #t) "end"))`
  );
});

test('splitFrames separates frames from ordinary text', () => {
  const result = splitFrames(`noise${RS}{"a":1}${RS}more`);
  assert.deepEqual(result.frames, ['{"a":1}']);
  assert.equal(result.text, 'noisemore');
  assert.equal(result.rest, '');
});

test('splitFrames keeps a half-arrived frame', () => {
  // A waveform answer is tens of kilobytes and does not come in one read.
  const first = splitFrames(`${RS}{"a":`);
  assert.deepEqual(first.frames, []);
  assert.equal(first.rest, `${RS}{"a":`);
  const second = splitFrames(first.rest + `1}${RS}`);
  assert.deepEqual(second.frames, ['{"a":1}']);
  assert.equal(second.rest, '');
});

test('splitFrames handles several frames in one chunk', () => {
  const result = splitFrames(`${RS}{"a":1}${RS}\n${RS}{"b":2}${RS}\n`);
  assert.equal(result.frames.length, 2);
  assert.equal(result.text.trim(), '');
});

test('Snd writing to stderr on its own account is not swallowed', () => {
  // Snd's own warnings arrive on the frame channel. Dropping them because
  // they are not frames would hide exactly the messages one needs.
  const result = splitFrames('snd: cannot open /tmp/nope.wav\n');
  assert.deepEqual(result.frames, []);
  assert.equal(result.text, 'snd: cannot open /tmp/nope.wav\n');
});

test('parseFrame rejects nonsense without raising', () => {
  assert.equal(parseFrame('{not json'), undefined);
  assert.equal(parseFrame('42'), undefined);
  assert.deepEqual(parseFrame('{"ok":true}'), { ok: true });
});

test('readState knows an unfinished form from a broken one', () => {
  assert.equal(readState('(+ 1 2)').depth, 0);
  assert.equal(readState('(let ((a 1)').depth, 2);
  assert.ok(readState('(+ 1 2))').tooManyClosers);
  assert.ok(readState('(display "abc').inString);
  assert.ok(isComplete('(+ 1 2)'));
  assert.ok(!isComplete('(+ 1'));
});

test('readState does not count a paren in a character literal', () => {
  // #\( is one character, not an open paren. Without this the REPL waits
  // forever for a closer that was never opened.
  assert.ok(isComplete('(display #\\()'));
  assert.ok(isComplete('(display "a)b")'));
  assert.ok(isComplete('(+ 1 2) ; )'));
});

test('splitTopLevelForms splits a file into forms', () => {
  const forms = splitTopLevelForms('(define a 1)\n(define b 2)\n');
  assert.deepEqual(forms, ['(define a 1)', '(define b 2)']);
});

test('splitTopLevelForms is not fooled by parens in strings or comments', () => {
  const forms = splitTopLevelForms('(display "(")\n; (not a form)\n(+ 1 2)');
  assert.deepEqual(forms, ['(display "(")', '(+ 1 2)']);
});

test('splitTopLevelForms keeps bare atoms', () => {
  // A file may end in a symbol that is meant to be evaluated.
  assert.deepEqual(splitTopLevelForms('(+ 1 2)\n*srate*\n'), ['(+ 1 2)', '*srate*']);
});

test('enclosingForm finds the definition the cursor sits in', () => {
  const text = '(define (a) 1)\n\n(define (b) 2)\n';
  const inside = enclosingForm(text, text.indexOf('(b)'));
  assert.equal(text.slice(inside.start, inside.end), '(define (b) 2)');
});

test('enclosingForm takes the previous form from behind it', () => {
  // Pressing "evaluate definition" on the blank line after a definition
  // means that definition. The alternative -- nothing happens -- is worse.
  const text = '(define (a) 1)\n\n';
  const form = enclosingForm(text, text.length);
  assert.equal(text.slice(form.start, form.end), '(define (a) 1)');
});

test('formRanges does not open a form inside a string', () => {
  const ranges = formRanges('(display "(")');
  assert.equal(ranges.length, 1);
});

test('zoomRange does not round, so it cannot creep', () => {
  // The creep in clamps-vscode came from feeding a ROUNDED result back
  // into the next call: each step lands on a whole frame, the error is
  // small, and it accumulates. Ten in, ten out has to land where it
  // started.
  let range = { start: 1000, dur: 5000 };
  for (let i = 0; i < 10; i++) {
    range = zoomRange(range.start, range.dur, 100000, 1.6, 0.5);
  }
  for (let i = 0; i < 10; i++) {
    range = zoomRange(range.start, range.dur, 100000, 1 / 1.6, 0.5);
  }
  assert.ok(Math.abs(range.start - 1000) < 1e-6, `start drifted to ${range.start}`);
  assert.ok(Math.abs(range.dur - 5000) < 1e-6, `duration drifted to ${range.dur}`);
});

test('zoomRange respects the anchor', () => {
  const range = zoomRange(0, 1000, 10000, 2, 0);
  assert.equal(range.start, 0);
  assert.equal(range.dur, 500);
  const right = zoomRange(0, 1000, 10000, 2, 1);
  assert.equal(right.start, 500);
});

test('zoomRange stays inside the file', () => {
  const out = zoomRange(0, 1000, 1000, 0.001, 0.5);
  assert.equal(out.start, 0);
  assert.equal(out.dur, 1000);
  const tiny = zoomRange(0, 32, 10000, 1000, 0.5);
  assert.ok(tiny.dur >= 16, 'a zoom must not collapse the range to nothing');
});

test('panRange stops at both ends', () => {
  assert.equal(panRange(0, 100, 1000, -1).start, 0);
  assert.equal(panRange(900, 100, 1000, 1).start, 900);
});

test('sampleAt rounds and clamps', () => {
  assert.equal(sampleAt(100, 200, 0.5), 200);
  assert.equal(sampleAt(0, 100, -1), 0);
  assert.equal(sampleAt(0, 100, 2), 100);
});

// --- the conversation ------------------------------------------------

function conversation() {
  const sent = [];
  const bridge = new Bridge(line => sent.push(line));
  return { sent, bridge };
}

const frame = (object) => `${RS}${JSON.stringify(object)}${RS}\n`;

test('a request resolves with its value', async () => {
  const { sent, bridge } = conversation();
  const promise = bridge.request('status');
  assert.equal(sent.length, 1);
  const id = /\(sv "(\d+)"/.exec(sent[0])[1];
  bridge.feed(frame({ id, op: 'status', ok: true, value: { snd: true } }));
  assert.deepEqual(await promise, { snd: true });
  assert.equal(bridge.outstanding, 0);
});

test('an error frame rejects rather than resolving with undefined', async () => {
  const { sent, bridge } = conversation();
  const promise = bridge.request('eval', { code: '(oops)' });
  const id = /\(sv "(\d+)"/.exec(sent[0])[1];
  bridge.feed(frame({ id, op: 'eval', ok: false, error: 'unbound variable oops' }));
  await assert.rejects(promise, /unbound variable oops/);
});

test('answers may arrive out of order', async () => {
  const { sent, bridge } = conversation();
  const first = bridge.request('a');
  const second = bridge.request('b');
  const ids = sent.map(line => /\(sv "(\d+)"/.exec(line)[1]);
  bridge.feed(frame({ id: ids[1], ok: true, value: 2 }));
  bridge.feed(frame({ id: ids[0], ok: true, value: 1 }));
  assert.equal(await first, 1);
  assert.equal(await second, 2);
});

test('a frame split across two chunks still arrives', async () => {
  const { sent, bridge } = conversation();
  const promise = bridge.request('waveform');
  const id = /\(sv "(\d+)"/.exec(sent[0])[1];
  const whole = frame({ id, ok: true, value: { columns: 2 } });
  bridge.feed(whole.slice(0, 12));
  bridge.feed(whole.slice(12));
  assert.deepEqual(await promise, { columns: 2 });
});

test('events are emitted, not matched against requests', () => {
  const { bridge } = conversation();
  const events = [];
  bridge.on('event', event => events.push(event.event));
  bridge.feed(frame({ event: 'ready', mode: 'nogui' }));
  bridge.feed(frame({ event: 'edited', snd: 0 }));
  assert.deepEqual(events, ['ready', 'edited']);
});

test('a late answer is reported, not thrown away silently', () => {
  const { bridge } = conversation();
  const orphans = [];
  bridge.on('orphan', frameData => orphans.push(frameData.id));
  bridge.feed(frame({ id: '999', ok: true, value: 1 }));
  assert.deepEqual(orphans, ['999']);
});

test('stderr text inside a frame goes to the log', async () => {
  const { sent, bridge } = conversation();
  const lines = [];
  bridge.on('log', text => lines.push(text));
  const promise = bridge.request('eval', { code: '(display 1)' });
  const id = /\(sv "(\d+)"/.exec(sent[0])[1];
  bridge.feed(frame({ id, ok: true, value: 1, stderr: 'a warning\n' }));
  await promise;
  assert.ok(lines.join('').includes('a warning'));
});

test('a timeout rejects instead of hanging', async () => {
  const { bridge } = conversation();
  bridge.timeout = 20;
  await assert.rejects(bridge.request('never'), /did not answer/);
  assert.equal(bridge.outstanding, 0);
});

test('a dead pipe rejects at once', async () => {
  const bridge = new Bridge(() => {
    throw new Error('No Snd session');
  });
  await assert.rejects(bridge.request('status'), /No Snd session/);
  assert.equal(bridge.outstanding, 0);
});

test('rejectAll clears everything that was waiting', async () => {
  const { bridge } = conversation();
  const promise = bridge.request('status');
  bridge.rejectAll(new Error('Snd has ended.'));
  await assert.rejects(promise, /Snd has ended/);
  assert.equal(bridge.outstanding, 0);
});

// --- SLIME's C-x C-e ---------------------------------------------------

const { precedingForm } = require('../out/bridge.js');

test('precedingForm takes the form that just ended', () => {
  // The difference from enclosingForm, and the case that matters: the cursor
  // sitting after a closing paren, which is where the hands leave it.
  const text = '(+ 1 2)';
  const form = precedingForm(text, text.length);
  assert.equal(text.slice(form.start, form.end), '(+ 1 2)');
});

test('precedingForm skips whitespace and a trailing comment', () => {
  const text = '(+ 1 2)   ; a note\n';
  const form = precedingForm(text, text.length);
  assert.equal(text.slice(form.start, form.end), '(+ 1 2)');
});

test('precedingForm does not reach past a later form', () => {
  const text = '(define a 1)\n(define b 2)\n';
  const form = precedingForm(text, text.indexOf('(define b'));
  assert.equal(text.slice(form.start, form.end), '(define a 1)');
});

test('precedingForm takes a bare atom', () => {
  // *srate* alone on a line is a form, and evaluating it is a normal thing
  // to want.
  const text = '(+ 1 2)\n*srate*';
  const form = precedingForm(text, text.length);
  assert.equal(text.slice(form.start, form.end), '*srate*');
});

test('precedingForm does not mistake the last argument for the form', () => {
  // The atom search must only look after the last paren form, or (+ 1 2)
  // yields 2 — which evaluates fine and is the wrong answer.
  const text = '(+ 1 2)';
  const form = precedingForm(text, text.length);
  assert.notEqual(text.slice(form.start, form.end), '2');
});

test('precedingForm inside a form still takes what ended before it', () => {
  const text = '(define a 1) (+ a';
  const form = precedingForm(text, text.length);
  // `a` is the atom just typed.
  assert.equal(text.slice(form.start, form.end), 'a');
});

test('precedingForm on an empty prefix returns nothing', () => {
  assert.equal(precedingForm('   \n', 4), undefined);
});
