# Checking the bridge without VS Code

Worth doing once before pressing F5, because it separates two questions that
otherwise fail as one: *does Snd talk to the bridge* and *does the extension
talk to Snd*. If this works and the extension does not, the fault is in the
extension. If this does not work, nothing in the extension can.

```sh
snd -l scheme/snd-vscode.scm
```

Frames go to **stderr**, so they appear on the terminal mixed with Snd's own
output. Expect one immediately:

```
{"event":"ready","mode":"gui","protocol":1}
```

`"mode":"gui"` with a Motif build, `"mode":"nogui"` without. If nothing
appears, Snd did not find the file — use an absolute path.

Now type requests. Each is one line:

```scheme
(sv "1" 'status (inlet))
(sv "2" 'eval (inlet 'code "(+ 1 2)"))
(sv "3" 'getvars (inlet 'names "fft-window transform-size min-dB"))
(sv "4" 'constants (inlet 'names "blackman2-window graph-as-sonogram"))
```

With a sound open (`(open-sound "/path/to/a.wav")`):

```scheme
(sv "5" 'sounds (inlet))
(sv "6" 'waveform (inlet 'snd 0 'chn 0 'columns 20))
```

The waveform answer carries `mins`, `maxs` and `rms` — twenty numbers each,
which is the whole reduction the panel draws. Twenty is small enough to read
by eye and check that the peak matches what Snd's own graph shows.

To see the frames on their own, without Snd's chatter:

```sh
snd -l scheme/snd-vscode.scm 2>&1 1>/dev/null
```

That is the extension's view of the channel.
