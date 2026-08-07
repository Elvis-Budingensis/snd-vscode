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

;; Everything Snd knows whose name contains "spectr":
(apropos "spectr")
