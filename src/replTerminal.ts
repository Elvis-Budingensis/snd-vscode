// replTerminal.ts
//
// The inferior Snd process, in a VS Code terminal.  This is inf-snd.el's
// job: comint buffer, prompt, history, completion, and the same channel
// the editor commands use, so that a definition evaluated from a file and
// one typed here land in the same s7.
//
// WHY A PSEUDOTERMINAL AND NOT JUST AN OUTPUT CHANNEL.  An output channel
// cannot be typed into, and a REPL one cannot type into is a log.  The
// price is that everything a terminal normally does -- cursor, history,
// redraw on a wrapped line -- has to be done here by hand.
//
// WHY NOT SIMPLY SHOW Snd's OWN stdin REPL.  Because we deliberately did
// not start it: repl.scm does ANSI cursor control on a channel we also
// have to parse, and the fallback REPL in snd-nogui.c reads with fgets
// into char buffer[512].  So the prompt here is ours, and what looks like
// Snd's REPL is the bridge's eval op with output and value separated.

import * as vscode from 'vscode';
import { isComplete, splitTopLevelForms } from './bridge';

export interface ReplHost {
  /** Evaluate and return what Snd said. Rejects on a Snd error. */
  evaluate(code: string): Promise<{ value: string; output: string }>;
  /** Completion candidates for a prefix. */
  complete(prefix: string): Promise<string[]>;
  /** Is a session running at all? */
  ready(): boolean;
  /** Start one -- so that the REPL is usable as the first thing after install. */
  start(): Promise<void>;
}

/** The token before the cursor that Tab should complete. */
export function completionPrefix(buffer: string, cursor: number): string {
  const text = buffer.slice(0, cursor);
  const match = /[^\s()'"`,;]*$/.exec(text);
  return match ? match[0] : '';
}

/** The longest common prefix of the candidates -- what Tab inserts. */
export function commonPrefix(candidates: string[]): string {
  if (candidates.length === 0) return '';
  let prefix = candidates[0];
  for (const candidate of candidates.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < candidate.length && prefix[i] === candidate[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

export class SndReplTerminal implements vscode.Pseudoterminal {
  private static instance: SndReplTerminal | undefined;
  private static terminal: vscode.Terminal | undefined;

  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  readonly onDidClose: vscode.Event<void> = this.closeEmitter.event;

  private buffer = '';
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private busy = false;
  private cols = 80;
  private renderedRows = 1;
  private opened = false;
  private lastCompletionAt: string | undefined;

  static show(host: ReplHost): SndReplTerminal {
    if (!this.instance || !this.terminal) {
      this.instance = new SndReplTerminal(host);
      this.terminal = vscode.window.createTerminal({
        name: 'Snd REPL',
        pty: this.instance,
        iconPath: new vscode.ThemeIcon('terminal'),
      });
      const created = this.terminal;
      vscode.window.onDidCloseTerminal(closed => {
        if (closed === created) {
          this.instance = undefined;
          this.terminal = undefined;
        }
      });
    }
    this.terminal.show(false);
    return this.instance;
  }

  static get current(): SndReplTerminal | undefined {
    return this.instance;
  }

  /** Text Snd produced on its own account (stdout) belongs on screen. */
  static passThrough(text: string): void {
    this.instance?.writeForeign(text);
  }

  static async evaluate(host: ReplHost, code: string): Promise<void> {
    const repl = this.show(host);
    await repl.submitCode(code);
  }

  private constructor(private readonly host: ReplHost) {}

  open(initialDimensions?: vscode.TerminalDimensions): void {
    if (initialDimensions) this.cols = Math.max(20, initialDimensions.columns);
    this.write('\x1b[1mSnd REPL\x1b[0m\r\n');
    this.write('The same s7 as the editor commands and the panels.\r\n');
    this.write('Enter: evaluate (unfinished forms carry on) · Tab: complete\r\n');
    this.write('↑/↓: history · Ctrl+L: clear · Ctrl+C: abandon the input\r\n\r\n');
    this.opened = true;
    this.renderInput();
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.cols = Math.max(20, dimensions.columns);
    if (this.opened) this.renderInput();
  }

  close(): void {
    this.closeEmitter.fire();
  }

  private write(text: string): void {
    this.writeEmitter.fire(text);
  }

  /** Snd's own stdout, interleaved with the prompt without eating it. */
  private writeForeign(text: string): void {
    if (!this.opened) return;
    this.clearInput();
    this.write(text.replace(/\r?\n/g, '\r\n'));
    if (!text.endsWith('\n')) this.write('\r\n');
    this.renderInput();
  }

  handleInput(data: string): void {
    // A keystroke delivers one character, or a short escape sequence. More
    // than one character at once and not starting with ESC is a paste --
    // and a paste must not be interpreted key by key, or an embedded \r
    // submits half of it.
    if (data.length > 1 && !data.startsWith('\x1b')) {
      this.handlePaste(data);
      return;
    }

    for (let i = 0; i < data.length; ) {
      if (data.startsWith('\x1b[A', i)) { this.recallHistory(-1); i += 3; continue; }
      if (data.startsWith('\x1b[B', i)) { this.recallHistory(1); i += 3; continue; }
      if (data.startsWith('\x1b[C', i)) { this.moveCursor(1); i += 3; continue; }
      if (data.startsWith('\x1b[D', i)) { this.moveCursor(-1); i += 3; continue; }
      if (data.startsWith('\x1b[', i)) {
        // Swallow an unknown CSI sequence whole, otherwise its printable
        // tail ("[24~") lands in the buffer as junk.
        let j = i + 2;
        while (j < data.length && data[j] >= '0' && data[j] <= ';') j++;
        if (j < data.length) j++;
        i = j;
        continue;
      }
      if (data.startsWith('\x1b', i)) { i += Math.min(2, data.length - i); continue; }

      const ch = data[i++];
      switch (ch) {
        case '\r':
          void this.submit();
          break;
        case '\n':
          this.insert('\n');
          break;
        case '\t':
          void this.complete();
          break;
        case '\x7f':
        case '\b':
          this.backspace();
          break;
        case '\x03': // Ctrl+C
          this.buffer = '';
          this.cursor = 0;
          this.write('\r\n');
          this.renderedRows = 1;
          this.renderInput();
          break;
        case '\x0c': // Ctrl+L
          this.write('\x1b[2J\x1b[H');
          this.renderedRows = 1;
          this.renderInput();
          break;
        case '\x01': // Ctrl+A
          this.cursor = 0;
          this.renderInput();
          break;
        case '\x05': // Ctrl+E
          this.cursor = this.buffer.length;
          this.renderInput();
          break;
        default:
          if (ch >= ' ') this.insert(ch);
      }
    }
  }

  private handlePaste(text: string): void {
    const normalised = text.replace(/\r\n?/g, '\n');
    this.insert(normalised);
    // Pasted complete forms are evaluated, an incomplete one waits. That
    // way pasting a whole definition behaves the way pasting into a
    // comint buffer does, and pasting half of one does not lose it.
    if (normalised.includes('\n') && isComplete(this.buffer)) void this.submit();
  }

  private insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    this.lastCompletionAt = undefined;
    this.renderInput();
  }

  private backspace(): void {
    if (this.cursor === 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor--;
    this.lastCompletionAt = undefined;
    this.renderInput();
  }

  private moveCursor(by: number): void {
    this.cursor = Math.min(this.buffer.length, Math.max(0, this.cursor + by));
    this.renderInput();
  }

  private recallHistory(direction: number): void {
    if (this.history.length === 0) return;
    this.historyIndex = Math.min(
      this.history.length,
      Math.max(0, this.historyIndex + direction)
    );
    this.buffer = this.history[this.historyIndex] ?? '';
    this.cursor = this.buffer.length;
    this.renderInput();
  }

  private prompt(): string {
    return this.busy ? '\x1b[2msnd…\x1b[0m ' : '\x1b[1msnd>\x1b[0m ';
  }

  /**
   * Redraw the input.
   *
   * Counts SCREEN lines, not buffer lines: a Scheme line is regularly
   * wider than the panel and gets wrapped, and clearing by buffer lines
   * leaves every wrapped remainder standing -- one extra copy per
   * keystroke.
   */
  private renderInput(): void {
    if (!this.opened) return;
    this.clearInput();
    const promptText = this.prompt();
    const lines = (promptText.replace(/\x1b\[[0-9;]*m/g, '') + this.buffer).split('\n');
    let rows = 0;
    for (const line of lines) rows += Math.max(1, Math.ceil(line.length / this.cols));
    this.renderedRows = rows;
    this.write(promptText + this.buffer.replace(/\n/g, '\r\n'));
    // Put the cursor back where it belongs, counted from the end.
    const behind = this.buffer.length - this.cursor;
    if (behind > 0) this.write(`\x1b[${behind}D`);
  }

  private clearInput(): void {
    if (this.renderedRows > 1) this.write(`\x1b[${this.renderedRows - 1}A`);
    this.write('\r\x1b[J');
    this.renderedRows = 1;
  }

  private async complete(): Promise<void> {
    const prefix = completionPrefix(this.buffer, this.cursor);
    if (!prefix) return;
    let candidates: string[] = [];
    try {
      candidates = await this.host.complete(prefix);
    } catch {
      return;
    }
    if (candidates.length === 0) return;

    const shared = commonPrefix(candidates);
    if (shared.length > prefix.length) {
      this.insert(shared.slice(prefix.length));
      this.lastCompletionAt = this.buffer;
      return;
    }
    // Nothing to insert: list them -- but only on the second Tab, the way
    // readline and SLY do it, so that a single Tab never scrolls the
    // screen away.
    if (this.lastCompletionAt === this.buffer) {
      this.clearInput();
      this.write(candidates.slice(0, 200).join('  ').replace(/\n/g, '') + '\r\n');
      if (candidates.length > 200) {
        this.write(`… ${candidates.length - 200} more\r\n`);
      }
      this.renderInput();
    }
    this.lastCompletionAt = this.buffer;
  }

  private async submit(): Promise<void> {
    if (!isComplete(this.buffer)) {
      // Unfinished form: a newline, no evaluation. That is the difference
      // between a REPL and a line reader.
      this.insert('\n');
      return;
    }
    const code = this.buffer.trim();
    this.clearInput();
    this.write(this.prompt() + this.buffer.replace(/\n/g, '\r\n') + '\r\n');
    this.buffer = '';
    this.cursor = 0;
    this.renderedRows = 1;
    if (!code) {
      this.renderInput();
      return;
    }
    this.history.push(code);
    this.historyIndex = this.history.length;
    await this.runCode(code, false);
  }

  private async submitCode(code: string): Promise<void> {
    if (this.opened) {
      this.clearInput();
      this.write(`\x1b[2m;; from the editor\x1b[0m\r\n`);
      this.write(this.prompt() + code.replace(/\n/g, '\r\n') + '\r\n');
      this.renderedRows = 1;
    }
    await this.runCode(code, true);
  }

  /**
   * One form at a time.
   *
   * Snd evaluates ONE expression per request, so a block containing two
   * top-level forms produces "eval-string trailing junk" and only the first
   * one is defined -- which is how (define-envelope ramp ...) worked and
   * (define-envelope pyramid ...) pasted with it did not, with an error
   * message that named neither.
   *
   * Pasting several forms is normal: a definition and its use, two envelopes,
   * a snippet out of a file. `Snd: Evaluate File` has always split them; the
   * REPL did not.
   */
  private async runCode(code: string, fromEditor: boolean): Promise<void> {
    if (!this.host.ready()) {
      this.write('\x1b[33mNo Snd session — starting one.\x1b[0m\r\n');
      try {
        await this.host.start();
      } catch (error) {
        this.write(`\x1b[31m${String(error)}\x1b[0m\r\n`);
        this.renderInput();
        return;
      }
    }
    this.busy = true;
    try {
      const forms = splitTopLevelForms(code);
      // A single form goes through as it was typed, so an expression the
      // splitter would not recognise -- a bare atom, something odd -- still
      // reaches Snd unchanged.
      for (const form of forms.length > 1 ? forms : [code]) {
        const result = await this.host.evaluate(form);
        if (result.output) {
          this.write(result.output.replace(/\r?\n/g, '\r\n'));
          if (!result.output.endsWith('\n')) this.write('\r\n');
        }
        this.write(`\x1b[36m${result.value}\x1b[0m\r\n`);
      }
    } catch (error) {
      this.write(`\x1b[31m${String((error as Error).message ?? error)}\x1b[0m\r\n`);
    } finally {
      this.busy = false;
      void fromEditor;
      this.renderInput();
    }
  }
}
