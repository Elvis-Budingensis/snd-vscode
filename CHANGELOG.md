# Changelog

## 0.1.0 — unreleased

First cut. The session, the REPL, the panels, the tree, the gates.

- two-process design: TypeScript extension ↔ `scheme/snd-vscode.scm` in Snd's s7
- frames on stderr, requests as one balanced line on stdin; works the same in
  a Motif build (where Snd reads stdin itself) and a headless one (where the
  bridge does)
- inferior Snd in a VS Code terminal, with the `inf-snd.el` key chords
- waveform panel: min/max/RMS reduction in Snd, zoom, pan, click for cursor,
  drag for selection, marks
- spectrum panel from Snd's own `snd-spectrum`
- Snd Sounds tree: sounds, channels, marks, edit history
- hover, completion and signature help from the running session, with a
  generated static index as the offline fallback
- Snd's dialogs as panels — Transform Options, control panel, View options,
  Preferences — from one declarative registry (`src/sndVariables.ts`) and one
  renderer, over the same variables Snd's own dialogs write
- enum values resolved from the running build (`constants` op) instead of
  hard-coded integers
- the generated index now covers `snd-strings.h`, `clm-strings.h` and
  `sndlib-strings.h`, so the constants exist for the gate to check the
  registry against — 2063 names
- Snd's Edit menu: selection operations in the waveform panel and the palette,
  plus scale, resample and save-selection — all through Snd, one edit-history
  entry each, resolved against a whitelist in the bridge
- two keymaps, switched with `snd.keymap`: `inf-snd.el`'s by default,
  SLIME/SLY on request. Exclusive, because `C-c C-p`, `C-c C-t` and `C-c C-e`
  mean different things in the two — and `C-c C-p` for *play* has no SLIME
  equivalent, which is the argument for Snd's own map being the default
- SLIME-shaped commands that did not exist before: evaluate the form that
  just ended (`C-x C-e`), evaluate and print into the buffer as a comment
  (`C-c C-p`), and `procedure-source` for a symbol (`M-.`)
- the waveform panel now shows **all channels of a sound on one shared time
  range**, separate or superimposed, with per-lane click focus. The range is
  decided in Snd in a single request: per-channel requests would let the lanes
  drift during a drag, and lanes showing different windows of time invent
  phase differences between channels
- a channel shorter than its neighbours is drawn to its true width with a
  dashed end, rather than stretched to fill its lane
- **definitions sent from the editor did not survive the request.**
  `eval-string` evaluates in the current environment, which inside the
  handler is the handler, so a `(define ...)` landed in a closure that was
  discarded when the request finished. The definition looked like it worked —
  the REPL printed the symbol — and the next form reported the name unbound,
  which reads as if Snd had forgotten it. Every `eval-string` in the bridge
  now names `(rootlet)`, and a gate keeps it that way
- **`(sounds)` returns sound OBJECTS, not indices.** They print as
  `#<sound 1>`, and the JSON writer's fallback to `object->string` sent that
  string to the extension, which sent it back as the `snd` argument — where
  Snd rejected it with *"is a string but should be a sound object, an integer
  (sound index), or #f"*, three requests away from the cause, in a different
  process, without mentioning `(sounds)` at all. The waveform panel drew
  nothing, which read as a broken canvas. Sounds now cross the wire as
  integers in both directions, normalised at two points, with a gate
- the waveform panel no longer takes `sounds[0]`: it prefers Snd's
  `selected-sound`, then the last opened, and an empty sound only if there is
  nothing else — `(new-sound)` leaves an empty sound behind, so the first
  sound in the list is often the blank one
- an empty channel now says so in the middle of the panel instead of drawing
  nothing, because nothing is indistinguishable from broken
- **"insert at cursor" and "mix at cursor" pasted at sample 0.** Snd's
  reference is explicit — *"The Edit:Insert selection menu choice is
  essentially `(insert-selection (cursor))`"* — and `insert-selection beg snd
  chn` defaults `beg` to 0 when called with no arguments. No error, no
  message, just the wrong place. `delete`, `reverse` and `smooth` genuinely
  take nothing, which is why the mistake was invisible in the other buttons
- `save-selection` takes **keywords** (`:file :srate :sample-type …`), not
  positional arguments; the positional call wrote the file under Snd's default
  name somewhere else
- **the cursor now follows playback.** `with-tracking-cursor` is a GUI answer —
  the cursor is redrawn every `cursor-update-interval` while the DAC runs, and
  without a GUI there is no redraw, so it never moved. The bridge sums
  `play-hook`'s buffer sizes instead, throttled to that same interval, and
  applies `cursor-location-offset` — Snd's own correction for buffering it
  cannot see, so the playhead inherits the same uncertainty Snd documents for
  its own. Drawn in green: the cursor is where the next edit lands and stays
  put, the playhead means nothing afterwards
- the play hooks could be installed twice, counting every DAC buffer twice —
  a playhead at double speed, which reads as a sample-rate mistake rather than
  a duplicate handler
- **nothing was selectable, from the fix for the opposite confusion.** Snd's
  `(sound? snd)` answers *"does this refer to an open sound"* — so it says `#t`
  for the index `0` as readily as for the object, and the reference is explicit
  that `(cursor 0)` and `(cursor (integer->sound 0))` mean the same thing.
  Using `sound?` as the discriminator therefore sent every integer into
  `sound->integer`, which rejects it: *"first argument, 0, is an integer but
  should be a sound"*. Every click became a failed request. `sound?` is about
  validity, not about type; only the s7 type predicates say which
  representation is in hand, so `integer?` is asked first
- the test stub for `sound?` was written as a type predicate, which is exactly
  why 141 checks stayed green through it. It now answers like the real one
- **dragging could not make a selection: `set-selection-position` does not
  exist.** I invented it — it looks like one of Snd's old-style names, and a
  few of those are real, so it read as plausible. The correct sequence is in
  Snd's own `extract-channels` example, and all three parts matter in order:
  `(set! (selection-member? snd chn) #t)`, then `(set! (selection-position …))`,
  then `(set! (selection-framples …))`. Position before framples because the
  reference is explicit that moving the start keeps the *end* fixed and
  rewrites the length — the reverse order lands in the right place with the
  wrong extent, which looks like a rounding problem in the drag
- a new gate checks **every Snd name the bridge calls against
  `data/snd-index.json`**, 2000+ names from Snd's own headers. It is the
  cheapest gate in the file and would have caught the most expensive mistake.
  On its first run it found a second invention, `snd-exit`, sitting unused in
  a fallback chain — invisible precisely because an earlier fallback always
  succeeded
- the waveform panel shows errors **above** the canvas. The failed selection
  did report itself, at the bottom of a tall page, below the fold — so the
  search went to the mouse handling rather than to the message already on
  screen
- **"play view" failed: `play` is keyword-based.** The documented signature is
  `play object :start :end :channel :edit-position …`, and the object comes
  first. Called positionally as `(play start snd chn #f end)`, the end sample
  landed on `:edit-position` and Snd answered *"no such edpos: 88200 (from
  88200), current edit: 1"* — a message about the edit history for a mistake
  about argument names. Third mistake of this shape in one session, after
  `save-selection` and the missing `beg` for insert/mix, so there is now a
  gate: the handful of Snd functions documented with keywords must be called
  with keywords
- **the sonogram**, the last thing Snd's Motif window could do that this one
  could not. Transforms in Snd through its own `snd-spectrum`, so the sonogram,
  the single-frame view and Snd's transform dialog share one set of variables.
  Rows are bands reduced by their maximum, not their average — a partial is one
  or two bins wide, and averaging dilutes it by the band's width. The dB floor
  is `min-dB`, not the loudest cell in view, so the shades mean the same thing
  at every zoom level
- one byte per cell, base64, drawn as `ImageData` in a single blit: as a JSON
  array of numbers a 600 × 256 sonogram is ~600 kB per redraw, and one
  `fillRect` per cell is 150,000 draw calls
- the name-checking gate had a lowercase-only character class, so it truncated
  `min-dB` to `min-d` and then reported that as a name that does not exist. A
  checker that mangles its input is worse than none: it produces failures with
  no cause to find
- **a log frequency axis, and a range limit** — Snd's `fft-log-frequency`,
  `log-freq-start` and `spectrum-end`. Without them a sonogram of anything
  musical is a bright line along the bottom of a black rectangle: 440 Hz is 2%
  of the way up an axis that runs to 22050. Snd's collapsing of everything
  below 32 Hz into the origin is reproduced too — the reference explains it as
  keeping the audible data from starting a quarter of the way along
- **the step in the middle of every dB spectrum** was the drawing, not the
  signal: `snd-spectrum` returns a vector as long as the transform and leaves
  the upper half untouched, which in dB is 0.0 — the top of the scale. The bin
  count now comes from the transform size rather than from half the array
- **`npm run gates` reported "FAIL node tests:" with nothing after the colon.**
  The gate ran `node --test 'test/*.test.js'`, which works on Node 22 — where
  `--test` expands globs — and passes the pattern through as a filename on
  Node 20. The tests all passed; the invocation did not. The files are now
  listed explicitly, which needs no feature of any Node version, and a failure
  with no recognisable test output prints everything instead of nothing
- the s7 gate **builds s7 itself** from the sources `tools/build-snd.sh` left
  in `.build`, rather than printing an instruction. A gate that reports `skip`
  every time is the one that was going to catch the next mistake in the bridge
- a gate against **stray copies of source files in the project root**.
  Downloading files one at a time puts `waveformView.ts` beside
  `src/waveformView.ts`; nothing loads the copy, so editing it has no effect
  at all — and tsc says nothing, because `rootDir` is `src` and it never looks
  there. The change simply does not happen, which reads as broken code rather
  than an ignored file
- **"FAIL node tests: no test output to show — node --test exited 0"** — a gate
  contradicting itself in one line. `node --test` uses the TAP reporter on some
  versions and the spec reporter on others, so the summary reads `# pass 105`
  here and `ℹ pass 105` there; the gate required the first spelling. The exit
  code is the contract now, and the count is read from either spelling purely
  to print it. Second time this gate has failed a run in which every test
  passed — the first was the glob
- the s7 gate looked for `.build` relative to the **current directory**, so
  running `npm run gates` from a subdirectory made it search
  `.build/.build/snd-26.5` and report `skip`. npm walks up to find
  `package.json`; the script now derives the project root from its own
  location and does the same
- and the gate **swallowed the reason**: which directories were searched,
  whether a source tree was incomplete, what the compiler said. All of it
  disappeared behind the word `skip` and a pointer to a file to go and read.
  It is printed now
- s7 is built with `-O1` rather than `-O2`: s7.c is one 100,000-line file and
  `-O2` takes minutes on a laptop, while the tests are not compute-bound. A
  build step that seems to hang is a build step people interrupt
- **s7 failed to link: "Undefined symbols … `_main`"** — after
  `tools/build-snd.sh` has run in `.build/snd-26.5` (which it does, to build
  Snd itself), that directory contains `mus-config.h`, generated by
  `configure`, with `#define USE_SND 1`. `s7.c` auto-includes `mus-config.h`
  when present, and its own `main()` is gated by
  `#if WITH_MAIN && (!USE_SND)` — so once that header exists, `main()`
  silently disappears from the compile. Not a compile error: a successful
  compile of an object with no `main`, which the linker then reports in a way
  that sounds like a toolchain problem and is actually a stale header from an
  earlier, unrelated build step in the same directory. `-DUSE_SND=0` is now
  passed explicitly, which wins over the header's `#ifndef` guard
- `npm run gates`: five structural gates, tsc, 56 node checks, 63 s7 checks

Found by the gates while writing it, and worth recording because neither
would have been visible in use until it bit:

- `inletLiteral` wrote the key before validating the value, so a computed
  `NaN` produced `(inlet 'n)` — a key with no value, which the s7 reader
  rejects wholesale
- `verbose-cursor` in the View menu is the variable `with-verbose-cursor`;
  the gate that checks the registry against Snd's index caught it, and
  without that gate a typo would have been indistinguishable from a build
  that lacks the variable — both greyed out, no message
- the panel-edit gate fired on a tooltip and on the comment explaining the
  rule — it banned the Snd function names outright, including where the code
  was documenting what it deliberately does not do. Gate 1 had already
  stripped comments for that reason; doing it in one of the two and not the
  other is how a gate earns being switched off
- the whitelist gate read the wrong op: `edit` without a following space also
  matches `edits`, the edit-history op, which never had a whitelist. A gate
  failing an unchanged file is worse than no gate
- **after-edit-hook is not a global hook.** It is one of Snd's three
  channel-specific hooks (with edit-hook and undo-hook): the name is a
  function of `(snd chn)` returning that channel's hook. Passing it to
  `hook-functions` raised while the bridge was *loading*, which took the
  serving loop with it — after which Snd continued into its own `repl.scm`,
  which required `*libc*`, which tried to compile `libc_s7.c` in the current
  directory. One wrong hook produced four screens of failure that named
  none of it. The watch is now installed per channel, when the sound opens.
- the same channel could be watched twice (once for sounds already open at
  load, once via after-open-hook), and Snd calls every handler — two
  `edited` events per edit, two waveform fetches per keystroke of a loop
- there is no `hook?` in s7, and `hook-functions` accepts any closure, so a
  predicate cannot tell a hook from a function returning one. The three
  channel hooks are therefore named explicitly, from Snd's documentation
- on EOF the bridge now really exits. It relied on `sv-have? 'exit`, and
  falling out of the loop instead let Snd continue its startup
- `callContext` subtracted one from the argument count unconditionally, so
  signature help was off by one whenever the cursor sat before the next
  argument rather than inside one
