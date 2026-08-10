// customUi.ts
//
// Renderer for UI declared by Scheme. Snd owns values and callback closures;
// this file owns only VS Code tree items, webview controls, and opaque ids.

import * as vscode from 'vscode';

export interface SndUiNode {
  id: string;
  kind: string;
  label: string;
  parent?: string | false;
  value?: unknown;
  minimum?: number | false;
  maximum?: number | false;
  step?: number | false;
  options?: unknown[];
  enabled?: boolean;
  visible?: boolean;
  managed?: boolean;
  description?: string;
}

export interface SndUiHost {
  snapshot(): Promise<SndUiNode[]>;
  action(id: string, action: string, value?: unknown): Promise<SndUiNode>;
  ready(): boolean;
}

export class SndCustomUi implements vscode.TreeDataProvider<SndUiNode> {
  private readonly nodes = new Map<string, SndUiNode>();
  private readonly changeEmitter = new vscode.EventEmitter<SndUiNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly panels = new Map<string, SndUiPanel>();

  constructor(private readonly host: SndUiHost) {}

  async reload(): Promise<void> {
    if (!this.host.ready()) {
      this.nodes.clear();
      this.changeEmitter.fire(undefined);
      return;
    }
    const snapshot = await this.host.snapshot();
    this.nodes.clear();
    for (const node of snapshot) this.nodes.set(node.id, node);
    this.reconcilePanels();
    this.changeEmitter.fire(undefined);
  }

  clear(): void {
    this.nodes.clear();
    for (const panel of this.panels.values()) panel.disposeFromSession();
    this.panels.clear();
    this.changeEmitter.fire(undefined);
  }

  handle(frame: any): void {
    const action = String(frame.action ?? '');
    if (action === 'remove') {
      const id = String(frame.id ?? '');
      this.removeTree(id);
    } else if (frame.widget && typeof frame.widget.id === 'string') {
      this.nodes.set(frame.widget.id, frame.widget as SndUiNode);
      this.panels.get(frame.widget.id)?.updateRoot(frame.widget as SndUiNode);
    }
    this.reconcilePanels();
    this.changeEmitter.fire(undefined);
    for (const panel of this.panels.values()) panel.refresh();
  }

  async invoke(id: string, action = 'click', value?: unknown): Promise<void> {
    try {
      const updated = await this.host.action(id, action, value);
      if (updated?.id) this.nodes.set(updated.id, updated);
      this.reconcilePanels();
      this.changeEmitter.fire(undefined);
      for (const panel of this.panels.values()) panel.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(`Snd UI: ${String((error as Error).message ?? error)}`);
    }
  }

  show(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if ((node.kind === 'dialog' || node.kind === 'instrument') && node.managed === false) {
      void this.invoke(id, 'open');
      return;
    }
    let panel = this.panels.get(id);
    if (!panel) {
      panel = new SndUiPanel(
        node,
        () => this.descendants(id),
        (widgetId, action, value) => this.invoke(widgetId, action, value),
        () => this.panels.delete(id)
      );
      this.panels.set(id, panel);
    } else {
      panel.reveal();
      panel.refresh();
    }
  }

  getTreeItem(node: SndUiNode): vscode.TreeItem {
    const children = this.children(node.id);
    const collapsible =
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label || node.kind, collapsible);
    item.id = `snd-ui:${node.id}`;
    item.description = node.description || undefined;
    item.tooltip = `${node.label || node.kind}\n${node.kind} · ${node.id}`;
    item.contextValue = `sndUi.${node.kind}`;
    item.iconPath = new vscode.ThemeIcon(iconFor(node.kind));
    if (node.enabled === false || node.visible === false) {
      item.description = [item.description, node.visible === false ? 'hidden' : 'disabled']
        .filter(Boolean)
        .join(' · ');
    }
    if (node.kind === 'menu-item' && node.enabled !== false) {
      item.command = {
        command: 'snd.ui.invoke',
        title: node.label,
        arguments: [node.id, 'click'],
      };
    } else if (node.kind === 'dialog' || node.kind === 'instrument') {
      item.command = {
        command: 'snd.ui.show',
        title: `Show ${node.label}`,
        arguments: [node.id],
      };
    }
    return item;
  }

  getChildren(node?: SndUiNode): SndUiNode[] {
    if (!this.host.ready()) return [];
    const result = node ? this.children(node.id) : this.roots();
    return result.filter(item => item.visible !== false && item.kind !== 'separator');
  }

  private roots(): SndUiNode[] {
    return [...this.nodes.values()].filter(
      node => !node.parent && ['menu', 'dialog', 'instrument'].includes(node.kind)
    );
  }

  private children(parent: string): SndUiNode[] {
    return [...this.nodes.values()].filter(node => node.parent === parent);
  }

  private descendants(parent: string): SndUiNode[] {
    const out: SndUiNode[] = [];
    const visit = (id: string) => {
      for (const child of this.children(id)) {
        out.push(child);
        visit(child.id);
      }
    };
    visit(parent);
    return out;
  }

  private removeTree(id: string): void {
    for (const child of this.children(id)) this.removeTree(child.id);
    this.nodes.delete(id);
    this.panels.get(id)?.disposeFromSession();
    this.panels.delete(id);
  }

  private reconcilePanels(): void {
    for (const node of this.nodes.values()) {
      if ((node.kind === 'dialog' || node.kind === 'instrument') && node.managed !== false) {
        this.show(node.id);
      }
    }
    for (const [id, panel] of this.panels) {
      const node = this.nodes.get(id);
      if (!node || node.managed === false || node.visible === false) {
        panel.disposeFromSession();
        this.panels.delete(id);
      }
    }
  }
}

class SndUiPanel {
  private readonly panel: vscode.WebviewPanel;
  private sessionDispose = false;

  constructor(
    private node: SndUiNode,
    private readonly children: () => SndUiNode[],
    private readonly invoke: (id: string, action: string, value?: unknown) => Promise<void>,
    private readonly disposed: () => void
  ) {
    this.panel = vscode.window.createWebviewPanel(
      `sndCustomUi.${node.id}`,
      `Snd: ${node.label}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(message => void this.onMessage(message));
    this.panel.onDidDispose(() => {
      if (!this.sessionDispose) void this.invoke(this.node.id, 'close');
      this.disposed();
    });
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  updateRoot(node: SndUiNode): void {
    this.node = node;
  }

  refresh(): void {
    void this.panel.webview.postMessage({
      type: 'model',
      root: this.node,
      nodes: this.children(),
    });
  }

  disposeFromSession(): void {
    this.sessionDispose = true;
    this.panel.dispose();
  }

  private async onMessage(message: any): Promise<void> {
    if (message?.type === 'ready') {
      this.refresh();
      return;
    }
    if (message?.type !== 'action') return;
    await this.invoke(String(message.id), String(message.action), message.value);
  }

  private html(): string {
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
  padding: 12px; font-size: 12px; }
h1 { font-size: 17px; margin: 0 0 4px; }
.description { opacity: .72; margin-bottom: 14px; }
.controls { display: grid; gap: 7px; }
.row { display: grid; grid-template-columns: minmax(130px, 220px) 1fr auto;
  gap: 9px; align-items: center; min-height: 25px; }
.row.hidden { display: none; } .row.disabled { opacity: .45; }
label { text-align: right; } input[type=range], input[type=text], select { width: 100%; }
input[type=text], input[type=number], select, textarea { box-sizing: border-box;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; }
button { border: none; padding: 5px 11px; cursor: pointer;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button:hover { background: var(--vscode-button-hoverBackground); }
.buttons { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 10px; }
.value { font-family: var(--vscode-editor-font-family); min-width: 60px; text-align: right; }
meter, progress { width: 100%; } textarea { min-height: 80px; resize: vertical; }
.group { border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; margin-top: 6px; }
.error { color: var(--vscode-errorForeground); min-height: 18px; margin-top: 8px; }
</style></head><body>
<h1 id="title">Snd</h1><div class="description" id="description"></div>
<div class="controls" id="controls"></div><div class="buttons" id="buttons"></div>
<div class="error" id="error"></div>
<script>
const vscode = acquireVsCodeApi();
const controls = document.getElementById('controls');
const buttons = document.getElementById('buttons');

function send(node, action, value) {
  vscode.postMessage({ type: 'action', id: node.id, action, value });
}
function text(value) {
  if (value === false || value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
function controlFor(node) {
  const row = document.createElement('div'); row.className = 'row';
  if (node.visible === false) row.classList.add('hidden');
  if (node.enabled === false) row.classList.add('disabled');
  const label = document.createElement('label'); label.textContent = node.label || node.kind;
  row.appendChild(label);
  let input;
  if (node.kind === 'slider') {
    input = document.createElement('input'); input.type = 'range';
    input.min = Number(node.minimum ?? 0); input.max = Number(node.maximum ?? 1);
    input.step = Number(node.step ?? 1); input.value = Number(node.value ?? 0);
    const shown = document.createElement('span'); shown.className = 'value'; shown.textContent = input.value;
    input.oninput = () => shown.textContent = input.value;
    input.onchange = () => send(node, 'change', Number(input.value));
    row.append(input, shown);
  } else if (node.kind === 'toggle') {
    input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!node.value;
    input.onchange = () => send(node, 'change', input.checked);
    row.append(input, document.createElement('span'));
  } else if (node.kind === 'select') {
    input = document.createElement('select');
    for (const option of node.options || []) {
      const el = document.createElement('option');
      if (typeof option === 'object' && option) {
        el.value = String(option.value ?? option.label ?? ''); el.textContent = String(option.label ?? option.value ?? '');
      } else { el.value = String(option); el.textContent = String(option); }
      input.appendChild(el);
    }
    input.value = String(node.value ?? ''); input.onchange = () => send(node, 'change', input.value);
    row.append(input, document.createElement('span'));
  } else if (node.kind === 'envelope') {
    input = document.createElement('textarea'); input.value = text(node.value);
    input.onchange = () => { try { send(node, 'change', JSON.parse(input.value)); }
      catch { send(node, 'change', input.value); } };
    row.append(input, document.createElement('span'));
  } else if (node.kind === 'meter') {
    input = document.createElement('meter'); input.min = Number(node.minimum ?? 0);
    input.max = Number(node.maximum ?? 1); input.value = Number(node.value ?? 0);
    const shown = document.createElement('span'); shown.className = 'value'; shown.textContent = text(node.value);
    row.append(input, shown);
  } else if (node.kind === 'graph') {
    input = document.createElement('pre'); input.textContent = text(node.value);
    row.append(input, document.createElement('span'));
  } else if (node.kind === 'button') {
    const button = document.createElement('button'); button.textContent = node.label;
    button.disabled = node.enabled === false; button.onclick = () => send(node, 'click', node.value);
    buttons.appendChild(button); return;
  } else if (node.kind === 'separator') {
    const sep = document.createElement('div'); sep.className = 'group'; controls.appendChild(sep); return;
  } else {
    input = document.createElement('input'); input.type = 'text'; input.value = text(node.value);
    input.onchange = () => send(node, 'change', input.value);
    row.append(input, document.createElement('span'));
  }
  if (input) input.disabled = node.enabled === false;
  controls.appendChild(row);
}
window.addEventListener('message', event => {
  const message = event.data; if (message.type !== 'model') return;
  document.getElementById('title').textContent = message.root.label || 'Snd';
  document.getElementById('description').textContent = message.root.description || '';
  controls.replaceChildren(); buttons.replaceChildren();
  for (const node of message.nodes || []) controlFor(node);
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}

function iconFor(kind: string): string {
  switch (kind) {
    case 'menu': return 'menu';
    case 'menu-item': return 'run';
    case 'dialog': return 'settings-gear';
    case 'instrument': return 'pulse';
    case 'slider': return 'settings';
    case 'toggle': return 'check';
    default: return 'symbol-field';
  }
}
