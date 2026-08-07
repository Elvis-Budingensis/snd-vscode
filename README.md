# snd-vscode

Snd — Bill Schottstaedt's programmable sound editor — as a VS Code session.

Two things at once, which is the whole point:

- **The inferior Snd**, the way `inf-snd.el` does it: a real Snd process, its
  s7 reachable from the editor, `C-c C-e` to evaluate the definition under
  the cursor, Tab completion, `snd-help` on hover. The same key chords as
  `inf-snd.el`, because anyone who already works this way has them in their
  fingers.
- **Snd's graphs as editor panels**: the channel waveform and the spectrum,
  drawn in VS Code from numbers Snd computes. Which means they work in a
  headless Snd build, over ssh, and beside the file being edited — three
  things Snd's own Motif window cannot do.

Snd stays the editor. Every edit happens in Snd, in Scheme, so there is one
edit history and it is the one that gets saved. The panels set the cursor,
the selection and the visible range, and ask for a redraw.

## Requirements

A Snd binary. Getting one is not the ordeal it has the reputation of being,
because **the ordeal is Motif, and Motif is the part this extension
replaces**.

Snd's own configure defaults to *no GUI* — Motif is used only with
`--with-motif` — and the headless build has no X dependency at all. sndlib
and s7 are in the tarball; on macOS the audio backend is CoreAudio, which is
part of the system. So there is no XQuartz, no libXm, no libXt, no Homebrew
archaeology:

```sh
tools/build-snd.sh          # fetches snd-26.5, configures headless, builds
```

Two minutes and a C compiler. The binary lands in `bin/<platform>-<arch>/snd`,
which is where the extension looks before it looks at `PATH`. The script
refuses to continue if configure picked up Motif anyway, because that failure
otherwise surfaces much later and looks like something else.

To skip even that: `.github/workflows/build-snd.yml` builds the same binaries
in CI for macOS (arm64 and x64) and Linux. Snd's licence permits shipping
them — "permission to use, copy, modify, distribute, and license … No written
agreement, license, or royalty fee is required" — so a release can carry them
and nothing needs building on your machine. Windows is a documented gap;
see `WINDOWS.md`.

If you already have a Snd you like, including a Motif one, point `snd.path` at
it and it wins over everything.

Either build works, and the difference matters:

| build | what you get | how it is driven |
| --- | --- | --- |
| `--with-motif` | Snd's own window **and** the VS Code panels | Snd reads stdin through its X input callback — the path its own source calls "the emacs subjob connection" |
| without Motif (`snd-nogui`) | the VS Code panels only | the bridge takes stdin itself and reads with `read-line` |

Same protocol, same commands, same panels. Point `snd.path` at the binary
you built; `snd.mode` only decides which name to guess when you leave it at
`snd`.

Whether a build has a GUI is decided when it is compiled. No setting here
can switch one on.

## Starting it

```sh
cd snd-vscode
npm install
npm run compile
npm run index -- /path/to/snd-26.5   # the offline help index
```

Then open the folder in VS Code and press **F5**. A second VS Code window
opens with the extension loaded; open a `.scm` file in it and run
**Snd: Start** (`C-c C-s`) or just **Snd: Open REPL** (`C-c C-z`), which
starts a session if none is running.

Before the first start, tell it where your Snd is. From your Preferences
window, `/usr/local/share/snd` is the s7 file directory, so the binary is
most likely `/usr/local/bin/snd`:

```json
{
  "snd.path": "/usr/local/bin/snd"
}
```

Only if you pointed `snd.path` at a Motif build: XQuartz has to be running
before the session starts — Snd builds its window during startup, and without a display it will
fail there rather than later. `Snd: Open Log` shows what Snd said.

If it does not come up, check the channel by hand first: see
`SMOKETEST.md`. That separates *does Snd talk to the bridge* from *does the
extension talk to Snd*, which otherwise fail as one symptom.

## Installing from source

```sh
npm run gates   # structural checks, tsc, node tests, s7 tests
```

`npm run gates` wants an `s7` binary for the Scheme half of the tests. One
builds from Snd's own sources in about twenty seconds:

```sh
gcc -O2 -o s7 /path/to/snd-26.5/s7.c -DWITH_MAIN -I/path/to/snd-26.5 -lm -ldl
```

Without it the s7 gate reports `skip`, not `ok`.

## Commands

Two keymaps, chosen with `snd.keymap`. **`inf-snd.el`'s is the default**,
because it is Snd's own — and because two of its chords have no SLIME
equivalent at all: `C-c C-p` for *play* and `C-c C-t` for *stop* only exist
in a keymap written for a sound editor.

| `inf-snd.el` | command | SLIME |
| --- | --- | --- |
| `C-c C-e` | evaluate the definition at the cursor | `C-M-x` |
| `C-c C-r` | evaluate the selection | `C-c C-r` |
| `C-c C-o` | evaluate the file, form by form | `C-c C-c` |
| `C-c C-l` | `(load …)`, so errors carry the file and line | `C-c C-k` / `C-c C-l` |
| `C-c C-i` | `snd-help` for a symbol | `C-c C-d C-d` |
| `C-c C-z` | the REPL (inferior Snd) | `C-c C-z` |
| `C-c C-f` | open a sound file | `C-c C-f` |
| `C-c C-p` | **play** | — |
| `C-c C-t` | stop playing | `C-c C-t` |
| `C-c C-s` | start the session | — |
| `C-c C-c` | the control panel | — |
| — | evaluate the form that just ended | `C-x C-e` |
| — | evaluate and print into the buffer as a comment | `C-c C-p` |
| — | the source of a symbol, as the session has it | `M-.` |
| — | apropos over the live symbol table | `C-c C-d C-a` |
| — | the waveform panel | `C-c C-w` |

Set `"snd.keymap": "slime"` for the SLIME/SLY chords instead. The setting is
exclusive rather than additive, because three chords disagree: `C-c C-p` is
eval-and-print in SLIME and *play* here, `C-c C-t` is trace against *stop
playing*, `C-c C-e` is an eval prompt against *evaluate definition*. Two
meanings on one chord is worse than either choice. `"none"` leaves the palette
only.

Everything in the right-hand column stays available as a command whichever
keymap is on — `Snd: Evaluate Last Expression`, `Snd: Show Source of Symbol`,
`Snd: Apropos`. Only the chords change. Two of the SLIME bindings are
approximations worth knowing about: `C-c C-c` is `slime-compile-defun` there,
and s7 has no separate compile step, so it evaluates the file; and `M-.` does
not jump to a file, because Snd's own functions are C and have no Scheme
source — it shows `procedure-source` for a closure and says so for a built-in.

The **Snd Sounds** tree in the side bar shows the open sounds, their
channels, their marks and their edit history. Clicking a channel opens the
waveform; clicking an entry in the edit history moves Snd to that edit.

## What is not there yet

Stated plainly, because a feature list that quietly omits things is worse
than a short one:

- **No editing from the panels.** Deliberate, and explained in
  `ARCHITECTURE.md`. Edits go through Scheme.
- **No session across a window reload.** The channel is the pipe, so there is
  nothing to reconnect to. `Snd: Save Session State` is what survives it.
- **No Ruby or Forth.** The bridge is s7 Scheme.
- **Regions and mixes are not in the tree.** Marks and edit history are.
- **No envelope editor panel yet.** The bridge has the ops (`envelope`,
  `setenvelope` through `env-channel`, so one entry in the edit history);
  the drawing surface is not built. `filter-control-envelope` therefore
  shows read-only in the control panel.
- **The Files, Regions and Mixes dialogs** have no panel. Marks and edit
  history are in the tree; regions and mixes are not.
- **`ladspa`** is reachable from the REPL only.

## Licence

GPL-3.0-or-later, following Snd's own terms. `scheme/snd-vscode.scm` is
loaded into Snd and is part of the same program.

Snd is by Bill Schottstaedt; s7 is his too. `inf-snd.el`, whose command set
and key chords this extension follows, is by Michael Scholz. Neither is
included here.
