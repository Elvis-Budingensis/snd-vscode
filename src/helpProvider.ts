// helpProvider.ts
//
// Hover, completion and signature help.
//
// THE POINT OF DIFFERENCE FROM inf-snd.el.  There, completion and help
// work against a list of names scraped out of snd-xref.c -- 1624 strings,
// fixed at the time the Emacs file was written.  Everything the user
// defines during the session is invisible to it, and that is most of what
// one actually types in a working session.  Here the first source is the
// LIVE symbol table of the running s7, so a generator defined two minutes
// ago completes like a built-in and its docstring is the one in the image.
//
// The static index is kept anyway, as a fallback for the case where no
// session is running -- opening a .scm file and reading it is a real use
// and should not require booting Snd.  It is generated from snd-xref.c by
// tools/make-index.mjs, so it stays in step with the Snd version it was
// generated from rather than with the extension.

import * as fs from 'fs';
import * as vscode from 'vscode';

export interface HelpHost {
  ready(): boolean;
  help(name: string): Promise<{
    name: string;
    help: string;
    bound: boolean;
    signature: string;
    documentation: string;
  }>;
  completions(prefix: string): Promise<Array<{ name: string; kind: string }>>;
}

const SYMBOL_CHARACTERS = /[A-Za-z0-9_+\-*/<>=!?%&$:.~^]/;

/**
 * The symbol at an offset.
 *
 * Not \w+: Scheme names contain -, ?, !, *, ->, and a hover on
 * `channel->float-vector` that returns `float` is worse than no hover,
 * because it silently finds help for a different function.
 */
export function symbolAtOffset(text: string, offset: number): string | undefined {
  if (offset < 0 || offset > text.length) return undefined;
  let start = offset;
  let end = offset;
  while (start > 0 && SYMBOL_CHARACTERS.test(text[start - 1])) start--;
  while (end < text.length && SYMBOL_CHARACTERS.test(text[end])) end++;
  const name = text.slice(start, end);
  if (!name || /^[.0-9]+$/.test(name)) return undefined;
  return name;
}

/**
 * The head of the innermost open call before the offset, and which
 * argument the cursor is on -- what signature help needs.
 */
export function callContext(
  text: string,
  offset: number
): { name: string; argument: number } | undefined {
  const stack: Array<{ open: number; commas: number }> = [];
  let i = 0;
  let inString = false;
  while (i < offset && i < text.length) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 2;
      else { if (c === '"') inString = false; i++; }
      continue;
    }
    if (c === '#' && text[i + 1] === '\\') { i += 3; continue; }
    if (c === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '"') { inString = true; i++; continue; }
    if (c === '(') { stack.push({ open: i, commas: 0 }); i++; continue; }
    if (c === ')') { stack.pop(); i++; continue; }
    i++;
  }
  const innermost = stack.pop();
  if (!innermost) return undefined;
  const head = text.slice(innermost.open + 1, offset);
  const match = /^\s*([^\s()'"`;]+)/.exec(head);
  if (!match) return undefined;
  const rest = head.slice(match[0].length);
  // Count the arguments already written, so that a nested call counts as
  // one argument and not as its own arity, and a string with spaces in it
  // counts as one and not as several.
  let depth = 0;
  let tokens = 0;
  let inToken = false;
  let inArgumentString = false;
  for (let k = 0; k < rest.length; k++) {
    const ch = rest[k];
    if (inArgumentString) {
      if (ch === '\\') { k++; continue; }
      if (ch === '"') inArgumentString = false;
      continue;
    }
    if (ch === '"') {
      if (!inToken && depth === 0) { tokens++; inToken = true; }
      inArgumentString = true;
      continue;
    }
    if (ch === '(') {
      if (!inToken && depth === 0) { tokens++; inToken = true; }
      depth++;
      continue;
    }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (/\s/.test(ch)) { inToken = false; continue; }
    if (!inToken) { tokens++; inToken = true; }
  }
  // Whether the cursor is ON an argument or BEFORE the next one is decided
  // by the last character, not by subtracting one from the count: after
  // `(mix-sound "a.wav" 0 ` two arguments are written and the cursor is on
  // the third, while inside `(mix-sound "a.w` it is on the first.
  const argument = inToken || inArgumentString ? Math.max(0, tokens - 1) : tokens;
  return { name: match[1], argument };
}

export interface IndexEntry {
  name: string;
  /** Where it came from: "snd" for Snd's own index, "s7" for the s7 core. */
  source: string;
}

export class StaticIndex {
  private entries: IndexEntry[] = [];

  load(file: string): void {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw?.entries)) this.entries = raw.entries;
    } catch {
      // A missing index is not an error: it only means offline completion
      // has nothing to offer until make-index has run.
      this.entries = [];
    }
  }

  get size(): number {
    return this.entries.length;
  }

  matching(prefix: string, limit = 300): IndexEntry[] {
    if (!prefix) return [];
    const out: IndexEntry[] = [];
    for (const entry of this.entries) {
      if (entry.name.startsWith(prefix)) {
        out.push(entry);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  has(name: string): boolean {
    return this.entries.some(entry => entry.name === name);
  }
}

export class SndHelpProvider
  implements vscode.HoverProvider, vscode.CompletionItemProvider, vscode.SignatureHelpProvider
{
  constructor(
    private readonly host: HelpHost,
    private readonly index: StaticIndex
  ) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const name = symbolAtOffset(document.getText(), document.offsetAt(position));
    if (!name) return undefined;

    if (!this.host.ready()) {
      if (!this.index.has(name)) return undefined;
      const text = new vscode.MarkdownString();
      text.appendCodeblock(name, 'scheme');
      text.appendMarkdown(
        '\nIn Snd\'s help index. Start a session for the description ' +
          '(`Snd: Start`).'
      );
      return new vscode.Hover(text);
    }

    let help;
    try {
      help = await this.host.help(name);
    } catch {
      return undefined;
    }
    if (!help.bound && !help.help) return undefined;

    const text = new vscode.MarkdownString();
    text.appendCodeblock(help.signature ? `${name} ${help.signature}` : name, 'scheme');
    // snd-help is Snd's own help text, the same one the listener shows;
    // the s7 docstring is the fallback for things Snd knows nothing about.
    const body = help.help || help.documentation;
    if (body) {
      // Snd's help texts are preformatted, with hard line breaks and
      // examples. Rendering them as Markdown collapses them into one
      // paragraph -- so they go in as a code block.
      text.appendCodeblock(body, 'text');
    }
    if (!help.bound) text.appendMarkdown('\n_not bound in this session_');
    return new vscode.Hover(text);
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[]> {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const prefix = symbolAtOffset(text.slice(0, offset) + ' ', offset) ?? '';
    if (prefix.length < 1) return [];

    if (!this.host.ready()) {
      return this.index.matching(prefix).map(entry => {
        const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Function);
        item.detail = `Snd index (${entry.source})`;
        return item;
      });
    }

    let candidates: Array<{ name: string; kind: string }> = [];
    try {
      candidates = await this.host.completions(prefix);
    } catch {
      return [];
    }
    return candidates.map(candidate => {
      const item = new vscode.CompletionItem(
        candidate.name,
        candidate.kind === 'function'
          ? vscode.CompletionItemKind.Function
          : vscode.CompletionItemKind.Variable
      );
      item.detail = 'live in this Snd session';
      // Exact prefix matches first: VS Code sorts alphabetically, which
      // buries `play` under `play-and-wait`, `player-home` and the rest.
      item.sortText = (candidate.name === prefix ? '0' : '1') + candidate.name;
      return item;
    });
  }

  async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.SignatureHelp | undefined> {
    if (!this.host.ready()) return undefined;
    const context = callContext(document.getText(), document.offsetAt(position));
    if (!context) return undefined;
    let help;
    try {
      help = await this.host.help(context.name);
    } catch {
      return undefined;
    }
    if (!help.bound) return undefined;

    // Snd's help text starts with the calling sequence, which is the only
    // argument list many of these functions have -- they are C functions,
    // so there is no lambda list to read.
    const firstLine = (help.help || '').split('\n').find(line => line.trim().length > 0);
    const label = firstLine?.trim() || `${context.name} ${help.signature}`.trim();

    const signature = new vscode.SignatureInformation(label);
    const parameters = label
      .replace(/^\(?\s*[^\s]+\s*/, '')
      .replace(/\)$/, '')
      .split(/\s+/)
      .filter(Boolean);
    signature.parameters = parameters.map(name => new vscode.ParameterInformation(name));

    const result = new vscode.SignatureHelp();
    result.signatures = [signature];
    result.activeSignature = 0;
    result.activeParameter = Math.min(context.argument, Math.max(0, parameters.length - 1));
    return result;
  }
}
