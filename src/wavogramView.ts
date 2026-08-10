// wavogramView.ts
//
// Snd's time-domain 3D display.  Each line is exactly wavo-trace samples and
// starts where the previous one ended; that alignment is the information in
// this graph.  The projection is the same one used by Snd's spectrogram.

import * as vscode from 'vscode';
import { Orientation, place, rotationMatrix } from './spectrumView';

export interface Wavogram {
  snd: number;
  chn: number;
  fileName: string;
  srate: number;
  frames: number;
  start: number;
  traceLength: number;
  hop: number;
  points: number;
  traces: number[][];
  orientation: Orientation;
}

export interface WavogramHost {
  wavogram(params: {
    snd: number;
    chn: number;
    start: number;
    traces: number;
    points: number;
  }): Promise<Wavogram>;
  setWavogram(snd: number, chn: number, trace: number, hop: number): Promise<void>;
  cursorOf(snd: number, chn: number): Promise<number>;
}

const rotationMatrixSource = { toString: () => rotationMatrix.toString() };
const placeSource = { toString: () => place.toString() };

export class WavogramView {
  private static instance: WavogramView | undefined;
  private readonly panel: vscode.WebviewPanel;
  private snd = 0;
  private chn = 0;
  private start = 0;
  private trace = 64;
  private hop = 3;
  private height = 360;
  private width = 900;
  private activatedInSnd = false;
  private inFlight = false;
  private again = false;

  static show(host: WavogramHost, snd = 0, chn = 0): WavogramView {
    if (!this.instance) this.instance = new WavogramView(host);
    this.instance.snd = snd;
    this.instance.chn = chn;
    this.instance.start = 0;
    this.instance.activatedInSnd = false;
    this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
    void this.instance.reload();
    return this.instance;
  }

  static refresh(): void {
    void this.instance?.reload();
  }

  static follow(snd: number): void {
    if (!this.instance) return;
    this.instance.snd = snd;
    this.instance.chn = 0;
    this.instance.start = 0;
    this.instance.activatedInSnd = false;
    void this.instance.reload();
  }

  private constructor(private readonly host: WavogramHost) {
    this.panel = vscode.window.createWebviewPanel(
      'sndWavogram',
      'Snd: Wavogram',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(message => this.onMessage(message));
    this.panel.onDidDispose(() => { WavogramView.instance = undefined; });
  }

  private async onMessage(message: any): Promise<void> {
    switch (message?.type) {
      case 'ready':
        await this.reload();
        break;
      case 'geometry':
        this.width = Math.max(200, Math.round(Number(message.width) || 900));
        this.height = Math.max(120, Math.round(Number(message.height) || 360));
        await this.reload();
        break;
      case 'settings':
        this.trace = Math.max(2, Math.round(Number(message.trace) || this.trace));
        this.hop = Math.max(1, Math.round(Number(message.hop) || this.hop));
        await this.host.setWavogram(this.snd, this.chn, this.trace, this.hop);
        this.activatedInSnd = true;
        await this.reload();
        break;
      case 'page':
        this.start = Math.max(0, this.start + Math.round(Number(message.by) || 0));
        await this.reload();
        break;
      case 'cursor':
        this.start = await this.host.cursorOf(this.snd, this.chn);
        await this.reload();
        break;
      case 'start':
        this.start = Math.max(0, Math.round(Number(message.start) || 0));
        await this.reload();
        break;
      case 'refresh':
        await this.reload();
        break;
    }
  }

  private async reload(): Promise<void> {
    if (this.inFlight) { this.again = true; return; }
    this.inFlight = true;
    try {
      const traces = Math.max(4, Math.min(256, Math.floor(this.height / Math.max(1, this.hop))));
      const data = await this.host.wavogram({
        snd: this.snd,
        chn: this.chn,
        start: this.start,
        traces,
        points: Math.max(64, Math.min(2048, this.width)),
      });
      this.trace = data.traceLength;
      this.hop = data.hop;
      this.start = data.start;
      // Opening this panel means choosing graph-as-wavogram.  Set Snd's own
      // variables once so a Motif window and the VS Code panel cannot disagree.
      if (!this.activatedInSnd) {
        await this.host.setWavogram(this.snd, this.chn, this.trace, this.hop);
        this.activatedInSnd = true;
      }
      void this.panel.webview.postMessage({ type: 'wavogram', data });
    } catch (error) {
      void this.panel.webview.postMessage({
        type: 'error',
        message: String((error as Error).message ?? error),
      });
    } finally {
      this.inFlight = false;
      if (this.again) { this.again = false; await this.reload(); }
    }
  }

  private html(): string {
    const rotationMatrix = rotationMatrixSource;
    const place = placeSource;
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         margin: 0; padding: 8px; }
  .bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap;
         font-size:12px; margin-bottom:6px; }
  input, button { font:inherit; color:var(--vscode-input-foreground);
    background:var(--vscode-input-background); border:1px solid var(--vscode-input-border);
    padding:2px 5px; }
  input[type=number] { width:82px; }
  button { cursor:pointer; color:var(--vscode-button-secondaryForeground);
    background:var(--vscode-button-secondaryBackground); border:0; }
  canvas { width:100%; height:360px; display:block;
    background:var(--vscode-editor-background); }
  .status { font:11px var(--vscode-editor-font-family); opacity:.8; margin-top:6px; }
  .warning { font-size:11px; opacity:.7; }
  .error { color:var(--vscode-errorForeground); font-size:12px; margin-top:5px; }
</style></head><body>
<div class="bar">
  <label>trace <input id="trace" type="number" min="2" step="1"></label>
  <label>hop <input id="hop" type="number" min="1" max="256" step="1"></label>
  <label>start <input id="start" type="number" min="0" step="1"></label>
  <button id="left">◀ page</button><button id="right">page ▶</button>
  <button id="cursor">at cursor</button><button id="refresh">reload</button>
</div>
<div class="warning">trace is samples per line; matching it to a period aligns successive peaks</div>
<canvas id="plot"></canvas>
<div id="status" class="status">…</div><div id="error" class="error"></div>
<script>
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('plot');
const context = canvas.getContext('2d');
let current = null;
const rotationMatrix = ${rotationMatrix.toString()};
const place = ${place.toString()};

function css(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name);
  return (value && value.trim()) || fallback;
}

function draw() {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  canvas.width = width * ratio; canvas.height = height * ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!current || !current.traces || current.traces.length === 0) return;

  const o = current.orientation || { xAngle:90, yAngle:0, zAngle:358,
    xScale:1, yScale:1, zScale:0.1 };
  const mat = rotationMatrix({ ...o, zScale: o.zScale * height });
  const x0 = width / 2, y0 = height / 2;
  const projected = [];
  let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
  current.traces.forEach((trace, row) => {
    const line = [];
    trace.forEach((sample, i) => {
      const x = trace.length <= 1 ? 0 : i / (trace.length - 1) * width;
      const y = height - row * current.hop;
      const p = place(x - x0, y - y0, sample, mat);
      const point = { x:p.x + x0, y:p.y + y0 };
      minX=Math.min(minX,point.x); maxX=Math.max(maxX,point.x);
      minY=Math.min(minY,point.y); maxY=Math.max(maxY,point.y);
      line.push(point);
    });
    projected.push(line);
  });
  if (!isFinite(minX) || maxX === minX || maxY === minY) return;
  const pad=9, scale=Math.min((width-2*pad)/(maxX-minX),(height-2*pad)/(maxY-minY));
  const px=x=>pad+(x-minX)*scale, py=y=>pad+(y-minY)*scale;
  const background=css('--vscode-editor-background','#1e1e1e');
  const line=css('--vscode-charts-blue','#4fc1ff');
  // Hidden-line removal is an order, not an effect.  Trace 0 is the FRONT of
  // the landscape (lowest on the screen) and the last trace is the back, so
  // paint from the back forward: each nearer trace masks the ground beneath
  // its own curve and so hides the traces behind it.  Painting front-to-back
  // instead makes the hindmost trace's mask cover the entire picture, which
  // left every trace but the last few washed out to the background.
  const floor = py(maxY);
  for (let row = projected.length - 1; row >= 0; row--) {
    const points = projected[row];
    if (points.length < 2) continue;
    const trace = () => points.forEach((p,i) =>
      i ? context.lineTo(px(p.x),py(p.y)) : context.moveTo(px(p.x),py(p.y)));
    context.beginPath(); trace();
    context.lineTo(px(points[points.length-1].x), floor);
    context.lineTo(px(points[0].x), floor); context.closePath();
    context.fillStyle=background; context.fill();
    context.beginPath(); trace();
    context.strokeStyle=line; context.lineWidth=1; context.stroke();
  }
  const seconds = n => (n / Math.max(1,current.srate)).toFixed(4);
  document.getElementById('status').textContent = current.fileName + ' · ch ' + current.chn +
    ' · ' + current.traces.length + ' traces × ' + current.traceLength + ' samples' +
    ' · start ' + current.start + ' (' + seconds(current.start) + ' s)' +
    ' · x ' + Math.round(o.xAngle) + '° y ' + Math.round(o.yAngle) + '° z ' +
    Math.round(o.zAngle) + '°';
}

window.addEventListener('message', event => {
  const message=event.data;
  if (message.type === 'wavogram') {
    current=message.data;
    document.getElementById('trace').value=String(current.traceLength);
    document.getElementById('hop').value=String(current.hop);
    document.getElementById('start').value=String(current.start);
    document.getElementById('error').textContent='';
    draw();
  } else if (message.type === 'error') {
    document.getElementById('error').textContent=message.message;
  }
});

function settings() {
  vscode.postMessage({ type:'settings', trace:Number(document.getElementById('trace').value),
    hop:Number(document.getElementById('hop').value) });
}
document.getElementById('trace').onchange=settings;
document.getElementById('hop').onchange=settings;
document.getElementById('start').onchange=e=>vscode.postMessage({type:'start',start:Number(e.target.value)});
document.getElementById('left').onclick=()=>vscode.postMessage({type:'page',by:-(current ? current.traceLength*current.traces.length : 0)});
document.getElementById('right').onclick=()=>vscode.postMessage({type:'page',by:(current ? current.traceLength*current.traces.length : 0)});
document.getElementById('cursor').onclick=()=>vscode.postMessage({type:'cursor'});
document.getElementById('refresh').onclick=()=>vscode.postMessage({type:'refresh'});
let reported='';
function geometry() {
  const key=Math.round(canvas.clientWidth)+'x'+Math.round(canvas.clientHeight);
  if (key!==reported) { reported=key; vscode.postMessage({type:'geometry',width:canvas.clientWidth,height:canvas.clientHeight}); }
  else draw();
}
window.addEventListener('resize',geometry);
vscode.postMessage({type:'ready'}); geometry();
</script></body></html>`;
  }
}
