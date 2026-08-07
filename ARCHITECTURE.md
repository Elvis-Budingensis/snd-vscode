# Architecture

Two processes. A TypeScript extension in VS Code, and a Snd whose s7 has
`scheme/snd-vscode.scm` loaded into it. Between them one pipe, in each
direction, and nothing else — no socket, no second connection, no file
handshake.

```
VS Code extension                          Snd (s7)
─────────────────                          ────────
  Bridge  ──── stdin ────────────────────►  sv-request → op → value
   panels                                        │
   tree                        ◄──── stderr ─────┘  \x1e{"id":…}\x1e
   REPL                        ◄──── stdout ────────  what a human reads
```

## The protocol

A request is **one balanced line** on Snd's stdin:

```scheme
(sv "17" 'waveform (inlet 'snd 0 'chn 0 'start 0 'dur 44100 'columns 900))
```

An answer is **one frame on stderr**, wrapped in ASCII RS (0x1e):

```
\x1e{"id":"17","op":"waveform","ok":true,"value":{…},"stderr":""}\x1e
```

Unsolicited frames carry `event` instead of `id`: `ready`, `opened`,
`closed`, `edited`, `protocol-error`.

Four decisions are load-bearing.

### Frames go on stderr, not stdout

In the Motif build the listener widget takes stdout: everything Snd prints
in reaction to a stdin expression lands in the listener window rather than
in our pipe. A protocol on stdout works perfectly in a headless build and
breaks silently the moment the GUI is up — the worst possible failure shape,
because it looks like a GUI bug.

stderr is untouched by the listener in both builds. The side benefit is that
stdout stays free for what a human wants to read, which is exactly what the
REPL terminal shows.

The gate `the bridge writes to *stderr* only through sv-emit` exists because
a `(format *stderr* …)` added for debugging would corrupt the next answer.

### One balanced line per request

In the Motif build **Snd** reads the line, not us, and hands it to
`stdin_check_for_full_expression`, which accumulates text until the parens
balance. Send half a form and it sits in that accumulator, where the next
request completes it into something nobody wrote.

So code to be evaluated travels as a *string* with `\n` escapes, never as
raw multi-line text. `schemeString()` in `src/bridge.ts` does that, and
deliberately not with `JSON.stringify`: JSON writes `\uXXXX`, which the s7
reader does not know — it reads `\u` as the letter `u` and swallows the four
digits as text. The two escape sets overlap just enough (`\n`, `\t`, `\\`,
`\"`) for the mistake to survive every ASCII test and to surface on the first
umlaut. clamps-vscode learned the same lesson from the opposite side and
correctly reached the opposite conclusion: there the frame counts bytes, so
literal newlines are free and escaping them is the error.

### We do not use Snd's own stdin REPL

`snd-nogui.c` offers two. `repl.scm` does ANSI cursor control on a channel we
also have to parse. The fallback (`DUMB_REPL`) reads with
`fgets(buffer, 512, stdin)` and wraps the line in `(write …)` — and 512 bytes
is not a limit one can design a protocol around; a waveform request with a
dozen parameters is already close.

So in the headless case the bridge takes stdin itself and reads with
`read-line`, which has no limit. In the Motif case it must **not** do that —
a blocking read would freeze the X event loop — and there Snd's own
`XtAppAddInput` callback does the reading. `sv-start` decides which, by
asking whether `main-widgets` reports a window.

Same request text, two ways in, one way out.

### The reduction happens in Snd

An eight-minute recording is twenty million samples; the canvas is nine
hundred pixels wide. `sv-reduce-channel` returns three numbers per column —
minimum, maximum, RMS — and whatever else were transferred would be thrown
away on the other side.

Min *and* max, not max: reducing by the maximum loses the lower half, and a
symmetric signal comes out as a one-sided envelope, which still looks like a
waveform. That is what makes the mistake durable. With both, a DC offset
shows as an envelope that does not straddle zero — one of the few things a
waveform view is actually for. The RMS on top gives the dynamic range of the
passage as the gap between the two, so a compressed passage and a merely loud
one can be told apart.

The s7 test builds a sine with a deliberate DC offset of 0.1 and checks that
the fourth quarter comes back negative. That is the case a max-only reduction
gets wrong.

## Why the process is a child and not detached

clamps-vscode starts SBCL **detached**, so the image survives a restart of
the extension host: the channel there is a socket, and a fresh extension
reconnects to the port in `session.json`.

Here the channel *is* the pipe. A detached Snd would keep running with its
stdin bound to a dead parent, and nothing could ever speak to it again — an
orphan holding the audio device. So this process is a child and dies with the
window.

The consequence is honest rather than pleasant: reloading the window loses the
session. What can survive is the work, through `save-state`, and that is
offered as a command rather than pretended to be automatic.

## Why the panels do not edit

Every edit goes through Snd's Scheme, so there is one edit history and it is
the one `save-sound` writes. A "delete selection" implemented in the webview
with a local undo stack would build a second history that disagrees with
Snd's, and Snd's is the real one.

The gate `the panels do not carry their own edit operations` keeps that
decision from being quietly undone by a plausible-looking commit.

## Where the live symbol table beats a baked-in list

`inf-snd.el` completes and looks up help against names scraped out of
`snd-xref.c` — 1624 strings, fixed when that Emacs file was written. Anything
defined during the session is invisible to it, and that is most of what one
actually types.

Here the first source is the running s7's own `symbol-table`, so a generator
defined two minutes ago completes like a built-in and its docstring is the one
in the image. The static index (`data/snd-index.json`, generated by
`tools/make-index.mjs` from `snd-xref.c` and `s7.c`) is kept only as a fallback
for reading a file with no session running — a real use that should not
require booting Snd.

## What came from clamps-vscode

Reused, in substance rather than by copying:

- the **two-process shape**: a typed extension in front, a Lisp/Scheme bridge
  inside the image, request/response over one channel
- `zoomRange` and its no-rounding rule, including the reason: the creep comes
  from feeding a rounded result back into the next call, and it is invisible
  in any single screenshot
- the **reduction contract** for waveform views (min, max, RMS per column)
- `readState` / `splitTopLevelForms` / the pseudoterminal REPL, with its paste
  detection and its two-Tab completion listing
- the **gate discipline**: structural checks on the sources, then the
  compiler, then the tests, and a skipped gate that reports `skip` and never
  `ok`
- the string-quoting lesson, applied in the other direction

Not reused: Swank. Snd speaks no Swank and there is no Sly to be compatible
with, so the protocol here is as small as the job allows.
