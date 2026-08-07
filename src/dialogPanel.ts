// dialogPanel.ts
//
// One renderer for all of Snd's dialogs.
//
// The dialogs differ in which variables they show, not in how they show
// them: a checkbox for a boolean, a slider with a number beside it for a
// range, a list for an enumeration. Snd's Motif code writes each dialog by
// hand, which is why they all look slightly different from each other.
// Here the difference is a table (sndVariables.ts) and this file is the
// same for all of them.
//
// TWO THINGS THIS DOES THAT SND'S OWN DIALOGS CANNOT
//
// It shows what the build does not have. A variable missing from this Snd
// arrives from the bridge as unavailable and is rendered greyed out with
// the reason. Snd's dialogs are compiled against their own build, so the
// question never arises there -- but for us "this build cannot do it" is
// information, and a silently missing row is not.
//
// It re-reads. Snd's dialogs and these panels write the same variables, so
// with a Motif build both are live at once. Whoever looks second has to
// look again, which is why every panel has a reload and re-reads when it
// regains focus.

import * as vscode from 'vscode';
import { DialogSpec, VariableSpec, schemeLiteral, symbolNames, variableNames } from './sndVariables';

export interface VariableValue {
  name: string;
  available: boolean;
  value?: unknown;
  reason?: string;
}

export interface DialogHost {
  getVariables(names: string[], snd: number): Promise<VariableValue[]>;
  setVariable(name: string, literal: string, via: string | undefined, snd: number): Promise<void>;
  constants(names: string[]): Promise<VariableValue[]>;
  action(id: string, snd: number): Promise<string>;
  ready(): boolean;
}

export class DialogPanel {
  private static open = new Map<string, DialogPanel>();

  private readonly panel: vscode.WebviewPanel;
  private snd = 0;
  /** Symbol name → number in THIS build. Resolved once per panel. */
  private constants = new Map<string, number>();

  static show(host: DialogHost, spec: DialogSpec, snd = 0): DialogPanel {
    const existing = this.open.get(spec.id);
    if (existing) {
      existing.snd = snd;
      existing.panel.reveal(vscode.ViewColumn.Beside, true);
      void existing.reload();
      return existing;
    }
    const created = new DialogPanel(host, spec, snd);
    this.open.set(spec.id, created);
    return created;
  }

  /** After an edit or a sound change: the values may have moved. */
  static refreshAll(): void {
    for (const panel of this.open.values()) void panel.reload();
  }

  private constructor(
    private readonly host: DialogHost,
    private readonly spec: DialogSpec,
    snd: number
  ) {
    this.snd = snd;
    this.panel = vscode.window.createWebviewPanel(
      `sndDialog.${spec.id}`,
      spec.title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(message => void this.onMessage(message));
    this.panel.onDidChangeViewState(event => {
      // Snd's own dialog may have moved these while we were hidden.
      if (event.webviewPanel.visible) void this.reload();
    });
    this.panel.onDidDispose(() => DialogPanel.open.delete(spec.id));
  }

  private async onMessage(message: any): Promise<void> {
    try {
      switch (message?.type) {
        case 'ready':
          await this.reload();
          break;
        case 'set': {
          const variable = this.find(message.name);
          if (!variable) return;
          const literal =
            variable.kind === 'string'
              ? undefined // handled below, needs quoting from the extension side
              : schemeLiteral(variable, message.value);
          if (variable.kind === 'string') {
            await this.host.setVariable(
              variable.name,
              JSON.stringify(String(message.value ?? '')).replace(/\\u([0-9a-f]{4})/g, (_m, hex) =>
                `\\x${parseInt(hex, 16).toString(16)};`
              ),
              undefined,
              this.snd
            );
          } else if (literal !== undefined) {
            await this.host.setVariable(variable.name, literal, variable.via, this.snd);
          } else {
            // A value the field should not have been able to produce.
            // Reloading is the honest response: it shows what Snd actually
            // holds instead of leaving the field showing what it wanted.
            await this.reload();
            return;
          }
          // Re-read the whole dialog rather than trusting the write.
          // Several of these variables constrain each other -- setting
          // transform-size can move zero-pad, switching the graph type
          // changes what spectro-hop means -- and a panel that only
          // updates the field it wrote drifts away from the session it is
          // supposed to be showing.
          await this.reload();
          break;
        }
        case 'action': {
          const note = await this.host.action(message.id, this.snd);
          void this.panel.webview.postMessage({ type: 'note', note });
          await this.reload();
          break;
        }
        case 'reload':
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

  private find(name: string): VariableSpec | undefined {
    for (const group of this.spec.groups) {
      const found = group.variables.find(variable => variable.name === name);
      if (found) return found;
    }
    return undefined;
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
      if (this.constants.size === 0) {
        const symbols = symbolNames(this.spec);
        if (symbols.length > 0) {
          for (const entry of await this.host.constants(symbols)) {
            if (entry.available && typeof entry.value === 'number') {
              this.constants.set(entry.name, entry.value);
            }
          }
        }
      }
      const values = await this.host.getVariables(variableNames(this.spec), this.snd);
      void this.panel.webview.postMessage({
        type: 'values',
        values,
        constants: Object.fromEntries(this.constants),
        snd: this.snd,
      });
    } catch (error) {
      void this.panel.webview.postMessage({
        type: 'error',
        message: String((error as Error).message ?? error),
      });
    }
  }

  private html(): string {
    const spec = JSON.stringify(this.spec);
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         margin: 0; padding: 10px 12px; font-size: 12px; }
  h2 { font-size: 12px; text-transform: lowercase; letter-spacing: .06em;
       opacity: .75; margin: 14px 0 6px; font-weight: 600;
       border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 3px; }
  .note { opacity: .7; margin-bottom: 4px; line-height: 1.45; }
  .row { display: grid; grid-template-columns: 190px 1fr 76px; gap: 8px;
         align-items: center; padding: 2px 0; }
  .row.off { opacity: .4; }
  label { text-align: right; }
  input[type=range] { width: 100%; }
  input[type=text], select, input[type=number] {
    width: 100%; font-family: inherit; font-size: 12px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); padding: 2px 4px; }
  .value { font-family: var(--vscode-editor-font-family); text-align: right; opacity: .85; }
  .why { grid-column: 2 / span 2; font-size: 11px; opacity: .8; }
  .actions { margin: 14px 0 4px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button { font-family: inherit; font-size: 12px; cursor: pointer; border: none; padding: 4px 10px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.secondary { background: var(--vscode-button-secondaryBackground);
                     color: var(--vscode-button-secondaryForeground); }
  .hint { opacity: .65; font-size: 11px; }
  .error { color: var(--vscode-errorForeground); min-height: 16px; margin-top: 6px; }
  .msg { color: var(--vscode-charts-green); min-height: 16px; }
</style></head><body>
<div class="note" id="head"></div>
<div id="body"></div>
<div class="actions" id="actions"></div>
<div class="msg" id="msg"></div>
<div class="error" id="error"></div>
<script>
const vscode = acquireVsCodeApi();
const spec = ${spec};
let constants = {};
document.getElementById('head').textContent = spec.note || '';

// Slider and number field are one control with two faces: the slider for
// finding a value, the number for saying one. Both write on 'change' and
// not on 'input' -- one request per drag, not one per pixel, because each
// request re-reads the whole dialog.
function rowFor(variable) {
  const row = document.createElement('div');
  row.className = 'row';
  row.id = 'row-' + variable.name;
  const label = document.createElement('label');
  label.textContent = variable.label;
  label.title = variable.name + (variable.hint ? ' — ' + variable.hint : '');
  row.appendChild(label);

  if (variable.kind === 'bool') {
    const wrap = document.createElement('div');
    const box = document.createElement('input');
    box.type = 'checkbox'; box.id = 'f-' + variable.name;
    box.onchange = () => vscode.postMessage({ type: 'set', name: variable.name, value: box.checked });
    wrap.appendChild(box);
    row.appendChild(wrap);
    row.appendChild(document.createElement('div'));
  } else if (variable.kind === 'enum') {
    const select = document.createElement('select');
    select.id = 'f-' + variable.name;
    for (const option of variable.options || []) {
      const element = document.createElement('option');
      element.value = option.symbol; element.textContent = option.label;
      select.appendChild(element);
    }
    select.onchange = () => vscode.postMessage({ type: 'set', name: variable.name, value: select.value });
    row.appendChild(select);
    row.appendChild(document.createElement('div'));
  } else if (variable.kind === 'string') {
    const field = document.createElement('input');
    field.type = 'text'; field.id = 'f-' + variable.name;
    field.onchange = () => vscode.postMessage({ type: 'set', name: variable.name, value: field.value });
    row.appendChild(field);
    row.appendChild(document.createElement('div'));
  } else if (variable.kind === 'readonly') {
    const shown = document.createElement('div');
    shown.className = 'value'; shown.style.textAlign = 'left'; shown.id = 'f-' + variable.name;
    row.appendChild(shown);
    const hint = document.createElement('div');
    hint.className = 'hint'; hint.textContent = variable.hint || '';
    row.appendChild(hint);
  } else {
    const slider = document.createElement('input');
    slider.type = 'range'; slider.id = 'f-' + variable.name;
    slider.min = variable.min ?? 0; slider.max = variable.max ?? 1;
    slider.step = variable.step ?? (variable.kind === 'int' ? 1 : 0.001);
    const number = document.createElement('input');
    number.type = 'number'; number.className = 'value'; number.id = 'n-' + variable.name;
    number.step = slider.step;
    slider.oninput = () => { number.value = slider.value; };
    slider.onchange = () => vscode.postMessage({ type: 'set', name: variable.name, value: Number(slider.value) });
    number.onchange = () => {
      slider.value = number.value;
      vscode.postMessage({ type: 'set', name: variable.name, value: Number(number.value) });
    };
    row.appendChild(slider);
    row.appendChild(number);
  }
  return row;
}

const body = document.getElementById('body');
for (const group of spec.groups) {
  const heading = document.createElement('h2');
  heading.textContent = group.title;
  body.appendChild(heading);
  for (const variable of group.variables) body.appendChild(rowFor(variable));
}

const actions = document.getElementById('actions');
for (const action of (spec.actions || [])) {
  const button = document.createElement('button');
  button.textContent = action.label;
  button.title = action.hint || '';
  button.onclick = () => vscode.postMessage({ type: 'action', id: action.id });
  actions.appendChild(button);
}
const reload = document.createElement('button');
reload.textContent = 'reload from Snd';
reload.className = 'secondary';
reload.onclick = () => vscode.postMessage({ type: 'reload' });
actions.appendChild(reload);

function symbolFor(variable, value) {
  // An enum arrives as a number. Which option that is depends on this
  // build, which is why the numbers were resolved from it rather than
  // written down here.
  for (const option of variable.options || []) {
    if (/^-?\\d+(\\.\\d+)?$/.test(option.symbol)) {
      if (Number(option.symbol) === Number(value)) return option.symbol;
    } else if (constants[option.symbol] === Number(value)) {
      return option.symbol;
    }
  }
  return undefined;
}

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'values') {
    constants = message.constants || {};
    document.getElementById('error').textContent = '';
    const byName = new Map(message.values.map(entry => [entry.name, entry]));
    for (const group of spec.groups) {
      for (const variable of group.variables) {
        const entry = byName.get(variable.name);
        const row = document.getElementById('row-' + variable.name);
        const field = document.getElementById('f-' + variable.name);
        const number = document.getElementById('n-' + variable.name);
        if (!entry || !entry.available) {
          row.classList.add('off');
          if (field) field.disabled = true;
          if (number) number.disabled = true;
          row.title = entry ? (entry.reason || 'not available') : 'no answer';
          continue;
        }
        row.classList.remove('off');
        row.title = variable.name;
        if (field) field.disabled = false;
        if (number) number.disabled = false;
        if (variable.kind === 'bool') field.checked = !!entry.value;
        else if (variable.kind === 'enum') {
          const symbol = symbolFor(variable, entry.value);
          if (symbol !== undefined) field.value = symbol;
          else {
            // The build holds a value this panel has no option for. Say so
            // rather than snapping the list to something else, which would
            // look like the value and then become it on the next change.
            row.title = variable.name + ': Snd holds ' + entry.value + ', which is not in this list';
            row.classList.add('off');
          }
        }
        else if (variable.kind === 'string') field.value = entry.value ?? '';
        else if (variable.kind === 'readonly') field.textContent = String(entry.value ?? '');
        else { field.value = entry.value; if (number) number.value = entry.value; }
      }
    }
  } else if (message.type === 'error') {
    document.getElementById('error').textContent = message.message;
  } else if (message.type === 'note') {
    const box = document.getElementById('msg');
    box.textContent = message.note || '';
    setTimeout(() => { if (box.textContent === message.note) box.textContent = ''; }, 4000);
  }
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}
