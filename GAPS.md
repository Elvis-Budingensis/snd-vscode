# What is not covered yet

Measured against the reference set (snd.html, extsnd.html, sndclm.html,
sndlib.html, s7.html and the index), not against a wish list. The bridge and
the variable and custom-UI registries between them touch about 200 Snd names; the reference
documents around 1500. Most of that difference is deliberate — see the last
section — so the list below is the part that is a real gap.

Ordered by what it costs the user, not by how much work it is.

## 1. Hooks — 14 of 27

*Eleven observers installed. What follows is what is left.*

The largest gap by far, and the one that changes the character of the thing.
Snd's whole customization model is hooks: *"A hook is a list of callbacks
invoked whenever its associated event happens."* The bridge installs exactly
eleven event observers. In addition, it watches the channel-specific
`after-edit-hook`, and uses `play-hook` and `stop-playing-hook` to keep the
playhead in step. Together those paths touch the 14 hooks counted above.

- **`edit-hook`** — *"if it returns #t, the edit is cancelled"*, which is how
  the reference implements protected regions of the edit history. There is no
  way to say "this far and no further" here. Note that this one is the
  exception to the observer rule: its whole purpose is the result, so it
  cannot be installed as an observer — it needs to be offered to the user, not
  used by the bridge.
- **`before-exit-hook`** — Snd exits flushing unsaved edits. Nothing warns.
- **`after-graph-hook`** — for finishing touches drawn *after* Snd's own
  drawing. `graph-hook` and `lisp-graph-hook` are done (see the README);
  this one has no counterpart yet because the panels have no "after" moment
  a user function could hook into.
- **`before-transform-hook`, `after-transform-hook`** — the spectrum panel
  computes its own transform, so a user function that adjusts where the FFT
  starts is ignored here.
- **`mouse-click-hook`, `key-press-hook`** — user-bound behaviour in the
  graph. The panel has its own handlers and does not consult them.
- **`update-hook`, `open-hook`, `before-save-as-hook`, `save-hook`** — the
  file lifecycle; `autosave.scm` is built on these.

That last point is the strategic one: a Snd user's own hook code is the reason
they have their `~/.snd`. If it cannot reach these panels, the panels are a
parallel world rather than the same editor.

## 2. Files and headers — 4 of 20

Edit Header and `save-state` are covered. What remains:

- **Save As with a choice of header and sample type** — `save-sound-as` takes
  `:header-type` and `:sample-type` keywords. The extension writes with
  whatever the sound already had.
- **`update-sound`** — re-read a file changed on disk behind Snd's back.
  Related: `auto-update`, and the warning about two conflicting versions.
- **`read-only`** / the lock icon — a view-only sound looks editable here.
- **`sound-loop-info`, `soundfont-info`** — loop points and soundfont regions;
  `mark-loops` in `examp.scm` places marks at them.

## 3. Edit lists — 1 of 8

- **`save-edit-history`** — writes the edit list as a loadable program. The
  reference's `clone-sound-as` uses it to fork an editing path, which is
  exactly the A/B comparison one wants while working.
- **`edit-list->function`** — the same thing as a callable: back up, save the
  sequence, change something, re-run it.
- **`as-one-edit`** — group several operations into one history entry. The
  region and mix commands here should be using it already.
- **`edit-tree`, `display-edits`** — what an edit actually consists of. The
  tree shows names; these show the fragments, which is what one reads when an
  edit did not do what it looked like.

## 4. Play — 8 of 15

**First, the thing that explains the rest of this section.** In a build with no
toolkit loop, playback is synchronous: `play` returns when the sound is over.
The DAC writer is scheduled as an idle work procedure through the toolkit's
`BACKGROUND_ADD`; under `USE_NO_GUI` that macro is an immediate one-shot call
rather than a scheduler, so `play` is forced down the blocking path and `:wait`
has nothing left to decide. Setting it to "background" by hand would write the
first buffer and then underrun.

**But the output IS running while it blocks, and it can be watched.** Measured
in this build, playing `oboe.snd`: `play-hook` fired 795 times inside one
blocking call, which for 50828 framples is one call per 64-frame buffer. Those
events go out through `sv-emit` on stderr while the bridge is still inside the
call, and the extension reads them independently of the pending request — so
the playhead moves during synchronous playback. The op reports `'synchronous #t`
and `'playing #f` because that describes what it RETURNED, not what happened
along the way.

So `pausing` and `playing` are not absent state. They are unreachable state:
for the duration of the sound the bridge is not reading stdin, so nothing can
be asked or set until `play` comes back. That is a different limit with a
different remedy — `char-ready?` works here, and 795 hook calls are 795 chances
to service a waiting request, which would make stop and pause work without an
event loop. Not built: a request that reaches an edit from inside the hook while
the DAC is reading is a re-entrancy question, and it deserves measuring before
code.

They are registered as variables regardless, because a build whose `play`
returns early has both, and `sv-async-play?` is the one place that decides which
case holds.

A separate thing that looks the same and is not: `(play)` with no argument
returns `#f`. Snd is asking for the SELECTED sound, and a build with no GUI has
no selection. The op never does that — `snd` defaults to index 0 — but typing it
in the REPL is the obvious first test of playback, and it answers `#f` without
an error, which reads as broken audio.

- **`pausing`** — space pauses and resumes during playback in Snd. Here space
  auditions an envelope and does nothing during a play. Registered; reachable
  in a build with a loop.
- **`playing`** — whether output is running. Registered read-only; synchronously
  the second play cannot start until the first is over, so it costs nothing
  here and everything in a Motif build.
- **`make-player` / `add-player` / `start-playing`** — per-channel amplitudes
  and custom control panels; `play-with-envs` in `enved.scm` is built on it.
- **`dac-size`** — the fix for interruptions on stereo 44.1k, per the
  reference. Now registered: it is 64 in this build, so it also sets how often
  the playhead path runs — 690 hook calls per second at 44.1k.

## 5. Marks — 6 of 14

- **`mark-sync`, `syncd-marks`, `mark-sync-max`** — grouped marks move
  together and play together. The sync field is read but never set.
- **`save-marks`** — marks to a loadable file.
- **`find-mark`** — by sample or by name, across channels.
- **`mark-properties`** — the reference's own `describe-mark` and
  `mark-click-info` use them.

## 6. Transforms — 27 of 34

Mostly covered, and the remainder is real:

- **`peaks`** — the FFT peak list. Snd's transform dialog shows it beside the
  spectrum; `max-transform-peaks` is already in the registry but nothing
  displays them.
- **`add-transform`** — a user-defined transform joins the list. The
  reference's histogram and Hankel examples are ten lines each.
- **`transform-framples`, `transform-sample`** — reading the transform Snd
  itself computed, rather than computing a parallel one. Worth having so the
  panel and Snd's own display cannot disagree.

## 7. Editing — 9 of 29

The gaps here matter less than the count suggests, because the REPL reaches
all of them and most are one call. Worth commands of their own:

- **`reverse-channel` / `reverse-selection`** — in Snd's Edit menu.
- **`delete-selection-and-smooth`, `smooth-selection`** — the click-repair
  pair.
- **`convolve-with`** — the reference's `conrev` is high-quality reverb in
  four lines.
- **`swap-channels`** — mostly a virtual operation, so it is nearly free.
- **`normalize-channel` / `scale-to`** — normalising is a menu item everywhere
  else.

## Deliberately not covered

Not gaps, and worth naming so the count above is not read as a to-do list:

- **Raw Motif/Xt widget access** — `main-widgets`, `channel-widgets`,
  `sound-widgets`, `XtAppAddActions`, and arbitrary `XmN*` resources still
  refer to objects that do not exist in a headless build. High-level intent is
  covered now: menus, effect dialogs, sliders and variable displays are
  registered in s7 and rendered by VS Code, including the small `*motif*`
  helper surface used by the non-X branches of Snd's menu scripts. What
  remains excluded is code whose purpose is specifically to walk or mutate an
  Xt widget tree; the bridge deliberately does not provide `snd-motif` and
  thereby lie to such scripts.
- **Display state Snd keeps for its own graphs** — `x-bounds`, `y-bounds`,
  `left-sample`, `right-sample`, `graph-style`, `dot-size`. The panels compute
  their own view from the data; adopting Snd's window would make two sources
  of truth for the same picture.
- **Colors and fonts** — `basic-color`, `axis-label-font` and friends. The
  panels follow the VS Code theme, which is the right answer here and the
  wrong one to override.
- **CLM and sndlib in full** — `sndclm.html` is 413 KB of generators. They
  belong in the REPL, where they already work; wrapping them in bridge ops
  would be a worse interface than the language.
- **s7 itself** — `s7.html` is the language. The REPL is the interface to it.
