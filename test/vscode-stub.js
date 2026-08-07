// vscode-stub.js
//
// Enough of the vscode module for the pure functions in modules that
// import it to be loadable under `node --test`.
//
// The alternative would be moving those functions into a vscode-free
// module purely so the gate can reach them, which shapes the source
// around the test runner.  A stub keeps the shape and pays for it with
// this file.

class EventEmitter {
  constructor() { this.listeners = []; }
  get event() { return (listener) => { this.listeners.push(listener); return { dispose() {} }; }; }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() {}
}

class MarkdownString {
  constructor() { this.value = ''; }
  appendCodeblock(text, language) { this.value += '```' + (language ?? '') + '\n' + text + '\n```\n'; }
  appendMarkdown(text) { this.value += text; }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id) { this.id = id; }
}

class CompletionItem {
  constructor(label, kind) { this.label = label; this.kind = kind; }
}

class SignatureInformation {
  constructor(label) { this.label = label; this.parameters = []; }
}

class ParameterInformation {
  constructor(label) { this.label = label; }
}

class SignatureHelp {
  constructor() { this.signatures = []; }
}

class Hover {
  constructor(contents) { this.contents = contents; }
}

const vscode = {
  EventEmitter,
  MarkdownString,
  TreeItem,
  ThemeIcon,
  CompletionItem,
  SignatureInformation,
  ParameterInformation,
  SignatureHelp,
  Hover,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  CompletionItemKind: { Function: 2, Variable: 5 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Beside: -2, One: 1 },
  Uri: { file: (p) => ({ fsPath: p }) },
  window: {
    createOutputChannel: () => ({ append() {}, appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    createTerminal: () => ({ show() {}, dispose() {} }),
    createWebviewPanel: () => ({
      webview: { html: '', postMessage() {}, onDidReceiveMessage() {} },
      onDidDispose() {},
      reveal() {},
    }),
    createTreeView: () => ({ dispose() {} }),
    showErrorMessage() {},
    showInformationMessage() {},
    onDidCloseTerminal() {},
    activeTextEditor: undefined,
  },
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    workspaceFolders: undefined,
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand() {} },
  languages: {
    registerHoverProvider: () => ({ dispose() {} }),
    registerCompletionItemProvider: () => ({ dispose() {} }),
    registerSignatureHelpProvider: () => ({ dispose() {} }),
  },
};

module.exports = vscode;

/** Route require('vscode') to this stub. Call before requiring out/*.js. */
module.exports.install = function install() {
  const Module = require('module');
  if (Module._sndVscodeStubInstalled) return;
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return load.call(this, request, parent, isMain);
  };
  Module._sndVscodeStubInstalled = true;
};
