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

A built macOS/arm64 Snd is **committed**, in `bin/darwin-arm64/`, with its
checksum and provenance in `bin/README.md`. A binary in a repository is a real
cost; the alternative was worse — without one, a fresh clone falls back to
whatever `snd` is on `PATH`, and on a machine with a Motif build installed
that means Snd's own X window opening beside the panels on every clone.

For other platforms, `tools/build-snd.sh` puts a binary in `bin/` on its own,
and the extension picks it up with no configuration. The session says so once
if it ends up on a GUI build from `PATH`.

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

`npm run gates` needs an `s7` for the Scheme half of the tests, and builds one
itself on the first run — the sources are in `third-party/s7` (two files,
0BSD), so a fresh clone runs all 181 s7 checks without downloading anything.
Takes a few seconds, once.

The gate reports `skip`, never `ok`, if that fails for any reason, and prints
why.

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

## The envelope editor

Built to Bill Schottstaedt's own description of the Edit Envelope dialog, and
using his labels, because those are what a Snd user already knows.

**Three targets** — what the envelope *is*: `amp` (amplitude), `flt` (the
spectrum, through an FIR filter of `enved-filter-order` taps), `src` (the
sampling rate, which changes length and pitch together).

**Three scopes** — where it goes. Nine combinations, seven of which exist:

|  | the sound | the selection | a mix |
| --- | --- | --- | --- |
| **amp** | `env-sound` | `env-selection` | `mix-amp-env` |
| **flt** | `filter-sound` | `filter-selection` | — |
| **src** | `src-sound` | `src-selection` | — |

The two empty cells are empty in Snd too: a mix has an amplitude envelope and
no filter or sampling-rate envelope. They are greyed out and refused by name
rather than falling back to the sound — which would envelope a whole file when
one mix was asked for.

The rest of his dialog: **linear / exp** with the base, **clip** (whether the
mouse is held at the y bounds), **wave**, the **fir order**, an **undo/redo**
pair moving through the *envelope's* own history — separate from Snd's edit
list, because undoing a breakpoint one did not mean to add must not undo an
edit to the sound — and **define it**, which names the curve through
`define-envelope` so it can be used anywhere an envelope is, exactly as in
Snd's own `funcs.scm`.

The y axis follows the target: a filter response is a gain from 0 to 1, an
amplitude envelope is a multiplier that may exceed 1, an src envelope is a
speed ratio where 1 is unchanged. In `flt` the x axis runs from 0 Hz to half
the sampling rate — labelled 0–1, as his documentation has it.

Type a name in the field and press Enter to load that envelope — Bill's other
way in, alongside the list. The panel re-reads when it comes back into view,
so a `define-envelope` typed in the REPL a moment ago is there.

The named envelopes are found by scanning the symbol table for even-length
lists of reals. There is no Scheme-visible registry to ask: the editor's list
lives in `all_envs` in `snd-env.c`, C-side only. `define-envelope` defines an
ordinary variable, which is why the heuristic is exactly right — and why his
`funcs.scm` is a hundred lines of them.

**Space** is his *Undo&Apply*: it takes back the previous audition, applies,
and plays the affected range. Each press replaces the last, so twenty presses
while dragging a point leave one entry in the edit history, not twenty.
`apply` keeps it. The replacing only happens while the audition is still the
top of the edit history — if anything else happened since, the next audition
stacks, because undoing would remove that other work instead.

## Snd's keyboard, in the waveform panel

"Editing in Snd is modelled after Emacs in many regards ... Where an operation
has an obvious analog in text editing, I've tried to use the associated Emacs
command." The chords are Bill's, live in the panel:

`C-a` `C-e` window start/end · `C-f` `C-b` forward/back · `C-n` `C-p` a
'line' (128 samples) · `C-j` next mark · `C-d` delete the sample · `C-h`
delete the previous one · `C-k` delete a line · `C-o` insert a zero · `C-z`
zero the sample · `C-m` place a mark · `C-y` paste the selection · `C-w`
delete it

`C-u` then digits gives a count first, and — Snd's rule — an integer is
samples while a decimal is seconds: `C-u 2.1 C-f` moves 2.1 seconds. The
conversion happens in the bridge, where the sampling rate is known.

## Find

Not a text search. Snd's Find asks for **a function of one sample**:
`(lambda (y) (> y .1))` finds the next sample above 0.1. `Snd: Find`
(`C-c C-x`) and `Snd: Find Backwards` prompt for it, move the cursor to the
hit, and report the value.

The predicate may be a closure, and that is the point — Bill's own example
keeps the previous sample in a `let` to find positive-going zero crossings:

```scheme
(let ((last 0.0))
  (lambda (y)
    (let ((crossing (and (< last 0.0) (>= y 0.0))))
      (set! last y)
      crossing)))
```

Which is why the expression is *evaluated* rather than parsed into some
restricted query syntax: any restriction would rule out exactly the searches
worth having. It comes from a prompt, like the REPL, and no panel can send
one — a test checks that.

Snd's own `search-procedure` is set at the same time, so `C-s` in a Motif
window and Find here look for the same thing.

## Sync

Snd groups sounds for simultaneous editing through the `sync` field: sounds
sharing a value other than 0 are edited and moved together.
`Snd: Sync This Sound With…` sets it, and the tree shows it — a sound edited
together with another one otherwise looks possessed, an edit here changing
something over there with nothing on screen to say why. "A new group" uses
`sync-max + 1`, which is how one gets a group guaranteed not to collect the
sounds already grouped.

## Regions and mixes

Snd's last two dialogs without a counterpart here, and both are lists rather
than windows — which is the one thing this side does better: the region
browser and the mix dialog are two more windows to arrange, and a tree is
simply there.

**Regions** sit beside the sounds, not under one, because that is where they
belong: a region outlives the selection and the sound it came from. There are
only `max-regions` of them and the oldest is dropped when a new one arrives —
worth knowing before wondering where one went. Play, insert or mix at the
cursor, save, or forget (which drops Snd's copy and touches no sound; the
confirmation says so, because "forget" reads like "delete").

**Mixes** hang under their channel. A mix is a piece of sound laid over a
channel and still movable: position and amplitude are settable, and each
change is an edit — that is exactly the difference from having mixed something
in destructively.

**Marks** can be added at the cursor, renamed and deleted from the tree. Snd's
marks follow the edit list, so a deleted mark comes back if you undo to a point
where it existed; no separate bookkeeping, and no confirmation dialog for
something that is undoable.

## The dB floor, and why part of the spectrum is empty

`snd-spectrum` sets any bin whose raw magnitude is under `1e-6` to a flat
**−90 dB** — a literal in `snd-sig.c`, carrying Bill Schottstaedt's own comment
wondering whether it should be `min-dB`. Bins just above that threshold are
computed and can be *lower*: −105.14 in a test file here.

So −90 does not mean "very quiet", it means "did not reach the threshold", and
the panels treat it that way. Those bins are left out of the curve rather than
drawn down to a floor — joining measured points across an unmeasured stretch
draws a slope that is not in the data — and the sonogram scales against −90
rather than `min-dB`, so real measurements below −60 dB keep their shading
instead of collapsing into the same black as the unmeasured ones.

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
- **The Files, Regions and Mixes dialogs** have no panel. Marks and edit
  history are in the tree; regions and mixes are not.
- **`ladspa`** is reachable from the REPL only.

## Licence

GPL-3.0-or-later, following Snd's own terms. `scheme/snd-vscode.scm` is
loaded into Snd and is part of the same program.

Snd is by Bill Schottstaedt; s7 is his too. `inf-snd.el`, whose command set
and key chords this extension follows, is by Michael Scholz. Neither is
included here.
