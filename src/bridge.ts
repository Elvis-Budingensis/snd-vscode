// bridge.ts
//
// The protocol half of the extension: everything that can be decided
// without a running Snd, and therefore everything that can be checked by
// the gate.  The process itself lives in sndProcess.ts.
//
// THE SHAPE OF THE CHANNEL, AND WHY IT IS THIS SHAPE
//
// Requests go down Snd's stdin as ONE BALANCED LINE each:
//
//     (sv "17" 'waveform (inlet 'snd 0 'chn 0 'columns 800))
//
// One line, because in the Motif build Snd reads stdin itself (the path
// snd-motif.c calls "the emacs subjob connection") and hands what it
// reads to stdin_check_for_full_expression, which accumulates text until
// the parens balance.  Send an unbalanced fragment and it sits in that
// accumulator, where the NEXT request completes it into something
// nobody wrote.
//
// Answers come back up stderr, each wrapped in ASCII RS (0x1e):
//
//     \x1e{"id":"17","ok":true,...}\x1e\n
//
// stderr and not stdout, because in the Motif build the listener widget
// takes stdout: a protocol on stdout works headless and breaks silently
// the moment the GUI is up.  Which leaves stdout free for what a human
// wants to read, and that is what the REPL terminal shows.

import { EventEmitter } from 'events';

export const RS = '\x1e';

export interface Frame {
  id?: string;
  op?: string;
  ok?: boolean;
  value?: unknown;
  error?: string;
  errorType?: string;
  stderr?: string;
  event?: string;
  [key: string]: unknown;
}

/**
 * A Scheme string literal from a text.
 *
 * NOT JSON.stringify, and not because it looks similar: JSON escapes
 * \uXXXX, which the s7 reader does not know -- it reads \u as the
 * character u and swallows the four digits as text.  s7 spells the same
 * thing \xNN;.  The overlap between the two escape sets (\n, \t, \\, \")
 * is exactly large enough for the mistake to survive every simple test
 * and to surface on a string with an umlaut or a control character.
 *
 * Newlines are escaped rather than passed through even though s7 accepts
 * a literal newline inside a string literal: a request is one line, so a
 * raw newline in the payload would end the line early and leave the rest
 * to be read as a second, broken request.
 *
 * (clamps-vscode learned the same lesson from the other side and reached
 * the opposite conclusion, correctly: there the frame counts bytes and
 * newlines are free, so literal newlines are cheaper than escaping.)
 */
export function schemeString(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 32 || code === 127) out += '\\x' + code.toString(16) + ';';
    else out += ch;
  }
  return out + '"';
}

export type ParamValue = string | number | boolean | null | undefined | ParamValue[];

function paramLiteral(value: ParamValue): string | undefined {
  if (typeof value === 'string') return schemeString(value);
  if (typeof value === 'boolean') return value ? '#t' : '#f';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value === null) return '#f';
  if (Array.isArray(value)) {
    const values = value.map(paramLiteral);
    if (values.some(item => item === undefined)) return undefined;
    return `(list ${values.join(' ')})`;
  }
  return undefined;
}

/** An (inlet 'k v ...) literal. Undefined values are dropped, not sent as #f. */
export function inletLiteral(params: Record<string, ParamValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    // The literal is worked out BEFORE the key is written. Pushing the key
    // first and then bailing out on a bad value leaves `(inlet 'n)` on the
    // wire -- a key with no value, which the s7 reader takes as an odd
    // argument list and rejects wholesale. Found by the gate, and it would
    // have shown up in the wild only as a request that mysteriously fails
    // when a computed number came out NaN.
    const literal = paramLiteral(value);
    if (literal === undefined) continue;
    parts.push(`'${key}`, literal);
  }
  return parts.length ? `(inlet ${parts.join(' ')})` : '(inlet)';
}

export function requestLine(
  id: string,
  op: string,
  params: Record<string, ParamValue> = {}
): string {
  return `(sv ${schemeString(id)} '${op} ${inletLiteral(params)})`;
}

/**
 * Splits a stderr chunk into frames and the text between them.
 *
 * Two things force this to be a stateful splitter rather than a regex
 * over the whole buffer.  A frame can arrive in pieces -- a waveform
 * answer is tens of kilobytes and does not come in one read.  And Snd
 * writes to stderr on its own account (warnings, its own error
 * messages), which must NOT be swallowed just because it is on the frame
 * channel; it belongs in the log where the user can see it.
 *
 * Returns the leftover for the next call.
 */
export function splitFrames(buffer: string): {
  frames: string[];
  text: string;
  rest: string;
} {
  const frames: string[] = [];
  let text = '';
  let rest = buffer;

  for (;;) {
    const open = rest.indexOf(RS);
    if (open < 0) {
      text += rest;
      rest = '';
      break;
    }
    text += rest.slice(0, open);
    const close = rest.indexOf(RS, open + 1);
    if (close < 0) {
      // Frame still incomplete -- keep it, including the opening RS.
      rest = rest.slice(open);
      break;
    }
    frames.push(rest.slice(open + 1, close));
    rest = rest.slice(close + 1);
  }

  return { frames, text, rest };
}

export function parseFrame(payload: string): Frame | undefined {
  try {
    const value = JSON.parse(payload);
    return typeof value === 'object' && value !== null ? (value as Frame) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reader state of an input buffer -- is the expression finished?
 *
 * The REPL needs it so that Enter on "(let ((a 1)" continues instead of
 * sending half a form.  Character literals (#\( does not count as a
 * paren), strings and comments are taken into account; block comments
 * are #| |# in Common Lisp but s7 spells them the same way, so the same
 * code serves.
 */
export interface ReadState {
  depth: number;
  tooManyClosers: boolean;
  inString: boolean;
  inBlockComment: boolean;
}

export function readState(text: string): ReadState {
  let depth = 0;
  let tooManyClosers = false;
  let inString = false;
  let blockDepth = 0;
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (inString) {
      if (c === '\\') i += 2;
      else {
        if (c === '"') inString = false;
        i++;
      }
      continue;
    }
    if (blockDepth > 0) {
      if (c === '|' && text[i + 1] === '#') { blockDepth--; i += 2; continue; }
      if (c === '#' && text[i + 1] === '|') { blockDepth++; i += 2; continue; }
      i++;
      continue;
    }
    if (c === '#' && text[i + 1] === '\\') { i += 3; continue; }
    if (c === '#' && text[i + 1] === '|') { blockDepth++; i += 2; continue; }
    if (c === ';') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '"') { inString = true; i++; continue; }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') {
      depth--;
      if (depth < 0) { tooManyClosers = true; depth = 0; }
      i++;
      continue;
    }
    i++;
  }

  return { depth, tooManyClosers, inString, inBlockComment: blockDepth > 0 };
}

export const isComplete = (text: string): boolean => {
  const state = readState(text);
  return state.depth === 0 && !state.inString && !state.inBlockComment;
};

/**
 * Splits a text into top-level forms.
 *
 * "Evaluate file" cannot simply hand the whole text over: Snd evaluates
 * ONE expression per request, so a file sent as a block runs its first
 * form and silently drops the rest -- a bug that presents as "nothing
 * happens".
 */
export function splitTopLevelForms(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let i = 0;
  let inString = false;
  let blockDepth = 0;

  const flush = (end: number) => {
    if (start >= 0) {
      const piece = text.slice(start, end).trim();
      if (piece) out.push(piece);
    }
    start = -1;
  };

  while (i < text.length) {
    const c = text[i];

    if (inString) {
      if (c === '\\') i += 2;
      else { if (c === '"') inString = false; i++; }
      continue;
    }
    if (blockDepth > 0) {
      if (c === '|' && text[i + 1] === '#') { blockDepth--; i += 2; continue; }
      if (c === '#' && text[i + 1] === '|') { blockDepth++; i += 2; continue; }
      i++;
      continue;
    }
    if (c === '#' && text[i + 1] === '\\') {
      if (start < 0) start = i;
      i += 3;
      continue;
    }
    if (c === '#' && text[i + 1] === '|') { blockDepth++; i += 2; continue; }
    if (c === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (/\s/.test(c)) { if (depth === 0 && start >= 0) flush(i); i++; continue; }

    if (start < 0) start = i;
    if (c === '"') { inString = true; i++; continue; }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') {
      depth--;
      i++;
      if (depth <= 0) { depth = 0; flush(i); }
      continue;
    }
    i++;
  }
  flush(text.length);
  return out;
}

/**
 * The top-level form the cursor sits in, as an offset range.
 *
 * inf-snd.el's snd-send-definition does this with backward-sexp, which
 * relies on Emacs' syntax tables.  Here it is a scan from the start of
 * the text, because that is the only way to know whether an opening
 * paren at column 0 is code or sits inside a string.
 */
export function enclosingForm(
  text: string,
  offset: number
): { start: number; end: number } | undefined {
  for (const form of formRanges(text)) {
    if (form.start <= offset && offset <= form.end) return form;
  }
  // Cursor in whitespace behind the last form: take that one -- pressing
  // "evaluate definition" with the cursor on the blank line after a
  // definition means that definition.
  const all = formRanges(text);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].end <= offset) return all[i];
  }
  return undefined;
}

export function formRanges(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  let i = 0;
  let inString = false;
  let blockDepth = 0;

  while (i < text.length) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 2;
      else { if (c === '"') inString = false; i++; }
      continue;
    }
    if (blockDepth > 0) {
      if (c === '|' && text[i + 1] === '#') { blockDepth--; i += 2; continue; }
      i++;
      continue;
    }
    if (c === '#' && text[i + 1] === '\\') { i += 3; continue; }
    if (c === '#' && text[i + 1] === '|') { blockDepth++; i += 2; continue; }
    if (c === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '"') { inString = true; i++; continue; }
    if (c === '(') {
      if (depth === 0) start = i;
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth--;
      i++;
      if (depth <= 0) {
        depth = 0;
        if (start >= 0) out.push({ start, end: i });
        start = -1;
      }
      continue;
    }
    i++;
  }
  return out;
}

/**
 * The form that ENDS at or just before the offset.
 *
 * This is what SLIME's C-x C-e evaluates: the sexp before point, not the one
 * around it. The two differ in the case that matters -- the cursor sitting
 * after a closing paren, which is where one's hands leave it after typing a
 * form -- and there C-x C-e means "that thing I just finished" while C-M-x
 * means "the definition I am inside of".
 *
 * Whitespace and comments between the form and the cursor are skipped, so
 * pressing it at the end of a line after a trailing comment still works.
 * A bare atom counts: `*srate*` alone on a line is a form.
 */
export function precedingForm(
  text: string,
  offset: number
): { start: number; end: number } | undefined {
  const limit = Math.min(offset, text.length);
  let best: { start: number; end: number } | undefined;
  for (const form of formRanges(text)) {
    if (form.end <= limit) best = form;
  }

  // A top-level atom is not in formRanges (which tracks parens), so it is
  // looked for separately -- and only if it lies AFTER the last paren form,
  // otherwise `(+ 1 2)` would yield `2`.
  const searchFrom = best ? best.end : 0;
  const tail = text.slice(searchFrom, limit);
  const withoutTrailing = tail.replace(/(?:\s|;[^\n]*)*$/, '');
  const atom = /([^\s()\[\]'"`,;]+)$/.exec(withoutTrailing);
  if (atom) {
    const start = searchFrom + withoutTrailing.length - atom[1].length;
    return { start, end: searchFrom + withoutTrailing.length };
  }
  return best;
}

/**
 * A new range after zooming by FACTOR around ANCHOR (0..1 of the visible
 * range).  Fractional frames, and deliberately NOT rounded.
 *
 * Straight out of clamps-vscode's buffer view, including the reason it
 * looks like this: the creep does not come from the zoom arithmetic but
 * from feeding a rounded result back into the next call.  Each step lands
 * on a whole frame, the error is small, and it accumulates -- measured
 * there as 479 frames adrift after ten steps in and ten out.  So the view
 * keeps fractional frames and rounds once, at the moment of the request.
 * Nothing rounded ever feeds back.
 */
export function zoomRange(
  start: number,
  dur: number,
  frames: number,
  factor: number,
  anchor: number
): { start: number; dur: number } {
  const minimum = 16;
  const point = start + dur * Math.min(1, Math.max(0, anchor));
  let next = dur / factor;
  next = Math.min(frames, Math.max(minimum, next));
  let nextStart = point - next * anchor;
  nextStart = Math.min(frames - next, Math.max(0, nextStart));
  return { start: nextStart, dur: next };
}

export function panRange(
  start: number,
  dur: number,
  frames: number,
  by: number
): { start: number; dur: number } {
  const nextStart = Math.min(Math.max(0, frames - dur), Math.max(0, start + dur * by));
  return { start: nextStart, dur };
}

/**
 * Which sample a click at fraction X of the visible range means.
 * Rounds, because a cursor position is a sample and not an opinion.
 */
export function sampleAt(start: number, dur: number, x: number): number {
  return Math.max(0, Math.round(start + dur * Math.min(1, Math.max(0, x))));
}

export class BridgeError extends Error {
  constructor(message: string, readonly frame: Frame) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Request/response over a line channel.
 *
 * Knows nothing about child processes: it is handed a write function and
 * fed the incoming text.  That is what makes it testable without Snd,
 * and the reason the tests can drive a whole conversation.
 */
export class Bridge extends EventEmitter {
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();

  /** ms after which a request is given up on. */
  timeout = 30000;

  constructor(private readonly write: (line: string) => void) {
    super();
  }

  /** Feed a stderr chunk. Frames are dispatched, other text is emitted as 'log'. */
  feed(chunk: string): void {
    const { frames, text, rest } = splitFrames(this.buffer + chunk);
    this.buffer = rest;
    if (text) this.emit('log', text);
    for (const payload of frames) {
      const frame = parseFrame(payload);
      if (!frame) {
        this.emit('log', `[snd-vscode] unreadable frame: ${payload.slice(0, 200)}\n`);
        continue;
      }
      this.dispatch(frame);
    }
  }

  private dispatch(frame: Frame): void {
    if (frame.event) {
      this.emit('event', frame);
      return;
    }
    const id = frame.id;
    const pending = id !== undefined ? this.pending.get(id) : undefined;
    if (!pending) {
      // An answer to a request we have already given up on. Not an
      // error, but worth seeing in the log -- it means the timeout is
      // too short for this operation.
      this.emit('orphan', frame);
      return;
    }
    this.pending.delete(id!);
    if (pending.timer) clearTimeout(pending.timer);
    if (frame.stderr) this.emit('log', frame.stderr);
    if (frame.ok === false) {
      pending.reject(new BridgeError(frame.error ?? 'Snd reported an error', frame));
      return;
    }
    pending.resolve(frame.value);
  }

  request<T = unknown>(op: string, params: Record<string, ParamValue> = {}): Promise<T> {
    const id = String(this.nextId++);
    const line = requestLine(id, op, params);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Snd did not answer within ${this.timeout} ms (${op}).`));
      }, this.timeout);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.write(line + '\n');
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** Evaluate Scheme in the running Snd. */
  evaluate(code: string): Promise<{ value: string; output: string }> {
    return this.request<{ value: string; output: string }>('eval', { code });
  }

  rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  get outstanding(): number {
    return this.pending.size;
  }
}
