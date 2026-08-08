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
(apply-controls)


(define (filter-sweep flt chan)
  (let ((phase 0.0)
	(freq 0.0)
	(incr (/ (* 2 pi) 44100.0))
        (samps (seconds->samples 0.5)))
    (do ((i 0 (+ i 1)))
	((= i samps))
      (let ((sval (* .8 (sin phase))))
	(set! phase (+ phase freq)) 
	(set! freq (+ freq incr))
	(out-any i (flt sval) chan)))))

(with-sound (:channels 5 :output "test.snd")
  (filter-sweep (make-butterworth-lowpass 8 .1) 0)
  (filter-sweep (make-bessel-lowpass 8 .1) 1)
  (filter-sweep (make-chebyshev-lowpass 8 .1) 2)
  (filter-sweep (make-inverse-chebyshev-lowpass 8 .1) 3)
  (filter-sweep (make-elliptic-lowpass 8 .1) 4))


(add-envelopes '(0 0 1 1) '(0 0 1 1 2 0))
(play)
(define brfft
  (let ((+documentation+ "(brfft lofrq hifrq) removes all frequencies between lofrq and hifrq: (brfft 1000.0 2000.0)"))
    (lambda (lofrq hifrq)
      (let* ((fsize (let ((len (framples)))
                      (expt 2 (ceiling (log len 2)))))
	     (ctr -1)
	     (lo (round (/ (* fsize lofrq) (srate))))
	     (hi (round (/ (* fsize hifrq) (srate)))))
        (filter-fft (lambda (y)
		      (set! ctr (+ 1 ctr))
		      (if (>= hi ctr lo)
		          0.0
		          y)))))))