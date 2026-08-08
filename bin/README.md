# The Snd binaries

Committed on purpose. A binary in a repository is a real cost, and the
alternative turned out to be worse: without one, a fresh clone falls back to
whatever `snd` is on `PATH`, and on a machine with a Motif build installed
that means Snd's own X window opening beside the panels — correct behaviour,
and a surprise every single time.

The extension looks for `bin/<platform>-<arch>/snd` before `PATH`. An explicit
`snd.path` still beats both.

## What is here

| path | platform | built from | sha256 |
| --- | --- | --- | --- |
| `darwin-arm64/snd` | macOS, Apple silicon | snd-26.5, headless | `27391cca6d18084da348199838984abd55d721ca3f765025015e01bda3d94297` |

Verify before trusting it:

    shasum -a 256 bin/darwin-arm64/snd

## How it was built

`tools/build-snd.sh` — `./configure --with-s7` with **no** `--with-motif`, so
no X dependency at all, and `CC=/usr/bin/clang` because Snd's configure
prefers `gcc` and a real GCC on `PATH` produces binaries that will not run on
current macOS.

To rebuild, or to add a platform:

    tools/build-snd.sh                  # fetches snd-26.5
    tools/build-snd.sh /path/to/snd-26.5

It lands in `bin/<platform>-<arch>/` on its own.

## Packaging

A `.vsix` that carries every platform's binary makes a Linux user download a
macOS one. VS Code has platform-specific packages for exactly this:

    npx vsce package --target darwin-arm64

Add a target per binary in `bin/`. The untargeted `npm run package` includes
everything here, which is fine for a local install and wasteful for the
marketplace.

## Licence

Snd is by Bill Schottstaedt. Its licence grants "permission to use, copy,
modify, distribute, and license this software and its documentation for any
purpose", with no written agreement, licence or royalty fee required — so
redistributing a build is explicitly allowed. The full text is in the Snd
source tree as `COPYING`, which `tools/build-snd.sh` leaves in `.build`.
