// userGraphView.ts
//
// What the user's own drawing code drew.
//
// Snd's third graph pane — the "lisp graph" — is where `display-bark-fft`
// (dsp.scm), `display-energy` (examp.scm) and twenty years of private code
// put their output. All of it works the same way: a function on
// `lisp-graph-hook` calls `graph` with a float-vector, and Snd draws it beside
// the time and fft graphs.
//
// The bridge wraps `graph` to record those calls and runs the hook on demand.
// This panel draws the result. It is deliberately plain: whatever the user's
// function computed is the content, and a panel that restyled it would be
// arguing with the person who wrote it.

import * as vscode from 'vscode';

export interface UserGraph {
  label: string;
  x0: number;
  x1: number;
  /** A list of breakpoints rather than a sampled curve. */
  envelope: boolean;
  traces: number[][];
}

export interface UserGraphState {
  /** How many functions are on lisp-graph-hook. */
  installed: number;
  graphs: UserGraph[];
  /** The message, if one of the user's functions raised. */
  failed: string | false;
}

export interface UserGraphHost {
  lispGraph(snd: number, chn: number): Promise<UserGraphState>;
  ready(): boolean;
}

/**
 * The y range of a set of traces.
 *
 * Over ALL traces together, not each on its own. Snd draws a list of
 * float-vectors in one graph with one axis; scaling them separately would make
 * two curves of different magnitude look the same size, which is the one thing
 * a comparison graph must not do.
 */
export function traceRange(graphs: UserGraph[]): { low: number; high: number } {
  let low = Infinity;
  let high = -Infinity;
  for (const graph of graphs) {
    for (const trace of graph.traces) {
      for (const value of trace) {
        if (value < low) low = value;
        if (value > high) high = value;
      }
    }
  }
  if (!isFinite(low) || !isFinite(high)) return { low: 0, high: 1 };
  if (high === low) return { low: low - 0.5, high: high + 0.5 };
  return { low, high };
}

/**
 * Breakpoints to points, keeping their own x values.
 *
 * An envelope's x values are its own — `(0 0 1 1 2 0)` has a point at x=1,
 * not at the midpoint of a resampled curve. Treating it as a trace would put
 * the peak in the same place by accident here and in the wrong place for
 * `(0 0 0.1 1 2 0)`.
 */
export function envelopePoints(flat: number[]): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) points.push({ x: flat[i], y: flat[i + 1] });
  if (points.length === 0) return points;
  const first = points[0].x;
  const span = points[points.length - 1].x - first;
  if (span <= 0) return points.map((point, index) => ({ x: index === 0 ? 0 : 1, y: point.y }));
  return points.map(point => ({ x: (point.x - first) / span, y: point.y }));
}

export class UserGraphView {
  private static instance: UserGraphView | undefined;
  private readonly panel: vscode.WebviewPanel;
  private snd = 0;
  private chn = 0;

  static show(host: UserGraphHost, snd = 0, chn = 0): UserGraphView {
    if (!this.instance) this.instance = new UserGraphView(host);
    this.instance.snd = snd;
    this.instance.chn = chn;
    this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
    void this.instance.reload();
    return this.instance;
  }

  static refresh(): void {
    void this.instance?.reload();
  }

  private constructor(private readonly host: UserGraphHost) {
    this.panel = vscode.window.createWebviewPanel(
      'sndUserGraph',
      'Snd: User Graph',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready' || message?.type === 'reload') void this.reload();
    });
    this.panel.onDidChangeViewState(event => {
      if (event.webviewPanel.visible) void this.reload();
    });
    this.panel.onDidDispose(() => {
      UserGraphView.instance = undefined;
    });
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
      const state = await this.host.lispGraph(this.snd, this.chn);
      void this.panel.webview.postMessage({ type: 'state', state });
      this.panel.title = `Snd: User Graph · ${this.snd}.${this.chn}`;
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
  .bar { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  button { font-family: inherit; font-size: 12px; border: none; padding: 3px 9px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground); }
  .error { color: var(--vscode-errorForeground); }
  .error:not(:empty) { padding: 4px 6px; margin-bottom: 6px;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder); }
  canvas { width: 100%; height: 260px; display: block;
           background: var(--vscode-editor-background); }
  .status { opacity: .8; margin-top: 4px; font-family: var(--vscode-editor-font-family);
            font-size: 11px; }
  .hint { opacity: .65; font-size: 11px; margin-top: 6px; }
  .empty { opacity: .7; padding: 14px 4px; line-height: 1.5; }
  code { font-family: var(--vscode-editor-font-family); }
</style></head><body>
<div class="error" id="error"></div>
<div class="bar">
  <button id="reload">run the hook again</button>
  <span class="status" id="count"></span>
</div>
<div id="empty" class="empty" style="display:none">
  Nothing on <code>lisp-graph-hook</code>.<br><br>
  This panel shows what your own drawing code draws. A function there calls
  <code>graph</code>, exactly as in Snd:
  <br><br>
  <code>(hook-push lisp-graph-hook<br>
  &nbsp;&nbsp;(lambda (hook) (display-energy (hook 'snd) (hook 'chn))))</code>
  <br><br>
  <code>display-energy</code> is in examp.scm; <code>display-bark-fft</code> in
  dsp.scm. Load either and press the button.
</div>
<canvas id="graphs"></canvas>
<div class="status" id="status"></div>
<div class="hint">
  Snd's own <code>graph</code> is still called, so with a Motif build the same
  curve appears in its third pane.
</div>
<script>
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('graphs');
const context = canvas.getContext('2d');
let state = null;

function css(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name);
  return (value && value.trim()) || fallback;
}

// The colours Snd uses for superimposed channels, in that order, because a
// user's function that draws three traces expects them to be distinguishable
// the way they are in Snd.
const COLOURS = ['--vscode-charts-blue', '--vscode-charts-green',
                 '--vscode-charts-orange', '--vscode-charts-purple',
                 '--vscode-charts-red'];

function range(graphs) {
  let low = Infinity, high = -Infinity;
  for (const g of graphs) for (const t of g.traces) for (const v of t) {
    if (v < low) low = v;
    if (v > high) high = v;
  }
  if (!isFinite(low) || !isFinite(high)) return { low: 0, high: 1 };
  if (high === low) return { low: low - 0.5, high: high + 0.5 };
  return { low, high };
}

function draw() {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  canvas.width = width * ratio; canvas.height = height * ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!state || !state.graphs || state.graphs.length === 0) return;

  // ONE range over all traces: Snd draws a list of float-vectors in one graph
  // with one axis, and scaling them separately would make curves of different
  // magnitude look the same size.
  const r = range(state.graphs);
  const y = value => height - (value - r.low) / (r.high - r.low) * (height - 8) - 4;

  if (r.low < 0 && r.high > 0) {
    context.strokeStyle = css('--vscode-panel-border', '#555');
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(0, y(0)); context.lineTo(width, y(0));
    context.stroke();
    context.setLineDash([]);
  }

  let colour = 0;
  for (const g of state.graphs) {
    for (const trace of g.traces) {
      context.strokeStyle = css(COLOURS[colour % COLOURS.length], '#4fc1ff');
      colour++;
      context.lineWidth = 1.5;
      context.beginPath();
      if (g.envelope) {
        // Breakpoints keep their own x values: (0 0 1 1 2 0) has its peak at
        // x=1, and resampling it as a curve would move the peak for any
        // envelope whose points are not evenly spaced.
        const points = [];
        for (let i = 0; i + 1 < trace.length; i += 2) points.push([trace[i], trace[i + 1]]);
        if (points.length === 0) continue;
        const first = points[0][0];
        const span = points[points.length - 1][0] - first;
        points.forEach((p, i) => {
          const x = span > 0 ? (p[0] - first) / span * width : (i === 0 ? 0 : width);
          if (i === 0) context.moveTo(x, y(p[1])); else context.lineTo(x, y(p[1]));
        });
      } else {
        trace.forEach((value, i) => {
          const x = trace.length > 1 ? i / (trace.length - 1) * width : 0;
          if (i === 0) context.moveTo(x, y(value)); else context.lineTo(x, y(value));
        });
      }
      context.stroke();
      context.lineWidth = 1;
    }
  }

  const labels = state.graphs.map(g => g.label || '(no label)').join(', ');
  const total = state.graphs.reduce((n, g) => n + g.traces.length, 0);
  document.getElementById('status').textContent =
    labels + ' · ' + total + (total === 1 ? ' trace' : ' traces') +
    ' · y: ' + r.low.toFixed(3) + ' … ' + r.high.toFixed(3);
}

document.getElementById('reload').onclick = () => vscode.postMessage({ type: 'reload' });

window.addEventListener('error', event => {
  const box = document.getElementById('error');
  if (box) box.textContent = 'panel error: ' + event.message;
});

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'state') {
    state = message.state;
    // A function that raised is reported rather than left as an empty panel:
    // an empty panel says "nothing drew", which is a different fact.
    document.getElementById('error').textContent =
      state.failed ? 'the hook raised: ' + state.failed : '';
    document.getElementById('count').textContent =
      state.installed + (state.installed === 1 ? ' function on lisp-graph-hook'
                                               : ' functions on lisp-graph-hook');
    const empty = state.installed === 0;
    document.getElementById('empty').style.display = empty ? '' : 'none';
    canvas.style.display = empty ? 'none' : '';
    if (empty) document.getElementById('status').textContent = '';
    draw();
  } else if (message.type === 'error') {
    document.getElementById('error').textContent = message.message;
  }
});

window.addEventListener('resize', draw);
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}
