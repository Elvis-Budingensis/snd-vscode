// headerPanel.ts
//
// Edit Header is intentionally a separate, explicit panel.  These changes
// reinterpret bytes on disk and do not belong in Snd's undo history.

import * as vscode from 'vscode';

export interface NamedConstant { name: string; value: number; }

export interface HeaderInfo {
  snd: number;
  fileName: string;
  shortName: string;
  headerType: number;
  sampleType: number;
  srate: number;
  channels: number;
  dataLocation: number;
  dataSize: number;
  comment: string;
  edited: boolean;
  commentPending?: boolean;
  headerTypes: NamedConstant[];
  sampleTypes: NamedConstant[];
}

export interface HeaderHost {
  headerInfo(snd: number): Promise<HeaderInfo>;
  editHeader(params: {
    snd: number;
    headerType: number;
    sampleType: number;
    srate: number;
    channels: number;
    dataLocation: number;
    dataSize: number;
    setLocation: boolean;
    setSize: boolean;
    comment: string;
  }): Promise<HeaderInfo>;
}

export class HeaderPanel {
  private static instance: HeaderPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private snd = 0;

  static show(host: HeaderHost, snd: number): HeaderPanel {
    if (!this.instance) this.instance = new HeaderPanel(host);
    this.instance.snd = snd;
    this.instance.panel.reveal(vscode.ViewColumn.Beside, true);
    void this.instance.reload();
    return this.instance;
  }

  static refresh(): void { void this.instance?.reload(); }

  private constructor(private readonly host: HeaderHost) {
    this.panel = vscode.window.createWebviewPanel(
      'sndEditHeader',
      'Snd: Edit Header',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(message => this.onMessage(message));
    this.panel.onDidDispose(() => { HeaderPanel.instance = undefined; });
  }

  private async onMessage(message: any): Promise<void> {
    try {
      if (message?.type === 'ready' || message?.type === 'reload') {
        await this.reload();
        return;
      }
      if (message?.type === 'apply') {
        const info = await this.host.editHeader({
          snd: this.snd,
          headerType: Number(message.headerType),
          sampleType: Number(message.sampleType),
          srate: Number(message.srate),
          channels: Number(message.channels),
          dataLocation: Number(message.dataLocation),
          dataSize: Number(message.dataSize),
          setLocation: !!message.setLocation,
          setSize: !!message.setSize,
          comment: String(message.comment ?? ''),
        });
        void this.panel.webview.postMessage({ type: 'header', info, saved: true });
      }
    } catch (error) {
      void this.panel.webview.postMessage({
        type: 'error', message: String((error as Error).message ?? error),
      });
    }
  }

  private async reload(): Promise<void> {
    try {
      const info = await this.host.headerInfo(this.snd);
      void this.panel.webview.postMessage({ type: 'header', info, saved: false });
    } catch (error) {
      void this.panel.webview.postMessage({
        type: 'error', message: String((error as Error).message ?? error),
      });
    }
  }

  private html(): string {
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
 body { font-family:var(--vscode-font-family); color:var(--vscode-foreground);
   margin:0; padding:12px; max-width:760px; }
 .warning { border-left:3px solid var(--vscode-editorWarning-foreground); padding:8px 10px;
   background:var(--vscode-inputValidation-warningBackground); margin-bottom:12px; }
 .warning strong { display:block; margin-bottom:4px; }
 .grid { display:grid; grid-template-columns:180px minmax(220px,1fr); gap:8px 12px;
   align-items:center; }
 label { font-size:12px; }
 input, select, textarea { box-sizing:border-box; width:100%; font:12px var(--vscode-font-family);
   color:var(--vscode-input-foreground); background:var(--vscode-input-background);
   border:1px solid var(--vscode-input-border); padding:4px 6px; }
 textarea { min-height:90px; resize:vertical; }
 .wide { grid-column:1 / -1; }
 .fine { font-size:11px; opacity:.72; }
 .confirm { display:flex; gap:7px; align-items:flex-start; margin-top:12px; font-size:12px; }
 .confirm input { width:auto; margin-top:2px; }
 .actions { display:flex; gap:8px; align-items:center; margin-top:12px; }
 button { font:12px var(--vscode-font-family); padding:4px 10px; border:0; cursor:pointer;
   color:var(--vscode-button-foreground); background:var(--vscode-button-background); }
 button:disabled { opacity:.45; cursor:default; }
 .secondary { color:var(--vscode-button-secondaryForeground);
   background:var(--vscode-button-secondaryBackground); }
 .status { font:11px var(--vscode-editor-font-family); opacity:.8; }
 .error { color:var(--vscode-errorForeground); font-size:12px; margin-top:8px; }
</style></head><body>
<div class="warning"><strong>This changes the file header immediately.</strong>
The sound data is not converted. A wrong rate, channel count, sample type, location or size
reinterprets the same bytes and is not undoable. Unsaved sample edits are not folded into this operation.</div>
<div class="grid">
 <label>file</label><div id="file" class="status">…</div>
 <label for="header">header type</label><select id="header"></select>
 <label for="sample">sample type</label><select id="sample"></select>
 <label for="srate">sample rate</label><input id="srate" type="number" min="1" step="1">
 <label for="channels">channels</label><input id="channels" type="number" min="1" step="1">
 <label for="location">data location (bytes)</label><input id="location" type="number" min="0" step="1">
 <label for="size">data size (bytes)</label><input id="size" type="number" min="0" step="1">
 <label for="comment">comment</label><textarea id="comment"></textarea>
 <div class="wide fine">If data location is left unchanged, Snd chooses a syntactically correct location after a header-type change.
The public Snd API stages a changed comment with the open sound; “Save Sound” writes that comment.</div>
</div>
<label class="confirm"><input id="confirm" type="checkbox">
I understand that this rewrites header fields on disk and is outside undo.</label>
<div class="actions"><button id="apply" disabled>Apply header</button>
 <button id="reload" class="secondary">Reload values</button><span id="status" class="status"></span></div>
<div id="error" class="error"></div>
<script>
const vscode=acquireVsCodeApi();
let original=null;
const byId=id=>document.getElementById(id);

function options(select, values, selected) {
  select.innerHTML='';
  for (const entry of values || []) {
    const option=document.createElement('option');
    option.value=String(entry.value);
    option.textContent=entry.name.replace(/^mus-/, '');
    select.appendChild(option);
  }
  select.value=String(selected);
}

function show(info, saved) {
  original=info;
  byId('file').textContent=info.fileName + (info.edited ? ' · unsaved sample edits present' : '');
  options(byId('header'),info.headerTypes,info.headerType);
  options(byId('sample'),info.sampleTypes,info.sampleType);
  byId('srate').value=String(info.srate);
  byId('channels').value=String(info.channels);
  byId('location').value=String(info.dataLocation);
  byId('size').value=String(info.dataSize);
  byId('comment').value=info.comment || '';
  byId('confirm').checked=false; byId('apply').disabled=true;
  byId('status').textContent=saved
    ? (info.commentPending
        ? 'header applied; comment staged — Save Sound writes it with the pending edits'
        : 'header applied; views refreshed')
    : '';
  byId('error').textContent='';
}

window.addEventListener('message',event=>{
  const message=event.data;
  if(message.type==='header') show(message.info,message.saved);
  else if(message.type==='error') byId('error').textContent=message.message;
});
byId('confirm').onchange=e=>{byId('apply').disabled=!e.target.checked;};
byId('reload').onclick=()=>vscode.postMessage({type:'reload'});
byId('apply').onclick=()=>{
  if(!original || !byId('confirm').checked) return;
  const location=Number(byId('location').value), size=Number(byId('size').value);
  vscode.postMessage({type:'apply',headerType:Number(byId('header').value),
    sampleType:Number(byId('sample').value),srate:Number(byId('srate').value),
    channels:Number(byId('channels').value),dataLocation:location,dataSize:size,
    setLocation:location!==original.dataLocation,setSize:size!==original.dataSize,
    comment:byId('comment').value});
};
vscode.postMessage({type:'ready'});
</script></body></html>`;
  }
}
