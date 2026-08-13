;;; test-bridge.scm -- checks snd-vscode.scm in PLAIN s7, without Snd.
;;;
;;; Why without Snd: building Snd takes minutes and needs Motif or at
;;; least a working audio stack, so a gate that needs it does not get
;;; run.  What is actually fragile in the bridge is not the Snd calls but
;;; the parts around them -- the JSON writer, the framing, the dispatch,
;;; the error path, the column reduction.  All of that is pure s7 and can
;;; be checked in a second.
;;;
;;; The Snd side is stubbed with the SIGNATURES Snd really has, so a
;;; wrong argument order shows up here and not on stage.
;;;
;;; Run:  s7 scheme/test-bridge.scm

(define sv-no-autostart #t)

(define failures 0)
(define checks 0)

(define (check name expected got)
  (set! checks (+ checks 1))
  (unless (equal? expected got)
    (set! failures (+ failures 1))
    (format *stdout* "FAIL ~A~%  expected: ~S~%  got:      ~S~%" name expected got)))

(define (check-true name got)
  (check name #t (and got #t)))

;; ---------------------------------------------------------------- stubs
;;
;; A 1000-sample test channel: a sine of one period plus a DC offset of
;; 0.1.  The offset is deliberate -- it is what tells a min/max reduction
;; apart from a max-only one.

(define *test-frames* 1000)
(define *test-data*
  (let ((v (make-float-vector *test-frames* 0.0)))
    (do ((i 0 (+ i 1)))
        ((= i *test-frames*) v)
      (set! (v i) (+ 0.1 (* 0.5 (sin (/ (* 2 pi i) *test-frames*))))))))

(define (open-sound file) 0)
(define (framples . args)
  ;; Channels of a sound can differ in length as soon as one is edited, and
  ;; that is the case the shared-range logic has to get right.
  (if (and *short-frames* (pair? (cdr args)) (= (cadr args) 1))
      *short-frames*
      *test-frames*))
(define (srate . args) 44100)
(define *channel-count* 2)
(define (channels . args) *channel-count*)
(define *short-frames* #f)   ; when set, channel 1 is this long
(define (channel-style . args) 0)
(define (file-name . args) "/tmp/test.snd")
(define (short-file-name . args) "test.snd")
;; Snd's (sounds) returns SOUND OBJECTS, not indices, and they print as
;; "#<sound 0>". Stubbing them as bare integers hid the bug that cost an
;; evening: the objects were JSON-encoded as that string, travelled to the
;; extension, came back as 'snd, and Snd rejected them three requests later
;; with a message that never mentioned (sounds).
(define (make-sound-object index) (list '*sound* index))
;; Snd's sound? answers "does this refer to an open sound" -- so it says #t
;; for the INDEX as readily as for the object. Stubbing it as a type
;; predicate is what hid the second half of this bug: sound? was used as the
;; discriminator, every integer went into sound->integer, and Snd rejected
;; it. The stub now behaves like the real one.
(define (sound? x)
  (or (and (pair? x) (eq? (car x) '*sound*))
      (and (integer? x) (>= x 0))))
(define (sound->integer s) (cadr s))
(define (integer->sound n) (make-sound-object n))
(define (sounds) (list (make-sound-object 0)))
(define (selected-sound) (make-sound-object 0))
(define (edit-position . args) 3)
(define cursor-value 42)
(define cursor
  (dilambda (lambda* ((snd 0) (chn 0)) cursor-value)
            (lambda* ((snd 0) (chn 0) v) (set! cursor-value v))))
(define (marks . args) (list 7))
(define (mark-sample m) 100)
(define (mark-name m) "start")
;; A dilambda, because that is what Snd's is: the overlay sets it with
;; (set! ((symbol->value 'mark-sync) m) v), and a plain procedure makes that an
;; error rather than a wrong value -- which is how the missing setter showed up
;; here in the first place.
(define *mark-syncs* (make-hash-table))
(define mark-sync
  (dilambda (lambda (m) (or (*mark-syncs* m) 0))
            (lambda (m v) (set! (*mark-syncs* m) v) v)))
;; The selection, in Snd's own three parts. Written as dilambdas because
;; that is what they are -- and because the whole bug was calling a
;; set-selection-position that does not exist.
(define *selection-log* ())
(define *sel-member* #f)
(define *sel-position* 0)
(define *sel-frames* 0)
(define selection-member?
  (dilambda (lambda* ((snd 0) (chn 0)) *sel-member*)
            (lambda* ((snd 0) (chn 0) v)
              (set! *selection-log* (cons (list 'member v) *selection-log*))
              (set! *sel-member* v))))
(define selection-position
  (dilambda (lambda* ((snd 0) (chn 0)) *sel-position*)
            (lambda* ((snd 0) (chn 0) v)
              (set! *selection-log* (cons (list 'position v) *selection-log*))
              (set! *sel-position* v)
              ;; The real behaviour, from the reference: moving the start
              ;; keeps the END fixed and changes the length. This is what
              ;; makes the order of the two set!s matter.
              (set! *sel-frames* (max 0 (- (+ *sel-position* *sel-frames*) v))))))
(define selection-framples
  (dilambda (lambda* ((snd 0) (chn 0)) *sel-frames*)
            (lambda* ((snd 0) (chn 0) v)
              (set! *selection-log* (cons (list 'framples v) *selection-log*))
              (set! *sel-frames* v))))
(define (selection?) (or *has-selection* *sel-member*))

;; Regions and mixes are OBJECTS, like sounds -- and region? and mix? say #t
;; for a valid index too, which is the trap sounds fell into twice.
(define (make-region-object i) (list '*region* i))
(define (region? x) (or (and (pair? x) (eq? (car x) '*region*)) (and (integer? x) (>= x 0))))
(define (region->integer r) (cadr r))
(define (integer->region i) (make-region-object i))
(define (regions) (list (make-region-object 0) (make-region-object 1)))
(define (region-framples r) 1000)
(define (region-chans r) 1)
(define (region-srate r) 44100)
(define (region-position r chan) 500)
(define (region-home r) (list 'sound 0 0 500 1500))
(define *region-log* ())
(define (insert-region r beg snd chn) (set! *region-log* (cons (list 'insert (region->integer r) beg) *region-log*)) 1)
(define (mix-region r samp snd chn) (set! *region-log* (cons (list 'mix (region->integer r) samp) *region-log*)) 1)
(define (save-region r . args) (set! *region-log* (cons (cons 'save args) *region-log*)) "f.wav")
(define (forget-region r) (set! *region-log* (cons 'forget *region-log*)) #t)

(define (make-mix-object i) (list '*mix* i))
(define (mix? x) (or (and (pair? x) (eq? (car x) '*mix*)) (and (integer? x) (>= x 0))))
(define (mix->integer m) (cadr m))
(define (integer->mix i) (make-mix-object i))
(define (mixes . args) (list (make-mix-object 0)))
(define *mix-position-value* 2000)
(define mix-position
  (dilambda (lambda (m) *mix-position-value*) (lambda (m v) (set! *mix-position-value* v))))
(define *mix-amp-value* 1.0)
(define mix-amp (dilambda (lambda (m) *mix-amp-value*) (lambda (m v) (set! *mix-amp-value* v))))
(define *mix-name-value* "")
(define mix-name (dilambda (lambda (m) *mix-name-value*) (lambda (m v) (set! *mix-name-value* v))))
(define (mix-length m) 300)
(define (mix-home m) (list 'sound 0 0))

;; Marks are objects too, with the same validity-predicate shape as sounds.
(define (make-mark-object i) (list '*mark* i))
(define (mark? x) (or (and (pair? x) (eq? (car x) '*mark*)) (and (integer? x) (>= x 0))))
(define (mark->integer m) (if (pair? m) (cadr m) m))
(define (integer->mark i) (make-mark-object i))

(define *mark-log* ())
(define (add-mark sample . rest)
  (set! *mark-log* (cons (cons 'add (cons sample rest)) *mark-log*))
  7)
(define (delete-mark m) (set! *mark-log* (cons (list 'delete m) *mark-log*)) #t)

(define (snd-spectrum data window len . rest)
  ;; The real signature: data window length (linear #t) (beta 0.0) in-place
  ;; (normalized #t). In dB the values are <= 0 with min-dB as the floor.
  (let ((linear (and (pair? rest) (car rest)))
        (out (make-float-vector len 0.0)))
    (do ((i 0 (+ i 1))) ((= i len) out)
      (set! (out i) (if linear (if (< i 4) 1.0 0.0) (if (< i 4) 0.0 -90.0))))))
(define (min-dB) -60.0)
;; A sampler, as the reference describes it: make-sampler start snd chn dir,
;; then read-sample walks in that direction.
(define (make-sampler start . rest)
  (let ((pos start)
        (dir (if (and (pair? rest) (pair? (cdr rest)) (pair? (cddr rest)))
                 (caddr rest)
                 1)))
    (list 'sampler (lambda () (let ((v (*test-data* (max 0 (min (- *test-frames* 1) pos)))))
                                (set! pos (+ pos dir))
                                v)))))
(define (read-sample r) ((cadr r)))
(define *search-procedure-value* #f)
(define search-procedure
  (dilambda (lambda () *search-procedure-value*)
            (lambda (v) (set! *search-procedure-value* v))))
(define *sync-value* 0)
(define sync
  (dilambda (lambda* ((snd 0)) *sync-value*)
            (lambda* ((snd 0) v) (set! *sync-value* v))))
(define (sync-max) 3)

;; Snd's global hooks, as real s7 hooks -- with each hook's OWN argument names
;; in the documented order, because an s7 hook is called POSITIONALLY:
;;
;;   (mark-hook 7 0 1 2)   not   (mark-hook (inlet 'id 7 ...))
;;
;; The hook builds the environment from its argument names and passes THAT to
;; the functions on it. Handing a hook an inlet instead binds the inlet to its
;; first argument, so every field reads #f -- which is what the first version
;; of these tests did, and it looked exactly like a broken bridge.
;;
;; Missing trailing arguments are #f, and 'result exists on every hook.
(define start-playing-hook (make-hook 'snd))
(define stop-playing-hook (make-hook 'snd))
(define stop-playing-selection-hook (make-hook))
(define new-sound-hook (make-hook 'name))
(define mark-hook (make-hook 'id 'snd 'chn 'reason))
(define mix-release-hook (make-hook 'id 'samples))
(define mix-click-hook (make-hook 'id))
(define snd-error-hook (make-hook 'message))
(define snd-warning-hook (make-hook 'message))
(define mus-error-hook (make-hook 'type 'message))

;; `graph` as Snd has it: data xlabel x0 x1 y0 y1 snd chn force-display.
;; Recorded so a test can tell the wrapper called the original.
(define *graph-calls* ())
(define (graph . args) (set! *graph-calls* (cons args *graph-calls*)) 0)
(define lisp-graph-hook (make-hook 'snd 'chn))
(define graph-hook (make-hook 'snd 'chn 'y0 'y1))

(define (snd-help sym) (string-append "help for " (symbol->string sym)))
(define (snd-version) "Snd 26.5 (test stub)")
(define (default-output-srate) 44100)

;; Wavogram and header fields are dilambdas in Snd: getters with optional
;; sound/channel arguments and setters whose value is last.
(define *wavo-trace-value* 64)
(define wavo-trace
  (dilambda (lambda* ((snd 0) (chn 0)) *wavo-trace-value*)
            (lambda* ((snd 0) (chn 0) v) (set! *wavo-trace-value* v))))
(define *wavo-hop-value* 3)
(define wavo-hop
  (dilambda (lambda* ((snd 0) (chn 0)) *wavo-hop-value*)
            (lambda* ((snd 0) (chn 0) v) (set! *wavo-hop-value* v))))
(define graph-as-wavogram 1)
(define *time-graph-type-value* 0)
(define time-graph-type
  (dilambda (lambda* ((snd 0) (chn 0)) *time-graph-type-value*)
            (lambda* ((snd 0) (chn 0) v) (set! *time-graph-type-value* v))))

(define mus-next 0)
(define mus-aifc 1)
(define mus-riff 2)
(define mus-rf64 3)
(define mus-aiff 4)
(define mus-nist 5)
(define mus-ircam 6)
(define mus-caff 7)
(define mus-raw 8)
(define mus-lshort 10)
(define mus-bshort 11)
(define mus-lint 12)
(define mus-bint 13)
(define mus-lfloat 14)
(define mus-bfloat 15)
(define mus-ldouble 16)
(define mus-bdouble 17)
(define mus-mulaw 18)
(define mus-alaw 19)
(define mus-ubyte 20)
(define mus-byte 21)

(define *header-type-value* mus-next)
(define header-type
  (dilambda (lambda* ((snd 0)) *header-type-value*)
            (lambda* ((snd 0) v) (set! *header-type-value* v))))
(define *sample-type-value* mus-lshort)
(define sample-type
  (dilambda (lambda* ((snd 0)) *sample-type-value*)
            (lambda* ((snd 0) v) (set! *sample-type-value* v))))
(define *srate-value* 44100)
(set! srate
  (dilambda (lambda* ((snd 0)) *srate-value*)
            (lambda* ((snd 0) v) (set! *srate-value* v))))
(define *channels-value* 2)
(set! channels
  (dilambda (lambda* ((snd 0)) *channels-value*)
            (lambda* ((snd 0) v) (set! *channels-value* v))))
(define *data-location-value* 28)
(define data-location
  (dilambda (lambda* ((snd 0)) *data-location-value*)
            (lambda* ((snd 0) v) (set! *data-location-value* v))))
(define *data-size-value* 4000)
(define data-size
  (dilambda (lambda* ((snd 0)) *data-size-value*)
            (lambda* ((snd 0) v) (set! *data-size-value* v))))
(define *comment-value* "test comment")
(define comment
  (dilambda (lambda* ((snd 0)) *comment-value*)
            (lambda* ((snd 0) v) (set! *comment-value* v))))
(define *saved-state-file* #f)
(define (save-state file) (set! *saved-state-file* file) #t)

(define (channel->float-vector beg dur . rest)
  ;; Snd's own contract: fewer samples than asked for near the end.
  (let* ((available (max 0 (min dur (- *test-frames* beg))))
         (out (make-float-vector (max 1 available) 0.0)))
    (do ((i 0 (+ i 1)))
        ((= i available) out)
      (set! (out i) (*test-data* (+ beg i))))))


;; --- stubs for the dialog variables ---------------------------------
;;
;; Written as dilambdas, the way Snd writes them, because that is what
;; makes (set! (f) v) work and (set! f v) a silent disaster.

(define *fft-window-value* 2)
(define fft-window
  (dilambda (lambda () *fft-window-value*)
            (lambda (v) (set! *fft-window-value* v))))
(define *transform-size-value* 512)
(define transform-size
  (dilambda (lambda () *transform-size-value*)
            (lambda (v) (set! *transform-size-value* v))))
(define *amp-value* 1.0)
(define amp-control                       ; the sound-scoped shape
  (dilambda (lambda* ((snd 0)) *amp-value*)
            (lambda* ((snd 0) v) (set! *amp-value* v))))
(define *fourier* (list 'transform 'fourier 0))
(define (transform? x) (and (pair? x) (eq? (car x) 'transform)))
(define (transform->integer x) (caddr x))
(define (integer->transform n) (list 'transform 'fourier n))
(define *transform-type-value* *fourier*)
(define transform-type
  (dilambda (lambda () *transform-type-value*)
            (lambda (v) (set! *transform-type-value* v))))
(define *normalize* #t)
(define transform-normalization
  (dilambda (lambda () *normalize*) (lambda (v) (set! *normalize* v))))
(define (apply-controls . args) 1)
(define *edits* ())
(define *has-selection* #f)
(define (delete-selection) (set! *edits* (cons 'delete *edits*)) 1)
(define *key-log* ())
(define (delete-samples beg dur snd chn)
  (set! *key-log* (cons (list 'delete-samples beg dur) *key-log*)) 1)
(define (insert-silence beg dur snd chn)
  (set! *key-log* (cons (list 'insert-silence beg dur) *key-log*)) 1)
(define (smooth-sound beg dur snd chn)
  (set! *key-log* (cons (list 'smooth beg dur) *key-log*)) 1)
(define *sample-value* 0.5)
(define sample
  (dilambda (lambda* (samp (snd 0) (chn 0)) *sample-value*)
            (lambda* (samp (snd 0) (chn 0) v)
              (set! *key-log* (cons (list 'sample samp v) *key-log*))
              (set! *sample-value* v))))
;; The signatures the reference gives: insert-selection beg snd chn, and
;; mix-selection beg snd chn selection-chan. Stubbing them as no-argument
;; functions is what let "insert at cursor" paste at 0 unnoticed.
(define (insert-selection beg snd chn) (set! *edits* (cons (list 'insert beg) *edits*)) 1)
(define (mix-selection beg snd chn) (set! *edits* (cons (list 'mix beg) *edits*)) 1)
(define (smooth-selection) (set! *edits* (cons 'smooth *edits*)) 1)
(define (save-selection . args) (set! *edits* (cons (cons 'save args) *edits*)) 1)
(define play-hook (make-hook 'size))
(define stop-playing-hook (make-hook 'snd))
(define (cursor-update-interval) 0.05)
(define (cursor-location-offset) 0)
(define (reverse-selection) (set! *edits* (cons 'reverse *edits*)) 1)
(define (select-all . args) (set! *has-selection* #t) 1)
(define (unselect-all) (set! *has-selection* #f) 1)
(define (scale-selection-by f) (set! *edits* (cons (list 'scale f) *edits*)) 1)
(define (scale-channel f beg dur snd chn) (set! *edits* (cons (list 'scale-chan f) *edits*)) 1)
; src-selection is defined once, further down, where the envelope stubs are:
; two definitions and the second silently wins, which is how the resample test
; started passing an empty list.
(define fourier-transform 0)
(define blackman2-window 2)
;; The envelope side, with the signatures the reference gives:
;;   env-channel            env beg dur snd chn edpos
;;   env-channel-with-base  env base beg dur snd chn edpos
;;   env-selection          envelope env-base
;; Each stub records HOW it was called, so a positional slip shows up here
;; rather than as an edit in the wrong place.
(define *env* (list 0.0 1.0 1.0 0.0))
(define *env-calls* ())
(define enved-envelope (dilambda (lambda () *env*) (lambda (v) (set! *env* v))))
(define *enved-base-value* 1.0)
(define enved-base
  (dilambda (lambda () *enved-base-value*) (lambda (v) (set! *enved-base-value* v))))
(define (enved-clip?) #f)
(define (env-channel e beg dur snd chn)
  (set! *env-calls* (cons (list 'env-channel e beg dur snd chn) *env-calls*)) 1)
;; Bill's matrix: three targets times three scopes. The signatures are the
;; documented ones, so a positional slip shows up here.
;;   env-sound env beg dur base s c e     (the base is the FOURTH argument)
;;   filter-sound env order s c e
;;   src-sound num-or-env s c e
(define (env-sound e beg dur base snd chn)
  (set! *env-calls* (cons (list 'env-sound e beg dur base snd chn) *env-calls*)) 1)
(define (filter-sound e order snd chn)
  (set! *env-calls* (cons (list 'filter-sound e order snd chn) *env-calls*)) 1)
(define (filter-selection e order)
  (set! *env-calls* (cons (list 'filter-selection e order) *env-calls*)) 1)
(define (src-sound e snd chn)
  (set! *env-calls* (cons (list 'src-sound e snd chn) *env-calls*)) 1)
(define (src-selection e)
  ;; Recorded in BOTH logs: the resample op and the envelope op both call it,
  ;; and a stub that serves one of them leaves the other testing nothing.
  (set! *env-calls* (cons (list 'src-selection e) *env-calls*))
  (set! *edits* (cons (list 'src e) *edits*))
  1)
(define *mix-amp-env-value* ())
(define mix-amp-env
  (dilambda (lambda (m) *mix-amp-env-value*)
            (lambda (m v)
              (set! *env-calls* (cons (list 'mix-amp-env v) *env-calls*))
              (set! *mix-amp-env-value* v))))
;; Snd's REAL arrangement, from snd-env.c: a procedure named
;; define-envelope-1, plus a macro named define-envelope that quotes the name
;; for you. Stubbing it as a plain procedure hid the fact that sv-have?
;; answered "not available in this Snd build" for a working macro.
(define *defined-envelopes* ())
(define (define-envelope-1 name points base)
  (set! *defined-envelopes* (cons (list name points base) *defined-envelopes*))
  name)
(define-macro (define-envelope a . b) `(define-envelope-1 ',a ,@b))
(define enved-amplitude 0)
(define enved-spectrum 1)
(define enved-srate 2)
(define envelope-linear 0)
(define envelope-exponential 1)
(define *enved-target-value* 0)
(define enved-target
  (dilambda (lambda () *enved-target-value*) (lambda (v) (set! *enved-target-value* v))))
(define (enved-style) envelope-linear)
(define (enved-wave?) #f)
(define (enved-in-dB) #f)
(define (enved-power) 3.0)
(define (enved-filter-order) 40)
;; A named envelope is an ordinary variable holding an even-length list of
;; reals -- exactly what Snd's own funcs.scm defines on every line.
(define sv-test-ramp '(0 0 1 1))
(define (env-channel-with-base e base beg dur snd chn)
  (set! *env-calls* (cons (list 'with-base e base beg dur snd chn) *env-calls*)) 1)
(define (env-selection e base)
  (set! *env-calls* (cons (list 'env-selection e base) *env-calls*)) 1)
(define *filter-env* (list 0.0 1.0 1.0 1.0))
(define filter-control-envelope
  (dilambda (lambda* ((snd 0)) *filter-env*)
            (lambda* ((snd 0) v) (set! *filter-env* v))))
(define (filter-control-order . args) 20)
(define (filter-control-in-hz . args) #f)


;; --- hooks, in Snd's own two shapes ---------------------------------
;;
;; GLOBAL hooks are variables holding a hook. CHANNEL hooks -- edit-hook,
;; undo-hook, after-edit-hook -- are FUNCTIONS of (snd chn) returning the
;; hook for that channel. Passing the second kind to hook-functions is what
;; broke the load on a real Snd, so both shapes are stubbed here.

(define after-open-hook (make-hook 'snd))
(define close-hook (make-hook 'snd))
(define *channel-hooks* (make-hash-table))
(define (after-edit-hook snd chn)
  (let ((key (list snd chn)))
    (or (*channel-hooks* key)
        (set! (*channel-hooks* key) (make-hook 'snd)))))


;; ---- stubs the parity overlay needs --------------------------------------
;;
;; Each records HOW it was called, because that is what these tests are for.
;; The overlay's own comments name two places where a positional order was
;; wrong and silently did something else: save-marks takes the sound first and
;; the filename second, and swap-channels takes (snd chn snd other), not
;; (other ...) alone. A stub that only returned a value would pass either way.

(define *calls* ())
(define (record! name . args)
  (set! *calls* (cons (cons name args) *calls*))
  #t)
(define (last-call name)
  (let loop ((rest *calls*))
    (cond ((null? rest) #f)
          ((eq? (caar rest) name) (cdar rest))
          (else (loop (cdr rest))))))

(define (save-sound-as file . rest) (apply record! 'save-sound-as file rest))
(define (update-sound snd) (record! 'update-sound snd))
(define *read-only-flag* #t)
(define (read-only snd) *read-only-flag*)
(define (auto-update) #f)
(define (save-edit-history file snd chn) (record! 'save-edit-history file snd chn))
(define (edit-fragment position snd chn) (list 'fragment position snd chn))
(define (find-mark needle snd chn) (record! 'find-mark needle snd chn) 42)
(define (save-marks snd file) (record! 'save-marks snd file))
(define (mark-properties m) (list 'colour 'red))
(define (transform-framples snd chn) 4)
(define (transform-sample bin slice snd chn) (* 0.25 (+ bin 1)))
(define (reverse-channel . args) (apply record! 'reverse-channel args))
(define (normalize-channel . args) (apply record! 'normalize-channel args))
(define (scale-to peak snd) (record! 'scale-to peak snd))
(define (swap-channels . args) (apply record! 'swap-channels args))

(load "scheme/snd-vscode.scm")

;; ---- the parity overlay ---------------------------------------------------
;;
;; Loaded here for the same reason the bridge is: its ops are dispatch,
;; argument order and error paths, all of which are pure s7. In the product it
;; is loaded from inside snd-vscode.scm just before (sv-start); here it is
;; loaded directly, because sv-no-autostart means sv-start never runs.
;;
;; Worth stating plainly: until the op-coverage gate was widened to read every
;; scheme file rather than the one filename it had hard-coded, these nine ops
;; were invisible to it. The number stayed green while the newest code in the
;; project sat outside it.
(load "scheme/snd-vscode-s7-parity-overlay.scm")

;; ------------------------------------------------------------ JSON

(check "json: true"        "true"            (sv-json->string #t))
(check "json: false"       "false"           (sv-json->string #f))
(check "json: empty list"  "[]"              (sv-json->string ()))
(check "json: integer"     "42"              (sv-json->string 42))
(check "json: ratio"       "0.3333333333333333" (sv-json->string (/ 1 3)))
(check "json: symbol"      "\"abc\""         (sv-json->string 'abc))
(check "json: list"        "[1,2,3]"         (sv-json->string (list 1 2 3)))
(check "json: vector"      "[1,2]"           (sv-json->string (vector 1 2)))
(check "json: inlet"       "{\"a\":1,\"b\":\"x\"}"
       (sv-json->string (inlet 'a 1 'b "x")))
(check "json: nested"      "{\"a\":[1,{\"b\":false}]}"
       (sv-json->string (inlet 'a (list 1 (inlet 'b #f)))))

;; The escaping is the whole reason for not using json.scm's s7->json.
(check "json: quote in string"   "\"a\\\"b\""  (sv-json->string "a\"b"))
(check "json: backslash"         "\"a\\\\b\""  (sv-json->string "a\\b"))
(check "json: newline"           "\"a\\nb\""   (sv-json->string "a\nb"))
(check "json: tab"               "\"a\\tb\""   (sv-json->string "a\tb"))
(check "json: control character" "\"a\\u0001b\"" (sv-json->string "a\x01;b"))

;; NaN and infinity have no JSON notation.  Substituting 0.0 would put a
;; plausible wrong number into a waveform; null says the value is not a
;; number.
(check "json: nan"      "null" (sv-json->string (string->number "+nan.0")))
(check "json: infinity" "null" (sv-json->string (string->number "+inf.0")))

;; A frame must survive JSON.parse on the other side, so no raw control
;; character may reach the wire.
(let ((frame (sv-json->string (inlet 'output "line1\nline2\ttab"))))
  (check-true "json: no raw newline in frame"
              (not (string-position "\n" frame))))

;; --------------------------------------------------------- reduction

(let ((r (sv-reduce-channel 0 0 0 *test-frames* 4)))
  (check "reduce: columns" 4 (r 'columns))
  (check "reduce: length"  4 (length (r 'mins)))
  ;; The peak of 0.1 + 0.5 sin is 0.6, not 0.5 -- if the offset were
  ;; dropped somewhere this is where it shows.
  (check-true "reduce: peak near 0.6" (< (abs (- (r 'peak) 0.6)) 0.01)
              )
  ;; Second quarter of a sine period: rising to the maximum.
  (check-true "reduce: max in second column near 0.6"
              (> ((r 'maxs) 1) 0.55))
  ;; Fourth quarter: below the offset, i.e. NEGATIVE -- the case a
  ;; max-only reduction gets wrong.
  (check-true "reduce: min in fourth column negative"
              (< ((r 'mins) 3) -0.3))
  (check-true "reduce: rms below peak"
              (< ((r 'rms) 1) ((r 'maxs) 1)))
  (check "reduce: no clipping" 0 (r 'clipped)))

;; More columns than samples: every column must still get a number, and
;; none may be left at the initial 0.0 by accident.
(let ((r (sv-reduce-channel 0 0 0 8 16)))
  (check "reduce: 16 columns from 8 samples" 16 (r 'columns))
  (check-true "reduce: rms vector complete" (= 16 (length (r 'rms)))))

;; A range at the very end: Snd returns fewer samples than asked for.
(let ((r (sv-reduce-channel 0 0 (- *test-frames* 10) 100 4)))
  (check-true "reduce: clipped range does not raise" (float-vector? (r 'maxs))))

;; ---------------------------------------------------------- dispatch
;;
;; Frames are collected instead of printed, so the test can look at what
;; would go over the wire.

(define captured ())
(define original-emit sv-emit)
(set! sv-emit (lambda (obj) (set! captured (cons obj captured))))

(define (last-frame) (car captured))

(sv-request "1" 'status (inlet))
(check "dispatch: id"      "1" ((last-frame) 'id))
(check "dispatch: op"      "status" ((last-frame) 'op))
(check "dispatch: ok"      #t ((last-frame) 'ok))
(check-true "status: sees a Snd"  (((last-frame) 'value) 'snd))
(check "status: version" "Snd 26.5 (test stub)" (((last-frame) 'value) 'sndVersion))

(sv-request "2" 'eval (inlet 'code "(+ 1 2)"))
(check "eval: value"  "3" (((last-frame) 'value) 'value))
(check "eval: no output" "" (((last-frame) 'value) 'output))

(sv-request "3" 'eval (inlet 'code "(begin (display \"hi\") 7)"))
(check "eval: captured output" "hi" (((last-frame) 'value) 'output))
(check "eval: value beside output" "7" (((last-frame) 'value) 'value))

;; Multi-line code arrives as a string with \n and must evaluate as one
;; form.  This is the case that broke in clamps-vscode when strings were
;; built with JSON.stringify.
(sv-request "4" 'eval (inlet 'code "(let ((a 1)\n      (b 2))\n  (+ a b))"))
(check "eval: multi-line form" "3" (((last-frame) 'value) 'value))

;; An error must come back as a frame, not escape.  An escaping error
;; leaves the extension waiting forever -- a hang, not a message.
(sv-request "5" 'eval (inlet 'code "(this-is-not-defined 1)"))
(check "eval: error is a frame" #f ((last-frame) 'ok))
(check-true "eval: error has text" (> (length ((last-frame) 'error)) 0))

(sv-request "6" 'eval (inlet 'code "(+ 1"))
(check "eval: reader error is a frame" #f ((last-frame) 'ok))

(sv-request "7" 'no-such-op (inlet))
(check "dispatch: unknown op" #f ((last-frame) 'ok))
(check-true "dispatch: unknown op names itself"
            (string-position "no-such-op" ((last-frame) 'error)))

;; Missing parameters must fall back, not raise: the panels send partial
;; parameter sets while the user is still dragging.
(sv-request "8" 'waveform (inlet 'snd 0 'chn 0))
(check "waveform: default range is the whole channel"
       *test-frames* (((last-frame) 'value) 'dur))
(check "waveform: cursor comes along" 42 (((last-frame) 'value) 'cursor))
(check "waveform: marks come along" 1 (length (((last-frame) 'value) 'marks)))
(check-true "waveform: selection reported inactive"
            (not ((((last-frame) 'value) 'selection) 'active)))

(sv-request "9" 'waveform (inlet 'snd 0 'chn 0 'start 100 'dur 200 'columns 50))
(check "waveform: start honoured" 100 (((last-frame) 'value) 'start))
(check "waveform: columns honoured" 50 (((last-frame) 'value) 'columns))

;; A range beyond the end must be clamped rather than read past the file.
(sv-request "10" 'waveform (inlet 'snd 0 'chn 0 'start 900 'dur 10000))
(check "waveform: range clamped to the channel"
       100 (((last-frame) 'value) 'dur))

(sv-request "11" 'sounds (inlet))
(check "sounds: one sound" 1 (length ((last-frame) 'value)))
(check "sounds: reports which is selected" #t ((car ((last-frame) 'value)) 'selected))
(check "sounds: reports an empty sound as empty" #f ((car ((last-frame) 'value)) 'empty))
(check "sounds: short name" "test.snd" ((car ((last-frame) 'value)) 'shortName))

;; READ-ONLY, which is the one property whose absence misleads rather than
;; merely limits: a read-only sound looks editable, the edit takes, and the
;; refusal arrives at save time. The stand-in's read-only answers #t, so this
;; also pins that a true answer survives as a BOOLEAN rather than as whatever
;; Snd's C returns.
(check-true "sounds: reports a read-only sound as read-only"
            (eq? #t ((car ((last-frame) 'value)) 'readOnly)))
(set! *read-only-flag* #f)
(sv-request "11b" 'sounds (inlet))
(check "sounds: and a writable one as writable" #f
       ((car ((last-frame) 'value)) 'readOnly))
(set! *read-only-flag* #t)
(sv-request "11c" 'sounds (inlet))
;; An INTEGER on the wire. As the printed object it would come back in the
;; next request as the string "#<sound 0>" and be rejected by Snd.
(check "sounds: index is an integer" 0 ((car ((last-frame) 'value)) 'index))
(check-true "sounds: index is not the printed object"
            (integer? ((car ((last-frame) 'value)) 'index)))

(sv-request "11b" 'marks (inlet 'snd 0 'chn 0))
(check "marks: one mark" 1 (length ((last-frame) 'value)))
(check "marks: sample" 100 ((car ((last-frame) 'value)) 'sample))
(check "marks: name" "start" ((car ((last-frame) 'value)) 'name))

(sv-request "12" 'help (inlet 'name "open-sound"))
(check "help: text from snd-help" "help for open-sound"
       (((last-frame) 'value) 'help))
(check "help: bound" #t (((last-frame) 'value) 'bound))

(sv-request "13" 'completions (inlet 'prefix "sv-json"))
(check-true "completions: finds our own definitions"
            (> (length ((last-frame) 'value)) 2))
(check-true "completions: all match the prefix"
            (let loop ((entries ((last-frame) 'value)))
              (or (null? entries)
                  (and (string-position "sv-json" ((car entries) 'name))
                       (loop (cdr entries))))))

;; An op that needs a function this build does not have must say so
;; instead of dying.  The GUI ops are exactly this case in a nogui build.
(sv-request "14" 'spectrum (inlet 'snd 0 'chn 0))
(check "spectrum: ok" #t ((last-frame) 'ok))
(check "spectrum: available" #t (((last-frame) 'value) 'available))
(check "spectrum: size is a power of two" 4096 (((last-frame) 'value) 'size))

;; An op needing a function this build does not have must say so instead of
;; dying -- the case every GUI-only function is in, in a nogui build.
(sv-request "14b" 'envelope (inlet))
(check "unavailable: an absent function is reported, not fatal" #t
       ((last-frame) 'ok))
(let ((saved snd-spectrum))
  (set! snd-spectrum 42)
  (sv-request "14c" 'spectrum (inlet 'snd 0 'chn 0))
  (check "unavailable: a non-procedure is reported" #f ((last-frame) 'ok))
  (check-true "unavailable: names what is missing"
              (string-position "snd-spectrum" ((last-frame) 'error)))
  (set! snd-spectrum saved))

(sv-request "14d" 'wavogram (inlet 'snd 0 'chn 0 'traces 5 'points 32))
(let ((w ((last-frame) 'value)))
  (check "wavogram: trace length comes from Snd" 64 (w 'traceLength))
  (check "wavogram: requested trace count" 5 (length (w 'traces)))
  (check "wavogram: each trace is reduced for the wire" 32
         (length (car (w 'traces)))))

(sv-request "14e" 'setwavogram (inlet 'snd 0 'chn 0 'trace 100 'hop 7))
(check "wavogram: trace setting reaches Snd" 100 (wavo-trace 0 0))
(check "wavogram: hop setting reaches Snd" 7 (wavo-hop 0 0))
(check "wavogram: Snd's own graph switches too" graph-as-wavogram
       (time-graph-type 0 0))

(sv-request "14f" 'headerinfo (inlet 'snd 0))
(let ((h ((last-frame) 'value)))
  (check "header: current type" mus-next (h 'headerType))
  (check "header: sample type choices come from constants" #t
         (> (length (h 'sampleTypes)) 4))
  (check "header: comment" "test comment" (h 'comment)))

(sv-request "14g" 'editheader
            (inlet 'snd 0 'headerType mus-riff 'sampleType mus-lfloat
                   'srate 48000 'channels 1 'dataLocation 44 'dataSize 1234
                   'setLocation #t 'setSize #t 'comment "changed"))
(check "header: type set through accessor" mus-riff (header-type 0))
(check "header: sample type set through accessor" mus-lfloat (sample-type 0))
(check "header: rate set" 48000 (srate 0))
(check "header: channels set" 1 (channels 0))
(check "header: explicit location set" 44 (data-location 0))
(check "header: explicit size set" 1234 (data-size 0))
(check "header: comment staged" "changed" (comment 0))
(check "header: dirty sound reports staged comment" #t
       (((last-frame) 'value) 'commentPending))
;; The rest of this file exercises the original two-channel, 44.1 kHz fixture.
;; Restore it so this focused mutation cannot change unrelated expectations.
(set! (header-type 0) mus-next)
(set! (sample-type 0) mus-lshort)
(set! (srate 0) 44100)
(set! (channels 0) 2)
(set! (data-location 0) 28)
(set! (data-size 0) 4000)
(set! (comment 0) "test comment")

(sv-request "14h" 'savestate (inlet 'file "/tmp/session.scm"))
(check "save-state: calls Snd" "/tmp/session.scm" *saved-state-file*)

;; A whole request as it arrives on the wire: one balanced line.
(set! captured ())
(sv-handle-line "(sv \"20\" 'eval (inlet 'code \"(* 6 7)\"))")
(check "line protocol: evaluated" "42" (((last-frame) 'value) 'value))

;; Junk on the line must produce a frame, not silence.
(sv-handle-line "(sv \"21\"")
(check "line protocol: broken line reported" "protocol-error" ((last-frame) 'event))


;; --- the dialogs ---------------------------------------------------

(sv-request "30" 'getvars (inlet 'names "fft-window transform-size no-such-variable"))
(let ((values ((last-frame) 'value)))
  (check "getvars: three answers" 3 (length values))
  (check "getvars: fft-window" 2 ((car values) 'value))
  (check "getvars: transform-size" 512 ((cadr values) 'value))
  ;; A variable this build does not have must come back as unavailable,
  ;; not fail the whole request: a panel with forty fields would then
  ;; show nothing because of one field.
  (check "getvars: unknown reported, not fatal" #f ((caddr values) 'available))
  (check "getvars: request still ok" #t ((last-frame) 'ok)))

;; A transform OBJECT has to arrive as the integer the dialog shows.
(sv-request "31" 'getvars (inlet 'names "transform-type"))
(check "getvars: transform encoded as integer" 0 ((car ((last-frame) 'value)) 'value))

(sv-request "32" 'setvar (inlet 'name "transform-size" 'value "1024"))
(check "setvar: written" 1024 (transform-size))
(check "setvar: reports the value read back" 1024 (((last-frame) 'value) 'value))

;; The accessor must still BE an accessor afterwards. (set! f v) instead
;; of (set! (f) v) would have replaced it with the number, and every
;; later read would fail -- silently, with the panel showing what it
;; believes it set.
(check-true "setvar: accessor survives" (procedure? transform-size))

(sv-request "33" 'setvar (inlet 'name "transform-type" 'value "3" 'via "transform"))
(check "setvar: via transform" 3 (transform->integer (transform-type)))

(sv-request "34" 'setvar (inlet 'name "transform-normalization" 'value "#f"))
(check "setvar: boolean" #f (transform-normalization))

(sv-request "35" 'setvar (inlet 'name "no-such-variable" 'value "1"))
(check "setvar: unknown variable is an error frame" #f ((last-frame) 'ok))

(sv-request "35b" 'constants 
             (inlet 'names "fourier-transform blackman2-window not-a-constant"))
(let ((values ((last-frame) 'value)))
  (check "constants: resolved from the build" 0 ((car values) 'value))
  (check "constants: second" 2 ((cadr values) 'value))
  (check "constants: unknown flagged" #f ((caddr values) 'available)))

(sv-request "36" 'applycontrols (inlet 'snd 0))
(check "applycontrols: ok" #t ((last-frame) 'ok))



;; --- the Edit menu -------------------------------------------------

;; Without a selection, delete must refuse. Several of Snd's selection
;; functions fall back to the whole channel, and from a button press that
;; is indistinguishable from a misclick that just deleted the file.
(set! *has-selection* #f)
(sv-request "40" 'edit (inlet 'action "delete"))
(check "edit: refuses without a selection" #f ((last-frame) 'ok))
(check-true "edit: says why" (string-position "selection" ((last-frame) 'error)))
(check "edit: nothing happened" () *edits*)

(sv-request "41" 'edit (inlet 'action "select-all"))
(check "edit: select-all needs no selection" #t ((last-frame) 'ok))

(sv-request "42" 'edit (inlet 'action "delete"))
(check "edit: deletes with a selection" #t ((last-frame) 'ok))
(check "edit: called Snd's own function" (list 'delete) *edits*)

;; A whitelist, not a passthrough: a generic "run this edit function" op
;; would be eval with a different name, and then a panel button could
;; carry anything.
(sv-request "43" 'edit (inlet 'action "exit"))
(check "edit: unknown action refused" #f ((last-frame) 'ok))
(sv-request "44" 'edit (inlet 'action "(delete-selection)"))
(check "edit: no code through the action name" #f ((last-frame) 'ok))

(set! *edits* ())
(sv-request "45" 'scale (inlet 'factor 0.5 'selection #t))
(check "scale: selection by a factor" (list (list 'scale 0.5)) *edits*)

(set! *edits* ())
(sv-request "46" 'scale (inlet 'factor 2.0))
(check "scale: whole channel" (list (list 'scale-chan 2.0)) *edits*)

(sv-request "47" 'scale (inlet))
(check "scale: needs a factor or a peak" #f ((last-frame) 'ok))

(set! *edits* ())
(sv-request "48" 'resample (inlet 'ratio 1.5 'selection #t))
(check "resample: selection" (list (list 'src 1.5)) *edits*)


;; --- hooks ---------------------------------------------------------

(sv-install-hooks)

;; A channel hook must NOT be handed to hook-functions. If it were, the
;; error would stop this FILE loading -- which is what took the serving loop
;; with it and let Snd fall through to repl.scm and the libc_s7 mess.
(check-true "hooks: after-edit-hook is not treated as a global hook"
            (not (sv-hook-of 'after-edit-hook)))
(check-true "hooks: after-open-hook is" (and (sv-hook-of 'after-open-hook) #t))

(check "hooks: global hooks got a handler" 1
       (length (hook-functions after-open-hook)))

;; The edit watch hangs on the channel, and only once the sound exists.
(set! captured ())
;; sv-install-hooks already watched the open sound, so this is the SECOND
;; call for the same channel and must add nothing.
(sv-watch-channel 0 0)
(check "hooks: channel hook has exactly one handler" 1
       (length (hook-functions (after-edit-hook 0 0))))
(check-true "hooks: the second watch was declined" (not (sv-watch-channel 0 0)))
((after-edit-hook 0 0) 0)
(check "hooks: firing the channel hook emits an event" "edited" ((last-frame) 'event))

;; A build without after-edit-hook must not take the load down with it.
(let ((saved after-edit-hook))
  (set! after-edit-hook 42)
    (check-true "hooks: a non-hook does not raise" (not (sv-watch-channel 5 0)))
  (check-true "hooks: and installs nothing" (not (sv-watched-channels "5.0")))
  (check-true "hooks: sv-hook? says no to a number" (not (sv-hook? 42)))
  (check-true "hooks: sv-hook? says yes to a hook" (and (sv-hook? after-open-hook) #t))
  (set! after-edit-hook saved))


;; --- several channels, one range -----------------------------------

(sv-request "50" 'waveforms (inlet 'snd 0 'columns 40))
(let ((v ((last-frame) 'value)))
  (check "waveforms: both channels" 2 (length (v 'channels)))
  (check "waveforms: shared start" 0 (v 'start))
  (check "waveforms: shared range is the longest channel" *test-frames* (v 'dur))
  (check "waveforms: channel numbers" (list 0 1)
         (map (lambda (c) (c 'chn)) (v 'channels)))
  ;; Coupled axes are the whole point: every lane must report the SAME
  ;; window, or the picture invents phase differences between channels.
  (check "waveforms: full coverage" (list 1 1)
         (map (lambda (c) (c 'coverage)) (v 'channels))))

;; A named subset, in the order asked for.
(sv-request "51" 'waveforms (inlet 'snd 0 'chns "1" 'columns 10))
(check "waveforms: subset" (list 1)
       (map (lambda (c) (c 'chn)) (((last-frame) 'value) 'channels)))

;; A channel shorter than the others must be drawn to its true width, not
;; stretched to fill the lane -- an edited channel is the normal case.
(set! *short-frames* 500)
(sv-request "52" 'waveforms (inlet 'snd 0 'columns 40))
(let ((v ((last-frame) 'value)))
  (check "waveforms: range still the longest channel" *test-frames* (v 'dur))
  (check "waveforms: short channel reports partial coverage" 1/2
         ((cadr (v 'channels)) 'coverage))
  (check-true "waveforms: short channel got fewer columns"
              (< ((cadr (v 'channels)) 'columns) ((car (v 'channels)) 'columns))))

;; A range entirely past a short channel: no data, and it must say so
;; instead of raising.
(sv-request "53" 'waveforms (inlet 'snd 0 'start 700 'dur 200 'columns 20))
(let ((v ((last-frame) 'value)))
  (check "waveforms: request ok past the short channel" #t ((last-frame) 'ok))
  (check "waveforms: empty channel has no coverage" 0
         ((cadr (v 'channels)) 'coverage))
  (check "waveforms: empty channel has no columns" 0
         ((cadr (v 'channels)) 'columns)))
(set! *short-frames* #f)


;; --- definitions have to survive the request ------------------------
;;
;; eval-string evaluates in the CURRENT environment, which inside the
;; handler is the handler. Without (rootlet), a define from the editor lands
;; in a closure that is thrown away when the request finishes: the
;; definition looks like it worked, and the next request says the name is
;; unbound. It read as if Snd had forgotten it.

(sv-request "60" 'eval (inlet 'code "(define (sv-test-fn x) (* x 3))"))
(check "eval: define reports ok" #t ((last-frame) 'ok))
(sv-request "61" 'eval (inlet 'code "(sv-test-fn 4)"))
(check "eval: the definition survived the request" "12"
       (((last-frame) 'value) 'value))

(sv-request "62" 'eval (inlet 'code "(define sv-test-var 7)"))
(sv-request "63" 'eval (inlet 'code "(+ sv-test-var 1)"))
(check "eval: a defined variable survives too" "8" (((last-frame) 'value) 'value))

;; And it must really be global, not merely reachable from the next eval.
(check "eval: the definition is in the global environment" 7
       (symbol->value 'sv-test-var (rootlet)))

;; A local in one request must not be visible in the next.
(sv-request "64" 'eval (inlet 'code "(let ((sv-hidden 1)) sv-hidden)"))
(sv-request "65" 'eval (inlet 'code "sv-hidden"))
(check "eval: a local does not leak into the next request" #f ((last-frame) 'ok))


;; --- sound objects versus sound indices -----------------------------

(check "snd: an object becomes its index" 0 (sv-snd-index (make-sound-object 0)))
(check "snd: an integer stays itself" 3 (sv-snd-index 3))
;; The regression that made everything unclickable: sound? says #t for an
;; index, so a predicate-first ordering sent integers into sound->integer,
;; which rejects them.
(check-true "snd: an index is never passed to sound->integer"
            (integer? (sv-snd-index 0)))
(check "snd: zero survives" 0 (sv-snd-index 0))
(check "snd: an index is encoded as a number, not converted" "0"
       (sv-json->string (sv-var-encode 0)))
(check "snd: a sound object is never JSON-encoded as text" "0"
       (sv-json->string (sv-var-encode (make-sound-object 0))))

;; And on the way in: a string that should have been a number is repaired
;; rather than handed to Snd to be rejected.
(check "snd: a numeric string on the way in becomes a number" 2
       (sv-arg (inlet 'snd "2") 'snd 0))
(check "snd: an integer on the way in is untouched" 5
       (sv-arg (inlet 'snd 5) 'snd 0))


;; --- edits that take a position -------------------------------------
;;
;; "The Edit:Insert selection menu choice is essentially
;;  (insert-selection (cursor))" -- Snd's own reference. Called with no
;; arguments, beg is 0: the paste lands at the start of the file, silently,
;; wherever the cursor was. delete and reverse take nothing, which is why
;; this was invisible in the other buttons.

(select-all)
(set! *edits* ())
(set! cursor-value 4242)
(sv-request "70" 'edit (inlet 'action "insert" 'snd 0 'chn 0))
(check "edit: insert pastes at the cursor" (list (list 'insert 4242)) *edits*)

(set! *edits* ())
(sv-request "71" 'edit (inlet 'action "mix" 'snd 0 'chn 0))
(check "edit: mix mixes at the cursor" (list (list 'mix 4242)) *edits*)

(set! *edits* ())
(sv-request "72" 'edit (inlet 'action "reverse" 'snd 0 'chn 0))
(check "edit: reverse takes no position" (list 'reverse) *edits*)

;; save-selection takes KEYWORDS: a positional call writes the file
;; somewhere else, under Snd's default name.
(set! *edits* ())
(sv-request "73" 'saveselection (inlet 'file "/tmp/sel.wav"))
(check "saveselection: passes :file as a keyword"
       (list 'save :file "/tmp/sel.wav") (car *edits*))

;; --- the playhead ----------------------------------------------------

;; The play op itself: it must tell the playhead where playback BEGAN before
;; calling Snd, because play-hook can fire before the call returns and a
;; counter reset afterwards would throw away the first buffers.
;; The stub records EVERYTHING it was given, so that a positional call is
;; distinguishable from a keyword call. A stub taking (start snd chn) would
;; have accepted the wrong call happily -- which is how the first version
;; passed its tests and then told Snd to play at edit position 88200.
(define *played* #f)
(define (play . args) (set! *played* args) #f)
(define (stop-playing . args) 'stopped)
(sv-request "74" 'play (inlet 'snd 0 'chn 0 'start 500))
;; The SOUND is the first argument; the rest are keywords. Positionally,
;; (play start snd chn #f end) puts the end sample on :edit-position, and Snd
;; answers "no such edpos" -- a message about the edit history for a mistake
;; about argument names.
(check "play: the sound comes first" 0 (car *played*))
(check "play: the start is a keyword" #t (and (memq :start *played*) #t))
(check "play: the channel is a keyword" #t (and (memq :channel *played*) #t))
(check "play: nothing is passed as :edit-position" #f
       (and (memq :edit-position *played*) #t))
(check "play: the start value follows its keyword" 500
       (cadr (memq :start *played*)))
(check "play: the playhead origin is set before Snd is called" 500 sv-play-origin)
(check "play: the frame counter starts at zero" 0 sv-play-frames)

;; With an end sample -- what "play view" sends.
(sv-request "75" 'play (inlet 'snd 0 'chn 0 'start 100 'end 200))
(check "play: the end is a keyword too" 200 (cadr (memq :end *played*)))
(check "play: still no :edit-position" #f (and (memq :edit-position *played*) #t))
;; PLAY IS SYNCHRONOUS IN A BUILD WITH NO TOOLKIT LOOP, and the reply says so
;; rather than announcing a transport that is already over. The stand-in has no
;; main-widgets, so this is the nogui answer.
(check "play: a build with no loop plays synchronously" #t
       (((last-frame) 'value) 'synchronous))
(check "play: and does not claim to still be playing" #f
       (((last-frame) 'value) 'playing))

;; The other branch, forced: with main-widgets answering like a live toolkit,
;; play returns before the sound ends and the throttle interval is what the
;; panels need in order to place the playhead. It goes in the ROOTLET, because
;; sv-async-play? reaches the name through symbol->value from its own closure,
;; and a local define is invisible there -- the same reason the bridge looks
;; every Snd name up that way rather than closing over it.
(varlet (rootlet) 'main-widgets (lambda () (list 'shell)))
(sv-request "75b" 'play (inlet 'snd 0 'chn 0 'start 100))
(check "play: an asynchronous build reports the throttle interval"
       (sv-play-interval)
       (((last-frame) 'value) 'interval))
(check-true "play: and says it is playing"
            (((last-frame) 'value) 'playing))
(cutlet (rootlet) 'main-widgets)
(check-true "play: back to the nogui answer once the toolkit is gone"
            (not (sv-async-play?)))

;; ---- pause, and why the hook must not do it ------------------------------
;;
;; pausing is a Snd variable; the stand-in gives it the same set!-able shape
;; the real one has, so the op is exercised against the form it will meet.
(define *paused* #f)
(define (pausing) *paused*)
(define (set-pausing v) (set! *paused* v))
(varlet (rootlet) 'pausing pausing)
(set! (setter (symbol->value 'pausing)) set-pausing)

;; THE DEADLOCK, as a test.  Pausing the DAC in a build whose play blocks also
;; stops play-hook, and play-hook is the only thing reading stdin for the
;; duration -- so the resume can never arrive, play never returns, and Snd sits
;; at 100% CPU.  Observed, after a probe that "proved" pause worked: the probe
;; scheduled its own resume from inside the handler, so it never needed the way
;; back in.  Measuring the setting is not measuring the round trip.
(sv-request "76" 'pause (inlet 'on #t))
(check "pause: refused where play blocks" #f (((last-frame) 'value) 'paused))
(check "pause: and says it is unavailable" #f (((last-frame) 'value) 'available))
(check-true "pause: with a reason"
            (string? (((last-frame) 'value) 'reason)))
(check "pause: the variable was not touched" #f *paused*)

;; The other build, where something keeps running.
(varlet (rootlet) 'main-widgets (lambda () (list 'shell)))
(sv-request "77" 'pause (inlet 'on #t))
(check-true "pause: on where a loop exists" (((last-frame) 'value) 'paused))
(check-true "pause: and the variable followed" *paused*)
(sv-request "78" 'pause (inlet))
(check "pause: no argument toggles" #f (((last-frame) 'value) 'paused))
(sv-request "79" 'pause (inlet))
(check-true "pause: and toggles back" (((last-frame) 'value) 'paused))
(sv-request "79b" 'pause (inlet 'on #f))
(cutlet (rootlet) 'main-widgets)

;; THE HOOK SERVICE recognises stop and nothing else, by name, without running
;; the reader on the audio path.  Stop is safe because it ENDS the block, so
;; sv-serve is reading again a moment later.  Pause is not, and must fall
;; through to the queue like any other request.
(check "transport: a stop is recognised" 'stop
       (sv-transport-op "(sv \"1\" 'stop (inlet))"))
(check "transport: a pause is NOT handled in the hook" #f
       (sv-transport-op "(sv \"1\" 'pause (inlet))"))
(check "transport: nor is anything else" #f
       (sv-transport-op "(sv \"1\" 'scale (inlet 'scale 0.5))"))

;; A line the hook read and did not act on must be QUEUED, never dropped: the
;; extension is waiting on a reply for it.
(set! sv-pending-lines ())
(sv-queue-line "first")
(sv-queue-line "second")
(check "transport: the queue keeps the order it was sent in" "first"
       (sv-take-pending))
(check "transport: then the next" "second" (sv-take-pending))
(check "transport: and then nothing" #f (sv-take-pending))

(set! captured ())
;; sv-install-hooks already did this. A second install must add nothing:
;; Snd calls every handler, so two handlers count every DAC buffer twice and
;; the playhead runs at double speed -- which looks like a sample-rate
;; mistake rather than a duplicate handler.
(check-true "playhead: the second install is declined" (not (sv-install-play-hooks)))
(check "playhead: exactly one handler on play-hook" 1 (length (hook-functions play-hook)))
(sv-play-began 0 0 1000)

;; dac-size defaults to 256 frames: at 44100 that is 172 hook calls per
;; second. Emitting per buffer would put 172 JSON frames per second on the
;; audio path -- and Snd's own note on cursor-update-interval is that too
;; small a value causes audible clicks. So: throttled to that interval.
(do ((i 0 (+ i 1))) ((= i 4)) (play-hook 256))
(check "playhead: nothing emitted below the interval" 0 (length captured))

(do ((i 0 (+ i 1))) ((= i 6)) (play-hook 256))
(check-true "playhead: one event once the interval is passed" (= 1 (length captured)))
(check "playhead: it is a playing event" "playing" ((last-frame) 'event))
;; Position counted from where playback began, not from zero.
;; The event comes on the buffer that CROSSES the interval, not after a
;; round number of buffers: 44100 * 0.05 = 2205 frames, and 9 buffers of 256
;; is 2304. Computed here rather than written down, so the expectation
;; explains itself instead of looking like a magic number.
(define expected-first
  (let ((interval (sv-play-interval)))
    (* 256 (ceiling (/ interval 256)))))
(check "playhead: position includes the origin" (+ 1000 expected-first)
       ((last-frame) 'frame))

(set! captured ())
(stop-playing-hook 0)
(check "playhead: the end is announced" "stopped" ((last-frame) 'event))

;; And the counter is reset, so the next playback does not continue the last.
(sv-play-began 0 0 0)
(set! captured ())
(do ((i 0 (+ i 1))) ((= i 10)) (play-hook 256))
(check "playhead: a new playback starts from its own origin" expected-first
       ((last-frame) 'frame))


;; --- making a selection ---------------------------------------------

(set! *selection-log* ())
(set! *sel-member* #f)
(sv-request "80" 'select (inlet 'snd 0 'chn 0 'start 1000 'frames 500))
(check "select: request ok" #t ((last-frame) 'ok))
;; All three, in Snd's own order. member? first, because otherwise the
;; channel belongs to no selection and there is nothing to move; position
;; before framples, because moving the start keeps the END fixed and
;; rewrites the length -- so the reverse order discards the length.
(check "select: sets member?, then position, then framples"
       (list (list 'member #t) (list 'position 1000) (list 'framples 500))
       (reverse *selection-log*))
(check "select: the selection really is 500 long" 500 (selection-framples))
(check "select: and starts where asked" 1000 (selection-position))
(check "select: reported back as active" #t (((last-frame) 'value) 'active))
(check "select: with the right extent" 500 (((last-frame) 'value) 'frames))

;; A zero-length drag means unselect, not a zero-length selection.
(sv-request "81" 'select (inlet 'snd 0 'chn 0 'start 1000 'frames 0))
(check "select: an empty drag unselects" #f (((last-frame) 'value) 'active))


;; --- base64 ---------------------------------------------------------
;;
;; Checked against the known encodings, because an encoder that is wrong by
;; one byte produces a sonogram that is subtly sheared -- which looks like a
;; windowing artefact, not like a bug.

(check "base64: empty" "" (sv-base64 (make-int-vector 0 0)))
(check "base64: one byte pads twice" "AA==" (sv-base64 (int-vector 0)))
(check "base64: two bytes pad once" "AAA=" (sv-base64 (int-vector 0 0)))
(check "base64: three bytes do not pad" "AAAA" (sv-base64 (int-vector 0 0 0)))
(check "base64: Man" "TWFu" (sv-base64 (int-vector 77 97 110)))
(check "base64: Ma" "TWE=" (sv-base64 (int-vector 77 97)))
(check "base64: M" "TQ==" (sv-base64 (int-vector 77)))
(check "base64: high bytes" "//8=" (sv-base64 (int-vector 255 255)))
(check "base64: length is 4 per 3 bytes" 8
       (length (sv-base64 (int-vector 1 2 3 4))))

;; --- sonogram -------------------------------------------------------

(sv-request "90" 'sonogram (inlet 'snd 0 'chn 0 'columns 4 'bins 8 'size 64))
(let ((v ((last-frame) 'value)))
  (check "sonogram: ok" #t ((last-frame) 'ok))
  (check "sonogram: columns" 4 (v 'columns))
  (check "sonogram: bins" 8 (v 'bins))
  ;; One byte per cell, base64: 32 cells -> 44 characters with padding.
  (check "sonogram: one byte per cell, base64 encoded"
         (* 4 (ceiling (/ 32 3))) (length (v 'cells)))
  ;; The floor is Snd's min-dB, not the loudest cell in view. Scaling to the
  ;; view would make the same passage look different at every zoom level.
    ;; -90, and it is a literal in snd-sig.c rather than min-dB. Bins below
  ;; snd-spectrum's `lowest` threshold get a flat -90; bins just above it are
  ;; computed and can be lower (measured against a real Snd: -105.14). Pinned
  ;; here so that a change in Snd shows up as a failing test rather than as a
  ;; sonogram that is subtly too dark.
  (check "sonogram: the floor is snd-spectrum's own -90" -90.0 (v 'floorDB)))

;; A power of two, whatever was asked for -- snd-spectrum requires it.
(sv-request "91" 'sonogram (inlet 'snd 0 'chn 0 'columns 2 'bins 8 'size 1000))
(check "sonogram: size rounded up to a power of two" 1024
       (((last-frame) 'value) 'size))

;; Near the end of the file the read window must not run past it.
(sv-request "92" 'sonogram (inlet 'snd 0 'chn 0 'start 900 'dur 100
                                  'columns 4 'bins 8 'size 256))
(check "sonogram: a range at the end does not raise" #t ((last-frame) 'ok))



;; --- the envelope editor, Bill's dialog -----------------------------

(sv-request "100" 'envelope (inlet 'snd 0 'chn 0))
(let ((v ((last-frame) 'value)))
  (check "envelope: reads Snd's own editor state" (list 0.0 1.0 1.0 0.0) (v 'envelope))
  (check "envelope: base" 1.0 (v 'base))
  ;; The three buttons of the dialog, by Bill's own labels.
  (check "envelope: target" "amp" (v 'target))
  (check "envelope: style" "linear" (v 'style))
  (check "envelope: the FIR order the flt button uses" 40 (v 'filterOrder))
  ;; The list on the left of his dialog. There is no Scheme-visible registry
  ;; -- all_envs lives in snd-env.c -- so it is the symbol table, filtered to
  ;; what an envelope actually is.
  (check-true "envelope: named envelopes are found"
              (let loop ((rest (v 'named)))
                (and (pair? rest)
                     (or (string=? ((car rest) 'name) "sv-test-ramp")
                         (loop (cdr rest)))))))

;; Breakpoints are READ as numbers, not evaluated.
(sv-request "101" 'applyenvelope (inlet 'points "(exit)" 'snd 0 'chn 0))
(check "applyenvelope: refuses anything that is not a number" #f ((last-frame) 'ok))
(sv-request "102" 'applyenvelope (inlet 'points "0 0 1" 'snd 0 'chn 0))
(check "applyenvelope: refuses an odd number of values" #f ((last-frame) 'ok))
(sv-request "103" 'applyenvelope (inlet 'points "0 1" 'snd 0 'chn 0))
(check "applyenvelope: refuses a single breakpoint" #f ((last-frame) 'ok))

;; amp x sound: env-sound env beg dur BASE s c e -- the base is the fourth
;; argument, not the second, and getting that wrong would silently apply a
;; linear envelope where an exponential one was asked for.
(set! *env-calls* ())
(sv-request "104" 'applyenvelope (inlet 'points "0 0 1 1" 'target "amp" 'scope "sound"
                                        'base 32.0 'snd 0 'chn 0))
(check "envelope: amp x sound is env-sound with the base fourth"
       (list 'env-sound (list 0.0 0.0 1.0 1.0) 0 *test-frames* 32.0 0 0)
       (car *env-calls*))

;; flt x sound: filter-sound env ORDER s c e
(set! *env-calls* ())
(sv-request "105" 'applyenvelope (inlet 'points "0 1 1 0" 'target "flt" 'scope "sound"
                                        'order 64 'snd 0 'chn 0))
(check "envelope: flt x sound is filter-sound with the order"
       (list 'filter-sound (list 0.0 1.0 1.0 0.0) 64 0 0)
       (car *env-calls*))

;; src x sound: src-sound num-or-env s c e -- no base, no order.
(set! *env-calls* ())
(sv-request "106" 'applyenvelope (inlet 'points "0 1 1 2" 'target "src" 'scope "sound"
                                        'snd 0 'chn 0))
(check "envelope: src x sound is src-sound"
       (list 'src-sound (list 0.0 1.0 1.0 2.0) 0 0)
       (car *env-calls*))

;; The selection scope, and its refusal.
(set! *has-selection* #f)
(set! *sel-member* #f)
(sv-request "107" 'applyenvelope (inlet 'points "0 0 1 1" 'scope "selection"))
(check "envelope: no selection is an error, not the whole sound" #f ((last-frame) 'ok))
(set! *has-selection* #t)
(set! *env-calls* ())
(sv-request "108" 'applyenvelope (inlet 'points "0 0 1 1" 'target "flt" 'scope "selection"
                                        'order 20))
(check "envelope: flt x selection" (list 'filter-selection (list 0.0 0.0 1.0 1.0) 20)
       (car *env-calls*))
(set! *has-selection* #f)

;; amp x mix is a mix's amplitude envelope.
(set! *env-calls* ())
(sv-request "109" 'applyenvelope (inlet 'points "0 1 1 0" 'target "amp" 'scope "mix" 'mix 0))
(check "envelope: amp x mix sets mix-amp-env"
       (list 'mix-amp-env (list 0.0 1.0 1.0 0.0)) (car *env-calls*))

;; The two empty cells of the matrix are empty in Snd too, and are refused by
;; name rather than falling back to the sound -- which would envelope the
;; whole file when one mix was asked for.
(set! *env-calls* ())
(sv-request "110" 'applyenvelope (inlet 'points "0 1 1 0" 'target "flt" 'scope "mix" 'mix 0))
(check "envelope: flt x mix is refused" #f ((last-frame) 'ok))
(check "envelope: and nothing happened instead" () *env-calls*)
(check-true "envelope: the refusal says why"
            (string-position "amplitude envelope only" ((last-frame) 'error)))

;; "define it": the curve gets a name and becomes usable anywhere.
(sv-request "111" 'defineenvelope (inlet 'name "sv-test-fade" 'points "0 1 1 0" 'base 2.0))
(check "defineenvelope: defined" (list 'sv-test-fade (list 0.0 1.0 1.0 0.0) 2.0)
       (car *defined-envelopes*))
(sv-request "112" 'defineenvelope (inlet 'name "(exit)" 'points "0 1 1 0"))
(check "defineenvelope: a name that is not a name is refused" #f ((last-frame) 'ok))
(sv-request "113" 'defineenvelope (inlet 'name "" 'points "0 1 1 0"))
(check "defineenvelope: an empty name is refused" #f ((last-frame) 'ok))

;; Storing without applying, so Snd's own editor opens on the same curve.
(sv-request "114" 'storeenvelope (inlet 'points "0 0 0.5 1 1 0" 'base 4.0))
(check "storeenvelope: into Snd's editor state" (list 0.0 0.0 0.5 1.0 1.0 0.0) *env*)
(check "storeenvelope: including the base" 4.0 *enved-base-value*)


;; --- regions, mixes, marks ------------------------------------------

(sv-request "120" 'regions (inlet))
(let ((v ((last-frame) 'value)))
  (check "regions: two" 2 (length v))
  ;; Integers on the wire. As objects they would come back as the string
  ;; "#<region 0>" and be rejected -- the sounds mistake, twice over.
  (check "regions: index is an integer" 0 ((car v) 'index))
  (check-true "regions: really an integer" (integer? ((car v) 'index)))
  (check "regions: length" 1000 ((car v) 'frames))
  ;; Without region-home a region list is numbers with no way back to the
  ;; sound it came from.
  (check-true "regions: home is reported" (> (length ((car v) 'home)) 0)))

(set! *region-log* ())
(sv-request "121" 'regionaction (inlet 'action "insert" 'region 1 'at 4000 'snd 0 'chn 0))
(check "regions: insert-region reg beg snd chn" (list 'insert 1 4000) (car *region-log*))

(set! *region-log* ())
(sv-request "122" 'regionaction (inlet 'action "save" 'region 0 'file "/tmp/r.wav"))
;; save-region reg :file ... -- keywords, like save-selection and play.
(check "regions: save-region passes :file as a keyword"
       (list 'save :file "/tmp/r.wav") (car *region-log*))

(sv-request "123" 'regionaction (inlet 'action "explode" 'region 0))
(check "regions: an unknown action is refused" #f ((last-frame) 'ok))

(sv-request "124" 'mixes (inlet 'snd 0 'chn 0))
(let ((v ((last-frame) 'value)))
  (check "mixes: one" 1 (length v))
  (check "mixes: index is an integer" 0 ((car v) 'index))
  (check "mixes: position" 2000 ((car v) 'position))
  (check "mixes: amp" 1.0 ((car v) 'amp)))

;; Moving a mix is an edit -- that is the difference between a mix and having
;; mixed something in destructively.
(sv-request "125" 'mixaction (inlet 'action "position" 'mix 0 'value 3500 'snd 0 'chn 0))
(check "mixes: moved" 3500 (mix-position (integer->mix 0)))
(sv-request "126" 'mixaction (inlet 'action "amp" 'mix 0 'value 0.25))
(check "mixes: amp set as a float" 0.25 (mix-amp (integer->mix 0)))

(set! *mark-log* ())
(sv-request "127" 'markaction (inlet 'action "add" 'sample 1234 'snd 0 'chn 0))
;; add-mark sample snd chn name sync -- no name means no name argument, not
;; an empty one, because an empty name is a name.
(check "marks: added without a name" (list 'add 1234 0 0) (car *mark-log*))
(set! *mark-log* ())
(sv-request "128" 'markaction (inlet 'action "add" 'sample 10 'text "start" 'snd 0 'chn 0))
(check "marks: added with a name" (list 'add 10 0 0 "start") (car *mark-log*))

;; --- the object/index rule, now for three kinds ----------------------

(check "objects: a region object becomes its index" 1
       (sv-region-index (make-region-object 1)))
(check "objects: a region index stays an integer" 3 (sv-region-index 3))
(check "objects: a mix object becomes its index" 2 (sv-mix-index (make-mix-object 2)))
(check "objects: a mix index stays an integer" 0 (sv-mix-index 0))
;; And on the way in, an integer becomes the object Snd wants.
(check-true "objects: an index becomes a region object"
            (pair? (sv-region 1)))
(check-true "objects: an index becomes a mix object" (pair? (sv-mix 1)))


;; --- the keyboard, as Snd has it ------------------------------------
;;
;; "Where an operation has an obvious analog in text editing, I've tried to
;; use the associated Emacs command." The chords are Bill's; the functions
;; they call are checked here so a rebinding cannot quietly point C-d at
;; something else.

(set! cursor-value 1000)
(sv-request "130" 'key (inlet 'action "start" 'snd 0 'chn 0))
(check "keys: C-a goes to sample 0" 0 (cursor))
(sv-request "131" 'key (inlet 'action "end" 'snd 0 'chn 0))
(check "keys: C-e goes to the last sample" (- *test-frames* 1) (cursor))

(set! cursor-value 500)
(sv-request "132" 'key (inlet 'action "forward" 'count 10 'snd 0 'chn 0))
(check "keys: C-f moves forward by samples" 510 (cursor))
;; "If the argument is a float, it is multiplied by the sampling rate before
;; being applied to the command, so C-u 2.1 C-f moves the cursor forward 2.1
;; seconds in the data."
(set! cursor-value 0)
(sv-request "133" 'key (inlet 'action "forward" 'count 0.01 'snd 0 'chn 0))
(check "keys: a float count is seconds" 441 (cursor))

;; "C-n move cursor ahead one 'line'" and "C-k delete a 'line' -- 128
;; samples": the same number in both bindings, so a line is 128 samples.
(set! cursor-value 0)
(sv-request "134" 'key (inlet 'action "down" 'snd 0 'chn 0))
(check "keys: C-n moves one line of 128 samples" 128 (cursor))

(set! cursor-value 200)
(set! *key-log* ())
(sv-request "135" 'key (inlet 'action "delete-sample" 'snd 0 'chn 0))
(check "keys: C-d deletes at the cursor" (list 'delete-samples 200 1) (car *key-log*))

(set! *key-log* ())
(sv-request "136" 'key (inlet 'action "delete-previous" 'snd 0 'chn 0))
;; C-h deletes BEFORE the cursor and then the cursor follows the data back.
(check "keys: C-h deletes the previous sample" (list 'delete-samples 199 1)
       (car *key-log*))
(check "keys: and the cursor moves with it" 199 (cursor))

(set! *key-log* ())
(sv-request "137" 'key (inlet 'action "delete-line" 'snd 0 'chn 0))
(check "keys: C-k deletes 128 samples" (list 'delete-samples 199 128) (car *key-log*))

(set! *key-log* ())
(sv-request "138" 'key (inlet 'action "insert-zero" 'count 3 'snd 0 'chn 0))
(check "keys: C-o inserts silence" (list 'insert-silence 199 3) (car *key-log*))

(set! *key-log* ())
(sv-request "139" 'key (inlet 'action "zero-sample" 'snd 0 'chn 0))
(check "keys: C-z zeroes the sample at the cursor" (list 'sample 199 0.0)
       (car *key-log*))

(sv-request "140" 'key (inlet 'action "rm -rf" 'snd 0 'chn 0))
(check "keys: an unknown action is refused" #f ((last-frame) 'ok))

;; C-j goes to the NEXT mark, not the first one.
(set! cursor-value 0)
(sv-request "141" 'key (inlet 'action "next-mark" 'snd 0 'chn 0))
(check "keys: C-j jumps to the next mark" 100 (cursor))
(set! cursor-value 500)
(sv-request "142" 'key (inlet 'action "next-mark" 'snd 0 'chn 0))
(check "keys: and stays put when there is none ahead" 500 (cursor))


;; --- Find -----------------------------------------------------------
;;
;; "The expression it asks for is a function that takes one argument, the
;; current sample value, and returns #t when it finds a match." A predicate,
;; not a text pattern -- and it may be a closure, which is what his own zero+
;; example is. That is why the expression is evaluated: any little query
;; language of mine would rule out exactly the searches worth having.

(set! cursor-value 0)
(sv-request "150" 'find (inlet 'expr "(lambda (y) (> y 0.5))" 'snd 0 'chn 0))
(let ((v ((last-frame) 'value)))
  (check "find: found something" #t (v 'found))
  (check-true "find: the value really matches" (> (v 'value) 0.5))
  ;; The cursor moves to the hit, as C-s does in Snd.
  (check "find: the cursor moved there" (v 'sample) (cursor)))

;; Snd's own search-procedure is set too, so C-s in a Motif window and Find
;; here look for the same thing.
(check-true "find: search-procedure is set" (procedure? (search-procedure)))

;; A search that matches nothing must say so rather than moving the cursor
;; somewhere arbitrary.
(set! cursor-value 0)
(sv-request "151" 'find (inlet 'expr "(lambda (y) (> y 99.0))" 'snd 0 'chn 0))
(check "find: nothing found is reported" #f (((last-frame) 'value) 'found))
(check "find: and the cursor stayed put" 0 (cursor))

;; An expression that is not a procedure is refused with the reason.
(sv-request "152" 'find (inlet 'expr "42" 'snd 0 'chn 0))
(check "find: a non-procedure is refused" #f ((last-frame) 'ok))
(check-true "find: and says what was expected"
            (string-position "procedure of one argument" ((last-frame) 'error)))

;; A predicate that raises must not take the whole request down silently.
(sv-request "153" 'find (inlet 'expr "(lambda (y) (vector-ref y 0))" 'snd 0 'chn 0))
(check "find: a failing predicate is an error frame" #f ((last-frame) 'ok))

;; A closure works -- his zero+ example is exactly this shape.
(set! cursor-value 0)
(sv-request "154" 'find
             (inlet 'expr "(let ((last 0.0)) (lambda (y) (let ((r (and (< last 0.0) (>= y 0.0)))) (set! last y) r)))"
                    'snd 0 'chn 0))
(check "find: a closure keeps state across samples" #t
       (((last-frame) 'value) 'found))

;; --- sync -----------------------------------------------------------

(sv-request "155" 'sync (inlet 'snd 0 'value 2))
(check "sync: set" 2 (sync))
;; sync-max gives a value known to be unused, so a new group does not collect
;; the existing ones by accident.
(sv-request "156" 'sync (inlet 'snd 0 'value "new"))
(check "sync: a new group is above sync-max" 4 (sync))
(sv-request "157" 'sync (inlet 'snd 0 'value 0))
(check "sync: 0 means on its own" 0 (sync))


;; --- macros count as available --------------------------------------
;;
;; procedure? is #f for a macro, and Snd defines define-envelope as one:
;;   Xen_eval_C_string("(define-macro (define-envelope a . b)
;;                        `(define-envelope-1 ',a ,@b))")
;; Asking procedure? about it reports "not available in this Snd build" for
;; something that works in the REPL two lines away.

(check-true "available: a macro counts as available" (sv-have? 'define-envelope))
(check-true "available: so does a procedure" (sv-have? 'define-envelope-1))
(check "available: an undefined name does not" #f (sv-have? 'no-such-snd-name))

;; And "define it" reaches the procedure, not the macro, so no form is built
;; and nothing is evaluated.
(set! *defined-envelopes* ())
(sv-request "160" 'defineenvelope (inlet 'name "sv-macro-test" 'points "0 1 1 0" 'base 3.0))
(check "defineenvelope: went through define-envelope-1"
       (list 'sv-macro-test (list 0.0 1.0 1.0 0.0) 3.0)
       (car *defined-envelopes*))
(check "defineenvelope: reported ok" #t ((last-frame) 'ok))


;; --- the hooks the editor watches -----------------------------------
;;
;; Snd's customization model is hooks, and a Snd user's ~/.snd is mostly hook
;; functions. Two rules follow, and both are testable:
;;   1. install ADDITIVELY -- never replace what is already on the hook
;;   2. never set (hook 'result) -- watching must not become deciding

;; EXACTLY ONE handler on stop-playing-hook, counted rather than assumed.
;; The play code installs one there to reset the playhead, and the observer
;; table used to add a second -- two handlers each emitting 'stopped. The
;; install-once flag did not catch it, because it guarded the table against
;; itself and knew nothing about the play code. Counting catches it.
(check "hooks: one handler on stop-playing-hook, not two"
       1 (length (hook-functions stop-playing-hook)))
(check-true "hooks: installed on mark-hook"
            (= 1 (length (hook-functions mark-hook))))

;; Twice must not install twice: Snd runs every handler, so a second one means
;; two events per occurrence.
(sv-observe-hooks)
(check "hooks: installing twice is a no-op" 1 (length (hook-functions mark-hook)))

;; A user function already on the hook survives, and still runs.
(define *user-ran* #f)
(set! (hook-functions stop-playing-hook)
      (cons (lambda (h) (set! *user-ran* #t)) (hook-functions stop-playing-hook)))
(set! captured ())
(stop-playing-hook 0)
(check-true "hooks: the user's own function still runs" *user-ran*)
(check "hooks: and the event was emitted" "stopped" ((last-frame) 'event))
;; Once, not twice.
;; Once, not twice: two handlers each emitting it would look identical from
;; the panel's side except for the doubled work.
(check "hooks: exactly one stopped event" 1
       (let loop ((rest captured) (n 0))
         (cond ((null? rest) n)
               ((and (let? (car rest))
                     (defined? 'event (car rest))
                     (equal? ((car rest) 'event) "stopped"))
                (loop (cdr rest) (+ n 1)))
               (else (loop (cdr rest) n)))))

;; The event carries the hook's own arguments, under Snd's names.
(set! captured ())
(mark-hook 7 0 1 2)
(let ((f (last-frame)))
  (check "hooks: mark event" "markchanged" (f 'event))
  (check "hooks: carries the mark id" 7 (f 'id))
  (check "hooks: and the reason" 2 (f 'reason)))

;; Snd's warnings become events rather than vanishing into a terminal.
(set! captured ())
(snd-warning-hook "watch out")
(check "hooks: warnings are forwarded" "watch out" ((last-frame) 'message))

;; NEVER 'result. Setting it would take over a decision belonging to the
;; user's hook functions -- cancelling an edit, refusing an exit, suppressing
;; a warning.
;; NEVER 'result. A hook's result is how the user's own functions cancel an
;; edit, refuse an exit or suppress a warning; an observer that sets it takes
;; that decision away silently. Checked by watching what the hook's own
;; environment holds after a run -- the observers must leave it #f.
(define (sv-test-result-after hook . args)
  (let ((seen 'nothing))
    (set! (hook-functions hook)
          (append (hook-functions hook)
                  (list (lambda (env) (set! seen (env 'result))))))
    (apply hook args)
    seen))
;; UNSPECIFIED, not #f: that is how s7 initialises a hook's result, and it is
;; the distinction that matters -- #f would be an answer ("do not cancel"),
;; unspecified is no answer at all, which is what an observer must leave
;; behind. A test expecting #f would pass just as well if an observer set it.
(check-true "hooks: result is left untouched"
            (eq? #<unspecified> (sv-test-result-after stop-playing-hook 0)))
(check-true "hooks: a warning's result is left untouched too"
            (eq? #<unspecified> (sv-test-result-after snd-warning-hook "careful")))

;; A hook argument the build does not carry must not take the handler down --
;; a handler that raises inside a hook takes the operation with it.
(set! captured ())
(mark-hook 3)
(check "hooks: a missing argument is #f, not an error" #f ((last-frame) 'snd))


;; --- user drawing code: graph-hook and lisp-graph-hook ---------------
;;
;; The extension point that decides whether these panels are the same editor
;; or a parallel one. display-bark-fft in dsp.scm, display-energy in examp.scm
;; and twenty years of private code all work by calling `graph`.

;; A user function of exactly the documented shape, from examp.scm:
;;   (hook-push lisp-graph-hook (lambda (hook) (display-energy (hook 'snd) (hook 'chn))))
(set! (hook-functions lisp-graph-hook)
      (list (lambda (h)
              (graph (float-vector 0.0 0.5 1.0 0.5 0.0) "energy" 0.0 1.0 0.0 1.0
                     (h 'snd) (h 'chn) #f))))

(sv-request "170" 'lispgraph (inlet 'snd 0 'chn 0))
(let ((v ((last-frame) 'value)))
  (check "lispgraph: the hook was seen" 1 (v 'installed))
  (check "lispgraph: one graph came back" 1 (length (v 'graphs)))
  (let ((g (car (v 'graphs))))
    (check "lispgraph: the label survives" "energy" (g 'label))
    (check "lispgraph: and the x range" 1.0 (g 'x1))
    (check "lispgraph: the data came through" (list 0.0 0.5 1.0 0.5 0.0)
           (car (g 'traces)))))

;; The original `graph` still runs: in a Motif build both editors then show it.
(check-true "lispgraph: Snd's own graph was still called" (pair? *graph-calls*))

;; A list of numbers is an ENVELOPE, not a trace -- "If 'data' is a list of
;; numbers, it is assumed to be an envelope (a list of breakpoints)". Keeping
;; it as breakpoints matters: resampling a curve that has none invents points.
(set! (hook-functions lisp-graph-hook)
      (list (lambda (h) (graph '(0 0 1 1 2 0) "env" 0.0 2.0))))
(sv-request "171" 'lispgraph (inlet 'snd 0 'chn 0))
(let ((g (car (((last-frame) 'value) 'graphs))))
  (check "lispgraph: an envelope is marked as one" #t (g 'envelope))
  (check "lispgraph: with its breakpoints intact" (list 0.0 0.0 1.0 1.0 2.0 0.0)
         (car (g 'traces))))

;; Several traces at once: "The 'data' argument can be a list of float-vectors".
(set! (hook-functions lisp-graph-hook)
      (list (lambda (h)
              (graph (list (float-vector 0.0 1.0) (float-vector 1.0 0.0)) "two"))))
(sv-request "172" 'lispgraph (inlet 'snd 0 'chn 0))
(check "lispgraph: two traces" 2 (length ((car (((last-frame) 'value) 'graphs)) 'traces)))

;; A user function that raises must be reported, not swallowed and not fatal.
(set! (hook-functions lisp-graph-hook)
      (list (lambda (h) (vector-ref h 99))))
(sv-request "173" 'lispgraph (inlet 'snd 0 'chn 0))
(check "lispgraph: still a successful frame" #t ((last-frame) 'ok))
(check-true "lispgraph: and the failure is named"
            (string? (((last-frame) 'value) 'failed)))
(set! (hook-functions lisp-graph-hook) ())

;; graph-hook's RESULT is read, because "If it returns #t, the display is not
;; updated" -- the panels stand in for Snd's redraw here. Not writing a result
;; is the observer rule; not reading this one would make the hook look
;; supported while being ignored.
(check "graph-hook: nothing installed means nothing suppressed" #f
       (sv-graph-hook-suppresses? 0 0 -1.0 1.0))
(set! (hook-functions graph-hook)
      (list (lambda (h) (set! (h 'result) #t))))
(check "graph-hook: a #t result suppresses the display" #t
       (sv-graph-hook-suppresses? 0 0 -1.0 1.0))
(set! (hook-functions graph-hook)
      (list (lambda (h) (set! (h 'result) #f))))
(check "graph-hook: any other result does not" #f
       (sv-graph-hook-suppresses? 0 0 -1.0 1.0))
;; A user function that only adjusts something -- Snd's own example sets
;; dot-size -- returns nothing and must not suppress anything.
(set! (hook-functions graph-hook) (list (lambda (h) 'adjusted)))
(check "graph-hook: a function that just adjusts does not suppress" #f
       (sv-graph-hook-suppresses? 0 0 -1.0 1.0))
(set! (hook-functions graph-hook) ())


;; --- the load path --------------------------------------------------

(let ((before (length *load-path*)))
  (sv-request "180" 'loadpath (inlet 'path "/tmp/sv-test-path"))
  (check "loadpath: added" (+ before 1) (length *load-path*))
  ;; Twice must not add twice: a path added on every session start would grow
  ;; *load-path* by one entry per restart, and a duplicate that shadows nothing
  ;; looks harmless for a hundred restarts.
  (sv-request "181" 'loadpath (inlet 'path "/tmp/sv-test-path"))
  (check "loadpath: not added twice" (+ before 1) (length *load-path*)))
;; Prepended, so Snd's own files win over anything already on the path with the
;; same name.
(check "loadpath: prepended" "/tmp/sv-test-path" (car *load-path*))
(sv-request "182" 'loadpath (inlet 'path ""))
(check "loadpath: an empty path changes nothing" "/tmp/sv-test-path"
       (car *load-path*))


;; --- Snd objects in events ------------------------------------------
;;
;; A hook argument is whatever Snd passes, and Snd passes OBJECTS:
;; after-open-hook a sound, mark-hook a mark, mix-release-hook a mix. Sent as
;; they are they encode as "#<sound 1>" -- a string where the panels expect a
;; number, so nothing follows a newly opened sound. The same mistake as
;; (sounds) returning objects, in the one path that had never needed the
;; lesson.

(check "wire: a sound object becomes its index" 1 (sv-wire (make-sound-object 1)))
(check "wire: a mark object becomes its index" 7 (sv-wire (make-mark-object 7)))
(check "wire: a mix object becomes its index" 2 (sv-wire (make-mix-object 2)))
(check "wire: a region object becomes its index" 1 (sv-wire (make-region-object 1)))
;; And an integer STAYS an integer: sound? and friends are validity
;; predicates, not type predicates -- each says #t for a valid index, so asking
;; them before integer? sends integers through sound->integer, which refuses
;; them.
(check "wire: an integer stays an integer" 3 (sv-wire 3))
(check "wire: a string stays a string" "x" (sv-wire "x"))
(check "wire: a boolean stays a boolean" #f (sv-wire #f))

;; Through a real hook, which is how it actually arrives.
(set! captured ())
(mark-hook (make-mark-object 4) 0 0 2)
(check "wire: the mark event carries an integer" 4 ((last-frame) 'id))
(check-true "wire: really an integer" (integer? ((last-frame) 'id)))

;; --- declarative VS Code UI -----------------------------------------
;;
;; The callback remains a closure in this s7.  The extension gets only an
;; opaque id and JSON-safe widget data, then sends the id back on activation.

(define *ui-clicks* 0)
(define ui-menu (add-to-main-menu "Effects"))
(define ui-item
  (add-to-menu ui-menu "Invert" (lambda () (set! *ui-clicks* (+ *ui-clicks* 1)))))
(check "ui: string labels are not printed with quotes" "Effects" (ui-menu 'label))
(check "ui: item has its menu as parent" (ui-menu 'id) (ui-item 'parent))

(sv-request "190" 'uiwidgets (inlet))
(check "ui: snapshot is successful" #t ((last-frame) 'ok))
(check "ui: snapshot contains both widgets" 2 (length ((last-frame) 'value)))

(sv-request "191" 'uiaction
            (inlet 'id (ui-item 'id) 'action "click" 'value #f))
(check "ui: callback runs in s7" 1 *ui-clicks*)
(check "ui: action returns the addressed widget" (ui-item 'id)
       (((last-frame) 'value) 'id))

(define *ui-slider-value* 0)
(define ui-dialog (vscode-ui-dialog "Gain"))
(define ui-slider
  (vscode-ui-slider ui-dialog "amount" 0 1 10
                    (lambda (value) (set! *ui-slider-value* value))))
(sv-request "192" 'uiaction
            (inlet 'id (ui-slider 'id) 'action "change" 'value 7))
(check "ui: change updates Snd-owned state" 7 (ui-slider 'value))
(check "ui: one-argument callback receives the value" 7 *ui-slider-value*)

(check "ui: dialog begins unmanaged" #f (ui-dialog 'managed))
(vscode-ui-action (ui-dialog 'id) "open" #f)
(check "ui: open manages the dialog" #t (ui-dialog 'managed))
(vscode-ui-action (ui-dialog 'id) "close" #f)
(check "ui: close unmanages the dialog" #f (ui-dialog 'managed))

(define ui-meter (make-variable-display "instrument" "amplitude" 'meter '(0 2)))
(variable-display 1.25 ui-meter)
(check "ui: variable-display keeps its value in Snd" 1.25 (ui-meter 'value))
(check "ui: variable-display has an instrument parent" "instrument"
       ((sv-ui-widgets (ui-meter 'parent)) 'label))


;; ---- the parity overlay's ops ---------------------------------------------
;;
;; What these are for is argument ORDER and the error paths, not return values.
;; Two of the overlay's own comments record a positional order that was wrong
;; and did something else without complaining; these pin both.

(sv-request "p1" 'saveas (inlet 'file "/tmp/x.snd" 'snd 0 'srate 44100
                                'sampleType "mus-lshort" 'headerType "mus-riff"))
(check "overlay: saveas answers with the file" "/tmp/x.snd"
       (((last-frame) 'value) 'file))
(check "overlay: saveas passes the file first, then keywords" "/tmp/x.snd"
       (car (last-call 'save-sound-as)))
(check-true "overlay: saveas uses keywords, not positions"
            (and (memq :sound (last-call 'save-sound-as))
                 (memq :srate (last-call 'save-sound-as))
                 (memq :sample-type (last-call 'save-sound-as))
                 #t))
(check-true "overlay: saveas turns a sample-type string into a symbol"
            (symbol? (list-ref (last-call 'save-sound-as)
                               (+ 1 (- (length (last-call 'save-sound-as))
                                       (length (memq :sample-type (last-call 'save-sound-as))))))))
(sv-request "p2" 'saveas (inlet 'snd 0))
(check "overlay: saveas without a file is an error frame" #f ((last-frame) 'ok))

(sv-request "p3" 'updatesound (inlet 'snd 0))
(check-true "overlay: updatesound reports success" (((last-frame) 'value) 'updated))

(sv-request "p4" 'soundaccess (inlet 'snd 0))
(check-true "overlay: soundaccess reports read-only"
            (((last-frame) 'value) 'readOnly))
(check "overlay: and auto-update" #f (((last-frame) 'value) 'autoUpdate))

(sv-request "p5" 'saveedithistory (inlet 'file "/tmp/h.scm" 'snd 0 'chn 0))
(check "overlay: saveedithistory answers with the file" "/tmp/h.scm"
       (((last-frame) 'value) 'file))
(check "overlay: save-edit-history takes the file first" "/tmp/h.scm"
       (car (last-call 'save-edit-history)))
(sv-request "p6" 'saveedithistory (inlet 'snd 0))
(check "overlay: saveedithistory without a file is an error frame" #f
       ((last-frame) 'ok))

(sv-request "p7" 'editdetails (inlet 'snd 0 'chn 0 'position 1))
(check-true "overlay: editdetails sends the fragment as TEXT, never as data"
            (string? (((last-frame) 'value) 'fragment)))

;; SAVE-MARKS TAKES THE SOUND FIRST.  g_save_marks(snd, filename): a swapped
;; order here wrote nothing and reported success, and save-marks is a plain
;; typed procedure, so there are no keywords to catch it.
(sv-request "p8" 'paritymark (inlet 'action "save" 'snd 3 'file "/tmp/m.marks"))
(check "overlay: mark save passes the sound first" 3 (car (last-call 'save-marks)))
(check "overlay: and the file second" "/tmp/m.marks" (cadr (last-call 'save-marks)))

(sv-request "p9" 'paritymark (inlet 'action "find" 'needle 100 'snd 0 'chn 0))
(check-true "overlay: mark find reports a hit" (((last-frame) 'value) 'found))
(check-true "overlay: and sends the mark as an index, not an object"
            (integer? (((last-frame) 'value) 'mark)))

(sv-request "p10" 'paritymark (inlet 'action "sync" 'mark 42 'sync 2))
(check "overlay: mark sync sets the sync value" 2 (((last-frame) 'value) 'sync))
(sv-request "p11" 'paritymark (inlet 'action "sync"))
(check "overlay: mark sync without a mark is an error frame" #f ((last-frame) 'ok))

(sv-request "p12" 'paritymark (inlet 'action "properties" 'mark 42))
(check-true "overlay: mark properties travel as printed data, not code"
            (string? (((last-frame) 'value) 'properties)))
(sv-request "p13" 'paritymark (inlet 'action "wobble"))
(check "overlay: an unknown mark action is an error frame" #f ((last-frame) 'ok))

(sv-request "p14" 'transformdata (inlet 'snd 0 'chn 0 'slice 0))
(check "overlay: transformdata reports what Snd has" 4
       (((last-frame) 'value) 'framples))
(check "overlay: and returns that many values" 4
       (length (((last-frame) 'value) 'values)))
(sv-request "p15" 'transformdata (inlet 'snd 0 'chn 0 'count 2))
(check "overlay: count clamps to what is available" 2
       (length (((last-frame) 'value) 'values)))
(sv-request "p16" 'transformdata (inlet 'snd 0 'chn 0 'count 99))
(check "overlay: and a count past the end does not run off it" 4
       (length (((last-frame) 'value) 'values)))

;; SWAP-CHANNELS TAKES FOUR ARGUMENTS.  Passing 'other alone as chn0 ignored
;; the channel from context and swapped a different pair than was asked for.
(sv-request "p17" 'parityedit (inlet 'action "swap-channels" 'snd 1 'chn 0 'other 1))
(check "overlay: swap-channels is given all four positions" 4
       (length (last-call 'swap-channels)))
(check "overlay: the current channel is one side of the swap" (list 1 0 1 1)
       (last-call 'swap-channels))

(sv-request "p18" 'parityedit (inlet 'action "reverse-channel" 'snd 0 'chn 0))
(check-true "overlay: parityedit answers with an edit position"
            (integer? (((last-frame) 'value) 'editPosition)))
(sv-request "p19" 'parityedit (inlet 'action "scale-to" 'peak 0.5 'snd 0))
(check "overlay: scale-to is given the peak first" 0.5 (car (last-call 'scale-to)))

;; THE WHITELIST IS THE POINT: a caller must not be able to name any Snd
;; symbol and have the bridge call it.
(sv-request "p20" 'parityedit (inlet 'action "delete-sound"))
(check "overlay: an edit outside the whitelist is an error frame" #f
       ((last-frame) 'ok))

(sv-request "p21" 'paritycapabilities (inlet))
(check-true "overlay: capabilities are a list"
            (pair? ((last-frame) 'value)))
(check-true "overlay: each names a Snd function and whether it is there"
            (let ((first (car ((last-frame) 'value))))
              (and (string? (first 'name))
                   (boolean? (first 'available)))))
(check-true "overlay: a function the build has is reported present"
            (let loop ((rest ((last-frame) 'value)))
              (cond ((null? rest) #f)
                    ((string=? ((car rest) 'name) "save-marks") ((car rest) 'available))
                    (else (loop (cdr rest))))))
(check "overlay: one it does not have is reported absent" #f
       (let loop ((rest ((last-frame) 'value)))
         (cond ((null? rest) #f)
               ((string=? ((car rest) 'name) "add-transform") ((car rest) 'available))
               (else (loop (cdr rest))))))


(set! sv-emit original-emit)

(format *stdout* "~%~D checks, ~D failures~%" checks failures)
(if (> failures 0) (exit 1) (exit 0))
