// soundExplorer.ts
//
// The tree in the side bar: which sounds are open, their channels, their
// marks, their edit history.
//
// This replaces three separate Snd dialogs (Files, Regions, Edit History)
// with one tree, and the reason is not tidiness.  In Snd those dialogs are
// windows that have to be found and arranged; here the state of the
// session is visible without asking for it, which matters most for the
// edit history -- the one piece of Snd state that is easy to lose track
// of and expensive to lose.

import * as vscode from 'vscode';

export interface Sound {
  index: number;
  selected?: boolean;
  empty?: boolean;
  fileName: string;
  shortName: string;
  channels: number;
  frames: number;
  srate: number;
  editPosition: number;
  edited: boolean;
}

export interface EditHistory {
  position: number;
  undoable: number;
  redoable: number;
  list: Array<{ position: number; origin: string; type: string; start: number; frames: number }>;
}

export interface ExplorerHost {
  sounds(): Promise<Sound[]>;
  marks(snd: number, chn: number): Promise<Array<{ id: number; sample: number; name: string }>>;
  edits(snd: number, chn: number): Promise<EditHistory>;
  ready(): boolean;
}

type Node =
  | { kind: 'hint'; text: string }
  | { kind: 'sound'; sound: Sound }
  | { kind: 'channel'; sound: Sound; chn: number }
  | { kind: 'marks'; sound: Sound; chn: number }
  | { kind: 'mark'; sound: Sound; chn: number; id: number; sample: number; name: string }
  | { kind: 'history'; sound: Sound; chn: number }
  | { kind: 'edit'; sound: Sound; chn: number; position: number; label: string; current: boolean };

export class SoundExplorer implements vscode.TreeDataProvider<Node> {
  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly host: ExplorerHost) {}

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    switch (node.kind) {
      case 'hint': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
      case 'sound': {
        const item = new vscode.TreeItem(node.sound.shortName, collapsed);
        item.description =
          `${node.sound.channels} ch · ${(node.sound.frames / Math.max(1, node.sound.srate)).toFixed(2)} s` +
          (node.sound.edited ? ` · edited (${node.sound.editPosition})` : '');
        item.tooltip = node.sound.fileName;
        item.iconPath = new vscode.ThemeIcon(node.sound.edited ? 'circle-filled' : 'file-media');
        item.contextValue = 'sndSound';
        item.id = `sound:${node.sound.index}`;
        return item;
      }
      case 'channel': {
        const item = new vscode.TreeItem(`channel ${node.chn}`, collapsed);
        item.iconPath = new vscode.ThemeIcon('graph-line');
        item.contextValue = 'sndChannel';
        item.id = `channel:${node.sound.index}:${node.chn}`;
        // Clicking a channel opens the waveform. That is the whole point
        // of the tree, so it is the default action and not a context menu
        // entry.
        item.command = {
          command: 'snd.showWaveform',
          title: 'Show waveform',
          arguments: [node.sound.index, node.chn],
        };
        return item;
      }
      case 'marks': {
        const item = new vscode.TreeItem('marks', collapsed);
        item.iconPath = new vscode.ThemeIcon('bookmark');
        item.id = `marks:${node.sound.index}:${node.chn}`;
        return item;
      }
      case 'mark': {
        const item = new vscode.TreeItem(node.name || `mark ${node.id}`);
        item.description = String(node.sample);
        item.iconPath = new vscode.ThemeIcon('bookmark');
        item.command = {
          command: 'snd.goToSample',
          title: 'Go to mark',
          arguments: [node.sound.index, node.chn, node.sample],
        };
        return item;
      }
      case 'history': {
        const item = new vscode.TreeItem('edit history', collapsed);
        item.iconPath = new vscode.ThemeIcon('history');
        item.id = `history:${node.sound.index}:${node.chn}`;
        return item;
      }
      case 'edit': {
        const item = new vscode.TreeItem(node.label);
        item.description = node.current ? 'current' : '';
        item.iconPath = new vscode.ThemeIcon(node.current ? 'debug-stackframe' : 'circle-small');
        item.command = {
          command: 'snd.goToEdit',
          title: 'Go to this edit',
          arguments: [node.sound.index, node.chn, node.position],
        };
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!this.host.ready()) {
      return [{ kind: 'hint', text: 'No Snd session — run "Snd: Start".' }];
    }
    try {
      if (!node) {
        const sounds = await this.host.sounds();
        if (sounds.length === 0) {
          return [{ kind: 'hint', text: 'No sound open — run "Snd: Open Sound File".' }];
        }
        return sounds.map(sound => ({ kind: 'sound' as const, sound }));
      }
      if (node.kind === 'sound') {
        // A one-channel sound has no channel level worth clicking through:
        // its marks and history go straight under the file.
        if (node.sound.channels <= 1) {
          return [
            { kind: 'channel', sound: node.sound, chn: 0 },
            { kind: 'marks', sound: node.sound, chn: 0 },
            { kind: 'history', sound: node.sound, chn: 0 },
          ];
        }
        const out: Node[] = [];
        for (let chn = 0; chn < node.sound.channels; chn++) {
          out.push({ kind: 'channel', sound: node.sound, chn });
        }
        return out;
      }
      if (node.kind === 'channel' && node.sound.channels > 1) {
        return [
          { kind: 'marks', sound: node.sound, chn: node.chn },
          { kind: 'history', sound: node.sound, chn: node.chn },
        ];
      }
      if (node.kind === 'channel') return [];
      if (node.kind === 'marks') {
        const marks = await this.host.marks(node.sound.index, node.chn);
        if (marks.length === 0) return [{ kind: 'hint', text: 'no marks' }];
        return marks.map(mark => ({
          kind: 'mark' as const,
          sound: node.sound,
          chn: node.chn,
          id: mark.id,
          sample: mark.sample,
          name: mark.name,
        }));
      }
      if (node.kind === 'history') {
        const history = await this.host.edits(node.sound.index, node.chn);
        return history.list.map(edit => ({
          kind: 'edit' as const,
          sound: node.sound,
          chn: node.chn,
          position: edit.position,
          label:
            edit.position === 0
              ? 'the file as it was read'
              : `${edit.origin || edit.type} @ ${edit.start} (${edit.frames})`,
          current: edit.position === history.position,
        }));
      }
      return [];
    } catch (error) {
      return [{ kind: 'hint', text: String((error as Error).message ?? error) }];
    }
  }
}
