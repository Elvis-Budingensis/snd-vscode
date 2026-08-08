// envelopeView.ts
//
// Snd's envelope editor, as a panel.
//
// WHAT AN ENVELOPE IS HERE. A list of breakpoints, x then y, alternating:
// `(0 0 1 1 2 0)` is three points. Snd treats x as arbitrary units and
// stretches the whole envelope over whatever range it is applied to, which is
// why the panel shows x as 0..1 — the numbers in between mean nothing on
// their own, only their spacing does.
//
// WHAT THE PANEL DOES NOT DO. Apply the envelope itself, sample by sample.
// Snd's env-channel, env-channel-with-base and env-selection each put ONE
// entry in the edit history; a loop here would put thousands in and make undo
// useless. Same rule as the waveform panel's edit buttons: the drawing is
// here, the editing is in Snd.
//
// THE FILTER RESPONSE IS A DIFFERENT ENVELOPE. Same shape, different meaning:
// x is frequency, y is gain, and setting it is not an edit at all — it is a
// control, like the amp slider. The panel says so rather than letting the
// same-looking curve quietly mean two things.

import * as vscode from 'vscode';

export interface EnvelopeState {
  envelope: number[];
  base: number;
  clip: boolean;
  wave: boolean;
  inDB: boolean;
  power: number;
  filterOrder: number;
  target: EnvelopeTarget;
  style: string;
  named: Array<{ name: string; points: number[] }>;
  filter: number[];
  srate: number;
  frames: number;
  selection: { active: boolean; start: number; frames: number };
  editPosition: number;
}

/**
 * Bill's three buttons, by his own labels.
 *
 * "The envelope can be applied to the amplitude, the spectrum, or the
 * sampling rate. The choice is made via the three buttons marked 'amp',
 * 'flt', and 'src'."
 *
 * These are what the envelope IS, not where it goes — the scope is separate,
 * and that separation is his too: the selection and mix buttons sit apart
 * from the three.
 */
export type EnvelopeTarget = 'amp' | 'flt' | 'src';
export type EnvelopeScope = 'sound' | 'selection' | 'mix';

/**
 * Which combinations Snd actually has.
 *
 *            sound             selection          mix
 *   amp      env-sound         env-selection      mix-amp-env
 *   flt      filter-sound      filter-selection   —
 *   src      src-sound         src-selection      —
 *
 * A mix has an amplitude envelope and no filter or sampling-rate envelope.
 * Refusing by name beats falling back to the sound, which would envelope a
 * whole file when one mix was asked for.
 */
export function isSupported(target: EnvelopeTarget, scope: EnvelopeScope): boolean {
  if (scope === 'mix') return target === 'amp';
  return true;
}

/**
 * Bookkeeping for auditioning.
 *
 * Space applies the envelope and plays it, and one wants to press it twenty
 * times while dragging a point. Twenty presses must not leave twenty entries
 * in the edit history — but they also must not leave NONE, because then
 * "apply" and "audition" would be different code paths and the thing being
 * heard would not be the thing being applied.
 *
 * So: each audition undoes the previous one first, if and only if the
 * previous one is still the top of the edit history. If anything else has
 * been done since — an edit from the REPL, a delete in the waveform panel,
 * an undo by hand — the previous audition is no longer on top, and undoing
 * would remove somebody else's work. In that case the new audition simply
 * stacks, which is the safe direction to be wrong in.
 */
export function shouldUndoPrevious(
  previous: { editPosition: number } | undefined,
  currentEditPosition: number
): boolean {
  if (!previous) return false;
  return previous.editPosition === currentEditPosition;
}

export interface EnvelopeHost {
  envelope(snd: number, chn: number): Promise<EnvelopeState>;
  applyEnvelope(params: {
    snd: number;
    chn: number;
    target: EnvelopeTarget;
    scope: EnvelopeScope;
    base: number;
    order: number;
    mix: number;
    points: string;
  }): Promise<{ applied: boolean; editPosition?: number }>;
  storeEnvelope(points: string, base: number): Promise<void>;
  defineEnvelope(name: string, points: string, base: number): Promise<void>;
  /** Play a range of the channel, so an audition can be heard. */
  play(snd: number, chn: number, start: number, end?: number): Promise<void>;
  stop(): Promise<void>;
  undo(snd: number, chn: number): Promise<void>;
  ready(): boolean;
}

/**
 * Breakpoints to the wire format: plain numbers, space separated.
 *
 * Not JSON and not a Scheme list — the bridge reads these with
 * `string->number` and refuses anything else, so an envelope cannot become a
 * way to send code. Rounded, because a canvas position has about three
 * decimal places of meaning and the rest is noise that makes the stored
 * envelope unreadable in Snd's own editor.
 */
export function pointsToWire(points: Array<{ x: number; y: number }>): string {
  return points
    .map(point => `${round(point.x)} ${round(point.y)}`)
    .join(' ');
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** The bridge's flat list back into points. Odd lengths are refused there. */
export function wireToPoints(values: number[]): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    points.push({ x: values[i], y: values[i + 1] });
  }
  return points;
}

/**
 * Normalise x to 0..1, keeping the SPACING.
 *
 * Snd's envelopes carry arbitrary x units — `(0 0 1 1 2 0)` and
 * `(0 0 0.5 1 1 0)` are the same envelope. The panel draws in 0..1, so an
 * envelope arriving with a different range has to be scaled rather than
 * clipped; clipping would silently turn a three-point envelope into a
 * two-point one and lose the shape it was drawn for.
 */
export function normaliseX(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (points.length === 0) return [];
  const first = points[0].x;
  const last = points[points.length - 1].x;
  const span = last - first;
  if (span <= 0) return points.map((point, index) => ({ x: index === 0 ? 0 : 1, y: point.y }));
  return points.map(point => ({ x: (point.x - first) / span, y: point.y }));
}

/**
 * Keep the points in order and inside the box.
 *
 * The first and last x are pinned: an envelope that does not start at 0 and
 * end at 1 is applied over a shorter span than the one drawn, and the part
 * outside it is left at whatever the last value was — which looks like the
 * envelope having been ignored at the edges.
 */
export function constrain(
  points: Array<{ x: number; y: number }>,
  index: number,
  x: number,
  y: number,
  yRange: { min: number; max: number }
): Array<{ x: number; y: number }> {
  const next = points.map(point => ({ ...point }));
  const clampedY = Math.min(yRange.max, Math.max(yRange.min, y));
  if (index === 0) {
    next[0] = { x: 0, y: clampedY };
  } else if (index === points.length - 1) {
    next[index] = { x: 1, y: clampedY };
  } else {
    const low = next[index - 1].x;
    const high = next[index + 1].x;
    // Strictly between the neighbours: two points at the same x make a
    // vertical jump, which Snd's env generator reads as a division by zero in
    // the segment slope.
    const epsilon = 0.0005;
    next[index] = {
      x: Math.min(high - epsilon, Math.max(low + epsilon, x)),
      y: clampedY,
    };
  }
  return next;
}

export class EnvelopeView {
  private static instance: EnvelopeView | undefined;
  private readonly panel: vscode.WebviewPanel;
  private snd = 0;
  private chn = 0;
  /** The edit position the last audition left behind, if it is still on top. */
  private audition: { editPosition: number } | undefined;

  static show(host: EnvelopeHost, snd = 0, chn = 0): EnvelopeView {
    if (!this.instance) this.instance = new EnvelopeView(host);
    this.instance.snd = snd;
    this.instance.chn = chn;
    this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
    void this.instance.reload();
    return this.instance;
  }

  static refresh(): void {
    // An edit from anywhere else means the audition is no longer on top of
    // the history, and taking it back would remove that other work instead.
    if (this.instance) this.instance.audition = undefined;
    void this.instance?.reload();
  }

  private constructor(private readonly host: EnvelopeHost) {
    this.panel = vscode.window.createWebviewPanel(
      'sndEnvelope',
      'Snd: Envelope',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(message => void this.onMessage(message));
    this.panel.onDidChangeViewState(event => {
      // Envelopes get defined in the REPL, in a file, by loading somebody's
      // funcs.scm — none of which the panel hears about. Re-reading when it
      // comes back into view is what makes a define-envelope typed a minute
      // ago show up in the list at all.
      if (event.webviewPanel.visible) void this.reload();
    });
    this.panel.onDidDispose(() => {
      EnvelopeView.instance = undefined;
    });
  }

  private async onMessage(message: any): Promise<void> {
    try {
      switch (message?.type) {
        case 'ready':
        case 'reload':
          await this.reload();
          break;
        case 'audition': {
          // Apply, play, and remember — so the next press can take this one
          // back rather than piling up.
          const state = await this.host.envelope(this.snd, this.chn);
          if (shouldUndoPrevious(this.audition, state.editPosition)) {
            await this.host.undo(this.snd, this.chn);
          }
          this.audition = undefined;

          const result = await this.host.applyEnvelope({
            snd: this.snd,
            chn: this.chn,
            target: message.target,
            scope: message.scope,
            base: Number(message.base) || 1,
            order: Number(message.order) || 40,
            mix: Number(message.mix) || 0,
            points: message.points,
          });
          if (result.editPosition !== undefined) {
            this.audition = { editPosition: result.editPosition };
          }

          // Play what was actually changed: the selection if that was the
          // scope, otherwise the whole channel. Playing the file after
          // enveloping a selection means waiting through the part that did
          // not change.
          const selection = state.selection;
          const useSelection = message.scope === 'selection' && selection.active;
          await this.host.play(
            this.snd,
            this.chn,
            useSelection ? selection.start : 0,
            useSelection ? selection.start + selection.frames : state.frames
          );
          void this.panel.webview.postMessage({
            type: 'note',
            note: 'auditioning — space again replaces this, "apply" keeps it',
          });
          await this.reload();
          break;
        }
        case 'stop':
          await this.host.stop();
          break;
        case 'apply': {
          const result = await this.host.applyEnvelope({
            snd: this.snd,
            chn: this.chn,
            target: message.target,
            scope: message.scope,
            base: Number(message.base) || 1,
            order: Number(message.order) || 40,
            mix: Number(message.mix) || 0,
            points: message.points,
          });
          // An explicit apply KEEPS what is there: the next audition must not
          // undo it. Forgetting this would make "apply" the one action that
          // can be silently reversed by pressing space afterwards.
          this.audition = undefined;
          void this.panel.webview.postMessage({
            type: 'note',
            note: `applied to the ${message.scope} as ${message.target} — edit position ${result.editPosition}`,
          });
          await this.reload();
          break;
        }
        case 'store':
          await this.host.storeEnvelope(message.points, Number(message.base) || 1);
          void this.panel.webview.postMessage({
            type: 'note',
            note: "stored in Snd's envelope editor, not applied",
          });
          break;
        case 'load': {
          // "To load an existing envelope into the editor, you can also type
          // its name in the text field." Read fresh rather than from the
          // panel's copy: the whole point of typing a name is usually that it
          // was just defined.
          const state = await this.host.envelope(this.snd, this.chn);
          const found = (state.named ?? []).find(entry => entry.name === message.name);
          if (!found) {
            void this.panel.webview.postMessage({
              type: 'error',
              message:
                `no envelope called ${message.name} — define it here, or with ` +
                `(define-envelope ${message.name} '(0 0 1 1)) in the REPL`,
            });
            break;
          }
          void this.panel.webview.postMessage({ type: 'load', points: found.points });
          break;
        }
        case 'define':
          // Bill's "define it": the curve gets a name and joins the list, and
          // becomes usable anywhere an envelope is — define-envelope defines
          // an ordinary variable, which is what his funcs.scm is a hundred
          // lines of.
          await this.host.defineEnvelope(
            message.name,
            message.points,
            Number(message.base) || 1
          );
          void this.panel.webview.postMessage({
            type: 'note',
            note: `defined as ${message.name} — usable anywhere an envelope is`,
          });
          await this.reload();
          break;
      }
    } catch (error) {
      void this.panel.webview.postMessage({
        type: 'error',
        message: String((error as Error).message ?? error),
      });
    }
  }

  private async reload(): Promise<void> {
    if (!this.host.ready()) {
      void this.panel.webview.postMessage({
        type: 'error',
        message: 'No Snd session — run "Snd: Start".',
      });
      return;
    }
    try {
      const state = await this.host.envelope(this.snd, this.chn);
      void this.panel.webview.postMessage({ type: 'state', state });
      this.panel.title = `Snd: Envelope · ${this.snd}.${this.chn}`;
    } catch (error) {
      void this.panel.webview.postMessage({
        type: 'error',
        message: String((error as Error).message ?? error),
      });
    }
  }

  private html(): string {
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         margin: 0; padding: 8px; font-size: 12px; }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
  button { font-family: inherit; font-size: 12px; border: none; padding: 3px 9px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground); }
  button.primary { background: var(--vscode-button-background);
                   color: var(--vscode-button-foreground); }
  /* Bill's dialog uses latched buttons rather than menus, and the state of
     the whole editor is readable at a glance because of it. Worth copying:
     a dropdown hides two of the three choices. */
  button.toggle { opacity: .55; }
  button.toggle.on { opacity: 1; background: var(--vscode-button-background);
                     color: var(--vscode-button-foreground); }
  .group { font-size: 11px; opacity: .6; text-transform: lowercase;
           letter-spacing: .06em; margin-right: 2px; }
  input[type=text] { width: 120px; }
  select, input[type=number] { font-family: inherit; font-size: 12px;
    background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border); padding: 2px 4px; }
  input[type=number] { width: 70px; }
  .error { color: var(--vscode-errorForeground); min-height: 0; }
  .error:not(:empty) { padding: 4px 6px; margin-bottom: 6px;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder); }
  .msg { color: var(--vscode-charts-green); min-height: 16px; }
  canvas { width: 100%; height: 300px; display: block; cursor: crosshair;
           background: var(--vscode-editor-background); }
  .status { opacity: .8; margin-top: 6px; font-family: var(--vscode-editor-font-family);
            font-size: 11px; }
  .hint { opacity: .65; font-size: 11px; }
</style></head><body>
<div class="error" id="error"></div>
<div class="bar">
  <span class="group">apply as</span>
  <button class="toggle" id="t-amp" data-target="amp"
          title="env-sound / env-selection / mix-amp-env">amp</button>
  <button class="toggle" id="t-flt" data-target="flt"
          title="filter-sound / filter-selection — an FIR filter of enved-filter-order taps">flt</button>
  <button class="toggle" id="t-src" data-target="src"
          title="src-sound / src-selection — changes length and pitch together">src</button>
  <span class="group">to</span>
  <button class="toggle" id="s-sound" data-scope="sound">the sound</button>
  <button class="toggle" id="s-selection" data-scope="selection">selection</button>
  <button class="toggle" id="s-mix" data-scope="mix">mix</button>
  <label id="mix-field">mix <input type="number" id="mix" value="0" min="0" step="1"></label>
</div>
<div class="bar">
  <span class="group">shape</span>
  <button class="toggle" id="lin">linear</button>
  <button class="toggle" id="exp">exp</button>
  <label id="base-field">base <input type="number" id="base" value="1" step="0.1" min="0"
         title="Snd's enved-base: 1 is straight segments, larger is exponential"></label>
  <label id="order-field">fir order <input type="number" id="order" value="40" min="2" step="2"
         title="enved-filter-order — increase it to improve the fit"></label>
  <button class="toggle" id="clip" title="clip mouse movement at the y bounds (enved-clip?)">clip</button>
  <button class="toggle" id="wave" title="show the sound behind the envelope (enved-wave?)">wave</button>
</div>
<div class="bar">
  <button class="primary" id="apply">apply</button>
  <button id="audition" title="space — undo the previous audition, apply, and play">undo &amp; apply ▸</button>
  <button id="stop">stop</button>
  <button id="undo" title="the envelope's own history, not Snd's">undo</button>
  <button id="redo">redo</button>
  <button id="reset">reset</button>
  <button id="store">store in Snd's editor</button>
  <button id="reload">reload from Snd</button>
</div>
<div class="bar">
  <label>name <input type="text" id="name" placeholder="ramp"
         title="type a known envelope's name to load it, or a new name and press 'define it'"></label>
  <button id="define">define it</button>
  <select id="named" title="the envelopes defined in this session"></select>
</div>
<canvas id="env"></canvas>
<div class="status" id="status">…</div>
<div class="msg" id="msg"></div>
<div class="hint">
  click to add a point · drag to move · right-click or shift-click to remove ·
  the first and last x are fixed<br>
  <b>space</b>: undo the previous audition, apply, and play · <b>apply</b> keeps it ·
  <b>esc</b>: stop · <b>ctrl+z</b> / <b>ctrl+shift+z</b>: the envelope's own history
</div>
<script>
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('env');
const context = canvas.getContext('2d');
let points = [{ x: 0, y: 1 }, { x: 1, y: 1 }];
let state = null;
let dragging = -1;
let target = 'amp';
let scope = 'sound';
let style = 'linear';
let clip = true;
let wave = false;

// The envelope's OWN history, which is what Bill's Undo and Redo buttons move
// through: "The Undo and Redo buttons can be used to move around in the list
// of envelope edits". Separate from Snd's edit list on purpose — undoing a
// breakpoint one did not mean to add must not undo an edit to the sound.
let history = [JSON.stringify(points)];
let historyAt = 0;

function remember() {
  const now = JSON.stringify(points);
  if (history[historyAt] === now) return;
  history = history.slice(0, historyAt + 1);
  history.push(now);
  historyAt = history.length - 1;
}

function goBack(by) {
  const at = historyAt + by;
  if (at < 0 || at >= history.length) return;
  historyAt = at;
  points = JSON.parse(history[at]);
  draw();
}

function css(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name);
  return (value && value.trim()) || fallback;
}

// The y range depends on what the envelope MEANS. An amplitude envelope can
// exceed 1 (it is a multiplier); a filter response is a gain between 0 and 1.
// Drawing both on the same axis would make a filter curve look like it had
// headroom it does not have.
function yRange() {
  // A filter response is a gain between 0 and 1; an amplitude envelope is a
  // multiplier and may exceed 1; an src envelope is a speed ratio, where 1 is
  // unchanged and 2 is an octave up. Three meanings, three scales — drawing
  // them on one axis would make a filter curve look as if it had headroom.
  if (target === 'flt') return { min: 0, max: 1 };
  if (target === 'src') return { min: 0, max: 4 };
  return { min: 0, max: 2 };
}

function toCanvas(point, width, height) {
  const range = yRange();
  return {
    x: point.x * width,
    y: height - ((point.y - range.min) / (range.max - range.min)) * height,
  };
}

function fromCanvas(cx, cy, width, height) {
  const range = yRange();
  return {
    x: Math.min(1, Math.max(0, cx / width)),
    y: range.min + (1 - cy / height) * (range.max - range.min),
  };
}

function draw() {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  canvas.width = width * ratio; canvas.height = height * ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const range = yRange();
  // Unity, where an amplitude envelope changes nothing. Worth a line of its
  // own: without it there is no way to see whether a segment is boosting or
  // cutting.
  context.strokeStyle = css('--vscode-panel-border', '#555');
  context.setLineDash([3, 3]);
  for (const level of [1, 0.5]) {
    if (level < range.min || level > range.max) continue;
    const y = toCanvas({ x: 0, y: level }, width, height).y;
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }
  context.setLineDash([]);

  if (state && target === 'selection' && state.selection && state.selection.active &&
      state.frames > 0) {
    const from = state.selection.start / state.frames * width;
    const to = (state.selection.start + state.selection.frames) / state.frames * width;
    context.fillStyle = css('--vscode-editor-selectionBackground', '#264f78');
    context.globalAlpha = 0.35;
    context.fillRect(from, 0, to - from, height);
    context.globalAlpha = 1;
  }

  // The base only shapes the segments when the style is exponential, which is
  // Bill's linear/exp pair: with 'linear' selected the number is inert, and
  // showing its effect anyway would be a lie about what apply will do.
  const base = style === 'exponential'
    ? (Number(document.getElementById('base').value) || 1)
    : 1;
  context.strokeStyle = css('--vscode-charts-blue', '#4fc1ff');
  context.lineWidth = 2;
  context.beginPath();
  for (let i = 0; i < points.length; i++) {
    const from = toCanvas(points[i], width, height);
    if (i === 0) { context.moveTo(from.x, from.y); continue; }
    if (base === 1) {
      context.lineTo(from.x, from.y);
    } else {
      // Snd's exponential segments, drawn the way they will sound. A base of
      // 32 and a base of 1 are very different envelopes and identical
      // straight lines, so drawing segments straight regardless would make
      // the base a number with no visible effect until after applying.
      const previous = points[i - 1];
      const steps = 24;
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const shaped = (Math.pow(base, t) - 1) / (base - 1);
        const value = previous.y + (points[i].y - previous.y) * shaped;
        const at = toCanvas({ x: previous.x + (points[i].x - previous.x) * t, y: value },
                            width, height);
        context.lineTo(at.x, at.y);
      }
    }
  }
  context.stroke();
  context.lineWidth = 1;

  context.fillStyle = css('--vscode-charts-blue', '#4fc1ff');
  for (const point of points) {
    const at = toCanvas(point, width, height);
    context.beginPath(); context.arc(at.x, at.y, 4, 0, Math.PI * 2); context.fill();
  }

  const seconds = state && state.srate ? (state.frames / state.srate) : 0;
  const nyquist = state ? state.srate / 2 : 0;
  const order = document.getElementById('order').value;
  // "the X axis goes from 0 Hz to half the sampling rate, labelled as 1.0"
  const axis =
    target === 'flt'
      ? 'x: 0–' + Math.round(nyquist) + ' Hz (labelled 0–1), y: gain · fir order ' + order
      : target === 'src'
        ? 'x: 0–' + seconds.toFixed(2) + ' s, y: speed (1 = unchanged)'
        : 'x: 0–' + seconds.toFixed(2) + ' s, y: amplitude';
  document.getElementById('status').textContent =
    points.length + ' points · ' + axis +
    (state ? ' · ' + (state.named || []).length + ' named' : '') +
    (style === 'exponential' && base !== 1 ? ' · base ' + base : '') +
    ' · ' + scope +
    (state ? ' · edit ' + state.editPosition : '');
}

function nearest(cx, cy, width, height) {
  let best = -1, distance = 12;
  for (let i = 0; i < points.length; i++) {
    const at = toCanvas(points[i], width, height);
    const d = Math.hypot(at.x - cx, at.y - cy);
    if (d < distance) { distance = d; best = i; }
  }
  return best;
}

function place(event) {
  const box = canvas.getBoundingClientRect();
  return { cx: event.clientX - box.left, cy: event.clientY - box.top,
           width: box.width, height: box.height };
}

canvas.addEventListener('mousedown', event => {
  const { cx, cy, width, height } = place(event);
  const hit = nearest(cx, cy, width, height);
  if (event.button === 2 || event.shiftKey) {
    // Never below two points: an envelope with one breakpoint has no
    // segment, and Snd rejects it — better to refuse the removal than to
    // send something that fails on apply.
    if (hit > -1 && points.length > 2) { points.splice(hit, 1); remember(); draw(); }
    return;
  }
  if (hit > -1) { dragging = hit; return; }
  const at = fromCanvas(cx, cy, width, height);
  let index = points.findIndex(point => point.x > at.x);
  if (index < 0) index = points.length - 1;
  points.splice(index, 0, at);
  dragging = index;
  draw();
});

canvas.addEventListener('mousemove', event => {
  if (dragging < 0) return;
  const { cx, cy, width, height } = place(event);
  const at = fromCanvas(cx, cy, width, height);
  const range = yRange();
  // Bill's 'clip' button: "whether to clip mouse movement at the current y
  // axis bounds". With it off the value follows the mouse past the axis,
  // which is how one draws an envelope that goes above the visible range.
  const clampedY = clip
    ? Math.min(range.max, Math.max(range.min, at.y))
    : at.y;
  if (dragging === 0) points[0] = { x: 0, y: clampedY };
  else if (dragging === points.length - 1) points[dragging] = { x: 1, y: clampedY };
  else {
    const epsilon = 0.0005;
    points[dragging] = {
      x: Math.min(points[dragging + 1].x - epsilon,
                  Math.max(points[dragging - 1].x + epsilon, at.x)),
      y: clampedY,
    };
  }
  draw();
});

window.addEventListener('mouseup', () => {
  if (dragging >= 0) remember();
  dragging = -1;
});
canvas.addEventListener('contextmenu', event => event.preventDefault());

function wire() {
  return points.map(p => (Math.round(p.x * 10000) / 10000) + ' ' +
                          (Math.round(p.y * 10000) / 10000)).join(' ');
}

function settings(type) {
  return {
    type,
    target,
    scope,
    base: style === 'exponential' ? document.getElementById('base').value : 1,
    order: document.getElementById('order').value,
    mix: document.getElementById('mix').value,
    points: wire(),
  };
}

function audition() {
  vscode.postMessage(settings('audition'));
}

// Space, and not only the button: the point of auditioning is to keep the
// hand on the curve. Ignored while a number field has focus, or typing 1.5
// into "base" would play the sound on the space between the digits.
window.addEventListener('keydown', event => {
  const tag = (event.target && event.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (event.code === 'Space') {
    event.preventDefault();
    audition();
  } else if (event.key === 'Escape') {
    vscode.postMessage({ type: 'stop' });
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    // The ENVELOPE's history, not Snd's — undoing a breakpoint one did not
    // mean to add must not undo an edit to the sound.
    event.preventDefault();
    goBack(event.shiftKey ? 1 : -1);
  }
});

document.getElementById('audition').onclick = audition;
document.getElementById('stop').onclick = () => vscode.postMessage({ type: 'stop' });
document.getElementById('apply').onclick = () => vscode.postMessage(settings('apply'));
document.getElementById('store').onclick = () =>
  vscode.postMessage({ type: 'store',
                       base: document.getElementById('base').value, points: wire() });
document.getElementById('reload').onclick = () => vscode.postMessage({ type: 'reload' });
document.getElementById('reset').onclick = () => {
  points = target === 'filter' ? [{ x: 0, y: 1 }, { x: 1, y: 1 }]
                               : [{ x: 0, y: 1 }, { x: 1, y: 1 }];
  draw();
};
function latch(id, on) {
  document.getElementById(id).classList.toggle('on', on);
}

function refreshButtons() {
  for (const name of ['amp', 'flt', 'src']) latch('t-' + name, target === name);
  for (const name of ['sound', 'selection', 'mix']) latch('s-' + name, scope === name);
  latch('lin', style === 'linear');
  latch('exp', style === 'exponential');
  latch('clip', clip);
  latch('wave', wave);
  document.getElementById('mix-field').style.display = scope === 'mix' ? '' : 'none';
  document.getElementById('order-field').style.display = target === 'flt' ? '' : 'none';
  document.getElementById('base-field').style.display =
    style === 'exponential' ? '' : 'none';
  // The combinations Snd does not have are disabled rather than hidden: a
  // missing button looks like a missing feature, a greyed one says "not this
  // combination". A mix has an amplitude envelope and nothing else.
  for (const name of ['flt', 'src']) {
    const button = document.getElementById('t-' + name);
    const impossible = scope === 'mix';
    button.disabled = impossible;
    button.title = impossible
      ? 'a mix has an amplitude envelope only'
      : button.getAttribute('data-title') || button.title;
  }
}

for (const name of ['amp', 'flt', 'src']) {
  document.getElementById('t-' + name).onclick = () => {
    target = name;
    const range = yRange();
    points = points.map(p => ({ x: p.x, y: Math.min(range.max, Math.max(range.min, p.y)) }));
    remember();
    refreshButtons();
    draw();
  };
}
for (const name of ['sound', 'selection', 'mix']) {
  document.getElementById('s-' + name).onclick = () => {
    scope = name;
    if (scope === 'mix' && target !== 'amp') target = 'amp';
    refreshButtons();
    draw();
  };
}
document.getElementById('lin').onclick = () => { style = 'linear'; refreshButtons(); draw(); };
document.getElementById('exp').onclick = () => {
  style = 'exponential'; refreshButtons(); draw();
};
document.getElementById('clip').onclick = () => { clip = !clip; refreshButtons(); };
document.getElementById('wave').onclick = () => { wave = !wave; refreshButtons(); draw(); };
document.getElementById('undo').onclick = () => goBack(-1);
document.getElementById('redo').onclick = () => goBack(1);
document.getElementById('order').onchange = draw;
document.getElementById('define').onclick = () => {
  const name = document.getElementById('name').value.trim();
  if (!name) return;
  vscode.postMessage({ type: 'define', name,
                       base: document.getElementById('base').value, points: wire() });
};
function adopt(raw) {
  // Snd's envelopes carry arbitrary x units, so the incoming curve is scaled
  // to 0..1 rather than clipped -- (0 0 1 1 2 0) and (0 0 0.5 1 1 0) are the
  // same envelope and must arrive as the same drawing.
  const pairs = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push({ x: raw[i], y: raw[i + 1] });
  if (pairs.length < 2) return;
  const first = pairs[0].x, span = pairs[pairs.length - 1].x - pairs[0].x;
  points = span > 0 ? pairs.map(p => ({ x: (p.x - first) / span, y: p.y })) : pairs;
  remember();
  draw();
}

// "To load an existing envelope into the editor, you can also type its name
// in the text field." Enter loads; the same field then names the curve for
// 'define it', which is Bill's double duty for it.
document.getElementById('name').addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const name = event.target.value.trim();
  if (name) vscode.postMessage({ type: 'load', name });
});

// Re-read when the list is OPENED, not only when something else happened to
// refresh the panel. The list is a snapshot of the session's variables, and
// the session changes underneath it — a define-envelope in the REPL, a
// loaded file, another editor. Making the snapshot at the moment of looking
// removes timing from the question entirely.
document.getElementById('named').addEventListener('mousedown', () => {
  vscode.postMessage({ type: 'reload' });
});

document.getElementById('named').onchange = event => {
  // "click its name in the scrolled list on the left to select it ... to load
  // it into the editor portion, clearing out whatever was previously there."
  const chosen = (state.named || []).find(entry => entry.name === event.target.value);
  if (!chosen) return;
  document.getElementById('name').value = chosen.name;
  adopt(chosen.points);
};
document.getElementById('base').onchange = draw;
// The target dropdown this used to wire up is gone — Bill's dialog has three
// latched buttons instead, handled above. The leftover line reached for an
// element that no longer exists, threw on the first property set, and stopped
// the whole script: no curve, no status line, nothing. A panel that draws
// nothing looks like a panel with nothing to draw.

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'state') {
    state = message.state;
    document.getElementById('error').textContent = '';
    const source = state.envelope;
    if (source && source.length >= 4) {
      const raw = [];
      for (let i = 0; i + 1 < source.length; i += 2) raw.push({ x: source[i], y: source[i + 1] });
      // x is normalised, not clipped: Snd's envelopes carry arbitrary x units,
      // so (0 0 1 1 2 0) and (0 0 0.5 1 1 0) are the same envelope and both
      // must arrive as the same drawing.
      const first = raw[0].x, span = raw[raw.length - 1].x - raw[0].x;
      points = span > 0 ? raw.map(p => ({ x: (p.x - first) / span, y: p.y })) : raw;
    }
    document.getElementById('base').value = String(state.base ?? 1);
    document.getElementById('order').value = String(state.filterOrder ?? 40);
    if (state.target) target = state.target;
    if (state.style) style = state.style;
    clip = !!state.clip;
    wave = !!state.wave;
    const list = document.getElementById('named');
    list.innerHTML = '';
    const blank = document.createElement('option');
    // The count, in the status line as well as the list: "(1 envelopes)" in
    // the dropdown was the only sign that the scan had found less than
    // expected, and it is easy to read as a label rather than as data.
    const found = (state.named || []).length;
    blank.value = '';
    blank.textContent = found === 0 ? '(no named envelopes)' : '(' + found + ' envelopes)';
    list.appendChild(blank);
    for (const entry of (state.named || [])) {
      const option = document.createElement('option');
      option.value = entry.name; option.textContent = entry.name;
      list.appendChild(option);
    }
    refreshButtons();
    draw();
  } else if (message.type === 'load') {
    document.getElementById('error').textContent = '';
    adopt(message.points);
  } else if (message.type === 'error') {
    document.getElementById('error').textContent = message.message;
  } else if (message.type === 'note') {
    const box = document.getElementById('msg');
    box.textContent = message.note;
    setTimeout(() => { if (box.textContent === message.note) box.textContent = ''; }, 4000);
  }
});

// A JavaScript error in a webview goes to a console nobody has open, and the
// panel simply stops redrawing -- which reads as "the envelope is not shown".
// Reporting it costs four lines and saves an evening.
window.addEventListener('error', event => {
  const box = document.getElementById('error');
  if (box) box.textContent = 'panel error: ' + event.message;
});

window.addEventListener('resize', draw);
vscode.postMessage({ type: 'ready' });
draw();
</script></body></html>`;
  }
}
