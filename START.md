# Starting, in order

Four commands and F5. Each step says what it should print, because a step
that "seems to work" is the expensive kind.

## 1. Build the headless Snd (once, ~2 minutes)

```sh
cd snd-vscode
tools/build-snd.sh
```

Needs a C compiler and nothing else — no XQuartz, no Motif, no Homebrew.
It fetches snd-26.5, configures **without** a GUI, builds, and then checks
the thing that actually matters: whether the bridge reports itself.

Ends with:

```
ok: /…/snd-vscode/bin/darwin-arm64/snd
```

If configure picked up Motif anyway, it stops there and says so, rather
than handing you a binary that needs a display.

Already have a Snd you like? Skip this and set `"snd.path"` to it later.
That wins over everything, including a Motif build if you want both.

## 2. Build the extension

```sh
npm install
npm run compile
```

## 3. Check the channel by hand

```sh
bin/darwin-arm64/snd -l scheme/snd-vscode.scm
```

Frames go to stderr, so they land in the terminal. Expect immediately:

```
{"event":"ready","mode":"nogui","protocol":1}
```

Then type one line and press Return:

```scheme
(sv "1" 'status (inlet))
```

Ctrl-D to quit. This step separates *does Snd talk to the bridge* from
*does the extension talk to Snd* — two faults with one symptom otherwise.
More requests to try: `SMOKETEST.md`.

## 4. Run it

Open **this** folder in VS Code. Then, before pressing F5, look at the
dropdown in the Run and Debug view: it must say **Run snd-vscode**.

That is not a formality. VS Code remembers the last launch configuration
across projects, so with another extension project in the recent list, F5
starts THAT extension while this project's files are on screen. The window
title of the development host says which folder it opened, and the dropdown
says which extension it loaded — if either mentions something else, this is
what happened.

If anything behaves oddly, use **Run snd-vscode (only this extension)**. It
passes `--disable-extensions`, because extensions installed in the editor are
active in the development host too — and clamps-vscode binds the same chords
this one does (`C-c C-e`, `C-c C-z`, `C-c C-l`) for Lisp and Scheme files.
Whichever loads second wins, silently, and then "evaluate definition" sends
the form to SBCL instead of Snd.

In the development host window:

- open any `.scm` file — nothing has to be registered or bound; the
  extension activates on Scheme files and on any workspace containing
  `*.scm`. Check the bottom-right of the status bar says **Scheme**; a file
  VS Code has typed as something else gets no commands.
- `C-c C-z` — the REPL. It also opens by itself whenever a session starts,
  without taking the focus, so a session begun by evaluating a form leaves the
  cursor in the file
- `C-c C-f` — open a sound file; the waveform panel opens with it
- `C-c C-c` — the control panel
- **Snd: Transform Options** from the palette

If the transform dialog shows your window and size, the panel resolved the
enum numbers out of the running Snd, and everything downstream of that works.

`Snd: Open Log` says which binary was taken — configured, bundled, or PATH —
and everything Snd printed.

## Snd opens its own window

Then the session is running a **Motif** Snd, almost certainly one found on
`PATH` — `/usr/local/bin/snd` on macOS. The panels work with it (both editors
share the same state, which is the point), but if you wanted the headless one:

```sh
ls bin/darwin-arm64/snd
```

Missing? It is not in the archive and not in git — it is a build artefact, and
`.gitignore` keeps it out on purpose. Either rebuild it:

```sh
tools/build-snd.sh ~/.build/snd-26.5      # the source tree you already have
```

or copy it over from a previous checkout:

```sh
cp -R ../snd-vscode-0.1.0.old/bin .
```

The extension prefers `bin/<platform>-<arch>/snd` over `PATH`; `Snd: Open Log`
says which of the three it took — configured, bundled, or path.

## When it does not start

- **nothing happens for 30 s, then a timeout.** Almost always `~/.snd`: it is
  loaded deliberately, and if it opens a dialog or blocks, Snd never reports
  ready. Test with `"snd.args": ["-noinit"]` — if that starts, it is the init
  file and not the bridge.
- **"snd could not be started".** The path. `Snd: Open Log` shows what was
  tried.
- **step 3 prints nothing.** Absolute path to `scheme/snd-vscode.scm`. Snd
  says nothing about a load it could not find.

## Checking the whole thing

```sh
npm run gates
```

Structural checks, tsc, 76 node checks, 93 s7 checks. The s7 half wants an
`s7` binary; build one from Snd's own source in twenty seconds:

```sh
gcc -O2 -o s7 .build/snd-26.5/s7.c -DWITH_MAIN -I.build/snd-26.5 -lm -ldl
```

Without it that gate reports `skip`, never `ok`.
