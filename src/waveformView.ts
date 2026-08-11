// waveformView.ts
//
// Snd's channel graph, in a VS Code panel.
//
// This is the part that is NOT a port of anything.  inf-snd.el sends text
// to Snd and shows what comes back; the picture stays in Snd's own X
// window.  Here the picture is drawn in the editor, from numbers the
// bridge reduces on the Snd side.  Which means it works in a nogui build,
// over ssh, and next to the file being edited -- three things Snd's Motif
// window cannot do.
//
// It is a VIEW, not a second editor.  Every edit still happens in Snd,
// through Scheme; this panel sets the cursor, the selection and the
// visible range, and asks for a redraw.  The temptation to implement
// "delete selection" here, in JavaScript, with a local undo stack, would
// buy a second edit history that disagrees with Snd's -- and Snd's is the
// real one, since it is the one that gets saved.

import * as vscode from 'vscode';
import { panRange, sampleAt, zoomRange } from './bridge';

export interface ChannelWaveform {
  chn: number;
  frames: number;
  columns: number;
  /** How much of the shared range this channel covers, 0..1. */
  coverage: number;
  mins: number[];
  maxs: number[];
  rms: number[];
  peak: number;
  clipped: number;
  cursor: number;
  editPosition: number;
  marks: Array<{ id: number; sample: number; name: string }>;
  selection: { active: boolean; start: number; frames: number };
}

/**
 * All requested channels of a sound over ONE time range.
 *
 * The shared range is what makes this different from a stack of separate
 * waveforms, and it is decided in Snd rather than here — see the `waveforms`
 * op. Coupled axes are the entire reason for looking at channels together:
 * a picture where the lanes show slightly different windows of time invents
 * phase differences that are not in the recording.
 */
export interface Waveform {
  snd: number;
  fileName: string;
  srate: number;
  frames: number;
  start: number;
  dur: number;
  columns: number;
  channelStyle: number;
  channels: ChannelWaveform[];
}

export interface WaveformHost {
  /** For the sound selector in the panel. */
  sounds(): Promise<Array<{ index: number; shortName: string; frames: number; channels: number }>>;
  waveform(params: {
    snd: number;
    chns: string;
    start: number;
    dur: number;
    columns: number;
  }): Promise<Waveform>;
  setCursor(snd: number, chn: number, sample: number): Promise<void>;
  setSelection(snd: number, chn: number, start: number, frames: number): Promise<void>;
  play(snd: number, chn: number, start: number, end?: number): Promise<void>;
  stop(): Promise<void>;
  undo(snd: number, chn: number): Promise<void>;
  redo(snd: number, chn: number): Promise<void>;
  /**
   * An edit, by NAME.
   *
   * The panel says "delete"; the bridge decides what that is. The
   * alternative -- the panel sending `(delete-selection)` -- would make
   * every button a channel for arbitrary Scheme, and would put the
   * knowledge of which Snd function does what on the side that cannot
   * check whether this build has it.
   */
  edit(action: string, snd: number, chn: number): Promise<void>;
  /** One of Snd's keyboard commands, by name. */
  key(action: string, snd: number, chn: number, count: number): Promise<void>;
}

/**
 * Snd's keyboard, from snd.html.
 *
 * "Editing in Snd is modelled after Emacs in many regards ... Where an
 * operation has an obvious analog in text editing, I've tried to use the
 * associated Emacs command."
 *
 * The chords are Bill's, and the point of keeping them exactly is that a Snd
 * user's hands already know them. Ctrl is used rather than VS Code's own
 * chords because these run inside the panel, where nothing else claims them.
 */
export const KEY_COMMANDS: Array<{ key: string; action: string; what: string }> = [
  { key: 'a', action: 'start', what: 'to the window start' },
  { key: 'e', action: 'end', what: 'to the window end' },
  { key: 'f', action: 'forward', what: 'forward' },
  { key: 'b', action: 'backward', what: 'back' },
  { key: 'n', action: 'down', what: "ahead one 'line' (128 samples)" },
  { key: 'p', action: 'up', what: "back one 'line'" },
  { key: 'j', action: 'next-mark', what: 'to the next mark' },
  { key: 'd', action: 'delete-sample', what: 'delete the sample at the cursor' },
  { key: 'h', action: 'delete-previous', what: 'delete the previous sample' },
  { key: 'k', action: 'delete-line', what: "delete a 'line'" },
  { key: 'o', action: 'insert-zero', what: 'insert a zero sample' },
  { key: 'z', action: 'zero-sample', what: 'set the sample to zero' },
  { key: 'm', action: 'mark', what: 'place a mark' },
  { key: 'y', action: 'paste', what: 'paste the selection at the cursor' },
  { key: 'w', action: 'delete-selection', what: 'delete the selection' },
];

export class WaveformView {
  private static instance: WaveformView | undefined;

  private readonly panel: vscode.WebviewPanel;

  // Fractional frames, and rounded only when a request goes out. See
  // zoomRange in bridge.ts for why that matters.
  private start = 0;
  private dur = 0;
  private snd = 0;
  /** The user chose this sound, so do not follow new ones. */
  private pinned = false;
  /** Which channel the edit commands and the spectrum follow. */
  private chn = 0;
  /** Empty means every channel of the sound. */
  private chns = '';
  private frames = 0;
  private columns = 900;
  /** separate = a lane each; superimposed = one lane, overlaid. */
  private layout: 'separate' | 'superimposed' = 'separate';
  private inFlight = false;
  private again = false;

  static show(host: WaveformHost, snd = 0, chn = 0): WaveformView {
    if (!this.instance) {
      this.instance = new WaveformView(host);
    }
    this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
    void this.instance.focusOn(snd, chn);
    return this.instance;
  }

  /** After an edit in Snd: same range, new numbers. */
  static refresh(): void {
    void this.instance?.reload();
  }

  /**
   * Where playback has got to.
   *
   * Posted straight to the webview WITHOUT reloading the waveform: a
   * position event arrives every cursor-update-interval, and refetching the
   * picture that often would put a reduction of the whole visible range on
   * the audio path twenty times a second. The samples have not changed; only
   * the playhead has.
   */
  static playhead(frame: number | undefined): void {
    void this.instance?.panel.webview.postMessage({ type: 'playhead', frame });
  }

  /**
   * A play started or ended, from start-playing-hook and stop-playing-hook.
   *
   * Separate from playhead(): a running play with no position yet is not the
   * same as no play, and the panel should not have to infer the difference
   * from the absence of updates -- which is exactly what it used to do.
   */
  /**
   * A new sound appeared; show it unless the user picked this one.
   *
   * Synthesising something and having the panel keep showing the previous
   * sound is the common case and reads as the panel being broken: `with-sound`
   * makes a new sound, and "show me what I just made" is the only reasonable
   * expectation. But once someone has chosen a sound from the list, following
   * would take it away from them, so the choice pins the panel.
   */
  static follow(snd: number): void {
    const panel = this.instance;
    if (!panel || panel.pinned) return;
    panel.snd = snd;
    panel.chn = 0;
    panel.chns = '';
    panel.start = 0;
    panel.dur = 0;
    void panel.reload();
  }

  static playing(running: boolean): void {
    void this.instance?.panel.webview.postMessage({ type: 'playing', running });
  }

  static isOpen(): boolean {
    return !!this.instance;
  }

  private constructor(private readonly host: WaveformHost) {
    this.panel = vscode.window.createWebviewPanel(
      'sndWaveform',
      'Snd: Waveform',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(message => this.onMessage(message));
    this.panel.onDidDispose(() => {
      WaveformView.instance = undefined;
    });
  }

  private async focusOn(snd: number, chn: number): Promise<void> {
    if (snd !== this.snd) {
      this.snd = snd;
      // A new sound means a new time range; keeping the old one would show
      // a window that has nothing to do with this file.
      this.start = 0;
      this.dur = 0; // 0 means "everything", resolved by the bridge
      this.chns = '';
    }
    this.chn = chn;
    await this.reload();
  }

  private async onMessage(message: any): Promise<void> {
    switch (message?.type) {
      case 'ready':
        await this.reload();
        break;
      case 'columns':
        // The panel reports its own width. Asking for more columns than
        // pixels would transfer numbers that get averaged away again.
        this.columns = Math.max(80, Math.min(4096, Math.round(message.columns)));
        await this.reload();
        break;
      case 'zoom': {
        const next = zoomRange(this.start, this.dur, this.frames, message.factor, message.anchor);
        this.start = next.start;
        this.dur = next.dur;
        await this.reload();
        break;
      }
      case 'pan': {
        const next = panRange(this.start, this.dur, this.frames, message.by);
        this.start = next.start;
        this.dur = next.dur;
        await this.reload();
        break;
      }
      case 'all':
        this.start = 0;
        this.dur = this.frames;
        await this.reload();
        break;
      case 'cursor':
        // The lane that was clicked becomes the focused channel: the edit
        // buttons and the spectrum panel follow it. Clicking a lane and
        // having the previous one stay selected is the kind of thing that
        // gets noticed only after an edit landed in the wrong channel.
        if (typeof message.chn === 'number') this.chn = message.chn;
        await this.host.setCursor(this.snd, this.chn, sampleAt(this.start, this.dur, message.x));
        await this.reload();
        break;
      case 'sound':
        // The user chose a sound, so stop following new ones. Switching away
        // from a sound somebody deliberately picked is worse than not
        // following at all.
        this.pinned = true;
        this.snd = Number(message.snd) || 0;
        this.chn = 0;
        this.chns = '';
        this.start = 0;
        this.dur = 0;
        await this.reload();
        break;
      case 'layout':
        this.layout = message.layout === 'superimposed' ? 'superimposed' : 'separate';
        await this.reload();
        break;
      case 'focus':
        this.chn = Number(message.chn) || 0;
        await this.reload();
        break;
      case 'select': {
        if (typeof message.chn === 'number') this.chn = message.chn;
        const from = sampleAt(this.start, this.dur, Math.min(message.from, message.to));
        const to = sampleAt(this.start, this.dur, Math.max(message.from, message.to));
        await this.host.setSelection(this.snd, this.chn, from, Math.max(0, to - from));
        await this.reload();
        break;
      }
      case 'play':
        // The webview sends selStart/selFrames when the focused channel has
        // an active selection; that takes priority over the visible view so
        // "play view" actually plays what is highlighted, not just what is
        // on screen.
        if (typeof message.selStart === 'number' && typeof message.selFrames === 'number') {
          await this.host.play(
            this.snd,
            this.chn,
            Math.round(message.selStart),
            Math.round(message.selStart + message.selFrames)
          );
        } else {
          await this.host.play(
            this.snd,
            this.chn,
            Math.round(this.start),
            Math.round(this.start + this.dur)
          );
        }
        break;
      case 'stop':
        await this.host.stop();
        break;
      case 'undo':
        await this.host.undo(this.snd, this.chn);
        // The reload is the whole point. Snd DID the undo; without refetching,
        // the panel keeps showing the old picture and the button looks broken
        // — the one failure mode that reads as "the feature does not work"
        // while the feature works.
        await this.reload();
        break;
      case 'redo':
        await this.host.redo(this.snd, this.chn);
        await this.reload();
        break;
      case 'key':
        await this.host.key(message.action, this.snd, this.chn, Number(message.count) || 1);
        await this.reload();
        break;
      case 'edit':
        // Edits go to Snd, always. Snd's edit history is the one that gets
        // saved, so a local implementation here would be a second history
        // that disagrees with the real one.
        await this.host.edit(message.action, this.snd, this.chn);
        await this.reload();
        break;
      case 'refresh':
        await this.reload();
        break;
    }
  }

  /**
   * Fetch and draw.
   *
   * Coalesces: while a request is out, a further one only sets a flag.
   * Dragging a selection produces one message per mouse move, and without
   * this a hundred waveform requests queue up behind a hundred reductions
   * over the same samples -- Snd falls behind, and the picture that
   * finally arrives is from the middle of the drag.
   */
  private async reload(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return;
    }
    this.inFlight = true;
    try {
      const waveform = await this.host.waveform({
        snd: this.snd,
        chns: this.chns,
        start: Math.round(this.start),
        dur: Math.round(this.dur),
        columns: this.columns,
      });
      this.frames = waveform.frames;
      this.start = waveform.start;
      this.dur = waveform.dur;
      // The list of open sounds travels with the picture, so the selector
      // cannot show a sound that has since been closed.
      let sounds: Array<{ index: number; shortName: string; frames: number }> = [];
      try {
        sounds = await this.host.sounds();
      } catch {
        sounds = [];
      }
      void this.panel.webview.postMessage({
        type: 'waveform',
        waveform,
        layout: this.layout,
        focused: this.chn,
        sounds,
      });
      const channels = waveform.channels.length;
      this.panel.title =
        `Snd: ${waveform.fileName} · ${channels} ch · ` +
        `${(waveform.frames / Math.max(1, waveform.srate)).toFixed(2)} s`;
    } catch (error) {
      void this.panel.webview.postMessage({
        type: 'error',
        message: String((error as Error).message ?? error),
      });
    } finally {
      this.inFlight = false;
      if (this.again) {
        this.again = false;
        await this.reload();
      }
    }
  }

  private html(): string {
    // The key table is interpolated from KEY_COMMANDS rather than written out
    // twice. It was written out twice for about ten minutes, and a
    // build-time regex silently dropped the three entries whose description
    // contains an apostrophe — three keys that would have done nothing, with
    // nothing to notice.
    const keys = JSON.stringify(KEY_COMMANDS);
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         margin: 0; padding: 8px; }
  .bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
         margin-bottom: 6px; font-size: 12px; }
  button { font-family: inherit; font-size: 12px;
           background: var(--vscode-button-secondaryBackground);
           color: var(--vscode-button-secondaryForeground);
           border: none; padding: 3px 8px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  select { font-family: inherit; font-size: 12px;
           background: var(--vscode-dropdown-background);
           color: var(--vscode-dropdown-foreground);
           border: 1px solid var(--vscode-dropdown-border); padding: 2px 4px; }
  canvas { width: 100%; height: 360px; display: block; cursor: crosshair;
           background: var(--vscode-editor-background); }
  .group { font-size: 11px; opacity: .6; text-transform: lowercase;
           letter-spacing: .06em; margin-right: 2px; }
  .hint { opacity: .65; font-size: 11px; margin-top: 4px; }
  .status { font-size: 11px; opacity: .8; margin-top: 6px;
            font-family: var(--vscode-editor-font-family); }
  /* Above the canvas, not below it. A failed request used to render its
     message at the bottom of a tall page, so a selection that could not be
     made looked like a drag that did nothing at all — and the search went to
     the mouse handling instead of to the error that was already on screen,
     just below the fold. */
  .error { color: var(--vscode-errorForeground); font-size: 12px;
           min-height: 0; margin-bottom: 4px; }
  .error:not(:empty) { padding: 4px 6px; margin-bottom: 6px;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder); }
</style></head><body>
<div class="bar">
  <button id="all">whole file</button>
  <button id="in">zoom in</button>
  <button id="out">zoom out</button>
  <button id="left">◀</button>
  <button id="right">▶</button>
  <button id="play">play view</button>
  <button id="stop">stop</button>
  <button id="undo">undo</button>
  <button id="redo">redo</button>
  <button id="refresh">reload</button>
  <select id="sound" title="which open sound this panel shows"></select>
  <select id="focus" title="which channel the edits and the spectrum follow"></select>
  <select id="layout" title="Snd's channel-style, for this panel">
    <option value="separate">separate lanes</option>
    <option value="superimposed">superimposed</option>
  </select>
</div>
<div class="bar">
  <span class="group">edit</span>
  <button id="e-delete" title="delete-selection">delete selection</button>
  <button id="e-delete-smooth" title="delete-selection-and-smooth">delete + smooth</button>
  <button id="e-insert" title="insert-selection: at the cursor">insert at cursor</button>
  <button id="e-mix" title="mix-selection: at the cursor">mix at cursor</button>
  <button id="e-reverse" title="reverse-selection">reverse</button>
  <button id="e-smooth" title="smooth-selection">smooth</button>
  <button id="e-select-all" title="select-all">select all</button>
  <button id="e-unselect-all" title="unselect-all">unselect</button>
</div>
<div class="error" id="error"></div>
<canvas id="wave"></canvas>
<div class="status" id="status">…</div>
<div class="hint" id="keys"></div>
<script>
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('wave');
const context = canvas.getContext('2d');
let current = null;
let drag = null;
let layout = 'separate';
let focusedChannel = 0;
let playhead = undefined;
// Whether a play is running at all, which is not the same as knowing where it
// has got to: stop-playing-hook says the first, play-hook the second.
let running = false;

function css(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name);
  return (value && value.trim()) || fallback;
}

// One shared x-axis, N lanes.
//
// The lane geometry is worked out once and reused by the hit testing below,
// so a click lands in the lane it looks like it landed in. Two separate
// computations of the same layout is how a click ends up one lane off --
// which, on a multichannel file, means editing the wrong channel.
function lanes(height, count) {
  if (layout === 'superimposed' || count <= 1) {
    return [{ top: 0, height: height, channels: 'all' }];
  }
  const gap = 6;
  const each = (height - gap * (count - 1)) / count;
  const out = [];
  for (let i = 0; i < count; i++) out.push({ top: i * (each + gap), height: each });
  return out;
}

function laneAt(y, height, count) {
  const geometry = lanes(height, count);
  if (geometry.length === 1 && geometry[0].channels === 'all') return -1;
  for (let i = 0; i < geometry.length; i++) {
    if (y >= geometry[i].top && y <= geometry[i].top + geometry[i].height) return i;
  }
  return Math.max(0, Math.min(count - 1, Math.floor(y / (height / count))));
}

function channelColour(index, count) {
  if (count <= 1) return css('--vscode-charts-blue', '#4fc1ff');
  const palette = ['--vscode-charts-blue', '--vscode-charts-green', '--vscode-charts-orange',
                   '--vscode-charts-purple', '--vscode-charts-red', '--vscode-charts-yellow'];
  return css(palette[index % palette.length], '#4fc1ff');
}

function drawChannel(channel, index, count, box, width, w) {
  const middle = box.top + box.height / 2;
  const scale = (box.height / 2) * (layout === 'superimposed' ? 0.9 : 0.94);
  const columns = channel.columns;
  if (columns <= 0) {
    // Said loudly, and centred. An empty sound is the normal state right
    // after (new-sound), and a panel that merely draws nothing in that case
    // is indistinguishable from a panel that is broken -- which is exactly
    // how it read the first time.
    context.strokeStyle = css('--vscode-panel-border', '#555');
    context.setLineDash([4, 4]);
    context.beginPath(); context.moveTo(0, middle); context.lineTo(width, middle);
    context.stroke(); context.setLineDash([]);
    context.fillStyle = css('--vscode-descriptionForeground', '#888');
    context.font = '12px var(--vscode-font-family)';
    context.textAlign = 'center';
    context.fillText(
      channel.frames === 0
        ? 'channel ' + channel.chn + ' is empty — 0 samples'
        : 'channel ' + channel.chn + ': nothing in this part of the file',
      width / 2, middle - 6);
    context.font = '10px var(--vscode-font-family)';
    context.fillText(
      channel.frames === 0
        ? '(new-sound) makes an empty sound; fill it, or pick another above'
        : 'try "whole file"',
      width / 2, middle + 12);
    context.textAlign = 'left';
    return;
  }

  // Drawn to its TRUE width. A channel shorter than the others -- which is
  // the normal case as soon as one has been edited -- ends where it ends,
  // rather than being stretched to fill the lane and quietly implying it is
  // as long as its neighbours.
  const laneWidth = width * (channel.coverage > 0 ? channel.coverage : 1);
  const step = laneWidth / columns;

  if (channel.selection && channel.selection.active && w.dur > 0) {
    const from = (channel.selection.start - w.start) / w.dur * width;
    const to = (channel.selection.start + channel.selection.frames - w.start) / w.dur * width;
    context.fillStyle = css('--vscode-editor-selectionBackground', '#264f78');
    context.globalAlpha = 0.5;
    context.fillRect(Math.max(0, from), box.top,
                     Math.min(width, to) - Math.max(0, from), box.height);
    context.globalAlpha = 1;
  }

  context.strokeStyle = css('--vscode-panel-border', '#555');
  context.beginPath(); context.moveTo(0, middle); context.lineTo(width, middle); context.stroke();

  const colour = channelColour(index, count);
  const focused = channel.chn === focusedChannel;
  context.globalAlpha = layout === 'superimposed' ? 0.65 : (focused || count === 1 ? 1 : 0.75);
  context.fillStyle = colour;
  for (let i = 0; i < columns; i++) {
    const top = middle - channel.maxs[i] * scale;
    const bottom = middle - channel.mins[i] * scale;
    context.fillRect(i * step, top, Math.max(step, 1), Math.max(1, bottom - top));
  }
  // The RMS body on top of the envelope: the gap between them is the
  // dynamic range of the passage, and it only reads if both are drawn.
  context.fillStyle = css('--vscode-charts-foreground', '#ddd');
  context.globalAlpha = layout === 'superimposed' ? 0.25 : 0.5;
  for (let i = 0; i < columns; i++) {
    const r = channel.rms[i] * scale;
    context.fillRect(i * step, middle - r, Math.max(step, 1), Math.max(1, 2 * r));
  }
  context.globalAlpha = 1;

  if (channel.coverage > 0 && channel.coverage < 1) {
    context.strokeStyle = css('--vscode-descriptionForeground', '#888');
    context.setLineDash([2, 3]);
    context.beginPath();
    context.moveTo(laneWidth, box.top);
    context.lineTo(laneWidth, box.top + box.height);
    context.stroke();
    context.setLineDash([]);
  }

  if (w.dur > 0) {
    for (const mark of (channel.marks || [])) {
      const x = (mark.sample - w.start) / w.dur * width;
      if (x < 0 || x > width) continue;
      context.strokeStyle = css('--vscode-charts-yellow', '#cca700');
      context.beginPath();
      context.moveTo(x, box.top); context.lineTo(x, box.top + box.height); context.stroke();
      if (mark.name) {
        context.fillStyle = css('--vscode-charts-yellow', '#cca700');
        context.font = '10px var(--vscode-font-family)';
        context.fillText(mark.name, x + 3, box.top + 11);
      }
    }
    const cursorX = (channel.cursor - w.start) / w.dur * width;
    if (cursorX >= 0 && cursorX <= width) {
      context.strokeStyle = css('--vscode-charts-red', '#f14c4c');
      context.lineWidth = focused ? 2 : 1;
      context.beginPath();
      context.moveTo(cursorX, box.top); context.lineTo(cursorX, box.top + box.height);
      context.stroke();
      context.lineWidth = 1;
    }

    // The playhead, in a different colour from the cursor and deliberately
    // so: they are different things. The cursor is where the next edit will
    // happen and stays put; this moves and means nothing afterwards. Drawing
    // both in red would make playback look as though it were dragging the
    // edit point along with it.
    if (running && playhead === undefined) {
      // Playing, position not known yet. Said in words rather than drawn as a
      // line at 0, which would be a claim about where the sound is.
      context.fillStyle = css('--vscode-charts-green', '#89d185');
      context.font = '10px var(--vscode-font-family)';
      context.fillText('playing…', 6, 12);
    }
    if (playhead !== undefined) {
      const x = (playhead - w.start) / w.dur * width;
      if (x >= 0 && x <= width) {
        context.strokeStyle = css('--vscode-charts-green', '#89d185');
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(x, box.top); context.lineTo(x, box.top + box.height);
        context.stroke();
        context.lineWidth = 1;
      }
    }
  }

  if (count > 1 && layout !== 'superimposed') {
    context.fillStyle = colour;
    context.font = (focused ? 'bold ' : '') + '10px var(--vscode-font-family)';
    context.fillText('ch ' + channel.chn + (focused ? ' •' : ''), 4, box.top + box.height - 4);
  }
}

function draw() {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  canvas.width = width * ratio; canvas.height = height * ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!current || !current.channels || current.channels.length === 0) return;

  const w = current;
  const count = w.channels.length;
  const geometry = lanes(height, count);

  if (layout === 'superimposed' || count === 1) {
    w.channels.forEach((channel, index) =>
      drawChannel(channel, index, count, geometry[0], width, w));
  } else {
    w.channels.forEach((channel, index) =>
      drawChannel(channel, index, count, geometry[index], width, w));
  }

  const seconds = (n) => (n / Math.max(1, w.srate)).toFixed(3);
  const focused = w.channels.find(c => c.chn === focusedChannel) || w.channels[0];
  const peak = Math.max(...w.channels.map(c => c.peak));
  const clipped = w.channels.reduce((sum, c) => sum + c.clipped, 0);
  document.getElementById('status').textContent =
    w.fileName + ' · ' + count + (count === 1 ? ' channel' : ' channels') +
    ' · view ' + seconds(w.start) + '–' + seconds(w.start + w.dur) + ' s' +
    ' of ' + seconds(w.frames) + ' s' +
    ' · ch ' + focused.chn + ' cursor ' + focused.cursor +
    ' (' + seconds(focused.cursor) + ' s) edit ' + focused.editPosition +
    ' · peak ' + peak.toFixed(4) +
    (clipped ? ' · ' + clipped + ' clipped' : '');
}

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'waveform') {
    current = message.waveform;
    layout = message.layout || 'separate';
    focusedChannel = message.focused ?? 0;
    const sounds = document.getElementById('sound');
    sounds.innerHTML = '';
    for (const sound of (message.sounds || [])) {
      const option = document.createElement('option');
      option.value = String(sound.index);
      option.textContent = sound.index + ': ' + sound.shortName +
        (sound.frames === 0 ? ' (empty)' : '');
      sounds.appendChild(option);
    }
    sounds.value = String(current.snd);
    sounds.style.display = (message.sounds || []).length > 1 ? '' : 'none';
    const select = document.getElementById('focus');
    select.innerHTML = '';
    for (const channel of current.channels) {
      const option = document.createElement('option');
      option.value = String(channel.chn);
      option.textContent = 'ch ' + channel.chn;
      select.appendChild(option);
    }
    select.value = String(focusedChannel);
    select.style.display = current.channels.length > 1 ? '' : 'none';
    document.getElementById('layout').style.display =
      current.channels.length > 1 ? '' : 'none';
    document.getElementById('error').textContent = '';
    draw();
  } else if (message.type === 'playing') {
    running = message.running;
    if (!running) playhead = undefined;
    draw();
  } else if (message.type === 'playhead') {
    playhead = message.frame;
    // Redraw only. The samples have not changed, so refetching them would
    // put a reduction of the visible range on the audio path twenty times a
    // second — which is what Snd warns about for its own cursor redisplay.
    draw();
  } else if (message.type === 'error') {
    document.getElementById('error').textContent = message.message;
  }
});

function fraction(event) {
  const box = canvas.getBoundingClientRect();
  return Math.min(1, Math.max(0, (event.clientX - box.left) / (box.width || 1)));
}

// Which channel was clicked. Superimposed lanes cannot be told apart by
// position, so there the focused channel stays whatever the selector says --
// guessing would silently aim an edit at a channel the user did not point at.
function channelAt(event) {
  if (!current || layout === 'superimposed' || current.channels.length <= 1) {
    return focusedChannel;
  }
  const box = canvas.getBoundingClientRect();
  const index = laneAt(event.clientY - box.top, box.height, current.channels.length);
  if (index < 0) return focusedChannel;
  return current.channels[Math.min(index, current.channels.length - 1)].chn;
}

canvas.addEventListener('mousedown', e => {
  drag = { from: fraction(e), chn: channelAt(e), moved: false };
});
canvas.addEventListener('mousemove', e => {
  if (!drag) return;
  drag.to = fraction(e);
  if (Math.abs(drag.to - drag.from) > 0.002) drag.moved = true;
});
window.addEventListener('mouseup', e => {
  if (!drag) return;
  const at = drag;
  drag = null;
  if (at.moved) {
    vscode.postMessage({ type: 'select', from: at.from, to: at.to ?? at.from, chn: at.chn });
  } else {
    vscode.postMessage({ type: 'cursor', x: at.from, chn: at.chn });
  }
});
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  vscode.postMessage({ type: 'zoom', factor: e.deltaY < 0 ? 1.6 : 1 / 1.6, anchor: fraction(e) });
}, { passive: false });
canvas.addEventListener('dblclick', () => vscode.postMessage({ type: 'all' }));

document.getElementById('all').onclick = () => vscode.postMessage({ type: 'all' });
document.getElementById('in').onclick = () => vscode.postMessage({ type: 'zoom', factor: 2, anchor: 0.5 });
document.getElementById('out').onclick = () => vscode.postMessage({ type: 'zoom', factor: 0.5, anchor: 0.5 });
document.getElementById('left').onclick = () => vscode.postMessage({ type: 'pan', by: -0.5 });
document.getElementById('right').onclick = () => vscode.postMessage({ type: 'pan', by: 0.5 });
document.getElementById('play').onclick = () => {
  // Play the selection if the focused channel has one; otherwise fall back
  // to the visible view. Without this, "play view" plays the view even
  // when the user just made a selection to hear -- the selection exists
  // only as a highlight, never as something the play button reads.
  const channel = current && current.channels.find(c => c.chn === focusedChannel);
  const selection = channel && channel.selection;
  if (selection && selection.active && selection.frames > 0) {
    vscode.postMessage({ type: 'play', selStart: selection.start, selFrames: selection.frames });
  } else {
    vscode.postMessage({ type: 'play' });
  }
};
document.getElementById('stop').onclick = () => vscode.postMessage({ type: 'stop' });
document.getElementById('undo').onclick = () => vscode.postMessage({ type: 'undo' });
document.getElementById('redo').onclick = () => vscode.postMessage({ type: 'redo' });
document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
document.getElementById('sound').onchange = e =>
  vscode.postMessage({ type: 'sound', snd: Number(e.target.value) });
document.getElementById('focus').onchange = e =>
  vscode.postMessage({ type: 'focus', chn: Number(e.target.value) });
document.getElementById('layout').onchange = e =>
  vscode.postMessage({ type: 'layout', layout: e.target.value });

for (const action of ['delete', 'delete-smooth', 'insert', 'mix', 'reverse', 'smooth',
                      'select-all', 'unselect-all']) {
  document.getElementById('e-' + action).onclick =
    () => vscode.postMessage({ type: 'edit', action });
}

// Snd's own chords, live in the panel.
const KEYS = ${keys};

document.getElementById('keys').textContent =
  'keys: ' + KEYS.map(k => 'C-' + k.key).join(' ') +
  ' — Snd\u2019s own bindings; C-u <number> first for a count, a decimal for seconds';

let pendingCount = '';

window.addEventListener('keydown', event => {
  const tag = (event.target && event.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (!event.ctrlKey || event.metaKey || event.altKey) return;

  // C-u introduces a numeric argument, as in Emacs and in Snd. The digits
  // that follow are collected until a command key arrives.
  if (event.key === 'u') {
    event.preventDefault();
    pendingCount = '';
    document.getElementById('status').textContent = 'C-u …';
    return;
  }
  if (/^[0-9.]$/.test(event.key)) {
    pendingCount += event.key;
    return;
  }

  const command = KEYS.find(entry => entry.key === event.key);
  if (!command) return;
  event.preventDefault();
  // An integer is samples, a decimal is seconds — Snd's rule, applied in the
  // bridge where the sampling rate is known.
  const count = pendingCount === '' ? 1 : Number(pendingCount);
  pendingCount = '';
  vscode.postMessage({ type: 'key', action: command.action, count });
});

let reportedColumns = 0;
function reportColumns() {
  const columns = Math.round(canvas.clientWidth * (window.devicePixelRatio || 1));
  if (Math.abs(columns - reportedColumns) > 24) {
    reportedColumns = columns;
    vscode.postMessage({ type: 'columns', columns });
  } else {
    draw();
  }
}
window.addEventListener('resize', reportColumns);
vscode.postMessage({ type: 'ready' });
reportColumns();
</script></body></html>`;
  }
}
