# s7, vendored

`s7.c` and `s7.h`, taken unmodified from **snd-26.5**.

- s7 version 11.9, dated 29-Jun-2026
- by Bill Schottstaedt, bil@ccrma.stanford.edu
- **SPDX-License-Identifier: 0BSD** — the licence line is at the top of
  `s7.c`. 0BSD carries no attribution requirement at all; this file exists
  because knowing where a copy came from is worth more than the licence
  demands.

## Why a copy is here at all

The s7 half of `npm run gates` — 181 checks, and the ones that cover the
framing, the reduction, the hooks and the keyword calls — needs an s7 to run
in. Without a copy, a fresh clone can only get one by running
`tools/build-snd.sh`, which downloads a 14 MB tarball from ccrma at whatever
speed ccrma feels like that day. Observed here: nineteen minutes.

The result was `skip s7 tests` on every fresh clone, and a gate that always
skips is the one that was going to catch the next mistake in the bridge. Two
files and four megabytes are a cheap price for the gate actually running.

`tools/run-scheme-tests.mjs` looks here first, then in `.build`, then at
`SND_SOURCE`, and builds the binary once:

    cc -O1 -o s7 third-party/s7/s7.c -DWITH_MAIN -DUSE_SND=0 -Ithird-party/s7 -lm -ldl

`-DUSE_SND=0` matters and is not decoration: `s7.c` auto-includes
`mus-config.h` if one is present, and Snd's configure writes one that sets
`USE_SND 1` — which switches off s7's own `main()` through
`#if WITH_MAIN && (!USE_SND)`. There is no `mus-config.h` in *this* directory,
so the flag is redundant here and essential in `.build`; it is passed in both
cases so the command is the same one.

## What is deliberately NOT here

The rest of Snd. `data/snd-index.json` is generated from `snd-xref.c`,
`snd-strings.h`, `clm-strings.h` and `sndlib-strings.h` — but it is generated
and committed, so those sources are only needed to regenerate it, which only
happens when the Snd version changes, at which point the whole source tree is
at hand anyway.

## Updating

When Snd moves to a newer s7:

    cp /path/to/snd-NN.N/s7.c /path/to/snd-NN.N/s7.h third-party/s7/
    rm -f s7            # the built binary, so it is rebuilt
    npm run gates

and update the version above from `S7_VERSION` and `S7_DATE` in `s7.h`.
