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
  ParamValue,
} from './bridge';
import { SndProcess, SndMode, SndStatus, resolveExecutable } from './sndProcess';
import * as fs from 'fs';
import { SndReplTerminal } from './replTerminal';
import { WaveformView, Waveform } from './waveformView';
import { SpectrumView, Spectrum, Sonogram } from './spectrumView';
import { WavogramView, Wavogram } from './wavogramView';
import { HeaderPanel, HeaderInfo } from './headerPanel';
import { SoundExplorer, Sound, EditHistory, Region, Mix } from './soundExplorer';
import { SndHelpProvider, StaticIndex } from './helpProvider';
import { DialogPanel, VariableValue } from './dialogPanel';
import { EnvelopeView, EnvelopeState, EnvelopeTarget } from './envelopeView';
import { UserGraphView, UserGraphState } from './userGraphView';
import { SndCustomUi, SndUiNode } from './customUi';
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
  showLog(): void {
    this.log.show();
  }

  /** Called once each time a session comes up. */
  onReady: () => void = () => undefined;
  /** A sound appeared; -1 when the event did not say which. */
  onNewSound: (snd: number) => void = () => undefined;

  /** Snd said something on its own account. */
  onSndDiagnostic: (severity: 'error' | 'warning', message: string) => void = () => undefined;
  /** A Scheme-created menu, dialog or control changed. */
  onUiEvent: (frame: any) => void = () => undefined;
  /** The process ended; every opaque widget id ended with it. */
  onUiReset: () => void = () => undefined;

  /** Where the binary came from: configured, bundled, or PATH. */
  private binarySource: 'configured' | 'bundled' | 'path' = 'path';
  private warnedAboutGui = false;

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
        this.onUiReset();
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
        this.onReady();
        // A Motif Snd found on PATH opens its own X window, which is
        // legitimate and supported -- and startling if one expected the
        // headless build and has just re-unpacked a release without bin/.
        // Said once, with the two ways out, rather than left as a window
        // nobody asked for.
        if (frame.mode === 'gui' && this.binarySource === 'path' && !this.warnedAboutGui) {
          this.warnedAboutGui = true;
          void vscode.window
            .showInformationMessage(
              'This Snd has its own GUI (found on PATH). The panels work either way — ' +
                'but for a headless session, build one with tools/build-snd.sh.',
              'Open Log',
              'How'
            )
            .then(answer => {
              if (answer === 'Open Log') this.log.show();
              if (answer === 'How') {
                void vscode.env.openExternal(
                  vscode.Uri.parse(
                    'https://github.com/Elvis-Budingensis/snd-vscode#requirements'
                  )
                );
              }
            });
        }
        break;
      case 'opened':
        this.onSoundsChanged();
        // Show what just appeared. with-sound makes a sound and a panel still
        // showing the previous one reads as broken — "show me what I just
        // made" is the only reasonable expectation. The panels themselves
        // refuse if the user has chosen a sound explicitly.
        this.onNewSound(typeof frame.snd === 'number' ? frame.snd : -1);
        break;
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
        WavogramView.refresh();
        // The control panel too: apply-controls moves the edit position,
        // and Snd resets the controls to neutral when it does.
        DialogPanel.refreshAll();
        EnvelopeView.refresh();
        // The user's drawing function reads the channel, so its output is as
        // stale as the waveform after an edit.
        UserGraphView.refresh();
        break;
      case 'playing':
        if (typeof frame.frame === 'number') {
          this.playEvents++;
          WaveformView.playhead(frame.frame);
        } else {
          // start-playing-hook. Nothing to draw yet -- play-hook supplies the
          // positions -- but the panel can say that a play is running.
          WaveformView.playing(true);
        }
        break;
      case 'ui':
        this.onUiEvent(frame);
        break;
      case 'markchanged':
      case 'mixmoved':
        // A mark or a mix moved from somewhere the editor cannot see -- a
        // script, a Motif window, a drag. Without these the tree was right
        // only after the next edit.
        this.onSoundsChanged();
        WaveformView.refresh();
        break;
      case 'newsound':
        this.onSoundsChanged();
        this.onNewSound(-1);
        break;
      case 'snderror':
      case 'sndwarning':
      case 'muserror': {
        // Snd's own warnings go to its listener, and in a headless build to a
        // terminal that may not be open. This is where a VS Code user looks.
        const message = String(frame.message ?? '');
        if (!message) break;
        this.log.appendLine(
          `[snd] ${frame.event === 'sndwarning' ? 'warning' : 'error'}: ${message}`
        );
        this.onSndDiagnostic(frame.event === 'sndwarning' ? 'warning' : 'error', message);
        break;
      }
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
    this.binarySource = resolved.source;
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

  stop(): Promise<void> {
    return this.process.stop();
  }

  async restart(): Promise<void> {
    // Awaited now that stop() reports when the process is really gone: the
    // fixed 800 ms was a guess that a spinning Snd could outlast, and starting
    // a second one beside it is how you end up with several at 100% CPU.
    await this.stop();
    this.readyPromise = undefined;
    await this.start();
  }

  private async ensure(): Promise<void> {
    if (!this.ready()) await this.start();
  }

  // --- host interfaces ------------------------------------------------

  async evaluate(code: string): Promise<{ value: string; output: string }> {
    await this.ensure();
    const result = await this.bridge.evaluate(code);
    // Anything evaluated can change what the panels are showing — most
    // obviously a define-envelope, which adds a name the envelope editor has
    // no other way of hearing about. Snd has no hook for "a variable was
    // defined", so the REPL saying "something ran" is the only signal there
    // is.
    //
    // Coalesced, because evaluating a file sends one of these per form.
    this.afterEvaluation();
    return result;
  }

  private evaluationTimer: ReturnType<typeof setTimeout> | undefined;
  private afterEvaluation(): void {
    if (this.evaluationTimer) clearTimeout(this.evaluationTimer);
    this.evaluationTimer = setTimeout(() => this.onEvaluated(), 200);
  }

  /** Set in activate; the panels that care refresh themselves. */
  onEvaluated: () => void = () => undefined;

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

  lispGraph(snd: number, chn: number): Promise<UserGraphState> {
    return this.bridge.request('lispgraph', { snd, chn });
  }

  regions(): Promise<Region[]> {
    return this.bridge.request('regions');
  }

  mixes(snd: number, chn: number): Promise<Mix[]> {
    return this.bridge.request('mixes', { snd, chn });
  }

  regionAction(params: Record<string, string | number>): Promise<any> {
    return this.bridge.request('regionaction', params);
  }

  mixAction(params: Record<string, string | number>): Promise<any> {
    return this.bridge.request('mixaction', params);
  }

  markAction(params: Record<string, string | number>): Promise<any> {
    return this.bridge.request('markaction', params);
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

  wavogram(params: {
    snd: number;
    chn: number;
    start: number;
    traces: number;
    points: number;
  }): Promise<Wavogram> {
    return this.bridge.request('wavogram', params);
  }

  async setWavogram(snd: number, chn: number, trace: number, hop: number): Promise<void> {
    await this.bridge.request('setwavogram', { snd, chn, trace, hop });
  }

  headerInfo(snd: number): Promise<HeaderInfo> {
    return this.bridge.request('headerinfo', { snd });
  }

  async editHeader(params: {
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
  }): Promise<HeaderInfo> {
    const result = await this.bridge.request<HeaderInfo>('editheader', params);
    this.onSoundsChanged();
    WaveformView.refresh();
    SpectrumView.refresh();
    WavogramView.refresh();
    return result;
  }

  async saveState(file: string): Promise<void> {
    await this.bridge.request('savestate', { file });
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
    const reply = await this.bridge.request('play', { snd, chn, start, end });
    // A NOGUI BUILD HAS ALREADY FINISHED by the time this returns: the DAC
    // writer is an idle work procedure of the toolkit loop, and without a loop
    // play takes the blocking path. So there is nothing to wait for and
    // nothing to warn about — the op says so with 'synchronous.
    if (reply && (reply as { synchronous?: boolean }).synchronous) return;
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

  /**
   * Pause or resume, with no argument meaning toggle so one command can serve
   * one button.
   *
   * This reaches a RUNNING sound even in a build where play blocks: play-hook
   * services stdin once per DAC buffer while it does, recognises the pause op
   * by name, and sets Snd's `pausing` from there. Reply comes back when play
   * returns.
   */
  async pausePlaying(on?: boolean): Promise<boolean> {
    const reply = await this.bridge.request('pause', on === undefined ? {} : { on });
    return Boolean(reply && (reply as { paused?: boolean }).paused);
  }

  envelope(snd: number, chn: number): Promise<EnvelopeState> {
    return this.bridge.request('envelope', { snd, chn });
  }

  applyEnvelope(params: {
    snd: number;
    chn: number;
    target: EnvelopeTarget;
    base: number;
    points: string;
  }): Promise<{ applied: boolean; editPosition?: number }> {
    return this.bridge.request('applyenvelope', params);
  }

  async storeEnvelope(points: string, base: number): Promise<void> {
    await this.bridge.request('storeenvelope', { points, base });
  }

  async defineEnvelope(name: string, points: string, base: number): Promise<void> {
    await this.bridge.request('defineenvelope', { name, points, base });
  }

  find(
    expr: string,
    snd: number,
    chn: number,
    backwards: boolean
  ): Promise<{ found: boolean; sample?: number; value?: number }> {
    return this.bridge.request('find', { expr, snd, chn, backwards });
  }

  async addLoadPath(directory: string): Promise<void> {
    await this.bridge.request('loadpath', { path: directory });
  }

  async setSync(snd: number, value: number | string): Promise<void> {
    await this.bridge.request('sync', { snd, value });
  }

  async key(action: string, snd: number, chn: number, count: number): Promise<void> {
    await this.bridge.request('key', { action, snd, chn, count });
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

  uiWidgets(): Promise<SndUiNode[]> {
    return this.bridge.request('uiwidgets', {});
  }

  uiAction(id: string, action: string, value?: unknown): Promise<SndUiNode> {
    return this.bridge.request('uiaction', { id, action, value: value as ParamValue });
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

/**
 * The directories that go on s7's *load-path* when a session becomes ready.
 *
 * Two of them, for two different reasons, and the order is the answer to
 * "which one wins when both hold a file of the same name":
 *
 *   1. THE EXTENSION'S OWN DIRECTORY, so the shipped examples load by the name
 *      their own header gives — `(load "examples/vscode-ui.scm")`. Snd's cwd is
 *      the workspace, not the extension, so without this the documented line
 *      fails and the only thing that works is an absolute path pasted in front
 *      of it. Every reader hits that once.
 *   2. SND'S OWN SOURCE TREE, so `(load-from-path "v.scm")` finds the
 *      fm-violin, clm-ins, dsp and examp.
 *
 * Extracted from onReady so it can be checked without a running Snd: it is one
 * `await` in a closure otherwise, and a refactor that dropped it would leave
 * nothing red anywhere.
 */
export function loadPathsFor(args: {
  configured: string;
  extensionPath: string;
  exists: (candidate: string) => boolean;
}): string[] {
  const { configured, extensionPath, exists } = args;
  const paths: string[] = [];
  if (extensionPath) paths.push(extensionPath);
  const trimmed = (configured ?? '').trim();
  const fallback = path.join(extensionPath, '.build', 'snd-26.5');
  const source = trimmed || (exists(fallback) ? fallback : '');
  if (source) paths.push(source);
  // The bridge refuses a duplicate, but sending one would still be a request
  // whose only outcome is a no-op, and the caller cannot tell the two apart.
  return paths.filter((entry, index) => paths.indexOf(entry) === index);
}

export function activate(context: vscode.ExtensionContext): void {
  const session = new SndSession(context);

  const index = new StaticIndex();
  index.load(path.join(context.extensionPath, 'data', 'snd-index.json'));

  const explorer = new SoundExplorer(session);
  const tree = vscode.window.createTreeView('sndSounds', { treeDataProvider: explorer });
  const customUi = new SndCustomUi({
    snapshot: () => session.uiWidgets(),
    action: (id, action, value) => session.uiAction(id, action, value),
    ready: () => session.ready(),
  });
  const uiTree = vscode.window.createTreeView('sndCustomUi', { treeDataProvider: customUi });
  context.subscriptions.push(tree, uiTree);
  session.onUiEvent = frame => customUi.handle(frame);
  session.onUiReset = () => customUi.clear();

  // Coalesced: after-edit-hook fires per edit, and refreshing the tree per
  // edit means a request per keystroke of a Scheme loop.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  session.onNewSound = async (snd: number) => {
    // The event does not always carry an index — new-sound-hook passes a name.
    // Asking for the list is one request and gives the right answer in both
    // cases: the newest sound is the last one Snd lists.
    let target = snd;
    if (target < 0) {
      try {
        const sounds = await session.sounds();
        if (sounds.length === 0) return;
        target = sounds[sounds.length - 1].index;
      } catch {
        return;
      }
    }
    WaveformView.follow(target);
    SpectrumView.follow(target);
    WavogramView.follow(target);
  };

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

  /**
   * The REPL comes up with the session.
   *
   * A running Snd with no visible listener is a process one cannot talk to:
   * the panels work, but there is nowhere to type, and nowhere for Snd's own
   * output to appear — it goes to the terminal, and if the terminal does not
   * exist it goes nowhere the user can see. Snd itself does the same thing;
   * its listener is part of the window.
   *
   * `show(false)` keeps the focus where it was, because a session started by
   * evaluating a form should leave the cursor in the file.
   */
  /**
   * Snd's own errors and warnings.
   *
   * They arrive through snd-error-hook, snd-warning-hook and mus-error-hook,
   * which is the only way to see them at all without a listener: in a headless
   * build they go to a terminal, and if the terminal is closed they go
   * nowhere. Shown as a notification for errors, quietly in the log for
   * warnings, because a warning per DAC underrun in a modal box would teach
   * the user to dismiss everything.
   */
  session.onSndDiagnostic = (severity, message) => {
    if (severity === 'error') {
      void vscode.window.showErrorMessage(`Snd: ${message}`, 'Open Log').then(answer => {
        if (answer === 'Open Log') session.showLog();
      });
    } else {
      void vscode.window.setStatusBarMessage(`Snd: ${message}`, 6000);
    }
  };

  session.onEvaluated = () => {
    // The envelope editor is the one that needs this: a define-envelope in
    // the REPL is invisible to it otherwise. The others follow the edit
    // hooks, which fire on their own.
    EnvelopeView.refresh();
    WavogramView.refresh();
    HeaderPanel.refresh();
    explorer.refresh();
  };

  session.onReady = () => {
    // Snd's own Scheme files on the load path, so (load-from-path "v.scm")
    // works — the fm-violin, clm-ins, dsp, examp. Done on every session start
    // because the setting can change between them; the bridge refuses to add
    // the same path twice.
    void (async () => {
      try {
        await customUi.reload();
      } catch (error) {
        session.log.appendLine(`[snd-vscode] custom UI snapshot failed: ${String(error)}`);
      }
      const directories = loadPathsFor({
        configured: vscode.workspace.getConfiguration('snd').get<string>('sourcePath', ''),
        extensionPath: context.extensionPath,
        exists: candidate => fs.existsSync(candidate),
      });
      for (const directory of directories) {
        try {
          await session.addLoadPath(directory);
        } catch {
          // Not fatal: the session works without it, and the failure shows up
          // as load saying which file it could not find, which is a better
          // message than anything shown here would be. Kept per directory so
          // one unreachable path does not cost the other.
        }
      }
    })();
    if (vscode.workspace.getConfiguration('snd').get<boolean>('openReplOnStart', true)) {
      SndReplTerminal.show(replHost);
    }
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
    pause: () => session.pausePlaying(),
    undo: (snd: number, chn: number) => session.undo(snd, chn),
    redo: (snd: number, chn: number) => session.redo(snd, chn),
    edit: (action: string, snd: number, chn: number) => session.edit(action, snd, chn),
    key: (action: string, snd: number, chn: number, count: number) =>
      session.key(action, snd, chn, count),
  };

  const envelopeHost = {
    envelope: (snd: number, chn: number) => session.envelope(snd, chn),
    applyEnvelope: (params: any) => session.applyEnvelope(params),
    storeEnvelope: (points: string, base: number) => session.storeEnvelope(points, base),
    defineEnvelope: (name: string, points: string, base: number) =>
      session.defineEnvelope(name, points, base),
    play: (snd: number, chn: number, start: number, end?: number) =>
      session.play(snd, chn, start, end),
    stop: () => session.stopPlaying(),
    undo: (snd: number, chn: number) => session.undo(snd, chn),
    ready: () => session.ready(),
  };

  const spectrumHost = {
    sonogram: (params: any) => session.bridge.request<Sonogram>('sonogram', params),
    spectrum: (params: any) => session.spectrum(params),
    cursorOf: (snd: number, chn: number) => session.cursorOf(snd, chn),
  };

  const wavogramHost = {
    wavogram: (params: any) => session.wavogram(params),
    setWavogram: (snd: number, chn: number, trace: number, hop: number) =>
      session.setWavogram(snd, chn, trace, hop),
    cursorOf: (snd: number, chn: number) => session.cursorOf(snd, chn),
  };

  const headerHost = {
    headerInfo: (snd: number) => session.headerInfo(snd),
    editHeader: (params: any) => session.editHeader(params),
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

  /**
   * The sound a command should work on when none was named.
   *
   * Not sounds[0]: (new-sound) leaves an EMPTY sound behind, so the first in
   * the list is often the blank one. Snd's own selected-sound first, then the
   * last opened, and an empty one only if there is nothing else.
   */
  const firstSound = async (): Promise<number | undefined> => {
    if (!session.ready()) await session.start();
    const sounds = await session.sounds();
    if (sounds.length === 0) {
      void vscode.window.showInformationMessage('No sound open.');
      return undefined;
    }
    const withData = sounds.filter(sound => !sound.empty);
    const candidates = withData.length > 0 ? withData : sounds;
    const chosen = candidates.find(sound => sound.selected) ?? candidates[candidates.length - 1];
    return chosen.index;
  };

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
  command('snd.openRepl', () =>
    guard(async () => {
      // Opening the REPL starts the session, rather than waiting for the
      // first form to be typed. Asking for a listener is asking for something
      // to listen to; a prompt in front of a process that does not exist yet
      // looks like a REPL that is not working.
      SndReplTerminal.show(replHost);
      if (!session.ready()) await session.start();
    })
  );

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

  command('snd.ui.refresh', () => guard(() => customUi.reload()));
  command('snd.ui.invoke', (id: string, action = 'click', value?: unknown) =>
    guard(() => customUi.invoke(id, action, value))
  );
  command('snd.ui.show', (id: string) => customUi.show(id));

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

  command('snd.showEnvelope', (snd?: number, chn?: number) =>
    guard(async () => {
      if (!session.ready()) await session.start();
      if (snd === undefined) {
        const chosen = await firstSound();
        if (chosen === undefined) return;
        snd = chosen;
        chn = 0;
      }
      EnvelopeView.show(envelopeHost, snd, chn ?? 0);
    })
  );

  command('snd.showSpectrum', (snd?: number, chn?: number) =>
    guard(async () => {
      if (!session.ready()) await session.start();
      SpectrumView.show(spectrumHost, snd ?? 0, chn ?? 0);
    })
  );

  command('snd.showWavogram', (snd?: number, chn?: number) =>
    guard(async () => {
      if (!session.ready()) await session.start();
      if (snd === undefined) {
        const chosen = await firstSound();
        if (chosen === undefined) return;
        snd = chosen;
        chn = 0;
      }
      WavogramView.show(wavogramHost, snd, chn ?? 0);
    })
  );

  command('snd.editHeader', (snd?: number) =>
    guard(async () => {
      if (!session.ready()) await session.start();
      if (snd === undefined) snd = await firstSound();
      if (snd === undefined) return;
      HeaderPanel.show(headerHost, snd);
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
  command('snd.pausePlaying', () =>
    guard(async () => {
      await session.pausePlaying();
    })
  );

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
      const previous = context.workspaceState.get<string>('snd.lastStateFile');
      const target = await vscode.window.showSaveDialog({
        filters: { Scheme: ['scm'] },
        saveLabel: 'Save Snd state',
        defaultUri: previous ? vscode.Uri.file(previous) : undefined,
      });
      if (!target) return;
      await session.saveState(target.fsPath);
      await context.workspaceState.update('snd.lastStateFile', target.fsPath);
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

  // --- regions, mixes, marks -------------------------------------------

  const afterEdit = () => {
    WaveformView.refresh();
    explorer.refresh();
  };

  command('snd.region.play', (node: any) =>
    guard(async () => {
      await session.regionAction({ action: 'play', region: node.region.index });
    })
  );

  command('snd.region.insert', (node: any) =>
    guard(async () => {
      const snd = await firstSound();
      if (snd === undefined) return;
      // At the cursor, like Snd's own Edit menu — not at 0, which was the
      // mistake insert-selection made this morning.
      const at = await session.cursorOf(snd, 0);
      await session.regionAction({
        action: 'insert',
        region: node.region.index,
        at,
        snd,
        chn: 0,
      });
      afterEdit();
    })
  );

  command('snd.region.mix', (node: any) =>
    guard(async () => {
      const snd = await firstSound();
      if (snd === undefined) return;
      const at = await session.cursorOf(snd, 0);
      await session.regionAction({ action: 'mix', region: node.region.index, at, snd, chn: 0 });
      afterEdit();
    })
  );

  command('snd.region.save', (node: any) =>
    guard(async () => {
      const target = await vscode.window.showSaveDialog({
        filters: { Sounds: ['wav', 'aiff', 'snd', 'flac'] },
        saveLabel: 'Save region',
      });
      if (!target) return;
      await session.regionAction({
        action: 'save',
        region: node.region.index,
        file: target.fsPath,
      });
      void vscode.window.showInformationMessage(`Region written to ${target.fsPath}`);
    })
  );

  command('snd.region.forget', (node: any) =>
    guard(async () => {
      // forget-region only drops Snd's copy — it does not touch any sound,
      // and the confirmation says so, because "forget" reads like "delete".
      const answer = await vscode.window.showWarningMessage(
        `Forget region ${node.region.index}? The sounds are not affected — this only drops Snd's copy.`,
        'Forget'
      );
      if (answer !== 'Forget') return;
      await session.regionAction({ action: 'forget', region: node.region.index });
      explorer.refresh();
    })
  );

  command('snd.mix.play', (node: any) =>
    guard(async () => {
      await session.mixAction({ action: 'play', mix: node.mix.index });
    })
  );

  command('snd.mix.amp', (node: any) =>
    guard(async () => {
      const answer = await vscode.window.showInputBox({
        prompt: `Amplitude for mix ${node.mix.index}`,
        value: String(node.mix.amp),
      });
      const amp = Number(answer);
      if (!Number.isFinite(amp)) return;
      await session.mixAction({ action: 'amp', mix: node.mix.index, value: amp });
      afterEdit();
    })
  );

  command('snd.mix.position', (node: any) =>
    guard(async () => {
      const answer = await vscode.window.showInputBox({
        prompt: `Position of mix ${node.mix.index}, in samples`,
        value: String(node.mix.position),
      });
      const position = Number(answer);
      if (!Number.isFinite(position)) return;
      await session.mixAction({
        action: 'position',
        mix: node.mix.index,
        value: Math.round(position),
        snd: node.sound.index,
        chn: node.chn,
      });
      afterEdit();
    })
  );

  command('snd.mark.add', () =>
    guard(async () => {
      const snd = await firstSound();
      if (snd === undefined) return;
      const sample = await session.cursorOf(snd, 0);
      const name = await vscode.window.showInputBox({
        prompt: `Name for the mark at sample ${sample} (optional)`,
      });
      if (name === undefined) return;
      await session.markAction({ action: 'add', sample, snd, chn: 0, text: name });
      afterEdit();
    })
  );

  command('snd.mark.delete', (node: any) =>
    guard(async () => {
      // Marks follow the edit list, so this is undoable like any edit — no
      // confirmation needed, and saying so is better than asking.
      await session.markAction({ action: 'delete', mark: node.id });
      afterEdit();
    })
  );

  command('snd.mark.rename', (node: any) =>
    guard(async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Mark name',
        value: node.name,
      });
      if (name === undefined) return;
      await session.markAction({ action: 'name', mark: node.id, text: name });
      afterEdit();
    })
  );

  // --- Find, and sync ---------------------------------------------------

  /**
   * Snd's Find, which is not a text search.
   *
   * "The expression it asks for is a function that takes one argument, the
   * current sample value, and returns #t when it finds a match." The
   * predicate may be a closure — his own zero+ example keeps the previous
   * sample in a let to find zero crossings — so the expression is evaluated,
   * and the prompt is the only way in. Nothing on a panel sends one.
   */
  let lastSearch = '(lambda (y) (> y .1))';

  const runSearch = (backwards: boolean) =>
    guard(async () => {
      const snd = await firstSound();
      if (snd === undefined) return;
      const expr = await vscode.window.showInputBox({
        prompt: backwards ? 'Search backwards for a sample where…' : 'Search for a sample where…',
        value: lastSearch,
        placeHolder: '(lambda (y) (> y .1))',
      });
      if (!expr) return;
      lastSearch = expr;
      const result = await session.find(expr, snd, 0, backwards);
      if (!result.found) {
        void vscode.window.showInformationMessage(
          backwards ? 'No match before the cursor.' : 'No match after the cursor.'
        );
        return;
      }
      WaveformView.refresh();
      SpectrumView.refresh();
      void vscode.window.setStatusBarMessage(
        `sample ${result.sample} = ${result.value?.toFixed(6)}`,
        4000
      );
    });

  command('snd.find', () => runSearch(false));
  command('snd.findBackwards', () => runSearch(true));

  command('snd.sync', (node?: any) =>
    guard(async () => {
      const snd = node?.sound?.index ?? (await firstSound());
      if (snd === undefined) return;
      // The three answers Snd's sync field actually has: on its own, a new
      // group, or an existing one. "sync-max + 1" is how one gets a group
      // that is guaranteed not to collect the sounds already grouped.
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'on its own', value: 0 },
          { label: 'a new group', value: 'new' },
          { label: 'group 1', value: 1 },
          { label: 'group 2', value: 2 },
          { label: 'group 3', value: 3 },
        ],
        { placeHolder: 'Edit and move this sound together with…' }
      );
      if (!choice) return;
      await session.setSync(snd, choice.value as number | string);
      explorer.refresh();
    })
  );

  const userGraphHost = {
    lispGraph: (snd: number, chn: number) => session.lispGraph(snd, chn),
    ready: () => session.ready(),
  };

  command('snd.showUserGraph', (snd?: number, chn?: number) =>
    guard(async () => {
      if (!session.ready()) await session.start();
      if (snd === undefined) {
        const chosen = await firstSound();
        if (chosen === undefined) return;
        snd = chosen;
        chn = 0;
      }
      UserGraphView.show(userGraphHost, snd, chn ?? 0);
    })
  );

  command('snd.listEnvelopes', () =>
    guard(async () => {
      // The same scan the envelope panel's list uses, printed. When the list
      // shows fewer envelopes than expected, the question is whether the scan
      // found them and the panel dropped them, or the scan never saw them —
      // and that question is otherwise unanswerable from the outside.
      if (!session.ready()) await session.start();
      const state = await session.envelope(0, 0);
      const named = state.named ?? [];
      const lines = named.map(entry => `${entry.name}  '(${entry.points.join(' ')})`);
      const document = await vscode.workspace.openTextDocument({
        content:
          `;;; ${named.length} named envelope${named.length === 1 ? '' : 's'} in this session\n` +
          ';;;\n' +
          ';;; Found by scanning the symbol table for even-length lists of reals,\n' +
          ';;; which is what define-envelope leaves behind — there is no\n' +
          ';;; Scheme-visible registry (all_envs lives in snd-env.c).\n\n' +
          (lines.length ? lines.join('\n') : ';;; none — try (define-envelope ramp \'(0 0 1 1))') +
          '\n',
        language: 'scheme',
      });
      await vscode.window.showTextDocument(document, { preview: true });
    })
  );

  command('snd.refreshSounds', () => explorer.refresh());

  if (vscode.workspace.getConfiguration('snd').get<boolean>('startOnActivation', false)) {
    void session.start().catch(() => undefined);
  }

  context.subscriptions.push({ dispose: () => void session.stop() });
  running = session;
}

/**
 * The session, kept at module scope so deactivate() can reach it.
 */
let running: SndSession | undefined;

export function deactivate(): Promise<void> {
  // THE PROCESS DOES NOT GO WITH THE WINDOW. This used to do nothing, on the
  // reasoning that a child dies with its parent -- which is not true on POSIX:
  // it is reparented to launchd and carries on. A Snd left spinning in
  // snd-dac.c's playback loop then burns a core until the machine is rebooted.
  // Six were found in Activity Monitor after one day of development, one with
  // 8:44 hours of CPU time.
  //
  // The promise is the other half. VS Code awaits what deactivate returns, and
  // without that the escalation in SndProcess.stop is a timer chain that never
  // runs, because the extension host is already tearing down -- so only
  // stdin.end() would happen, which reaches a Snd that is reading stdin and no
  // other.
  const session = running;
  running = undefined;
  return session ? session.stop() : Promise.resolve();
}
