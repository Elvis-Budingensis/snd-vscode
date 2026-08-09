;;; tour.scm -- a place to stand while trying snd-vscode.
;;;
;;; This folder exists so that the development host has a folder to open.
;;; Without one it reopens whatever it had last -- which is a different
;;; project, with a different extension's files, and looks like the wrong
;;; extension started.
;;;
;;; It is also Snd's working directory for the session, which is what
;;; (open-sound "x.wav") without a path means.

;; C-c C-e with the cursor in a form evaluates that form.
;; C-c C-z opens the REPL. C-c C-i asks Snd for help on a name.

(+ 1 2)

;; What Snd is this?
(snd-version)

;; A sound to look at, made rather than found -- so this file works with no
;; audio files to hand. Two seconds of a sine at 440 with a slow tremolo.
(define (make-test-sound file)
  (let* ((seconds 2.0)
         (rate 44100)
         (frames (round (* seconds rate)))
         (data (make-float-vector frames 0.0)))
    (do ((i 0 (+ i 1)))
        ((= i frames))
      (set! (data i)
            (* 0.6
               (+ 0.75 (* 0.25 (sin (/ (* 2 pi 3 i) rate))))   ; tremolo
               (sin (/ (* 2 pi 440 i) rate)))))
    (let ((out (new-sound file 1 rate)))
      (float-vector->channel data 0 frames out 0)
      out)))

;; Evaluate this, then run "Snd: Show Waveform".
(make-test-sound "/tmp/snd-vscode-test.wav")

;; The tremolo is visible in the waveform panel as an envelope that breathes
;; three times a second -- and the RMS line inside it shows how much of that
;; is loudness rather than peak.

;; Select something in the panel by dragging, then try the edit buttons.
;; Or from here:
(select-all)
(scale-selection-by 0.5)

;; The spectrum panel follows the cursor. Click in the waveform and watch it
;; move. 440 Hz should sit where the peak is.

;; Snd's own transform settings, which "Snd: Transform Options" shows:
(fft-window)
(transform-size)

;; Everything Snd knows whose name contains "spectr".
;;
;; NOT (apropos "spectr"): Snd's apropos prints into its listener and returns
;; #f, so in a headless build it appears to do nothing at all. The palette
;; command "Snd: Apropos" asks the bridge, which walks the symbol table and
;; sends back a list. From here, the same thing, returning a value the REPL
;; can print:
(let ((found ()))
  (for-each (lambda (sym)
              (when (string-position "spectr" (symbol->string sym))
                (set! found (cons (symbol->string sym) found))))
            (symbol-table))
  (sort! found string<?))

;; --- the envelope editor --------------------------------------------
;;
;; "Snd: Envelope Editor" (C-c C-v). Draw a curve, pick a target, and press
;; SPACE to hear it. Each press replaces the previous one, so you can drag a
;; point and press space again without filling the edit history; "apply" is
;; what keeps it.
;;
;; The same thing from here, so the two can be compared:

;; A fade out over the whole channel. One entry in the edit history.
(env-channel '(0 1 1 0) 0 (framples) 0 0)

;; The same shape as an exponential curve, which is what the base does.
;; Evaluate both and look at the waveform panel between them: the straight
;; fade leaves a triangle, the exponential one a curve that holds longer.
(undo)
(env-channel-with-base '(0 1 1 0) 32.0 0 (framples) 0 0)
(undo)

;; The filter response is a DIFFERENT envelope: x is frequency, y is gain.
;; Setting it changes nothing on its own -- it is a control, like the amp
;; slider, and takes effect when the filter is switched on and applied.
(set! (filter-control-envelope) '(0 1 0.1 1 0.2 0 1 0))
(set! (filter-control?) #t)
;; Now "apply" in the control panel, or:
;; (apply-controls)

;; --- Snd's own instruments -------------------------------------------
;;
;; oboe.snd, fm-violin.snd, pistol.snd and the rest are NOT in the Snd
;; tarball. I looked: all 676 entries, no audio at all. They live on Bill's
;; site and get downloaded separately, which is why every example in the
;; documentation that opens oboe.snd assumes you already have it.
;;
;; What DOES ship is better for a tour anyway: the instruments themselves.
;; v.scm is the fm-violin, clm-ins.scm two dozen more, dsp.scm the analysis
;; and filtering library, examp.scm the examples the reference quotes.
;;
;; Point snd.sourcePath at your Snd sources (or set SND_SOURCE) and these
;; work; without it, load-from-path will say which file it could not find.

;; The fm-violin, from v.scm -- Bill's own instrument, and the one that made
;; the ".snd" files everybody quotes.
(if (not (provided? 'snd-v.scm)) (load-from-path "v.scm"))
(if (not (provided? 'snd-ws.scm)) (load-from-path "ws.scm"))

;; THE ARGUMENTS ARE (start dur frequency amplitude ...), in that order, and
;; every one of them is required:
;;
;;   (fm-violin 330 .2)          -> hz->radians argument, #f, is boolean
;;                                  but should be a real
;;
;; because .2 landed on `dur` and `frequency` was left unset. And an instrument
;; called on its own writes nowhere:
;;
;;   (fm-violin 0 4 330 .2)      -> #<do-unspecified>, and no sound
;;
;; It needs an open output, which is what with-sound provides. with-sound is a
;; MACRO whose first argument is a list of options -- so the notes go INSIDE
;; it, they are not arguments to it:
;;
;;   (with-sound fm-violin 0 4 330 .2)  -> apply's last argument should be a
;;                                         proper list: fm-violin
(with-sound (:output "violin.snd" :channels 1)
  (fm-violin 0 1 440 0.3)
  (fm-violin 0.5 1 660 0.2 :fm-index 2.0)
  (fm-violin 1.0 1.5 330 0.25 :reverb-amount 0.1))

;; Now the panels have something with structure in them: "Snd: Show Waveform"
;; for the three overlapping notes, and the spectrogram for the FM sidebands
;; appearing and going again.
(play)

;; dsp.scm, which is where display-bark-fft lives -- the function that makes
;; "Snd: User Graph" show something. Load it, push it onto lisp-graph-hook,
;; and the panel draws a bark-scale spectrum:
;;
;;   (load-from-path "dsp.scm")
;;   (hook-push lisp-graph-hook
;;     (lambda (h) (display-bark-fft (h 'snd) (h 'chn))))
;;
;; examp.scm has display-energy, which is smaller and needs no arguments
;; beyond the channel.

;; --- oboe.snd, which ships with this extension -----------------------
;;
;; examples/sounds/oboe.snd: the file every worked example in Snd's
;; documentation opens. A real instrument -- an attack, harmonics that move, a
;; decay -- which is what the spectrogram and the waveform panel are actually
;; for; a synthesised sine has none of it.
;;
;; See examples/sounds/README.md for where it came from and for the one thing
;; about it that is not settled: it is not in the Snd tarball, and its
;; redistribution terms are not written down anywhere I could find.
;;
;; Opened, not loaded:
;;
;;   (load "oboe.snd")      -> tries to READ it as Scheme source
;;   (open-sound "oboe.snd") -> #<sound 1>
;;
;; load is for programs, open-sound for sounds. The mistake is easy because
;; every other file in this tour is loaded.
;;
;; Relative to this file, so it works wherever the extension is installed:
(open-sound "sounds/oboe.snd")

;; Now try the panels on something real:
;;   "Snd: Show Waveform"  -- the attack and the decay
;;   "Snd: Show Spectrum"  -- view: spectrogram (3D), log freq on, size 2048
;;                            and the oboe's harmonics stand up as ridges
;;   space in the waveform panel, or (play)
