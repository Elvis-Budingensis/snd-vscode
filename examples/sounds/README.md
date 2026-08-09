# examples/sounds

## oboe.snd

The file every example in Snd's documentation opens. NeXT/Sun header, 22050 Hz,
mono, 16-bit, 2.305 seconds.

    sha256  55cf3390fef9c338966bbeae4f7d99a03233146dc11d461092aefd626e20dec1
    size    101684 bytes

It is here because the tour is much better with it: a real instrument with a
real attack, harmonics that move, and a decay — none of which a synthesised
sine has, and all of which are what the spectrogram and the waveform panel are
for. Every worked example in `snd.html` and `extsnd.html` assumes you have it.

## Where it came from, and what the licence does and does not say

Downloaded from ccrma.stanford.edu, the same place the Snd sources come from.

It is **not in the Snd distribution**. Checked against both tarballs: snd-26.5
has 676 entries and snd-26 has 683, and neither contains a single audio file —
the only hits for `.snd` are `README.Snd` and `HISTORY.Snd`, which are named
that way. So the documentation quotes `oboe.snd` in nearly every worked example
while the distribution does not carry it.

Snd's `COPYING` is about as permissive as a licence gets: the authors grant
permission to <q>use, copy, modify, distribute, and license this software and
its documentation for any purpose</q>, with no agreement, licence or fee
required. `README.Snd` puts it more plainly still — available to anyone
interested, free gratis for nothing.

Two readings of that are both reasonable, and I am not the one who gets to
choose between them:

- a recording that exists to be the example in that documentation, distributed
  from the same page by the same author, is covered by "its documentation";
- or a recording is neither software nor documentation, and the grant does not
  reach it.

**So the terms are not stated for this file.** The decision to ship it was made
deliberately, by the person maintaining this extension and in contact with
Snd's author, on the first reading above: a recording that exists to be the
example in that documentation, distributed from the same page by the same
author.

That is a judgement, not a finding, and it is recorded as one here so that
nobody later mistakes it for a licence having been checked. The question is
worth putting to Bill Schottstaedt in a sentence, and if the answer is no:

    rm -r examples/sounds

Nothing depends on it. `examples/tour.scm` opens it if it is there and
synthesises fm-violin notes either way; the panels do not care which sound
they are shown.

and drop this file with it. Nothing depends on it: `examples/tour.scm` opens
the sound if it is there and synthesises fm-violin notes either way, and the
panels do not care which sound they are shown.
