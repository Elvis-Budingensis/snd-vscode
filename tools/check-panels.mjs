// check-panels.mjs
//
// Runs each webview's script against a stand-in DOM and reports any element
// it reaches for that its own HTML does not contain.
//
// WHY THIS EXISTS. A webview script that throws stops there. Every listener
// after the throw is never attached, nothing is ever drawn, and there is no
// message anywhere: the console belongs to a webview nobody has open. It
// looks exactly like a panel with nothing to draw.
//
// It happened with the envelope editor: a leftover line wired an `onchange`
// onto a dropdown that had been replaced by buttons. One dead line, and the
// whole panel silently stopped rendering — reported as "the envelopes are not
// shown", which sent the search to the envelope code rather than to the four
// characters that were wrong.
//
// This is not a substitute for opening the panel; it checks that the script
// RUNS, not that it draws the right thing. But "does it run" was the question
// that cost the evening.

import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const panels = fs
  .readdirSync(path.join(root, 'src'))
  .filter(name => /View\.ts$|Panel\.ts$/.test(name) || name === 'customUi.ts');

let failures = 0;

for (const file of panels) {
  const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
  const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(source);
  if (!script) continue;

  // The ids the panel's own HTML declares. Anything else the script asks for
  // is a reference to something that is not there.
  const html = source.slice(0, script.index);
  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));

  // Interpolations are extension-side values -- the dialog spec, the key
  // table. A placeholder has to stand in for them without pretending to know
  // their shape: `null` makes the script throw on the first property access,
  // which is the gate failing on itself rather than on the panel.
  //
  // So: an empty array that answers any unknown property with another empty
  // array. spec.groups iterates over nothing, KEYS.map works, spec.note is
  // harmless. The script runs its full length and every getElementById it
  // makes is still checked, which is the whole point.
  const code = script[1].replace(/\$\{[^}]*\}/g, '__lenient()');

  const missing = new Set();
  const elements = new Map();
  const element = id => ({
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    options: [],
    disabled: false,
    checked: false,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    appendChild() {},
    setAttribute() {},
    getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 300 }),
    getContext: () => new Proxy({}, { get: () => () => ({}), set: () => true }),
    clientWidth: 800,
    clientHeight: 300,
    width: 800,
    height: 300,
  });

  const lenient = () =>
    new Proxy([], {
      get(target, key) {
        if (key in target) return target[key];
        if (key === Symbol.iterator) return target[Symbol.iterator].bind(target);
        return lenient();
      },
    });

  const context = {
    __lenient: lenient,
    document: {
      getElementById(id) {
        if (!declared.has(id)) {
          missing.add(id);
          return null;
        }
        if (!elements.has(id)) elements.set(id, element(id));
        return elements.get(id);
      },
      createElement: () => element('new'),
      body: {},
    },
    window: { addEventListener() {}, devicePixelRatio: 1 },
    getComputedStyle: () => ({ getPropertyValue: () => '#ffffff' }),
    acquireVsCodeApi: () => ({ postMessage() {} }),
    atob: () => '',
    console,
    setTimeout,
    Math,
    JSON,
    isFinite,
    Number,
    String,
    Array,
    Object,
    RegExp,
    Infinity,
    NaN,
  };

  let threw;
  try {
    // eslint-disable-next-line no-new-func
    const run = new Function(...Object.keys(context), code);
    run(...Object.values(context));
  } catch (error) {
    threw = error;
  }

  if (missing.size > 0 || threw) {
    failures++;
    console.error(`FAIL ${file}`);
    if (missing.size > 0) {
      console.error(`     asks for ids its HTML does not have: ${[...missing].join(', ')}`);
    }
    if (threw) console.error(`     threw: ${threw.message}`);
  } else {
    console.log(`ok   ${file} (script runs, ${declared.size} ids)`);
  }
}

process.exit(failures === 0 ? 0 : 1);
