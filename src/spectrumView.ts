// spectrumView.ts
//
// The FFT of the passage at the cursor, drawn from Snd's OWN snd-spectrum
// -- not from an FFT of our own over samples we fetched.
//
// That is a deliberate restriction and it costs something: a spectrum
// computed here could be recomputed on zoom without asking Snd.  But
// snd-spectrum carries Snd's window families and Snd's dB scaling, and a
// spectral editor whose panel disagrees with its own transform dialog is
// worse than one with no panel.  The numbers in this window are the
// numbers Snd would show.

import * as vscode from 'vscode';

export interface Spectrum {
  available: boolean;
  reason?: string;
  start: number;
  size: number;
  linear: boolean;
  srate: number;
  values: number[];
}

export interface Sonogram {
  snd: number;
  chn: number;
  start: number;
  dur: number;
  columns: number;
  bins: number;
  size: number;
  linear: boolean;
  floorDB: number;
  srate: number;
  frames: number;
  /** One byte per cell, column-major, base64. */
  cells: string;
}

export interface SpectrumHost {
  sonogram(params: {
    snd: number;
    chn: number;
    start: number;
    dur: number;
    columns: number;
    bins: number;
    size: number;
    linear: boolean;
    window: string;
  }): Promise<Sonogram>;
  spectrum(params: {
    snd: number;
    chn: number;
    start: number;
    size: number;
    linear: boolean;
    window: string;
  }): Promise<Spectrum>;
  cursorOf(snd: number, chn: number): Promise<number>;
}

const WINDOWS = [
  'rectangular-window',
  'hann-window',
  'hamming-window',
  'blackman2-window',
  'blackman3-window',
  'kaiser-window',
  'gaussian-window',
];

export class SpectrumView {
  private static instance: SpectrumView | undefined;
  private readonly panel: vscode.WebviewPanel;

  private snd = 0;
  private chn = 0;
  private size = 4096;
  private linear = false;
  private window = 'blackman2-window';
  private followCursor = true;
  /** single = one transform at the cursor; sonogram = many over time. */
  private mode: 'single' | 'sonogram' = 'single';
  private columns = 500;
  private bins = 256;
  /**
   * Snd's own two settings for making a spectrum readable, and they exist
   * because without them one is unreadable: a 440 Hz partial on a linear axis
   * to 22050 Hz sits at 2% of the height, which is one line of pixels at the
   * very bottom with black above it. Correct, and useless.
   */
  private logFrequency = false;
  private logFreqStart = 32;
  /** Fraction of Nyquist shown — Snd's spectrum-end, the '% of spectrum' slider. */
  private spectrumEnd = 1;
  private inFlight = false;
  private again = false;

  static show(host: SpectrumHost, snd = 0, chn = 0): SpectrumView {
    if (!this.instance) this.instance = new SpectrumView(host);
    this.instance.snd = snd;
    this.instance.chn = chn;
    this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
    void this.instance.reload();
    return this.instance;
  }

  static refresh(): void {
    void this.instance?.reload();
  }

  static isOpen(): boolean {
    return !!this.instance;
  }

  private constructor(private readonly host: SpectrumHost) {
    this.panel = vscode.window.createWebviewPanel(
      'sndSpectrum',
      'Snd: Spectrum',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(message => this.onMessage(message));
    this.panel.onDidDispose(() => {
      SpectrumView.instance = undefined;
    });
  }

  private async onMessage(message: any): Promise<void> {
    switch (message?.type) {
      case 'ready':
        await this.reload();
        break;
      case 'size':
        this.size = Math.max(64, Math.min(65536, Number(message.size) || 4096));
        await this.reload();
        break;
      case 'window':
        if (WINDOWS.includes(message.window)) this.window = message.window;
        await this.reload();
        break;
      case 'scale':
        this.linear = !!message.linear;
        await this.reload();
        break;
      case 'logfreq':
        // Drawing only — the data is the same either way, so there is no
        // reason to make Snd recompute a hundred transforms for it.
        this.logFrequency = !!message.log;
        await this.redraw();
        break;
      case 'end':
        this.spectrumEnd = Math.min(1, Math.max(0.01, Number(message.end) || 1));
        await this.redraw();
        break;
      case 'follow':
        this.followCursor = !!message.follow;
        await this.reload();
        break;
      case 'mode':
        this.mode = message.mode === 'sonogram' ? 'sonogram' : 'single';
        await this.reload();
        break;
      case 'geometry':
        // The panel reports its own size. Asking for more columns than
        // pixels means computing transforms whose results are averaged away
        // again — and each column is a real FFT, so that is measurable time
        // rather than wasted bytes.
        this.columns = Math.max(40, Math.min(1024, Math.round(message.columns)));
        this.bins = Math.max(32, Math.min(512, Math.round(message.bins)));
        await this.reload();
        break;
      case 'refresh':
        await this.reload();
        break;
    }
  }

  /** Axis settings changed, not the data: tell the panel and let it redraw. */
  private async redraw(): Promise<void> {
    void this.panel.webview.postMessage({ type: 'axes', axes: this.axes() });
  }

  private axes() {
    return {
      logFrequency: this.logFrequency,
      logFreqStart: this.logFreqStart,
      spectrumEnd: this.spectrumEnd,
    };
  }

  private async reload(): Promise<void> {
    // Coalesced, unlike the single-frame case: a sonogram is hundreds of
    // FFTs, so a queue of them behind a drag would leave Snd computing views
    // the user has already left.
    if (this.inFlight) {
      this.again = true;
      return;
    }
    this.inFlight = true;
    try {
      if (this.mode === 'sonogram') {
        const sonogram = await this.host.sonogram({
          snd: this.snd,
          chn: this.chn,
          start: 0,
          dur: 0,
          columns: this.columns,
          bins: this.bins,
          size: this.size,
          linear: this.linear,
          window: this.window,
        });
        void this.panel.webview.postMessage({
          type: 'sonogram',
          sonogram,
          settings: {
            size: this.size,
            linear: this.linear,
            window: this.window,
            follow: this.followCursor,
            mode: this.mode,
            windows: WINDOWS,
            ...this.axes(),
          },
        });
        return;
      }
      // The cursor is fetched separately rather than remembered: it moves
      // in Snd too -- through a click in the Motif window, through
      // Scheme, through playback -- and a panel that trusts its own last
      // value shows the spectrum of a passage the user has left.
      const start = this.followCursor ? await this.host.cursorOf(this.snd, this.chn) : 0;
      const spectrum = await this.host.spectrum({
        snd: this.snd,
        chn: this.chn,
        start,
        size: this.size,
        linear: this.linear,
        window: this.window,
      });
      void this.panel.webview.postMessage({
        type: 'spectrum',
        spectrum,
        settings: {
          size: this.size,
          linear: this.linear,
          window: this.window,
          follow: this.followCursor,
          mode: this.mode,
          windows: WINDOWS,
          ...this.axes(),
        },
      });
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
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         margin: 0; padding: 8px; }
  .bar { display: flex; gap: 8px; align-items: center; font-size: 12px; flex-wrap: wrap;
         margin-bottom: 6px; }
  select, button { font-family: inherit; font-size: 12px;
    background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border); padding: 2px 4px; }
  canvas { width: 100%; height: 320px; cursor: crosshair; display: block;
           background: var(--vscode-editor-background); }
  .status { font-size: 11px; opacity: .8; margin-top: 6px;
            font-family: var(--vscode-editor-font-family); }
  .error { color: var(--vscode-errorForeground); font-size: 12px; }
</style></head><body>
<div class="bar">
  <label>view <select id="mode">
    <option value="single">single transform</option>
    <option value="sonogram">sonogram</option>
  </select></label>
  <label>size <select id="size"></select></label>
  <label>window <select id="window"></select></label>
  <label><input type="checkbox" id="linear"> linear</label>
  <label><input type="checkbox" id="logfreq"> log freq</label>
  <label>up to <select id="end">
    <option value="1">Nyquist</option>
    <option value="0.5">half</option>
    <option value="0.25">quarter</option>
    <option value="0.1">10%</option>
    <option value="0.05">5%</option>
  </select></label>
  <label><input type="checkbox" id="follow" checked> follow cursor</label>
  <button id="refresh">reload</button>
</div>
<canvas id="plot"></canvas>
<div class="status" id="status">…</div>
<div class="error" id="error"></div>
<script>
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('plot');
const context = canvas.getContext('2d');
let current = null, settings = null, hover = null, hoverY = 0, sonogram = null, mode = 'single';
let axes = { logFrequency: false, logFreqStart: 32, spectrumEnd: 1 };

// Snd's own log-frequency mapping, including the part that looks like a
// detail and is not: "the lowest are all inaudible, it seemed more informative
// to squash the lowest 30Hz or so into a single point (0 Hz) on the log freq
// graphs; otherwise the audible data starts about 1/4 of the way down the
// axis". So everything below log-freq-start collapses to the origin rather
// than stretching the inaudible bottom across a quarter of the picture.
function fractionToHz(fraction, nyquist) {
  const top = nyquist * axes.spectrumEnd;
  if (!axes.logFrequency) return fraction * top;
  const start = Math.max(1, axes.logFreqStart);
  if (top <= start) return fraction * top;
  return start * Math.pow(top / start, fraction);
}

function hzToFraction(hz, nyquist) {
  const top = nyquist * axes.spectrumEnd;
  if (top <= 0) return 0;
  if (!axes.logFrequency) return Math.min(1, hz / top);
  const start = Math.max(1, axes.logFreqStart);
  if (hz <= start || top <= start) return 0;
  return Math.log(hz / start) / Math.log(top / start);
}

for (const size of [256, 512, 1024, 2048, 4096, 8192, 16384]) {
  const option = document.createElement('option');
  option.value = String(size); option.textContent = String(size);
  document.getElementById('size').appendChild(option);
}

function css(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name);
  return (value && value.trim()) || fallback;
}

// The sonogram is built as an ImageData and put on the canvas in one call.
// One fillRect per cell would be 150,000 draw calls per redraw, which is
// visibly slow on a trackpad drag; this is one blit.
function drawSonogram(width, height) {
  const s = sonogram;
  const bytes = atob(s.cells);
  const nyquist = s.srate / 2;
  // The image is built at the DISPLAY's row count, not the data's: with a log
  // axis several display rows read the same low bin and the high bins are
  // thinned, which is the whole point. Sampling by nearest bin rather than
  // interpolating, because a partial one bin wide must stay one bin bright —
  // interpolation would smear it across the rows that a log axis stretches it
  // over, and make a clean tone look like noise.
  const rows = s.bins;
  const image = context.createImageData(s.columns, rows);
  for (let col = 0; col < s.columns; col++) {
    for (let row = 0; row < rows; row++) {
      const hz = fractionToHz(row / (rows - 1), nyquist);
      const bin = Math.min(s.bins - 1, Math.max(0, Math.round(hz / nyquist * (s.bins - 1))));
      const level = bytes.charCodeAt(col * s.bins + bin);
      // Row 0 is the lowest frequency, and the canvas counts down from the
      // top — so the image is filled bottom-up, or the spectrum comes out
      // upside down.
      const pixel = ((rows - 1 - row) * s.columns + col) * 4;
      // A monochrome ramp on the editor's own foreground colour rather than a
      // rainbow: a rainbow map implies boundaries between colours that are
      // not in the data, and reading a partial's strength off one is guessing.
      image.data[pixel] = level;
      image.data[pixel + 1] = level;
      image.data[pixel + 2] = Math.min(255, level + 30);
      image.data[pixel + 3] = 255;
    }
  }
  // Drawn through an offscreen canvas so the browser scales it; putImageData
  // ignores the transform and would paint 1:1 in the corner.
  const buffer = document.createElement('canvas');
  buffer.width = s.columns; buffer.height = rows;
  buffer.getContext('2d').putImageData(image, 0, 0);
  context.imageSmoothingEnabled = false;
  context.drawImage(buffer, 0, 0, width, height);

  let text = 'sonogram · ' + s.columns + ' transforms of ' + s.size + ' · ' +
    (axes.logFrequency ? 'log ' + axes.logFreqStart + '–' : '0–') +
    Math.round(nyquist * axes.spectrumEnd) + ' Hz · ' +
    (s.linear ? 'linear' : 'dB, floor ' + s.floorDB);
  if (hover !== null) {
    text += ' · ' + Math.round(fractionToHz(1 - hoverY, nyquist)) + ' Hz at ' +
      (hover * s.dur / Math.max(1, s.srate)).toFixed(3) + ' s';
  }
  document.getElementById('status').textContent = text;
}

function draw() {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  canvas.width = width * ratio; canvas.height = height * ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (mode === 'sonogram') {
    if (sonogram) drawSonogram(width, height);
    return;
  }
  if (!current || !current.available) return;

  const values = current.values;
  // HALF THE TRANSFORM SIZE, not half the returned array.
  //
  // snd-spectrum returns a float-vector as long as the transform, and leaves
  // the upper half untouched — which in dB is 0.0, i.e. the TOP of the scale.
  // Halving the array length instead of using the known size drew that
  // untouched half as a flat line at full level across the right of the plot:
  // a step in the middle of every dB spectrum, which reads as an artefact of
  // the signal rather than of the drawing.
  const bins = Math.max(1, Math.min(values.length, Math.floor(current.size / 2)));
  // -90 IS NOT A MEASUREMENT.
  //
  // snd-spectrum sets any bin whose raw magnitude is under 1e-6 to a flat
  // -90 (snd-sig.c, with Bill Schottstaedt's own comment wondering whether it
  // should be min-dB). Bins just above that threshold are computed and can be
  // LOWER — -105.14 in this file. So -90 means "did not reach the threshold",
  // and drawing it as part of the curve produces the step that made every dB
  // spectrum look as though the signal did something at that frequency.
  const NOT_MEASURED = -90;
  const measured = current.linear
    ? values.slice(0, bins)
    : values.slice(0, bins).filter(value => value !== NOT_MEASURED);
  let low = Infinity, high = -Infinity;
  for (const value of measured) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (!isFinite(low) || !isFinite(high) || high === low) { low = 0; high = 1; }

  context.strokeStyle = css('--vscode-panel-border', '#555');
  context.beginPath(); context.moveTo(0, height - 1); context.lineTo(width, height - 1); context.stroke();

  const nyquist = current.srate / 2;
  context.strokeStyle = css('--vscode-charts-blue', '#4fc1ff');
  context.beginPath();
  // Walked in SCREEN columns, not in bins: with a log axis the bins are not
  // evenly spaced on screen, and drawing bin by bin would leave the stretched
  // low end as a handful of long diagonals.
  const steps = Math.max(2, Math.round(width));
  let drawing = false;
  for (let step = 0; step < steps; step++) {
    const hz = fractionToHz(step / (steps - 1), nyquist);
    const bin = Math.min(bins - 1, Math.max(0, Math.round(hz / nyquist * (bins - 1))));
    const value = values[bin];
    const x = step / (steps - 1) * width;
    if (!current.linear && value === NOT_MEASURED) {
      // A gap, not a line to the floor: joining measured points across an
      // unmeasured stretch draws a slope that is not in the data.
      drawing = false;
      continue;
    }
    const y = height - (value - low) / (high - low) * (height - 4) - 2;
    if (!drawing) { context.moveTo(x, y); drawing = true; } else context.lineTo(x, y);
  }
  context.stroke();

  // And the floor itself, marked, so that the empty part of the picture is
  // visibly empty rather than merely blank.
  if (!current.linear && measured.length < bins) {
    context.strokeStyle = css('--vscode-panel-border', '#555');
    context.setLineDash([4, 4]);
    context.beginPath();
    context.moveTo(0, height - 2); context.lineTo(width, height - 2);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = css('--vscode-descriptionForeground', '#888');
    context.font = '10px var(--vscode-font-family)';
    context.fillText('below snd-spectrum\u2019s threshold (\u221290 dB)', 6, height - 6);
  }

  let text = 'start ' + current.start + ' · size ' + current.size +
    ' · ' + (current.linear ? 'linear' : 'dB') + ' · ' +
    (axes.logFrequency ? 'log ' + axes.logFreqStart + '–' : '0–') +
    Math.round(nyquist * axes.spectrumEnd) + ' Hz';
  if (hover !== null) {
    const hz = fractionToHz(hover, nyquist);
    const bin = Math.min(bins - 1, Math.max(0, Math.round(hz / nyquist * (bins - 1))));
    const value = values[bin];
    text += ' · at ' + Math.round(hz) + ' Hz: ' +
      (!current.linear && value === NOT_MEASURED ? 'under the threshold' : value.toFixed(3));
  }
  document.getElementById('status').textContent = text;
}

canvas.addEventListener('mousemove', e => {
  const box = canvas.getBoundingClientRect();
  hover = Math.min(1, Math.max(0, (e.clientX - box.left) / (box.width || 1)));
  hoverY = Math.min(1, Math.max(0, (e.clientY - box.top) / (box.height || 1)));
  draw();
});
canvas.addEventListener('mouseleave', () => { hover = null; draw(); });

function applySettings(next) {
  settings = next;
  mode = settings.mode || 'single';
  const windowSelect = document.getElementById('window');
  if (windowSelect.options.length === 0) {
    for (const name of settings.windows) {
      const option = document.createElement('option');
      option.value = name; option.textContent = name.replace('-window', '');
      windowSelect.appendChild(option);
    }
  }
  windowSelect.value = settings.window;
  document.getElementById('size').value = String(settings.size);
  document.getElementById('linear').checked = settings.linear;
  document.getElementById('follow').checked = settings.follow;
  document.getElementById('mode').value = mode;
  if (settings.logFrequency !== undefined) {
    axes = {
      logFrequency: settings.logFrequency,
      logFreqStart: settings.logFreqStart,
      spectrumEnd: settings.spectrumEnd,
    };
    document.getElementById('logfreq').checked = axes.logFrequency;
    document.getElementById('end').value = String(axes.spectrumEnd);
  }
  // "follow cursor" is meaningless for a sonogram, which shows the whole
  // range at once. Left enabled it would look like a setting that does
  // nothing.
  document.getElementById('follow').disabled = mode === 'sonogram';
}

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'sonogram') {
    sonogram = message.sonogram;
    applySettings(message.settings);
    document.getElementById('error').textContent = '';
    draw();
    return;
  }
  if (message.type === 'spectrum') {
    current = message.spectrum;
    applySettings(message.settings);
    document.getElementById('error').textContent =
      current.available ? '' : (current.reason || 'no data');
    draw();
  } else if (message.type === 'axes') {
    axes = message.axes;
    document.getElementById('logfreq').checked = axes.logFrequency;
    document.getElementById('end').value = String(axes.spectrumEnd);
    draw();
  } else if (message.type === 'error') {
    document.getElementById('error').textContent = message.message;
  }
});

document.getElementById('size').onchange = e =>
  vscode.postMessage({ type: 'size', size: Number(e.target.value) });
document.getElementById('window').onchange = e =>
  vscode.postMessage({ type: 'window', window: e.target.value });
document.getElementById('linear').onchange = e =>
  vscode.postMessage({ type: 'scale', linear: e.target.checked });
document.getElementById('logfreq').onchange = e =>
  vscode.postMessage({ type: 'logfreq', log: e.target.checked });
document.getElementById('end').onchange = e =>
  vscode.postMessage({ type: 'end', end: Number(e.target.value) });
document.getElementById('follow').onchange = e =>
  vscode.postMessage({ type: 'follow', follow: e.target.checked });
document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
document.getElementById('mode').onchange = e =>
  vscode.postMessage({ type: 'mode', mode: e.target.value });

let reported = 0;
function reportGeometry() {
  const ratio = window.devicePixelRatio || 1;
  const columns = Math.round(canvas.clientWidth * ratio);
  if (Math.abs(columns - reported) > 32) {
    reported = columns;
    vscode.postMessage({
      type: 'geometry',
      columns,
      bins: Math.round(canvas.clientHeight * ratio),
    });
  } else {
    draw();
  }
}
window.addEventListener('resize', reportGeometry);
vscode.postMessage({ type: 'ready' });
reportGeometry();
</script></body></html>`;
  }
}
