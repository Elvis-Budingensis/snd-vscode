;;; snd-vscode-s7-parity-overlay.scm
;;;
;;; Optional overlay for snd-vscode's existing s7 bridge.
;;;
;;; NOT a plain "-l this-file-second" load in the headless case: bridgePath
;;; is always the LAST -l argument (see src/sndProcess.ts), and
;;; scheme/snd-vscode.scm ends by calling (sv-start), which in a headless
;;; build blocks forever inside sv-serve's stdin loop. A -l after it on the
;;; command line is never reached. This overlay must instead be `load`ed
;;; from inside snd-vscode.scm itself, immediately before its (sv-start)
;;; call -- see S7_OVERLAY_HANDOFF.md for the one-line patch and why it is
;;; still a manual, reviewed step rather than something this file can do to
;;; itself.
;;;
;;; It intentionally adds operations only.  It neither replaces the existing
;;; bridge nor attempts to emulate Motif/Xt.  All Snd calls below were checked
;;; against Snd 26's C-side exported signatures.

(provide 'snd-vscode-s7-parity-overlay)

(unless (defined? 'sv-define-op)
  (error 'snd-vscode-s7-parity-overlay
         "load scheme/snd-vscode.scm before this overlay"))

(define (svp-call name . args)
  (sv-require name)
  (apply (symbol->value name) args))

(define (svp-symbol value fallback)
  (cond ((symbol? value) value)
        ((and (string? value) (> (length value) 0)) (string->symbol value))
        (else fallback)))

;; Marks travel on the wire as integers (see sv-wire), but mark-sync and
;; mark-properties check a real C mark object (xen_is_mark), not an integer
;; -- the same trap sv-region/sv-mix/sv-snd-index already guard against for
;; regions, mixes and sounds. integer->mark is the missing conversion at
;; this boundary.
(define (svp-mark value)
  (if (and (integer? value) (sv-have? 'integer->mark))
      ((symbol->value 'integer->mark) value)
      value))

;; ------------------------------------------------------------------
;; File safety: export, external-file reload and read-only state.
;; ------------------------------------------------------------------

(sv-define-op saveas (params)
  ;; Snd 26's s7 function-star arguments are:
  ;; file sound srate sample-type header-type channel edit-position comment.
  ;; Keywords keep the optional fields from silently shifting position.
  (let* ((file (sv-arg params 'file ""))
         (snd (sv-arg params 'snd 0))
         (srate (sv-arg params 'srate #f))
         (sample-type (svp-symbol (sv-arg params 'sampleType #f) #f))
         (header-type (svp-symbol (sv-arg params 'headerType #f) #f))
         (comment (sv-arg params 'comment #f)))
    (when (= (length file) 0) (error 'sv-bad-args "saveas needs a file"))
    (apply svp-call 'save-sound-as
           (append (list file :sound snd)
                   (if srate (list :srate srate) ())
                   (if sample-type (list :sample-type sample-type) ())
                   (if header-type (list :header-type header-type) ())
                   (if (string? comment) (list :comment comment) ())))
    (inlet 'file file 'sound snd)))

(sv-define-op updatesound (params)
  (let ((snd (sv-arg params 'snd 0)))
    (svp-call 'update-sound snd)
    (inlet 'sound snd 'updated #t)))

(sv-define-op soundaccess (params)
  (let ((snd (sv-arg params 'snd 0)))
    (inlet 'sound snd
           'readOnly (if (sv-have? 'read-only)
                         (and (svp-call 'read-only snd) #t)
                         #f)
           'autoUpdate (if (sv-have? 'auto-update)
                           (and (svp-call 'auto-update) #t)
                           #f))))

;; ------------------------------------------------------------------
;; Edit-list persistence.  Functions themselves are deliberately never sent
;; over JSON: their source/closure cannot be reconstructed reliably.
;; ------------------------------------------------------------------

(sv-define-op saveedithistory (params)
  (let ((file (sv-arg params 'file ""))
        (snd (sv-arg params 'snd 0))
        (chn (sv-arg params 'chn 0)))
    (when (= (length file) 0) (error 'sv-bad-args "saveedithistory needs a file"))
    (svp-call 'save-edit-history file snd chn)
    (inlet 'file file 'sound snd 'channel chn)))

(sv-define-op editdetails (params)
  (let* ((snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (position (sv-arg params 'position ((symbol->value 'edit-position) snd chn)))
         (fragment (svp-call 'edit-fragment position snd chn)))
    (inlet 'sound snd 'channel chn 'position position
           'fragment (object->string fragment))))

;; ------------------------------------------------------------------
;; Marks.  Property values travel as printed s7 data, never as executable
;; code.  Claude can choose a structured editor later without changing Snd.
;; ------------------------------------------------------------------

(sv-define-op paritymark (params)
  (let* ((action (sv-arg params 'action ""))
         (snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (mark (sv-arg params 'mark #f)))
    (cond
     ((string=? action "find")
      (let ((found (svp-call 'find-mark (sv-arg params 'needle "") snd chn)))
        (inlet 'found (and found #t)
               'mark (if found (sv-wire found) #f))))
     ((string=? action "save")
      (let ((file (sv-arg params 'file "")))
        (when (= (length file) 0) (error 'sv-bad-args "mark save needs a file"))
        ;; g_save_marks(Xen snd, Xen filename) in snd-marks.c -- snd comes
        ;; first. save-marks is a plain typed procedure, not a
        ;; function-star, so there are no keywords to save a swapped
        ;; positional order here.
        (svp-call 'save-marks snd file)
        (inlet 'file file)))
     ((string=? action "sync")
      (when (not mark) (error 'sv-bad-args "mark sync needs a mark"))
      (let ((m (svp-mark mark)))
        (set! ((symbol->value 'mark-sync) m) (sv-arg params 'sync 0))
        (inlet 'mark (sv-wire m) 'sync ((symbol->value 'mark-sync) m))))
     ((string=? action "properties")
      (when (not mark) (error 'sv-bad-args "mark properties needs a mark"))
      (let ((m (svp-mark mark)))
        (inlet 'mark (sv-wire m)
               'properties (object->string ((symbol->value 'mark-properties) m)))))
     (else (error 'sv-unknown-action (string-append "not a parity mark action: " action))))))

;; ------------------------------------------------------------------
;; Transform data.  `transform-sample` is data Snd already computed, so this
;; avoids a parallel FFT in VS Code.
;; ------------------------------------------------------------------

(sv-define-op transformdata (params)
  (let* ((snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (slice (sv-arg params 'slice 0))
         (count (max 0 (sv-arg params 'count 0)))
         (available (if (sv-have? 'transform-framples)
                        (svp-call 'transform-framples snd chn)
                        0))
         (n (if (> count 0) (min count available) available)))
    (inlet 'sound snd 'channel chn 'slice slice 'framples available
           'values (let loop ((bin 0) (out ()))
                     (if (>= bin n) (reverse out)
                         (loop (+ bin 1)
                               (cons (svp-call 'transform-sample bin slice snd chn) out)))))))

;; ------------------------------------------------------------------
;; Editing additions.  This is an explicit whitelist; callers cannot turn the
;; bridge into eval by passing an arbitrary Snd symbol.
;; ------------------------------------------------------------------

(sv-define-op parityedit (params)
  (let* ((action (sv-arg params 'action ""))
         (snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (cursor ((symbol->value 'cursor) snd chn)))
    (cond
     ((string=? action "reverse-channel") (svp-call 'reverse-channel 0 #f snd chn))
     ((string=? action "normalize-channel") (svp-call 'normalize-channel snd chn))
     ((string=? action "scale-to") (svp-call 'scale-to (sv-arg params 'peak 1.0) snd))
     ((string=? action "smooth-at-cursor")
      (svp-call 'smooth-sound cursor (sv-arg params 'samples 128) snd chn))
     ((string=? action "swap-channels")
      ;; g_swap_channels(snd0 chn0 snd1 chn1 ...): swap the CURRENT channel
      ;; (chn, from context) against 'other, both in the same sound. Passing
      ;; 'other' as chn0 alone (the previous version) silently ignored chn
      ;; and swapped a different pair than the caller asked for.
      (svp-call 'swap-channels snd chn snd (sv-arg params 'other 1)))
     (else (error 'sv-unknown-edit (string-append "not a parity edit: " action))))
    (inlet 'action action 'editPosition ((symbol->value 'edit-position) snd chn))))

;; A truthful capability report lets the extension hide a control when the
;; user's Snd was built without a particular optional feature.
(sv-define-op paritycapabilities (params)
  (map (lambda (name)
         (inlet 'name (symbol->string name) 'available (and (sv-have? name) #t)))
       '(save-sound-as update-sound read-only auto-update save-edit-history
         edit-list->function as-one-edit save-marks find-mark mark-properties
         mark-sync integer->mark transform-framples transform-sample peaks
         add-transform reverse-channel normalize-channel scale-to
         swap-channels)))
