// session.test.js -- start-up, help lookup, and the manifest.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

require('./vscode-stub.js').install();

const { commandLine, executableFor } = require('../out/sndProcess.js');
const { symbolAtOffset, callContext, StaticIndex } = require('../out/helpProvider.js');
const { completionPrefix, commonPrefix } = require('../out/replTerminal.js');

const base = {
  command: 'snd',
  args: [],
  cwd: '/tmp',
  bridgePath: '/ext/scheme/snd-vscode.scm',
  mode: 'auto',
};

test('the bridge is loaded last', () => {
  // Snd works through its startup arguments in order. A bridge loaded
  // before the files would announce itself ready before the sounds it is
  // supposed to report exist.
  const line = commandLine({ ...base, args: ['-noinit'], files: ['/tmp/a.wav'] });
  assert.deepEqual(line.args, ['-noinit', '/tmp/a.wav', '-l', '/ext/scheme/snd-vscode.scm']);
});

test('the user arguments keep their order', () => {
  const line = commandLine({ ...base, args: ['-p', '2', '-noinit'] });
  assert.deepEqual(line.args.slice(0, 3), ['-p', '2', '-noinit']);
});

test('-noinit is not added behind the user back', () => {
  // ~/.snd is where a Snd user keeps what makes Snd theirs. An editor that
  // silently discards it is not offering the same Snd.
  const line = commandLine(base);
  assert.ok(!line.args.includes('-noinit'));
});

test('the mode picks a binary and an explicit path wins', () => {
  assert.equal(executableFor('nogui', 'snd'), 'snd-nogui');
  assert.equal(executableFor('gui', 'snd'), 'snd-motif');
  assert.equal(executableFor('auto', 'snd'), 'snd');
  assert.equal(executableFor('nogui', '/opt/snd/bin/snd'), '/opt/snd/bin/snd');
});

test('symbolAtOffset takes the whole Scheme name', () => {
  const text = '(channel->float-vector 0 100)';
  assert.equal(symbolAtOffset(text, 5), 'channel->float-vector');
  assert.equal(symbolAtOffset(text, 1), 'channel->float-vector');
});

test('symbolAtOffset keeps the characters a Scheme name may contain', () => {
  // A hover on `float-vector?` that reports `float` is worse than no
  // hover: it finds help for a different function and says nothing about
  // it.
  assert.equal(symbolAtOffset('(float-vector? x)', 3), 'float-vector?');
  assert.equal(symbolAtOffset('(set! *srate* 44100)', 8), '*srate*');
  assert.equal(symbolAtOffset('(+ 1 44100)', 7), undefined, 'a number is not a symbol');
});

test('callContext finds the innermost call and the argument', () => {
  const text = '(mix-sound "a.wav" 0 ';
  const context = callContext(text, text.length);
  assert.equal(context.name, 'mix-sound');
  assert.equal(context.argument, 2);
});

test('callContext counts a nested call as one argument', () => {
  const text = '(scale-channel (max-amp 0) ';
  const context = callContext(text, text.length);
  assert.equal(context.name, 'scale-channel');
  assert.equal(context.argument, 1);
});

test('callContext counts a string with spaces as one argument', () => {
  const text = '(mix-sound "my sound.wav" ';
  assert.equal(callContext(text, text.length).argument, 1);
});

test('callContext stays on the argument being typed', () => {
  const text = '(mix-sound "a.w';
  assert.equal(callContext(text, text.length).argument, 0);
});

test('callContext ignores a paren inside a string', () => {
  const text = '(display "((" ';
  const context = callContext(text, text.length);
  assert.equal(context.name, 'display');
});

test('completionPrefix takes the token before the cursor', () => {
  assert.equal(completionPrefix('(open-so', 8), 'open-so');
  assert.equal(completionPrefix('(display (make-osc', 18), 'make-osc');
  assert.equal(completionPrefix('(+ 1 2) ', 8), '');
});

test('commonPrefix is what Tab may insert', () => {
  assert.equal(commonPrefix(['make-oscil', 'make-oscil?']), 'make-oscil');
  assert.equal(commonPrefix(['play', 'player']), 'play');
  assert.equal(commonPrefix(['abc', 'xyz']), '');
  assert.equal(commonPrefix([]), '');
});

test('the generated index is loadable and holds real Snd names', () => {
  const index = new StaticIndex();
  index.load(path.join(__dirname, '..', 'data', 'snd-index.json'));
  assert.ok(index.size > 1000, `index holds only ${index.size} names`);
  for (const name of ['open-sound', 'channel->float-vector', 'snd-spectrum', 'for-each']) {
    assert.ok(index.has(name), `${name} missing from the index`);
  }
  assert.ok(!index.has('additive synthesis'), 'index topics are not completable names');
});

test('a missing index is not an error', () => {
  // Without it, offline completion offers nothing -- which is a smaller
  // problem than an extension that fails to activate.
  const index = new StaticIndex();
  index.load(path.join(os.tmpdir(), 'no-such-index.json'));
  assert.equal(index.size, 0);
  assert.deepEqual(index.matching('open'), []);
});

test('index lookup matches by prefix and honours the limit', () => {
  const index = new StaticIndex();
  index.load(path.join(__dirname, '..', 'data', 'snd-index.json'));
  const hits = index.matching('make-', 5);
  assert.equal(hits.length, 5);
  assert.ok(hits.every(entry => entry.name.startsWith('make-')));
  assert.deepEqual(index.matching(''), [], 'an empty prefix is not a query');
});

// --- the manifest ----------------------------------------------------
//
// A command in package.json that nobody registers shows up in the palette
// and fails when picked; a registered command missing from package.json
// cannot be reached at all. Neither is visible when reading either file
// on its own, which is why this is a test and not a review item.

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);
const extensionSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'extension.ts'),
  'utf8'
);

test('every command in the manifest is registered', () => {
  for (const entry of manifest.contributes.commands) {
    const name = entry.command.replace(/^snd\./, '');
    // The eight edit actions are registered from a loop over their names,
    // so the literal `command('snd.edit.delete'` never appears. What the
    // gate can check is that the name is in that list.
    if (name.startsWith('edit.')) {
      const action = name.slice('edit.'.length);
      assert.ok(
        new RegExp(`'${action}',`).test(extensionSource) ||
          new RegExp(`'${action}',?\\s*\\]`).test(extensionSource),
        `${entry.command} is in package.json but not in the edit action list`
      );
      continue;
    }
    assert.ok(
      extensionSource.includes(`command('snd.${name}'`),
      `${entry.command} is in package.json but never registered`
    );
  }
});

test('the panel and the palette offer the same edit actions', () => {
  // Two lists of the same names, one in the webview and one in the
  // extension, and a name in only one of them is a button that does
  // nothing or a command that cannot be reached. Both are checked against
  // the bridge's whitelist, which is the third list and the real one.
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'waveformView.ts'), 'utf8');
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'scheme', 'snd-vscode.scm'), 'utf8');
  const listOf = (text, marker) => {
    const found = new RegExp(`${marker}([\\s\\S]*?)\\]`).exec(text);
    return found ? [...found[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]).sort() : [];
  };
  const inPanel = listOf(panel, 'for \\(const action of ');
  const inExtension = listOf(extensionSource, 'for \\(const action of \\[');
  const inBridge = [...bridge.matchAll(/\(list "([a-z-]+)"\s+'[a-z-]+/g)]
    .map(m => m[1])
    .sort();
  assert.ok(inPanel.length >= 8, `panel offers ${inPanel.length} actions`);
  assert.deepEqual(inPanel, inExtension, 'panel and palette disagree');
  assert.deepEqual(inPanel, inBridge, 'the panel offers something the bridge does not do');
});

test('every registered command is in the manifest', () => {
  const declared = new Set(manifest.contributes.commands.map(entry => entry.command));
  // snd.helpFor is called from snd.apropos and deliberately not in the
  // palette: on its own, without a name, it has nothing to show.
  // These are invoked from tree items, which pass arguments. In the
  // palette they would appear without those arguments and fail, so they
  // are registered and deliberately not declared.
  const internal = new Set(['snd.helpFor', 'snd.goToSample', 'snd.goToEdit']);
  for (const match of extensionSource.matchAll(/command\('(snd\.[a-zA-Z]+)'/g)) {
    if (internal.has(match[1])) continue;
    assert.ok(declared.has(match[1]), `${match[1]} is registered but not declared`);
  }
});

test('every keybinding points at a declared command', () => {
  const declared = new Set(manifest.contributes.commands.map(entry => entry.command));
  for (const binding of manifest.contributes.keybindings) {
    assert.ok(declared.has(binding.command), `${binding.command} has a key but no command`);
  }
});

const keymapOf = (name) =>
  new Map(
    manifest.contributes.keybindings
      .filter(binding => binding.when.includes(`config.snd.keymap == '${name}'`))
      .map(binding => [binding.key, binding.command])
  );

test('the inf-snd.el key chords are kept', () => {
  // Anyone coming from inf-snd.el has these in their fingers. Changing
  // them buys nothing and costs the muscle memory of the only people who
  // already use Snd this way.
  const byKey = keymapOf('inf-snd');
  assert.equal(byKey.get('ctrl+c ctrl+e'), 'snd.evalTopLevel');
  assert.equal(byKey.get('ctrl+c ctrl+z'), 'snd.openRepl');
  assert.equal(byKey.get('ctrl+c ctrl+l'), 'snd.loadFile');
  assert.equal(byKey.get('ctrl+c ctrl+p'), 'snd.play');
  assert.equal(byKey.get('ctrl+c ctrl+t'), 'snd.stopPlaying');
  assert.equal(byKey.get('ctrl+c ctrl+i'), 'snd.help');
});

test('every setting the code reads is declared', () => {
  const declared = new Set(Object.keys(manifest.contributes.configuration.properties));
  for (const match of extensionSource.matchAll(/get<[^>]+>\('([a-zA-Z]+)'/g)) {
    assert.ok(
      declared.has(`snd.${match[1]}`),
      `snd.${match[1]} is read in the code but not declared`
    );
  }
});

test('the entry point the manifest names is what tsc produces', () => {
  assert.equal(manifest.main, './out/extension.js');
  assert.ok(
    fs.existsSync(path.join(__dirname, '..', 'out', 'extension.js')),
    'run npm run compile'
  );
});

test('the bridge that gets shipped is the one that gets tested', () => {
  // .vscodeignore excluding scheme/ would produce an extension that
  // installs and cannot start, with an error naming a path that exists in
  // the repository.
  const ignore = fs.existsSync(path.join(__dirname, '..', '.vscodeignore'))
    ? fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8')
    : '';
  assert.ok(!/^scheme\/?$/m.test(ignore), 'scheme/ must ship with the extension');
  assert.ok(!/^data\/?$/m.test(ignore), 'data/ must ship with the extension');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scheme', 'snd-vscode.scm')));
});

// --- the dialogs -----------------------------------------------------

const {
  DIALOGS,
  TRANSFORM_DIALOG,
  CONTROLS_DIALOG,
  PREFERENCES_DIALOG,
  variableNames,
  symbolNames,
  schemeLiteral,
} = require('../out/sndVariables.js');

test('every dialog variable is a plausible Snd name', () => {
  // Typos here are invisible: the bridge reports the name as unavailable
  // and the row is greyed out, which looks exactly like a build that does
  // not have it. So the names are checked against Snd's own help index.
  const index = new StaticIndex();
  index.load(path.join(__dirname, '..', 'data', 'snd-index.json'));
  const missing = [];
  for (const spec of DIALOGS) {
    for (const name of variableNames(spec)) {
      if (!index.has(name)) missing.push(`${spec.id}:${name}`);
    }
  }
  assert.deepEqual(missing, [], 'not in Snd 26.5\u2019s help index');
});

test('every enum symbol is a plausible Snd constant', () => {
  const index = new StaticIndex();
  index.load(path.join(__dirname, '..', 'data', 'snd-index.json'));
  const missing = [];
  for (const spec of DIALOGS) {
    for (const symbol of symbolNames(spec)) {
      if (!index.has(symbol)) missing.push(`${spec.id}:${symbol}`);
    }
  }
  assert.deepEqual(missing, [], 'not in Snd 26.5\u2019s help index');
});

test('no variable appears in two dialogs with different ranges', () => {
  // show-controls is deliberately in more than one panel; what must not
  // differ is what the control claims the variable can be.
  const seen = new Map();
  for (const spec of DIALOGS) {
    for (const group of spec.groups) {
      for (const variable of group.variables) {
        const shape = `${variable.kind}:${variable.min}:${variable.max}`;
        const previous = seen.get(variable.name);
        if (previous) assert.equal(previous, shape, `${variable.name} has two shapes`);
        else seen.set(variable.name, shape);
      }
    }
  }
});

test('enum options are unique per variable', () => {
  for (const spec of DIALOGS) {
    for (const group of spec.groups) {
      for (const variable of group.variables) {
        if (!variable.options) continue;
        const symbols = variable.options.map(option => option.symbol);
        assert.equal(new Set(symbols).size, symbols.length, `${variable.name} repeats an option`);
      }
    }
  }
});

test('a float variable is never written as an exact integer', () => {
  // (set! (amp-control) 1) gives an exact 1 in s7, and an exact where one
  // of these accessors wants a real is a type error -- on a slider
  // position that happens to be whole, which is the position it lands on
  // most often.
  const amp = CONTROLS_DIALOG.groups[0].variables.find(v => v.name === 'amp-control');
  assert.equal(schemeLiteral(amp, 1), '1.0');
  assert.equal(schemeLiteral(amp, 0), '0.0');
  assert.equal(schemeLiteral(amp, 0.5), '0.5');
});

test('booleans become #t and #f, not 1 and 0', () => {
  const peaks = TRANSFORM_DIALOG.groups[2].variables.find(v => v.name === 'show-transform-peaks');
  assert.equal(schemeLiteral(peaks, true), '#t');
  assert.equal(schemeLiteral(peaks, false), '#f');
});

test('an enum only accepts symbols it declared', () => {
  const type = TRANSFORM_DIALOG.groups[0].variables.find(v => v.name === 'transform-type');
  assert.equal(schemeLiteral(type, 'fourier-transform'), 'fourier-transform');
  // Anything else would be arbitrary text arriving inside a (set! ...).
  assert.equal(schemeLiteral(type, '(exit)'), undefined);
  assert.equal(schemeLiteral(type, 'not-a-transform'), undefined);
});

test('an int field rounds rather than sending a fraction', () => {
  const order = CONTROLS_DIALOG.groups[4].variables.find(v => v.name === 'filter-control-order');
  assert.equal(schemeLiteral(order, 20.6), '21');
  assert.equal(schemeLiteral(order, NaN), undefined);
});

test('a readonly field is never written', () => {
  const envelope = CONTROLS_DIALOG.groups[4].variables.find(
    v => v.name === 'filter-control-envelope'
  );
  assert.equal(schemeLiteral(envelope, '(0 0 1 1)'), undefined);
});

test('numeric enum options stay literals and are not resolved as symbols', () => {
  // Sizes and sample rates are numbers, not constants; asking Snd for the
  // value of the symbol `512` would fail.
  assert.ok(!symbolNames(TRANSFORM_DIALOG).includes('512'));
  assert.ok(!symbolNames(PREFERENCES_DIALOG).includes('44100'));
  assert.ok(symbolNames(TRANSFORM_DIALOG).includes('blackman2-window'));
});

test('the transform dialog covers what Snd\u2019s own dialog shows', () => {
  // From the Transform Options window: type, size, window, wavelet,
  // display column, window parameters, spectrum start/end.
  const names = variableNames(TRANSFORM_DIALOG);
  for (const expected of [
    'transform-type',
    'transform-size',
    'fft-window',
    'wavelet-type',
    'transform-graph-type',
    'show-transform-peaks',
    'max-transform-peaks',
    'fft-log-magnitude',
    'min-dB',
    'fft-log-frequency',
    'transform-normalization',
    'show-selection-transform',
    'fft-with-phases',
    'fft-window-alpha',
    'fft-window-beta',
    'spectrum-start',
    'spectrum-end',
  ]) {
    assert.ok(names.includes(expected), `${expected} missing from the transform dialog`);
  }
});

test('the control panel covers Snd\u2019s controls and "More controls"', () => {
  const names = variableNames(CONTROLS_DIALOG);
  for (const expected of [
    'amp-control',
    'speed-control',
    'expand-control',
    'expand-control-hop',
    'expand-control-length',
    'expand-control-ramp',
    'expand-control-jitter',
    'contrast-control',
    'contrast-control-amp',
    'reverb-control-scale',
    'reverb-control-length',
    'reverb-control-feedback',
    'reverb-control-lowpass',
    'filter-control-order',
  ]) {
    assert.ok(names.includes(expected), `${expected} missing from the control panel`);
  }
});

// --- where the binary comes from -------------------------------------

const { resolveExecutable } = require('../out/sndProcess.js');

const resolveWith = (options) =>
  resolveExecutable({
    configured: 'snd',
    mode: 'auto',
    bundleRoot: '/ext/bin',
    platform: 'darwin',
    arch: 'arm64',
    exists: () => false,
    ...options,
  });

test('a configured path wins over everything', () => {
  // Someone who set it means it — including someone pointing at their own
  // Motif build on purpose.
  const resolved = resolveWith({
    configured: '/usr/local/bin/snd',
    exists: () => true,
  });
  assert.equal(resolved.command, '/usr/local/bin/snd');
  assert.equal(resolved.source, 'configured');
});

test('a bundled binary is preferred over PATH', () => {
  // The whole point: the common case needs no decision and no install.
  const resolved = resolveWith({
    exists: (candidate) => candidate === '/ext/bin/darwin-arm64/snd',
  });
  assert.equal(resolved.command, '/ext/bin/darwin-arm64/snd');
  assert.equal(resolved.source, 'bundled');
});

test('a platform-only bundle is accepted as a fallback', () => {
  const resolved = resolveWith({
    exists: (candidate) => candidate === '/ext/bin/darwin/snd',
  });
  assert.equal(resolved.source, 'bundled');
});

test('Windows looks for snd.exe', () => {
  const seen = [];
  resolveWith({
    platform: 'win32',
    arch: 'x64',
    exists: (candidate) => {
      seen.push(candidate);
      return false;
    },
  });
  assert.ok(seen.some((candidate) => candidate.endsWith('snd.exe')), seen.join(' '));
});

test('with nothing bundled it falls back to PATH', () => {
  const resolved = resolveWith({});
  assert.equal(resolved.command, 'snd');
  assert.equal(resolved.source, 'path');
});

test('the mode still picks a name when falling back to PATH', () => {
  assert.equal(resolveWith({ mode: 'nogui' }).command, 'snd-nogui');
  assert.equal(resolveWith({ mode: 'gui' }).command, 'snd-motif');
});

test('the build script does not ask for Motif', () => {
  // The one line that would undo the point of the script. --with-motif here
  // would pull in XQuartz and libXm — the install this is meant to avoid —
  // and the binary would then need a display.
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'build-snd.sh'), 'utf8');
  const configureLines = script
    .split('\n')
    .filter((line) => line.includes('./configure') && !line.trim().startsWith('#'));
  assert.ok(configureLines.length > 0, 'no configure call found');
  for (const line of configureLines) {
    assert.ok(!line.includes('--with-motif'), line);
    assert.ok(!line.includes('--with-gui'), line);
  }
});

test('the build script does not trust the ambient toolchain', () => {
  // "cannot run C compiled programs" on Apple silicon is almost always a
  // conda environment: conda's linker wrappers and $CONDA_PREFIX/lib make
  // configure's test binary unrunnable, and configure reports that as a
  // broken compiler. The script has to neutralise that, and it has to say
  // it did — a build that silently discards someone's environment is its
  // own problem.
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'build-snd.sh'), 'utf8');
  for (const variable of ['CC', 'CFLAGS', 'LDFLAGS', 'SDKROOT']) {
    assert.ok(new RegExp(`\\b${variable}\\b`).test(script), `${variable} not handled`);
  }
  assert.ok(/conda/.test(script), 'conda paths not stripped from PATH');
  assert.ok(/SND_KEEP_ENV/.test(script), 'no way to keep the environment');
  assert.ok(/ignoring for this build/.test(script), 'strips silently');
});

test('the compiler probe runs in the source directory', () => {
  // It once ran in mktemp -d, which passes on a machine where cc is fine
  // and configure still fails — because what configure cannot do is run a
  // binary in ITS OWN build directory. A probe that cannot see the failure
  // it exists for is worse than none: it rules out the real cause.
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'build-snd.sh'), 'utf8');
  const probeLine = script.split('\n').find(line => /^PROBE=/.test(line));
  assert.ok(probeLine, 'no probe directory');
  assert.ok(/\$SOURCE/.test(probeLine), `probe is not in the source tree: ${probeLine}`);
  assert.ok(!/mktemp/.test(probeLine), 'probe is in a temporary directory again');
  // And it has to actually execute the thing, not just build it.
  assert.ok(/\.\/probe/.test(script), 'the probe binary is never run');
});

test('the probe names the causes it can distinguish', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'build-snd.sh'), 'utf8');
  for (const cause of ['noexec', 'quarantine']) {
    assert.ok(script.includes(cause), `${cause} not checked`);
  }
});

test('the build script probes the compiler before configure does', () => {
  // configure turns this failure into a sentence about cross compiling,
  // which sends everyone looking in the wrong place.
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'build-snd.sh'), 'utf8');
  const probeAt = script.indexOf('checking the compiler');
  // The first ./configure in the file is in the comment at the top
  // explaining that the whole build is ./configure && make. The CALL is
  // what has to come after the probe.
  const configureAt = script.indexOf('./configure --with-s7');
  assert.ok(probeAt > 0, 'no compiler probe');
  assert.ok(probeAt < configureAt, 'the probe runs after configure');
  assert.ok(/config\.log/.test(script), 'config.log is where the real error is');
  assert.ok(/rm -f config\.cache/.test(script), 'a stale cache repeats the failure');
});

test('on macOS the compiler is named, not left to configure', () => {
  // configure looks for `gcc` first and only falls back to `cc`. Normally
  // gcc on macOS is a shim for Apple clang; where a real GCC is installed
  // it is found instead, and a GCC older than the SDK produces binaries
  // that will not start. configure calls that "cannot run C compiled
  // programs", which sounds like a broken machine.
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'build-snd.sh'), 'utf8');
  assert.ok(/CC=\/usr\/bin\/clang/.test(script), 'Apple clang is not pinned on darwin');
  assert.ok(/configure[^\n]*CC="\$CC"/.test(script), 'CC is not passed to configure');
});

test('the probe uses the compiler configure will use', () => {
  // The probe once used `cc` while configure used `gcc`, so it came back
  // green on the machine where configure failed — it answered a question
  // nobody had asked.
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'build-snd.sh'), 'utf8');
  const compileLine = script.split('\n').find(line => line.includes('probe.c -o probe'));
  assert.ok(compileLine, 'no probe compile');
  assert.ok(/\$\{CC:-cc\}/.test(compileLine), `probe hardcodes a compiler: ${compileLine}`);
});

test('the script refuses to run from outside the project', () => {
  // ROOT comes from where the script sits. Run as a loose copy, the build
  // lands outside the project and the binary goes where the extension will
  // not look — and the failure names a path that does exist, in the repo.
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'build-snd.sh'), 'utf8');
  assert.ok(/scheme\/snd-vscode\.scm/.test(script), 'no location guard');
  assert.ok(/tools\/build-snd\.sh from inside it/.test(script), 'guard does not say what to do');
});

test('the launch configurations name a folder for the development host', () => {
  // The development host remembers ITS OWN last opened folder, independently
  // of which extension is launched. Without a folder argument it reopens the
  // last project — which looks exactly like the wrong extension having
  // started, because the window title and the files on screen are someone
  // else's.
  const raw = fs.readFileSync(path.join(__dirname, '..', '.vscode', 'launch.json'), 'utf8');
  const launch = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  assert.ok(launch.configurations.length >= 2, 'expected a plain and an isolated config');
  for (const configuration of launch.configurations) {
    assert.ok(
      configuration.args.some(argument => /\$\{workspaceFolder\}\/examples$/.test(argument)),
      `${configuration.name} does not open a folder`
    );
    assert.ok(/snd-vscode/.test(configuration.name), `${configuration.name} is not identifiable`);
  }
  // Ruling out another extension is checked in its own test below, which
  // also pins the fact that it must NOT be done with --disable-extensions.
  assert.ok(
    fs.existsSync(path.join(__dirname, '..', 'examples')),
    'the folder the configurations open does not exist'
  );
});

test('the extension declares the scheme language itself', () => {
  // Without this, .scm is recognised only because a built-in extension
  // happens to be enabled. Disable the built-ins — which is what
  // --disable-extensions does — and the file opens as Plain Text:
  // onLanguage:scheme never fires and every keybinding guarded by
  // editorLangId == scheme is dead. Nothing responds at all, which looks
  // like a broken extension rather than a missing language.
  const languages = manifest.contributes.languages;
  assert.ok(Array.isArray(languages) && languages.length > 0, 'no language contributed');
  const scheme = languages.find(language => language.id === 'scheme');
  assert.ok(scheme, 'scheme not contributed');
  assert.ok(scheme.extensions.includes('.scm'), '.scm not claimed');
  assert.ok(
    fs.existsSync(path.join(__dirname, '..', scheme.configuration.replace('./', ''))),
    `${scheme.configuration} is referenced but missing`
  );
});

test('the keybindings survive a file typed as something else', () => {
  for (const binding of manifest.contributes.keybindings) {
    assert.ok(
      /resourceExtname == \.scm/.test(binding.when),
      `${binding.command} only works when the language is right: ${binding.when}`
    );
  }
});

test('the launch configurations do not disable the built-in extensions', () => {
  // --disable-extensions takes the Scheme language support with it.
  const raw = fs.readFileSync(path.join(__dirname, '..', '.vscode', 'launch.json'), 'utf8');
  const launch = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  for (const configuration of launch.configurations) {
    assert.ok(
      !configuration.args.includes('--disable-extensions'),
      `${configuration.name} disables the built-ins too`
    );
  }
  // Ruling out one other extension by id is still worth having.
  assert.ok(
    launch.configurations.some(c =>
      c.args.some(a => /^--disable-extension=/.test(a))
    ),
    'no configuration rules out another extension'
  );
});


// --- the two keymaps ---------------------------------------------------

test('the SLIME chords are the ones SLIME uses', () => {
  // These are muscle memory from Common Lisp, not from Snd. Getting one
  // wrong is worse than not offering the keymap: the hand does the thing
  // and something else happens.
  const byKey = keymapOf('slime');
  assert.equal(byKey.get('ctrl+x ctrl+e'), 'snd.evalLastExpression');
  assert.equal(byKey.get('ctrl+alt+x'), 'snd.evalTopLevel', 'C-M-x is eval-defun');
  assert.equal(byKey.get('ctrl+c ctrl+r'), 'snd.evalSelection');
  assert.equal(byKey.get('ctrl+c ctrl+p'), 'snd.evalPrint');
  assert.equal(byKey.get('ctrl+c ctrl+k'), 'snd.loadFile');
  assert.equal(byKey.get('alt+.'), 'snd.showSource');
  assert.equal(byKey.get('ctrl+c ctrl+d ctrl+d'), 'snd.help');
  assert.equal(byKey.get('ctrl+c ctrl+d ctrl+a'), 'snd.apropos');
  assert.equal(byKey.get('ctrl+c ctrl+z'), 'snd.openRepl');
});

test('every keybinding belongs to exactly one keymap', () => {
  // A binding with no keymap guard is active in both — including in "none",
  // which is then a lie.
  for (const binding of manifest.contributes.keybindings) {
    const guards = ["config.snd.keymap == 'slime'", "config.snd.keymap == 'inf-snd'"].filter(
      guard => binding.when.includes(guard)
    );
    assert.equal(guards.length, 1, `${binding.command} on ${binding.key}: ${binding.when}`);
  }
});

test('the keymaps are exclusive where they disagree', () => {
  // C-c C-p is eval-and-print in SLIME and *play* in inf-snd.el; C-c C-t is
  // trace against stop-playing. Both meanings on one chord is why the
  // setting is exclusive rather than additive — this test exists to record
  // that they really do disagree, so nobody "simplifies" it later.
  const slime = keymapOf('slime');
  const inf = keymapOf('inf-snd');
  const disagreements = [...slime.keys()].filter(
    key => inf.has(key) && inf.get(key) !== slime.get(key)
  );
  assert.ok(
    disagreements.includes('ctrl+c ctrl+p'),
    `expected C-c C-p to differ; disagreements: ${disagreements.join(', ')}`
  );
});

test('the keymap setting offers exactly the maps that exist', () => {
  const setting = manifest.contributes.configuration.properties['snd.keymap'];
  assert.ok(setting, 'no snd.keymap setting');
  assert.deepEqual(setting.enum, ['inf-snd', 'slime', 'none']);
  // Snd's own map is the default: these chords are what a Snd user's hands
  // already do, and C-c C-p for play has no SLIME equivalent to lose.
  assert.equal(setting.default, 'inf-snd');
  assert.ok(setting.enum.includes(setting.default), 'the default is not one of the options');
  assert.equal(setting.enum.length, setting.markdownEnumDescriptions.length);
  for (const name of ['slime', 'inf-snd']) {
    assert.ok(keymapOf(name).size > 5, `${name} has almost no bindings`);
  }
});

test('the SLIME-only commands exist and are registered', () => {
  for (const command of ['snd.evalLastExpression', 'snd.evalPrint', 'snd.showSource']) {
    assert.ok(
      manifest.contributes.commands.some(entry => entry.command === command),
      `${command} not declared`
    );
    assert.ok(extensionSource.includes(`command('${command}'`), `${command} not registered`);
  }
});

// --- the multichannel panel -------------------------------------------

test('the panel asks for all channels in one request', () => {
  // Coupled axes are the whole point of stacking channels: a loop over
  // per-channel requests lets the lanes drift apart during a drag, and lanes
  // showing different windows of time invent phase differences that are not
  // in the recording.
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'waveformView.ts'), 'utf8');
  assert.ok(/chns: string/.test(panel), 'the panel still asks per channel');
  assert.ok(
    /request\('waveforms'/.test(extensionSource),
    'the extension does not call the plural op'
  );
  assert.ok(
    !/request\('waveform'[^s]/.test(extensionSource),
    'the singular op is still being called'
  );
});

test('the shared range is decided in Snd, not in the panel', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'scheme', 'snd-vscode.scm'), 'utf8');
  const op = /sv-define-op waveforms[\s\S]*?(?=\(sv-define-op)/.exec(bridge);
  assert.ok(op, 'no waveforms op');
  // One range, from the longest channel, applied to every lane.
  assert.ok(/longest/.test(op[0]), 'the range is not taken from the longest channel');
  assert.ok(/coverage/.test(op[0]), 'a short channel cannot report its true width');
});

test('a click reports which lane it hit', () => {
  // Without this the focused channel stays whatever it was, and an edit
  // lands in a channel the user did not point at — noticed only afterwards.
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'waveformView.ts'), 'utf8');
  assert.ok(/function channelAt/.test(panel), 'no lane hit test');
  assert.ok(/type: 'cursor', x: at.from, chn: at.chn/.test(panel), 'cursor sends no channel');
  assert.ok(/chn: at.chn/.test(panel), 'selection sends no channel');
  // The lane geometry must be computed once and shared, or a click lands one
  // lane off.
  assert.ok(/function lanes\(/.test(panel) && /laneAt\(/.test(panel), 'geometry not shared');
});

// --- the frequency axis ------------------------------------------------

test('the spectrum panel uses the transform size, not the array length', () => {
  // snd-spectrum returns a vector as long as the transform and leaves the
  // upper half untouched — which in dB is 0.0, the TOP of the scale. Halving
  // the array length instead of using the known size drew that untouched half
  // as a flat line at full level across the right of the plot: a step in the
  // middle of every dB spectrum, which reads as an artefact of the signal.
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'spectrumView.ts'), 'utf8');
  assert.ok(
    /Math\.floor\(current\.size \/ 2\)/.test(panel),
    'the bin count is not derived from the transform size'
  );
  assert.ok(
    !/Math\.floor\(values\.length \/ 2\)/.test(panel),
    'the bin count is back to half the array length'
  );
});

test("the log frequency axis follows Snd's own settings", () => {
  // 440 Hz on a linear axis to 22050 Hz is 2% of the height — one line of
  // pixels at the bottom with black above it. Correct and useless, which is
  // why Snd has fft-log-frequency and log-freq-start at all.
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'spectrumView.ts'), 'utf8');
  assert.ok(/logFreqStart/.test(panel), 'log-freq-start is not honoured');
  assert.ok(/spectrumEnd/.test(panel), "Snd's spectrum-end has no equivalent");
  // Snd squashes everything below log-freq-start into the origin rather than
  // stretching the inaudible bottom across a quarter of the axis.
  assert.ok(/hz <= start/.test(panel), 'the low end is not collapsed to the origin');
});

test('a change of axis does not refetch the data', () => {
  // A sonogram is hundreds of FFTs. Recomputing them because the axis became
  // logarithmic would make a checkbox take a second.
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'spectrumView.ts'), 'utf8');
  const handler = /case 'logfreq':[\s\S]*?break;/.exec(panel);
  assert.ok(handler, 'no log frequency handler');
  assert.ok(/redraw\(\)/.test(handler[0]), 'the axis change refetches');
  assert.ok(!/reload\(\)/.test(handler[0]), 'the axis change refetches');
});

// --- the vendored s7 ---------------------------------------------------

test('s7 is in the repository, so the s7 gate runs from a fresh clone', () => {
  // Without a copy, the only way to get an s7 is tools/build-snd.sh, which
  // downloads 14 MB from ccrma — nineteen minutes, once, here. The result was
  // "skip s7 tests" on every fresh clone, and a gate that always skips is the
  // one that was going to catch the next mistake in the bridge.
  const directory = path.join(__dirname, '..', 'third-party', 's7');
  for (const name of ['s7.c', 's7.h', 'README.md']) {
    assert.ok(fs.existsSync(path.join(directory, name)), `third-party/s7/${name} missing`);
  }
  // 0BSD, and the line is in the file itself — worth asserting, because a
  // future update that pulled in a differently licensed s7 would otherwise be
  // invisible.
  const source = fs.readFileSync(path.join(directory, 's7.c'), 'utf8').slice(0, 2000);
  assert.ok(/SPDX-License-Identifier:\s*0BSD/.test(source), 's7.c is not the 0BSD one');
});

test('the test runner looks in the repository before anywhere else', () => {
  const runner = fs.readFileSync(
    path.join(__dirname, '..', 'tools', 'run-scheme-tests.mjs'),
    'utf8'
  );
  const list = /const sources = \[[\s\S]*?\]/.exec(runner);
  assert.ok(list, 'no source list');
  assert.ok(
    list[0].indexOf("'third-party'") < list[0].indexOf("'.build'"),
    'third-party/s7 is not searched first'
  );
});

test('the vendored source does not ship inside the extension', () => {
  // Four megabytes of C in a VSIX that cannot compile it. .vscodeignore is
  // the only thing standing between the repository layout and the package.
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8');
  for (const pattern of ['third-party/**', '.build/**']) {
    assert.ok(ignore.includes(pattern), `${pattern} would be packaged`);
  }
  // And the things that must still ship, which the same file could exclude by
  // accident.
  assert.ok(!/^scheme\/?\*?\*?$/m.test(ignore), 'scheme/ must ship');
  assert.ok(!/^data\/?\*?\*?$/m.test(ignore), 'data/ must ship');
});

// --- the envelope editor -----------------------------------------------

const { pointsToWire, wireToPoints, normaliseX, constrain } = require('../out/envelopeView.js');

test('breakpoints go over the wire as plain numbers', () => {
  // The bridge reads these with string->number and refuses anything else, so
  // an envelope cannot become a way to send code.
  assert.equal(pointsToWire([{ x: 0, y: 1 }, { x: 1, y: 0 }]), '0 1 1 0');
  assert.ok(!/[()a-z]/.test(pointsToWire([{ x: 0.5, y: 0.25 }, { x: 1, y: 0 }])));
});

test('breakpoints are rounded, not sent at full float precision', () => {
  // A canvas position has about three decimal places of meaning; the rest is
  // noise that makes the envelope unreadable in Snd's own editor.
  const wire = pointsToWire([{ x: 1 / 3, y: 2 / 3 }, { x: 1, y: 0 }]);
  assert.equal(wire, '0.3333 0.6667 1 0');
});

test('an envelope round-trips through the wire format', () => {
  const points = [{ x: 0, y: 1 }, { x: 0.5, y: 0.25 }, { x: 1, y: 0 }];
  const wire = pointsToWire(points);
  assert.deepEqual(wireToPoints(wire.split(' ').map(Number)), points);
});

test("x is normalised, keeping the spacing", () => {
  // Snd's envelopes carry arbitrary x units: (0 0 1 1 2 0) and (0 0 0.5 1 1 0)
  // are the same envelope, and both have to arrive as the same drawing.
  // Clipping instead would turn a three-point envelope into a two-point one
  // and lose the shape it was drawn for.
  const wide = normaliseX([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }]);
  assert.deepEqual(wide, [{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 0 }]);
  const already = normaliseX([{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 0 }]);
  assert.deepEqual(already, [{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 0 }]);
});

test('normaliseX survives an envelope with no span', () => {
  const flat = normaliseX([{ x: 3, y: 0.5 }, { x: 3, y: 0.9 }]);
  assert.equal(flat[0].x, 0);
  assert.equal(flat[1].x, 1);
});

test('the first and last x are pinned', () => {
  // An envelope that does not start at 0 and end at 1 is applied over a
  // shorter span than the one drawn, and the rest keeps the last value —
  // which looks like the envelope being ignored at the edges.
  const points = [{ x: 0, y: 1 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }];
  assert.equal(constrain(points, 0, 0.4, 0.8, { min: 0, max: 2 })[0].x, 0);
  assert.equal(constrain(points, 2, 0.6, 0.2, { min: 0, max: 2 })[2].x, 1);
});

test('a dragged point stays strictly between its neighbours', () => {
  // Two points at the same x make a vertical jump, which Snd's env generator
  // reads as a division by zero in the segment slope.
  const points = [{ x: 0, y: 1 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }];
  const far = constrain(points, 1, 5, 0.5, { min: 0, max: 2 });
  assert.ok(far[1].x < points[2].x, 'moved past its right neighbour');
  const near = constrain(points, 1, -5, 0.5, { min: 0, max: 2 });
  assert.ok(near[1].x > points[0].x, 'moved past its left neighbour');
});

test('y is clamped to the range the target allows', () => {
  // A filter response is a gain between 0 and 1; an amplitude envelope is a
  // multiplier and may exceed 1. The same curve must not mean both.
  const points = [{ x: 0, y: 1 }, { x: 1, y: 1 }];
  assert.equal(constrain(points, 0, 0, 5, { min: 0, max: 1 })[0].y, 1);
  assert.equal(constrain(points, 0, 0, 5, { min: 0, max: 2 })[0].y, 2);
  assert.equal(constrain(points, 0, 0, -3, { min: 0, max: 2 })[0].y, 0);
});

// --- the shipped binary ------------------------------------------------

test('the bundled Snd is not excluded from the package', () => {
  // The whole point of committing it is that it is there after a clone and
  // after an install. .vscodeignore is the one file that could quietly undo
  // that.
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.vscodeignore'), 'utf8');
  assert.ok(!/^bin\/?\*?\*?$/m.test(ignore), 'bin/ would not ship');
});

test('every committed binary is accounted for', () => {
  // A binary in a repository needs a note saying what it is and where it came
  // from. Without one it is just four megabytes nobody can check.
  const directory = path.join(__dirname, '..', 'bin');
  if (!fs.existsSync(directory)) return;
  const platforms = fs
    .readdirSync(directory)
    .filter(name => fs.existsSync(path.join(directory, name, 'snd')));
  if (platforms.length === 0) return;
  const readme = path.join(directory, 'README.md');
  assert.ok(fs.existsSync(readme), 'bin/README.md is missing');
  const text = fs.readFileSync(readme, 'utf8');
  for (const platform of platforms) {
    assert.ok(text.includes(platform), `bin/README.md does not mention ${platform}`);
  }
  // And a checksum, so it can be verified rather than trusted.
  assert.ok(/sha256|shasum/i.test(text), 'bin/README.md has no checksum');
});

// --- auditioning -------------------------------------------------------

const { shouldUndoPrevious } = require('../out/envelopeView.js');

test('an audition replaces the previous one', () => {
  // Twenty presses of space while dragging a point must not leave twenty
  // entries in the edit history.
  assert.equal(shouldUndoPrevious({ editPosition: 4 }, 4), true);
});

test('an audition does not undo somebody else\u2019s work', () => {
  // If anything happened since — an edit from the REPL, a delete in the
  // waveform panel, an undo by hand — the previous audition is no longer the
  // top of the history, and undoing would take that other work back instead.
  // Stacking is the safe direction to be wrong in.
  assert.equal(shouldUndoPrevious({ editPosition: 4 }, 7), false);
  assert.equal(shouldUndoPrevious({ editPosition: 4 }, 3), false);
});

test('the first audition has nothing to replace', () => {
  assert.equal(shouldUndoPrevious(undefined, 0), false);
});

test('apply clears the audition, so space cannot take it back', () => {
  // Otherwise "apply" would be the one action reversible by pressing space
  // afterwards.
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'envelopeView.ts'), 'utf8');
  const applyCase = /case 'apply': \{[\s\S]*?break;/.exec(panel);
  assert.ok(applyCase, 'no apply handler');
  assert.ok(/this\.audition = undefined/.test(applyCase[0]), 'apply leaves the audition set');
  // And an edit from anywhere else must clear it too.
  const refresh = /static refresh\(\)[\s\S]*?\n  \}/.exec(panel);
  assert.ok(/audition = undefined/.test(refresh[0]), 'refresh leaves the audition set');
});

test('space is ignored while a field has focus', () => {
  // Typing 1.5 into "base" would otherwise play the sound on the space
  // between the digits.
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'envelopeView.ts'), 'utf8');
  assert.ok(/tag === 'INPUT'/.test(panel), 'space is not guarded against form fields');
});

test('the REPL comes up with the session', () => {
  // A running Snd with no visible listener is a process nobody can type
  // into, and Snd's own stdout has nowhere to appear. Snd itself does the
  // same: its listener is part of the window.
  assert.ok(/session\.onReady = \(\)/.test(extensionSource), 'nothing runs when a session is ready');
  const handler = /session\.onReady = \(\) => \{[\s\S]*?\n  \};/.exec(extensionSource);
  assert.ok(handler, 'no onReady handler');
  assert.ok(/SndReplTerminal\.show/.test(handler[0]), 'the REPL is not opened');
  assert.ok(/openReplOnStart/.test(handler[0]), 'it cannot be switched off');
});

test('opening the REPL does not steal the focus', () => {
  // Starting a session by evaluating a form must leave the cursor in the
  // file — otherwise C-c C-e moves you somewhere you did not ask to go.
  const repl = fs.readFileSync(path.join(__dirname, '..', 'src', 'replTerminal.ts'), 'utf8');
  assert.ok(/terminal\.show\(false\)/.test(repl), 'the terminal takes focus');
});

test('snd.openReplOnStart is declared and on by default', () => {
  const setting = manifest.contributes.configuration.properties['snd.openReplOnStart'];
  assert.ok(setting, 'the setting is missing');
  assert.equal(setting.default, true);
});

test('opening the REPL starts a session', () => {
  // A prompt in front of a process that does not exist yet looks like a REPL
  // that is not working. Asking for a listener is asking for something to
  // listen to.
  const handler = /command\('snd\.openRepl'[\s\S]*?\n  \);/.exec(extensionSource);
  assert.ok(handler, 'no openRepl command');
  assert.ok(/SndReplTerminal\.show/.test(handler[0]), 'the terminal is not shown');
  assert.ok(/session\.start\(\)/.test(handler[0]), 'the session is not started');
});

// --- regions, mixes and marks in the tree ------------------------------

test('the region and mix commands are wired to the right context', () => {
  // A context menu entry on the wrong viewContext is invisible; on the right
  // one but unregistered it fails when clicked. Both are silent.
  const contexts = new Map();
  for (const entry of manifest.contributes.menus['view/item/context']) {
    const match = /viewItem == (\w+)/.exec(entry.when);
    if (match) contexts.set(entry.command, match[1]);
  }
  for (const command of ['snd.region.play', 'snd.region.insert', 'snd.region.save']) {
    assert.equal(contexts.get(command), 'sndRegion', `${command} is on the wrong item`);
  }
  for (const command of ['snd.mix.play', 'snd.mix.amp', 'snd.mix.position']) {
    assert.equal(contexts.get(command), 'sndMix', `${command} is on the wrong item`);
  }
  for (const command of ['snd.mark.delete', 'snd.mark.rename']) {
    assert.equal(contexts.get(command), 'sndMark', `${command} is on the wrong item`);
  }
  // And the tree must actually set those contextValues.
  const explorer = fs.readFileSync(path.join(__dirname, '..', 'src', 'soundExplorer.ts'), 'utf8');
  for (const value of ['sndRegion', 'sndMix', 'sndMark']) {
    assert.ok(explorer.includes(`'${value}'`), `${value} is never set on a tree item`);
  }
});

test('a region is inserted at the cursor, not at zero', () => {
  // The same mistake insert-selection made: beg defaults to 0, so the paste
  // lands at the start of the file wherever the cursor was.
  const insert = /command\('snd\.region\.insert'[\s\S]*?\n  \);/.exec(extensionSource);
  assert.ok(insert, 'no region insert command');
  assert.ok(/cursorOf/.test(insert[0]), 'the cursor is not asked for');
  assert.ok(/at,/.test(insert[0]), 'the position is not passed');
});

test('forgetting a region says what it does not do', () => {
  // "Forget" reads like "delete". forget-region drops Snd's copy and does not
  // touch any sound.
  const forget = /command\('snd\.region\.forget'[\s\S]*?\n  \);/.exec(extensionSource);
  assert.ok(/not affected/.test(forget[0]), 'the confirmation does not say what survives');
});

test("the sonogram floor is snd-spectrum's own -90, not min-dB", () => {
  // From snd-sig.c: bins under `lowest` (1e-6) are set to a flat -90, while
  // bins just above it are computed and can be LOWER (-105.14, measured).
  // Scaling against min-dB (-60) puts every real measurement below -60 into
  // the same black as the ones that were never measured.
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'scheme', 'snd-vscode.scm'), 'utf8');
  const op = /sv-define-op sonogram[\s\S]*?(?=\(sv-define-op)/.exec(bridge);
  assert.ok(op, 'no sonogram op');
  assert.ok(/floor-dB -90\.0/.test(op[0]), 'the floor is not -90');
  assert.ok(/snd-sig\.c/.test(op[0]), 'the source of the number is not recorded');
});

test('the single spectrum does not draw the -90 values as a curve', () => {
  // They are not measurements: snd-spectrum uses -90 for "raw magnitude under
  // 1e-6", while bins just above that are computed and can be lower. Drawing
  // them produced the step in the middle of every dB spectrum.
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'spectrumView.ts'), 'utf8');
  assert.ok(/NOT_MEASURED = -90/.test(panel), 'the threshold value is not named');
  assert.ok(/drawing = false/.test(panel), 'unmeasured bins are not skipped');
  // The range must be computed over measured bins only, or the whole curve is
  // squashed against a floor that is not part of it.
  assert.ok(/filter\(value => value !== NOT_MEASURED\)/.test(panel), 'the range includes -90');
  // Linear mode has no such threshold — the exclusion must not apply there.
  assert.ok(/current\.linear\s*\?/.test(panel), 'linear mode is treated the same');
});

// --- Bill's envelope dialog --------------------------------------------

const { isSupported } = require('../out/envelopeView.js');

test("the three targets are Bill's own labels", () => {
  // "The choice is made via the three buttons marked 'amp', 'flt', and 'src'."
  // Renaming them to something more descriptive would break the connection to
  // his documentation, which is the thing a Snd user already knows.
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'envelopeView.ts'), 'utf8');
  assert.ok(/'amp' \| 'flt' \| 'src'/.test(panel), 'the targets are not amp/flt/src');
  assert.ok(/'sound' \| 'selection' \| 'mix'/.test(panel), 'the scopes are not his either');
});

test('the target/scope matrix matches what Snd has', () => {
  //            sound             selection          mix
  //   amp      env-sound         env-selection      mix-amp-env
  //   flt      filter-sound      filter-selection   —
  //   src      src-sound         src-selection      —
  for (const scope of ['sound', 'selection']) {
    for (const target of ['amp', 'flt', 'src']) {
      assert.ok(isSupported(target, scope), `${target} × ${scope} should exist`);
    }
  }
  assert.ok(isSupported('amp', 'mix'), 'a mix has an amplitude envelope');
  // And the two cells Snd does not have. Falling back to the sound would
  // envelope a whole file when one mix was asked for.
  assert.ok(!isSupported('flt', 'mix'), 'a mix has no filter envelope');
  assert.ok(!isSupported('src', 'mix'), 'a mix has no src envelope');
});

test('the envelope has its own undo history, separate from Snd\u2019s', () => {
  // "The Undo and Redo buttons can be used to move around in the list of
  // envelope edits." Undoing a breakpoint one did not mean to add must not
  // undo an edit to the sound.
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'envelopeView.ts'), 'utf8');
  assert.ok(/let history = \[/.test(panel), 'no envelope history');
  assert.ok(/function goBack/.test(panel), 'no way to move through it');
  assert.ok(/not Snd/.test(panel), 'the separation is not recorded');
});

test('every enved variable the dialog shows is a real Snd name', () => {
  // Bill's dialog is a window over these; a typo here shows as a control that
  // silently does nothing.
  const index = new StaticIndex();
  index.load(path.join(__dirname, '..', 'data', 'snd-index.json'));
  for (const name of [
    'enved-envelope',
    'enved-base',
    'enved-clip?',
    'enved-wave?',
    'enved-in-dB',
    'enved-power',
    'enved-style',
    'enved-target',
    'enved-filter-order',
    'enved-amplitude',
    'enved-spectrum',
    'enved-srate',
    'define-envelope',
    'env-sound',
    'filter-sound',
    'src-sound',
    'env-selection',
    'filter-selection',
    'src-selection',
    'mix-amp-env',
  ]) {
    assert.ok(index.has(name), `${name} is not in Snd's index`);
  }
});

// --- Snd's keyboard ----------------------------------------------------

const { KEY_COMMANDS } = require('../out/waveformView.js');

test("the panel offers Snd's own chords", () => {
  // From snd.html: C-d deletes the sample at the cursor, C-k a 'line', C-m
  // places a mark, C-j goes to the next one, C-y pastes the selection, C-w
  // deletes it. A Snd user's hands already know these.
  const byKey = new Map(KEY_COMMANDS.map(entry => [entry.key, entry.action]));
  assert.equal(byKey.get('d'), 'delete-sample');
  assert.equal(byKey.get('h'), 'delete-previous');
  assert.equal(byKey.get('k'), 'delete-line');
  assert.equal(byKey.get('o'), 'insert-zero');
  assert.equal(byKey.get('z'), 'zero-sample');
  assert.equal(byKey.get('m'), 'mark');
  assert.equal(byKey.get('j'), 'next-mark');
  assert.equal(byKey.get('y'), 'paste');
  assert.equal(byKey.get('w'), 'delete-selection');
  assert.equal(byKey.get('a'), 'start');
  assert.equal(byKey.get('e'), 'end');
  assert.equal(byKey.get('f'), 'forward');
  assert.equal(byKey.get('b'), 'backward');
  assert.equal(byKey.get('n'), 'down');
  assert.equal(byKey.get('p'), 'up');
});

test('the key table is interpolated, not written out twice', () => {
  // It was written out twice for about ten minutes, and a build-time regex
  // dropped the three entries whose description contains an apostrophe —
  // three keys that would have done nothing, with nothing to notice.
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'waveformView.ts'), 'utf8');
  assert.ok(/const keys = JSON\.stringify\(KEY_COMMANDS\)/.test(panel), 'not interpolated');
  assert.ok(/const KEYS = \$\{keys\}/.test(panel), 'the webview has its own copy');
});

test('every key action exists in the bridge', () => {
  // A chord pointing at an action the bridge does not know fails silently in
  // the panel — the request errors and the key just seems dead.
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'scheme', 'snd-vscode.scm'), 'utf8');
  const op = /sv-define-op key \(params\)[\s\S]*?(?=\(sv-define-op)/.exec(bridge);
  assert.ok(op, 'no key op');
  for (const entry of KEY_COMMANDS) {
    assert.ok(
      op[0].includes(`"${entry.action}"`),
      `${entry.action} (C-${entry.key}) is not handled by the bridge`
    );
  }
});

test('the envelope panel hears about a define-envelope in the REPL', () => {
  // Snd has no hook for "a variable was defined", so the REPL saying
  // "something ran" is the only signal there is — and without it a name
  // defined a moment ago simply is not in the list, with nothing to suggest
  // why.
  assert.ok(/private afterEvaluation/.test(extensionSource), 'nothing runs after an eval');
  const handler = /session\.onEvaluated = \(\) => \{[\s\S]*?\n  \};/.exec(extensionSource);
  assert.ok(handler, 'no onEvaluated handler');
  assert.ok(/EnvelopeView\.refresh/.test(handler[0]), 'the envelope panel is not refreshed');
  // Coalesced: evaluating a file sends one of these per form.
  assert.ok(/clearTimeout\(this\.evaluationTimer\)/.test(extensionSource), 'not coalesced');
});

// --- Find and sync -----------------------------------------------------

test('Find evaluates a predicate, and only from a prompt', () => {
  // "The expression it asks for is a function that takes one argument, the
  // current sample value, and returns #t when it finds a match." A closure is
  // allowed and is the point — his zero+ example keeps the previous sample in
  // a let. So the expression is evaluated, which means it must come from a
  // prompt the user typed into and never from a panel button.
  assert.ok(/showInputBox/.test(extensionSource), 'Find does not prompt');
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'scheme', 'snd-vscode.scm'), 'utf8');
  const op = /sv-define-op find \(params\)[\s\S]*?(?=\(sv-define-op)/.exec(bridge);
  assert.ok(op, 'no find op');
  assert.ok(/eval-string expr \(rootlet\)/.test(op[0]), 'the expression is not evaluated');
  assert.ok(/procedure\? predicate/.test(op[0]), 'a non-procedure is not refused');
  // scan-channel is obsolete per the reference; a do loop over a sampler is
  // what it recommends instead.
  assert.ok(/make-sampler/.test(op[0]), 'the scan does not use a sampler');
  assert.ok(!/scan-channel/.test(op[0]), 'scan-channel is obsolete');
  // And Snd's own search-procedure is set, so C-s in a Motif window looks for
  // the same thing.
  assert.ok(/search-procedure/.test(op[0]), "Snd's own search-procedure is not set");
});

test('no panel sends a Find expression', () => {
  // The one place arbitrary Scheme is evaluated on purpose is the REPL, and
  // now Find. A webview must not be able to reach either.
  for (const name of ['waveformView.ts', 'spectrumView.ts', 'envelopeView.ts', 'dialogPanel.ts']) {
    const panel = fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
    assert.ok(!/type: 'find'/.test(panel), `${name} sends a find request`);
  }
});

test('sync is shown in the tree', () => {
  // A sound edited together with another one looks possessed otherwise: an
  // edit here changes something over there, with nothing on screen to say so.
  const explorer = fs.readFileSync(path.join(__dirname, '..', 'src', 'soundExplorer.ts'), 'utf8');
  assert.ok(/sync \$\{node\.sound\.sync\}/.test(explorer), 'sync is not displayed');
});
