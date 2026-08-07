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
(define (cursor . args) cursor-value)
(define (marks . args) (list 7))
(define (mark-sample m) 100)
(define (mark-name m) "start")
(define (mark-sync m) 0)
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

(define (snd-spectrum data window len . rest)
  ;; The real signature: data window length (linear #t) (beta 0.0) in-place
  ;; (normalized #t). In dB the values are <= 0 with min-dB as the floor.
  (let ((linear (and (pair? rest) (car rest)))
        (out (make-float-vector len 0.0)))
    (do ((i 0 (+ i 1))) ((= i len) out)
      (set! (out i) (if linear (if (< i 4) 1.0 0.0) (if (< i 4) 0.0 -90.0))))))
(define (min-dB) -60.0)
(define (snd-help sym) (string-append "help for " (symbol->string sym)))
(define (snd-version) "Snd 26.5 (test stub)")
(define (default-output-srate) 44100)

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
(define (src-selection r) (set! *edits* (cons (list 'src r) *edits*)) 1)
(define fourier-transform 0)
(define blackman2-window 2)
(define *env* (list 0.0 1.0 1.0 0.0))
(define enved-envelope (dilambda (lambda () *env*) (lambda (v) (set! *env* v))))
(define (env-channel e beg dur snd chn) (set! *env* e) 1)


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

(load "scheme/snd-vscode.scm")

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

(sv-request "37" 'setenvelope (inlet 'points "0.0 0.0 1.0 1.0" 'snd 0 'chn 0))
(check "setenvelope: written through env-channel" (list 0.0 0.0 1.0 1.0) *env*)

(sv-request "38" 'envelope (inlet))
(check "envelope: read back" (list 0.0 0.0 1.0 1.0) (((last-frame) 'value) 'envelope))


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
(check "play: reports the throttle interval it will use" (sv-play-interval)
       (((last-frame) 'value) 'interval))

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
  (check "sonogram: the floor comes from min-dB" -60.0 (v 'floorDB)))

;; A power of two, whatever was asked for -- snd-spectrum requires it.
(sv-request "91" 'sonogram (inlet 'snd 0 'chn 0 'columns 2 'bins 8 'size 1000))
(check "sonogram: size rounded up to a power of two" 1024
       (((last-frame) 'value) 'size))

;; Near the end of the file the read window must not run past it.
(sv-request "92" 'sonogram (inlet 'snd 0 'chn 0 'start 900 'dur 100
                                  'columns 4 'bins 8 'size 256))
(check "sonogram: a range at the end does not raise" #t ((last-frame) 'ok))

(set! sv-emit original-emit)

(format *stdout* "~%~D checks, ~D failures~%" checks failures)
(if (> failures 0) (exit 1) (exit 0))
