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
