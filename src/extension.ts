// extension.ts
//
// Wiring.  One session object owns the process and the bridge and serves
// as the host for the panels, the tree and the REPL, so that all of them
// speak to the SAME s7 -- that is the whole design in one sentence, and
// the reason there is no second connection anywhere in this file.

import * as path from 'path';
import * as vscode from 'vscode';

import {
  Bridge,
  splitTopLevelForms,
  enclosingForm,
  precedingForm,
  schemeString,
} from './bridge';
import { SndProcess, SndMode, SndStatus, resolveExecutable } from './sndProcess';
import * as fs from 'fs';
import { SndReplTerminal } from './replTerminal';
import { WaveformView, Waveform } from './waveformView';
import { SpectrumView, Spectrum, Sonogram } from './spectrumView';
import { SoundExplorer, Sound, EditHistory } from './soundExplorer';
import { SndHelpProvider, StaticIndex } from './helpProvider';
import { DialogPanel, VariableValue } from './dialogPanel';
import {
  CONTROLS_DIALOG,
  PREFERENCES_DIALOG,
  TRANSFORM_DIALOG,
  VIEW_DIALOG,
} from './sndVariables';

class SndSession {
  readonly log = vscode.window.createOutputChannel('Snd');
  private readonly process: SndProcess;
  readonly bridge: Bridge;
  private readyPromise: Promise<void> | undefined;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private statusItem: vscode.StatusBarItem;

  onSoundsChanged: () => void = () => undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.bridge = new Bridge(line => {
      if (!this.process.send(line)) {
        throw new Error('No Snd session — run "Snd: Start".');
      }
    });

    this.bridge.on('log', (text: string) => this.log.append(text));
    this.bridge.on('event', (frame: any) => this.onEvent(frame));
    this.bridge.on('orphan', (frame: any) =>
      this.log.appendLine(
        `[snd-vscode] late answer to request ${frame.id} (${frame.op}) — ` +
          'the timeout is too short for this operation.'
      )
    );

    this.process = new SndProcess({
      // Snd's own stdout is what a human would see in the listener. It
      // goes to the REPL terminal, because that is what the terminal IS:
      // the inferior process, not a second view of it.
      onStdout: text => {
        SndReplTerminal.passThrough(text);
        this.log.append(text);
      },
      onStderr: text => this.bridge.feed(text),
      onExit: () => {
        this.bridge.rejectAll(new Error('Snd has ended.'));
        this.rejectReady?.(new Error('Snd ended before it was ready.'));
        this.readyPromise = undefined;
        this.onSoundsChanged();
      },
      onStatus: (status, detail) => this.onStatus(status, detail),
    });

    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusItem.command = 'snd.showStatus';
    this.statusItem.text = '$(circle-outline) Snd';
    this.statusItem.tooltip = 'No Snd session';
    this.statusItem.show();
    context.subscriptions.push(this.statusItem, this.log);
  }

  private onStatus(status: SndStatus, detail: string): void {
    this.log.appendLine(`[snd-vscode] ${status}${detail ? ': ' + detail : ''}`);
    const icons: Record<SndStatus, string> = {
      stopped: '$(circle-outline)',
      starting: '$(sync~spin)',
      ready: '$(circle-filled)',
      error: '$(error)',
    };
    const mode = this.process.reportedMode ? ` (${this.process.reportedMode})` : '';
    this.statusItem.text = `${icons[status]} Snd${status === 'ready' ? mode : ''}`;
    this.statusItem.tooltip = detail || status;
    if (status === 'error') {
      this.rejectReady?.(new Error(detail));
      this.readyPromise = undefined;
      void vscode.window.showErrorMessage(`Snd: ${detail}`);
    }
  }

  private onEvent(frame: any): void {
    switch (frame.event) {
      case 'ready':
        this.process.markReady(frame.mode === 'gui' ? 'gui' : 'nogui');
        this.resolveReady?.();
        this.onSoundsChanged();
        break;
      case 'opened':
      case 'closed':
        this.onSoundsChanged();
        break;
      case 'edited':
        // One event per edit, and an edit can be one sample. So the event
        // says only THAT something changed; the panels then ask for what
        // they need. Sending the change itself would be a waveform per
        // keystroke.
        this.onSoundsChanged();
        WaveformView.refresh();
        SpectrumView.refresh();
        // The control panel too: apply-controls moves the edit position,
        // and Snd resets the controls to neutral when it does.
        DialogPanel.refreshAll();
        break;
      case 'playing':
        this.playEvents++;
        WaveformView.playhead(Number(frame.frame));
        break;
      case 'stopped':
        WaveformView.playhead(undefined);
        break;
      case 'protocol-error':
        this.log.appendLine(`[snd-vscode] Snd could not read a request: ${frame.line}`);
        break;
      default:
        this.log.appendLine(`[snd-vscode] event ${frame.event}`);
    }
  }

  ready(): boolean {
    return this.process.status === 'ready';
  }

  get mode(): string {
    return this.process.reportedMode ?? 'unknown';
  }

  async start(files: string[] = []): Promise<void> {
    if (this.ready()) return;
    if (this.readyPromise) return this.readyPromise;

    const settings = vscode.workspace.getConfiguration('snd');
    const mode = (settings.get<string>('mode') ?? 'auto') as SndMode;
    const resolved = resolveExecutable({
      configured: settings.get<string>('path') ?? 'snd',
      mode,
      bundleRoot: path.join(this.context.extensionPath, 'bin'),
      platform: process.platform,
      arch: process.arch,
      exists: candidate => fs.existsSync(candidate),
    });
    const command = resolved.command;
    this.log.appendLine(`[snd-vscode] Snd from ${resolved.source}: ${command}`);
    const args = settings.get<string[]>('args') ?? [];
    const bridgePath = path.join(this.context.extensionPath, 'scheme', 'snd-vscode.scm');
    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(bridgePath);

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      // Snd's startup is not instant -- it reads ~/.snd, opens the audio
      // device and in the Motif case builds a window. A timeout that is
      // too tight reports an error for a session that then comes up
      // anyway, which is worse than waiting.
      setTimeout(() => {
        if (!this.ready()) reject(new Error('Snd did not report itself ready within 30 s.'));
      }, 30000);
    });

    this.process.start({ command, args, cwd, bridgePath, mode, files });
    return this.readyPromise;
  }

  stop(): void {
    this.process.stop();
  }

  async restart(): Promise<void> {
    this.stop();
    await new Promise(resolve => setTimeout(resolve, 800));
    this.readyPromise = undefined;
    await this.start();
  }

  private async ensure(): Promise<void> {
    if (!this.ready()) await this.start();
  }

  // --- host interfaces ------------------------------------------------

  async evaluate(code: string): Promise<{ value: string; output: string }> {
    await this.ensure();
    return this.bridge.evaluate(code);
  }

  async complete(prefix: string): Promise<string[]> {
    if (!this.ready()) return [];
    const candidates = await this.bridge.request<Array<{ name: string }>>('completions', {
      prefix,
    });
    return candidates.map(candidate => candidate.name);
  }

  completions(prefix: string): Promise<Array<{ name: string; kind: string }>> {
    return this.bridge.request('completions', { prefix });
  }

  help(name: string): Promise<any> {
    return this.bridge.request('help', { name });
  }

  sounds(): Promise<Sound[]> {
    return this.bridge.request('sounds');
  }

  marks(snd: number, chn: number): Promise<Array<{ id: number; sample: number; name: string }>> {
    return this.bridge.request('marks', { snd, chn });
  }

  edits(snd: number, chn: number): Promise<EditHistory> {
    return this.bridge.request('edits', { snd, chn });
  }

  waveform(params: {
    snd: number;
    chns: string;
    start: number;
    dur: number;
    columns: number;
  }): Promise<Waveform> {
    // 'waveforms', plural: all requested channels over ONE range, decided in
    // Snd. Looping here instead would let the lanes drift apart during a
    // drag, and lanes showing different windows of time invent phase
    // differences between channels.
    return this.bridge.request('waveforms', params);
  }

  spectrum(params: {
    snd: number;
    chn: number;
    start: number;
    size: number;
    linear: boolean;
    window: string;
  }): Promise<Spectrum> {
    return this.bridge.request('spectrum', params);
  }

  async cursorOf(snd: number, chn: number): Promise<number> {
    const result = await this.bridge.evaluate(`(cursor ${snd} ${chn})`);
    const value = Number(result.value);
    return Number.isFinite(value) ? value : 0;
  }

  async setCursor(snd: number, chn: number, sample: number): Promise<void> {
    await this.bridge.request('cursor', { snd, chn, sample });
    SpectrumView.refresh();
  }

  async setSelection(snd: number, chn: number, start: number, frames: number): Promise<void> {
    await this.bridge.request('select', { snd, chn, start, frames });
  }

  async play(snd: number, chn: number, start: number, end?: number): Promise<void> {
    await this.bridge.request('play', { snd, chn, start, end });
    // If the playhead never moves, the reason is almost always that this
    // build has no working audio device — play returns without error and
    // simply produces nothing. Saying so beats a silent still playhead,
    // which reads as a bug in the panel.
    const before = this.playEvents;
    setTimeout(() => {
      if (this.playEvents === before) {
        this.log.appendLine(
          '[snd-vscode] play was accepted but no playback position arrived. ' +
            'This Snd may have no working audio output; everything except play ' +
            'works regardless.'
        );
      }
    }, 1500);
  }

  /** Counted only so that a silent playhead can be explained. */
  playEvents = 0;

  async stopPlaying(): Promise<void> {
    await this.bridge.request('stop');
  }

  async edit(action: string, snd: number, chn: number): Promise<void> {
    await this.bridge.request('edit', { action, snd, chn });
    DialogPanel.refreshAll();
  }

  async scale(params: {
    snd: number;
    chn: number;
    factor?: number;
    peak?: number;
    selection?: boolean;
  }): Promise<void> {
    await this.bridge.request('scale', params);
  }

  async resample(snd: number, chn: number, ratio: number, selection: boolean): Promise<void> {
    await this.bridge.request('resample', { snd, chn, ratio, selection });
  }

  async saveSelection(file: string): Promise<void> {
    await this.bridge.request('saveselection', { file });
  }

  async undo(snd: number, chn: number): Promise<void> {
    await this.bridge.request('undo', { snd, chn, count: 1 });
  }

  async redo(snd: number, chn: number): Promise<void> {
    await this.bridge.request('redo', { snd, chn, count: 1 });
  }

  async open(file: string): Promise<number> {
    await this.ensure();
    const result = await this.bridge.request<{ snd: number }>('open', { file });
    return result.snd;
  }

  status(): Promise<any> {
    return this.bridge.request('status');
  }

  // --- the dialogs ----------------------------------------------------

  getVariables(names: string[], snd: number): Promise<VariableValue[]> {
    // One request for the whole dialog. Forty requests would each be a
    // round trip and the panel would visibly fill in.
    return this.bridge.request('getvars', { names: names.join(' '), snd });
  }

  async setVariable(
    name: string,
    literal: string,
    via: string | undefined,
    snd: number
  ): Promise<void> {
    await this.bridge.request('setvar', { name, value: literal, via, snd });
  }

  constants(names: string[]): Promise<VariableValue[]> {
    return this.bridge.request('constants', { names: names.join(' ') });
  }

  async dialogAction(id: string, snd: number): Promise<string> {
    if (id === 'applycontrols') {
      const result = await this.bridge.request<{ editPosition: number }>('applycontrols', { snd });
      WaveformView.refresh();
      return `applied — edit position ${result.editPosition}`;
    }
    if (id === 'resetcontrols') {
      // reset-controls is Snd's own, so the neutral values are Snd's
      // notion of neutral and not a list of ours that would go stale.
      await this.bridge.evaluate(`(reset-controls ${snd})`);
      return 'controls reset';
    }
    return '';
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const session = new SndSession(context);

  const index = new StaticIndex();
  index.load(path.join(context.extensionPath, 'data', 'snd-index.json'));

  const explorer = new SoundExplorer(session);
  const tree = vscode.window.createTreeView('sndSounds', { treeDataProvider: explorer });
  context.subscriptions.push(tree);

  // Coalesced: after-edit-hook fires per edit, and refreshing the tree per
  // edit means a request per keystroke of a Scheme loop.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  session.onSoundsChanged = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => explorer.refresh(), 120);
  };

  const replHost = {
    evaluate: (code: string) => session.evaluate(code),
    complete: (prefix: string) => session.complete(prefix),
    ready: () => session.ready(),
    start: () => session.start(),
  };

  const waveformHost = {
    waveform: (params: any) => session.waveform(params),
    sounds: () => session.sounds(),
    setCursor: (snd: number, chn: number, sample: number) => session.setCursor(snd, chn, sample),
    setSelection: (snd: number, chn: number, start: number, frames: number) =>
      session.setSelection(snd, chn, start, frames),
    play: (snd: number, chn: number, start: number, end?: number) =>
      session.play(snd, chn, start, end),
    stop: () => session.stopPlaying(),
    undo: (snd: number, chn: number) => session.undo(snd, chn),
    redo: (snd: number, chn: number) => session.redo(snd, chn),
    edit: (action: string, snd: number, chn: number) => session.edit(action, snd, chn),
  };

  const spectrumHost = {
    sonogram: (params: any) => session.bridge.request<Sonogram>('sonogram', params),
    spectrum: (params: any) => session.spectrum(params),
    cursorOf: (snd: number, chn: number) => session.cursorOf(snd, chn),
  };

  const dialogHost = {
    getVariables: (names: string[], snd: number) => session.getVariables(names, snd),
    setVariable: (name: string, literal: string, via: string | undefined, snd: number) =>
      session.setVariable(name, literal, via, snd),
    constants: (names: string[]) => session.constants(names),
    action: (id: string, snd: number) => session.dialogAction(id, snd),
    ready: () => session.ready(),
  };

  const selector: vscode.DocumentSelector = [
    { language: 'scheme' },
    { pattern: '**/*.scm' },
  ];
  const help = new SndHelpProvider(session, index);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, help),
    vscode.languages.registerCompletionItemProvider(selector, help, '-', '>', '*', '?'),
    vscode.languages.registerSignatureHelpProvider(selector, help, ' ', '(')
  );

  const command = (name: string, handler: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));

  const guard = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      void vscode.window.showErrorMessage(`Snd: ${String((error as Error).message ?? error)}`);
    }
  };

  command('snd.start', () => guard(async () => { await session.start(); }));
  command('snd.stop', () => session.stop());
  command('snd.restart', () => guard(() => session.restart()));
  command('snd.openLog', () => session.log.show());
  command('snd.openRepl', () => { SndReplTerminal.show(replHost); });

  command('snd.showStatus', () =>
    guard(async () => {
      if (!session.ready()) {
        const answer = await vscode.window.showInformationMessage(
          'No Snd session.',
          'Start'
        );
        if (answer === 'Start') await session.start();
        return;
      }
      const status = await session.status();
      void vscode.window.showInformationMessage(
        `${status.sndVersion} · s7 ${status.s7Version} · ` +
          `${status.gui ? 'with GUI' : 'headless'} · protocol ${status.protocol}`
      );
    })
  );

  // --- evaluation, the inf-snd.el set ---------------------------------

  command('snd.evalSelection', () =>
    guard(async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const text = editor.selection.isEmpty
        ? editor.document.lineAt(editor.selection.active.line).text
        : editor.document.getText(editor.selection);
      if (text.trim()) await SndReplTerminal.evaluate(replHost, text.trim());
    })
  );

  command('snd.evalTopLevel', () =>
    guard(async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const text = editor.document.getText();
      const offset = editor.document.offsetAt(editor.selection.active);
      const form = enclosingForm(text, offset);
      if (!form) {
        void vscode.window.showInformationMessage('No top-level form at the cursor.');
        return;
      }
      await SndReplTerminal.evaluate(replHost, text.slice(form.start, form.end));
    })
  );

  command('snd.evalFile', () =>
    guard(async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      // Form by form, not as one block: Snd evaluates ONE expression per
      // request, so a file sent whole would run its first form and
      // silently drop the rest.
      const forms = splitTopLevelForms(editor.document.getText());
      const repl = SndReplTerminal.show(replHost);
      void repl;
      for (const form of forms) {
        await SndReplTerminal.evaluate(replHost, form);
      }
    })
  );

  // SLIME's C-x C-e: the form that just ended, not the one around the
  // cursor. The two differ exactly where the hands are — after a closing
  // paren — and that is why SLIME has both.
  command('snd.evalLastExpression', () =>
    guard(async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const text = editor.document.getText();
      const form = precedingForm(text, editor.document.offsetAt(editor.selection.active));
      if (!form) {
        void vscode.window.showInformationMessage('No form before the cursor.');
        return;
      }
      await SndReplTerminal.evaluate(replHost, text.slice(form.start, form.end));
    })
  );

  // SLIME's C-c C-p: the result into the buffer, as a comment.
  //
  // Written as a comment and not as bare text, which SLIME does too: the
  // file stays loadable. A result pasted in as code turns a working file
  // into one that fails on the next load, and the failure is at the line
  // one was experimenting on, which is the last place one looks.
  command('snd.evalPrint', () =>
    guard(async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const text = editor.document.getText();
      const offset = editor.document.offsetAt(editor.selection.active);
      const form = precedingForm(text, offset);
      if (!form) return;
      const result = await session.evaluate(text.slice(form.start, form.end));
      const printed = (result.output ? result.output.trim() + ' ' : '') + result.value;
      const position = editor.document.positionAt(form.end);
      await editor.edit(builder => {
        builder.insert(position, ` ; => ${printed.replace(/\r?\n/g, ' ')}`);
      });
    })
  );

  // SLIME's M-. -- as far as s7 allows.
  //
  // NOT a jump to a file. Snd's own functions are C, so they have no Scheme
  // source and no line to jump to; what s7 can give is the SOURCE of a
  // closure, which for anything the user defined is the useful half of M-.
  // and for a built-in is nothing. Saying which of the two happened is
  // better than a jump that silently lands nowhere.
  command('snd.showSource', () =>
    guard(async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const range = editor.document.getWordRangeAtPosition(
        editor.selection.active,
        /[^\s()'"`;]+/
      );
      const name = range ? editor.document.getText(range) : '';
      if (!name) return;
      const result = await session.evaluate(
        `(let ((v (and (defined? '${name}) ${name})))` +
          ` (if (procedure? v) (or (procedure-source v) 'built-in) 'not-a-procedure))`
      );
      if (/built-in/.test(result.value)) {
        void vscode.window.showInformationMessage(
          `${name} is built into Snd — no Scheme source. Its help is on C-c C-d C-d.`
        );
        return;
      }
      if (/not-a-procedure|#f/.test(result.value)) {
        void vscode.window.showInformationMessage(`${name} is not a procedure in this session.`);
        return;
      }
      const document = await vscode.workspace.openTextDocument({
        content: `;;; ${name} — source as the running Snd has it\n\n${result.value}\n`,
        language: 'scheme',
      });
      await vscode.window.showTextDocument(document, { preview: true });
    })
  );

  command('snd.loadFile', () =>
    guard(async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (editor.document.isDirty) await editor.document.save();
      // (load ...) rather than sending the text: that way Snd reports
      // errors with the FILE and the line, which is the whole difference
      // between a usable error message and "error somewhere".
      // schemeString, not JSON.stringify: see the note there. A path is
      // the most likely place for the difference to bite, because a path
      // is the one string here that comes from outside.
      await SndReplTerminal.evaluate(
        replHost,
        `(load ${schemeString(editor.document.uri.fsPath)})`
      );
    })
  );

  // --- sounds ---------------------------------------------------------

  command('snd.openSound', () =>
    guard(async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { Sounds: ['wav', 'aiff', 'aif', 'snd', 'au', 'flac', 'caf', 'w64'] },
      });
      if (!picked || picked.length === 0) return;
      const snd = await session.open(picked[0].fsPath);
      explorer.refresh();
      WaveformView.show(waveformHost, snd, 0);
    })
  );

  command('snd.showWaveform', (snd?: number, chn?: number) =>
    guard(async () => {
      if (!session.ready()) await session.start();
      if (snd === undefined) {
        const sounds = await session.sounds();
        if (sounds.length === 0) {
          void vscode.window.showInformationMessage(
            'No sound open — run "Snd: Open Sound File".'
          );
          return;
        }
        // Not sounds[0]. Snd's own notion of the current sound first, then
        // the last one opened, and an empty one only if there is nothing
        // else. (new-sound) leaves an EMPTY sound at index 0, so taking the
        // first would show a blank graph immediately after generating a
        // sound — which reads as a broken panel rather than an empty file.
        const withData = sounds.filter(sound => !sound.empty);
        const candidates = withData.length > 0 ? withData : sounds;
        const chosen =
          candidates.find(sound => sound.selected) ?? candidates[candidates.length - 1];
        snd = chosen.index;
        chn = 0;
      }
      WaveformView.show(waveformHost, snd, chn ?? 0);
    })
  );

  command('snd.showSpectrum', (snd?: number, chn?: number) =>
    guard(async () => {
      if (!session.ready()) await session.start();
      SpectrumView.show(spectrumHost, snd ?? 0, chn ?? 0);
    })
  );

  command('snd.goToSample', (snd: number, chn: number, sample: number) =>
    guard(async () => {
      await session.setCursor(snd, chn, sample);
      WaveformView.show(waveformHost, snd, chn);
      WaveformView.refresh();
    })
  );

  command('snd.goToEdit', (snd: number, chn: number, position: number) =>
    guard(async () => {
      // set-edit-position rather than undo/redo counting: the tree shows
      // absolute positions, and computing a relative number from them is
      // an arithmetic step that can only be wrong.
      await session.evaluate(`(set! (edit-position ${snd} ${chn}) ${position})`);
      explorer.refresh();
      WaveformView.refresh();
    })
  );

  command('snd.play', () =>
    guard(async () => {
      const sounds = await session.sounds();
      if (sounds.length === 0) return;
      await session.play(sounds[0].index, 0, 0);
    })
  );

  command('snd.stopPlaying', () => guard(() => session.stopPlaying()));

  command('snd.saveSound', () =>
    guard(async () => {
      const sounds = await session.sounds();
      if (sounds.length === 0) return;
      await session.evaluate(`(save-sound ${sounds[0].index})`);
      explorer.refresh();
    })
  );

  command('snd.saveState', () =>
    guard(async () => {
      // The session cannot survive a window reload -- the channel is the
      // pipe, so there is nothing to reconnect to. save-state is what CAN
      // survive it: a Scheme file that rebuilds the sounds and their edit
      // history. Offered as a command rather than pretended to be
      // automatic.
      const target = await vscode.window.showSaveDialog({
        filters: { Scheme: ['scm'] },
        saveLabel: 'Save Snd state',
      });
      if (!target) return;
      await session.evaluate(`(save-state ${schemeString(target.fsPath)})`);
      void vscode.window.showInformationMessage(`Snd state written to ${target.fsPath}`);
    })
  );

  command('snd.help', () =>
    guard(async () => {
      const editor = vscode.window.activeTextEditor;
      const suggestion = editor
        ? editor.document.getText(
            editor.document.getWordRangeAtPosition(editor.selection.active, /[^\s()'"`;]+/) ??
              editor.selection
          )
        : '';
      const name = await vscode.window.showInputBox({
        prompt: 'Snd help for',
        value: suggestion,
      });
      if (!name) return;
      const help = await session.help(name);
      if (!help.help && !help.documentation) {
        void vscode.window.showInformationMessage(`Snd knows no help for ${name}.`);
        return;
      }
      const document = await vscode.workspace.openTextDocument({
        content: `${name}\n\n${help.signature ? help.signature + '\n\n' : ''}${
          help.help || help.documentation
        }\n`,
        language: 'text',
      });
      await vscode.window.showTextDocument(document, { preview: true });
    })
  );

  command('snd.apropos', () =>
    guard(async () => {
      const text = await vscode.window.showInputBox({ prompt: 'Snd apropos' });
      if (!text) return;
      const names = await session.bridge.request<string[]>('apropos', { text });
      const picked = await vscode.window.showQuickPick(names, {
        placeHolder: `${names.length} matches`,
      });
      if (picked) await vscode.commands.executeCommand('snd.helpFor', picked);
    })
  );

  command('snd.helpFor', (name: string) =>
    guard(async () => {
      const help = await session.help(name);
      const document = await vscode.workspace.openTextDocument({
        content: `${name}\n\n${help.help || help.documentation}\n`,
        language: 'text',
      });
      await vscode.window.showTextDocument(document, { preview: true });
    })
  );

  // --- the dialogs, one command each ----------------------------------

  const openDialog = (spec: typeof TRANSFORM_DIALOG, needsSound: boolean) =>
    guard(async () => {
      if (!session.ready()) await session.start();
      let snd = 0;
      if (needsSound) {
        const sounds = await session.sounds();
        if (sounds.length === 0) {
          void vscode.window.showInformationMessage(
            `${spec.title} works on a sound — open one first ("Snd: Open Sound File").`
          );
          return;
        }
        snd = sounds[0].index;
      }
      DialogPanel.show(dialogHost, spec, snd);
    });

  command('snd.transformOptions', () => openDialog(TRANSFORM_DIALOG, false));
  command('snd.controlPanel', () => openDialog(CONTROLS_DIALOG, true));
  command('snd.viewOptions', () => openDialog(VIEW_DIALOG, false));
  command('snd.preferences', () => openDialog(PREFERENCES_DIALOG, false));

  // --- the Edit menu ---------------------------------------------------

  const firstSound = async (): Promise<number | undefined> => {
    if (!session.ready()) await session.start();
    const sounds = await session.sounds();
    if (sounds.length === 0) {
      void vscode.window.showInformationMessage('No sound open.');
      return undefined;
    }
    return sounds[0].index;
  };

  for (const action of [
    'delete',
    'delete-smooth',
    'insert',
    'mix',
    'reverse',
    'smooth',
    'select-all',
    'unselect-all',
  ]) {
    const name = 'snd.edit.' + action;
    context.subscriptions.push(
      vscode.commands.registerCommand(name, () =>
        guard(async () => {
          const snd = await firstSound();
          if (snd === undefined) return;
          await session.edit(action, snd, 0);
          WaveformView.refresh();
          explorer.refresh();
        })
      )
    );
  }

  command('snd.scale', () =>
    guard(async () => {
      const snd = await firstSound();
      if (snd === undefined) return;
      const answer = await vscode.window.showInputBox({
        prompt: 'Scale by a factor, or "to 0.9" for a peak',
        value: '0.5',
      });
      if (!answer) return;
      const toPeak = /^\s*to\s+([\d.]+)\s*$/.exec(answer);
      const selection = await vscode.window.showQuickPick(['selection', 'whole channel'], {
        placeHolder: 'apply to',
      });
      if (!selection) return;
      const onSelection = selection === 'selection';
      if (toPeak) {
        await session.scale({ snd, chn: 0, peak: Number(toPeak[1]), selection: onSelection });
      } else {
        const factor = Number(answer);
        if (!Number.isFinite(factor)) {
          void vscode.window.showErrorMessage(`Not a factor: ${answer}`);
          return;
        }
        await session.scale({ snd, chn: 0, factor, selection: onSelection });
      }
      WaveformView.refresh();
      explorer.refresh();
    })
  );

  command('snd.resample', () =>
    guard(async () => {
      const snd = await firstSound();
      if (snd === undefined) return;
      const answer = await vscode.window.showInputBox({
        prompt: 'Resample ratio (2 = half as long, an octave up)',
        value: '2.0',
      });
      const ratio = Number(answer);
      if (!Number.isFinite(ratio) || ratio === 0) return;
      const where = await vscode.window.showQuickPick(['selection', 'whole channel'], {
        placeHolder: 'apply to',
      });
      if (!where) return;
      await session.resample(snd, 0, ratio, where === 'selection');
      WaveformView.refresh();
      explorer.refresh();
    })
  );

  command('snd.saveSelection', () =>
    guard(async () => {
      const target = await vscode.window.showSaveDialog({
        filters: { Sounds: ['wav', 'aiff', 'snd', 'flac'] },
        saveLabel: 'Save selection',
      });
      if (!target) return;
      await session.saveSelection(target.fsPath);
      void vscode.window.showInformationMessage(`Selection written to ${target.fsPath}`);
    })
  );

  command('snd.refreshSounds', () => explorer.refresh());

  if (vscode.workspace.getConfiguration('snd').get<boolean>('startOnActivation', false)) {
    void session.start().catch(() => undefined);
  }

  context.subscriptions.push({ dispose: () => session.stop() });
}

export function deactivate(): void {
  // Nothing: the process is a child and goes with the window. See the
  // note at the top of sndProcess.ts for why it is deliberately not
  // detached.
}
