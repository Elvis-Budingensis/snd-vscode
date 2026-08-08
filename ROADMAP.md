# Roadmap

The organising idea is the same one that shaped clamps-vscode: parity with
the Emacs mode is the price of entry, not the goal. What makes this worth
building is the audio-domain work `inf-snd.el` never attempted, because Emacs
had nowhere to draw it.

## Parity with inf-snd.el

- [x] inferior Snd with the same key chords (`C-c C-e/r/o/l/z/f/p/t/i/s`)
- [x] evaluate definition / selection / file / load file
- [x] `snd-help` on hover and on demand, apropos
- [x] completion — from the live symbol table, not a baked-in name list
- [ ] `snd-help` in HTML, the way `inf-snd-help-html` opens `extsnd.html`
- [ ] Ruby and Forth builds (`snd-ruby`, `snd-fth`); the bridge is s7 today
- [ ] `snd-set-keys` equivalents for the editing commands in `snd-scheme-mode`

## Beyond it — the reason for the project

- [x] channel waveform as an editor panel (min/max/RMS, marks, selection, cursor)
- [x] **all channels on one shared time range**, separate or superimposed —
      the coupled axes of Snd's own window
- [x] spectrum at the cursor, from Snd's own `snd-spectrum`
- [x] sounds, channels, marks and **edit history** as a tree, clickable
- [x] **sonogram** over a range, not one frame — transforms in Snd through
      `snd-spectrum`, one byte per cell over the wire, drawn as `ImageData`
- [x] **regions and mixes** in the tree, with play, insert, mix, save, forget,
      and mix position/amplitude
- [ ] a waveform per region in the tree
- [ ] `ats` files: Snd reads them, and the analysis is already in the
      workflow of the Dorota / REASPCollider side of the desk
- [x] **marks** added, renamed and deleted from the tree
- [ ] **live level metering** while `play` runs (`dac-hook`)
- [x] **Transform Options, control panel, View options, Preferences** as
      panels, rendered from one declarative registry over Snd's variables
- [x] **envelope editor** — channel, selection and filter response, with
      Snd's exponential base drawn rather than only stored
- [ ] **diff of two edit positions** — the thing Snd's edit history implies
      and does not offer
- [ ] `variable-display` / `make-variable-display` in a panel: Snd's own way
      of showing an instrument's internals, which currently needs Motif
- [ ] a graph of the current `dsp` chain, once there is one to graph

- [x] **Find** — a sample predicate, closures included, sharing Snd's own
      `search-procedure`
- [x] **sync** — grouping sounds for simultaneous editing, shown in the tree
- [ ] the **wavogram** (`time-graph-type` as `graph-as-wavogram`)
- [ ] `enved-wave?` in `flt` mode: the filter's actual frequency response
      drawn over the envelope

## Infrastructure

- [x] gate chain: structural checks, tsc, node tests, s7 tests
- [x] static help index generated from `snd-xref.c` and `s7.c`
- [x] the variable and constant names in the dialog registry are checked
      against Snd's own index by the gate, so a typo is not indistinguishable
      from a build that lacks the variable
- [ ] a gate that runs against a **real built Snd**, not stubs: the stubs
      catch a wrong argument order, not a wrong Snd version
- [ ] packaging (`vsce`), CI
- [ ] `snd.mode` detection that reports what the binary actually is before
      starting it, instead of guessing a name
