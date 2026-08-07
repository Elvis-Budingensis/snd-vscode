# Windows

Stated separately because it is the one platform where I would be guessing,
and a build matrix that claims a Windows binary nobody has run is worse than
a documented gap.

## What is known from the source

Snd 26.5 does carry Windows paths. `audio.c` has a `_MSC_VER` branch that
plays through `waveOut`, and `snd-nogui.c` guards its stdin REPL with
`#if HAVE_SCHEME && (!defined(__sun)) && (!defined(_MSC_VER))` — which is
worth reading twice, because it means that under MSVC **Snd does not run its
own stdin REPL at all**.

For this extension that is not a problem and may be an advantage: the bridge
takes stdin itself in the headless case (`sv-serve`), so it does not depend
on Snd's REPL existing. What it does depend on is `read-line` on stdin
behaving, and a pipe on Windows behaving like a pipe.

## What is not known

- whether `./configure && make` runs at all under MSYS2 or Cygwin on a
  current Windows, or whether the MSVC project files in the tarball are the
  intended route
- whether `waveOut` playback works from a process with no window
- whether the frames arrive unbuffered on a Windows pipe, or whether the
  flush in `sv-emit` needs help

## What would work regardless

The parts of this extension that do not touch the audio device: opening and
editing sounds, the waveform and spectrum panels, the edit history, the
dialogs, the REPL, completion and help. `play` is the one command that needs
the device.

## If you try it

WSL is the path I would take first — a Linux build is known to work, the
audio side can go to PulseAudio, and the extension can be run from WSL
directly. Second choice is MSYS2 with `mingw-w64-x86_64-gcc`.

Either way, `SMOKETEST.md` is the thing to run before the extension: if
`snd -l scheme/snd-vscode.scm` prints a `ready` frame, everything except
`play` should follow. If it prints nothing, the problem is in Snd or in the
pipe and not in the extension.

Reports welcome; this file should stop being speculative.
