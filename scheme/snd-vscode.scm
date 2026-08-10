;;; snd-vscode.scm -- the Snd side of snd-vscode
;;;
;;; Loaded into Snd's s7 with  snd -l scheme/snd-vscode.scm.
;;; Speaks a line protocol with the VS Code extension.
;;;
;;; THREE DECISIONS THAT LOOK LIKE DETAILS AND ARE NOT
;;;
;;; 1. FRAMES GO TO stderr, HUMAN OUTPUT TO stdout.
;;;    In the Motif build the listener widget swallows stdout: everything
;;;    Snd prints in reaction to a stdin expression lands in the listener
;;;    window, not in our pipe.  A protocol on stdout would therefore work
;;;    headless and silently break as soon as the GUI is up.  stderr is
;;;    untouched by the listener in both builds, so the same code serves
;;;    nogui and Motif.  The pleasant side effect: a human can watch
;;;    stdout without our JSON scrolling past.
;;;
;;; 2. WE DO NOT USE Snd's OWN REPL.
;;;    snd-nogui.c offers two: repl.scm (line editing, ANSI cursor
;;;    control -- unparsable) and the fallback DUMB_REPL, which reads with
;;;    fgets into  char buffer[512]  and wraps the line in (write ...).
;;;    512 bytes is not a limit one can design a protocol around; a
;;;    waveform request with a dozen parameters is already close.  So in
;;;    the headless case we take stdin ourselves (sv-serve) and read with
;;;    read-line, which has no limit.  In the Motif case we must NOT do
;;;    that -- a blocking read would freeze the X event loop -- and there
;;;    we let Snd's own XtAppAddInput stdin callback (snd-motif.c, the
;;;    path its comment calls "the emacs subjob connection") do the
;;;    reading.  Same request text, two ways in, one way out.
;;;
;;; 3. EVERY REQUEST IS ONE BALANCED LINE.
;;;    Because in the Motif case Snd itself reads the line and hands it to
;;;    stdin_check_for_full_expression, which accumulates until the parens
;;;    balance.  Code to be evaluated therefore travels as a STRING with
;;;    \n escapes, never as raw multi-line text -- otherwise a half
;;;    expression sits in Snd's accumulator and the next request completes
;;;    it into nonsense.
;;;
;;; The file must load in plain s7 without Snd (see test-bridge.scm).
;;; Every call into Snd is therefore guarded by sv-have?; a missing
;;; function is reported as such instead of aborting the load.

(provide 'snd-vscode.scm)

(define sv-protocol-version 1)

;; ------------------------------------------------------------------
;; JSON output
;;
;; json.scm ships with Snd, but its s7->json knows only numbers,
;; strings, vectors and lets -- no #f, no (), no symbols, and it writes
;; NaN and inf straight through, which produces JSON that JSON.parse
;; rejects.  All four occur in Snd's answers (peak of an empty
;; selection, a missing mark, a symbolic sample type), so we write our
;; own.
;; ------------------------------------------------------------------

(define (sv-json-string str port)
  (write-char #\" port)
  (let ((len (length str)))
    (do ((i 0 (+ i 1)))
        ((= i len))
      (let* ((c (string-ref str i))
             (n (char->integer c)))
        (cond ((char=? c #\") (display "\\\"" port))
              ((char=? c #\\) (display "\\\\" port))
              ((char=? c #\newline) (display "\\n" port))
              ((char=? c #\return) (display "\\r" port))
              ((char=? c #\tab) (display "\\t" port))
              ((< n 32) (format port "\\u~4,'0X" n))
              (else (write-char c port))))))
  (write-char #\" port))

(define (sv-json-number x port)
  ;; NaN and infinity have no JSON notation.  null is the honest answer:
  ;; the value exists and is not a number.  Silently substituting 0
  ;; would put a plausible wrong number in a waveform.
  (if (or (nan? x) (infinite? x))
      (display "null" port)
      (display (if (and (rational? x) (not (integer? x)))
                   (* 1.0 x)          ; 1/3 is not JSON
                   x)
               port)))

(define (sv-json obj port)
  (cond ((eq? obj #t) (display "true" port))
        ((eq? obj #f) (display "false" port))
        ((null? obj) (display "[]" port))
        ((string? obj) (sv-json-string obj port))
        ((symbol? obj) (sv-json-string (symbol->string obj) port))
        ((char? obj) (sv-json-string (string obj) port))
        ((number? obj) (sv-json-number obj port))
        ((or (vector? obj) (float-vector? obj) (int-vector? obj))
         (write-char #\[ port)
         (let ((len (length obj)))
           (do ((i 0 (+ i 1)))
               ((= i len))
             (when (> i 0) (write-char #\, port))
             (sv-json (obj i) port)))
         (write-char #\] port))
        ((let? obj)
         ;; An inlet is our object.  for-each over a let walks the slots
         ;; in order of definition, which keeps the key order in the
         ;; frames stable and the log diffable.  (reverse a-let), the
         ;; obvious way to normalise the order, is an error in s7.
         (write-char #\{ port)
         (let ((first #t))
           (for-each (lambda (slot)
                       (if first (set! first #f) (write-char #\, port))
                       (sv-json-string (symbol->string (car slot)) port)
                       (write-char #\: port)
                       (sv-json (cdr slot) port))
                     obj))
         (write-char #\} port))
        ((pair? obj)
         (if (and (pair? (car obj)) (symbol? (caar obj)))
             ;; alist -> object
             (begin
               (write-char #\{ port)
               (let ((first #t))
                 (for-each (lambda (entry)
                             (if first (set! first #f) (write-char #\, port))
                             (sv-json-string (symbol->string (car entry)) port)
                             (write-char #\: port)
                             (sv-json (cdr entry) port))
                           obj))
               (write-char #\} port))
             (begin
               (write-char #\[ port)
               (let ((first #t))
                 (for-each (lambda (x)
                             (if first (set! first #f) (write-char #\, port))
                             (sv-json x port))
                           obj))
               (write-char #\] port))))
        (else
         ;; Procedures, c-pointers, #<unspecified>: their printed form is
         ;; the only thing we can honestly pass on.
         (sv-json-string (object->string obj) port))))

(define (sv-json->string obj)
  (let ((port (open-output-string)))
    (sv-json obj port)
    (get-output-string port)))

;; ------------------------------------------------------------------
;; Framing
;; ------------------------------------------------------------------

(define sv-rs (string (integer->char 30)))   ; ASCII RECORD SEPARATOR

(define (sv-emit obj)
  ;; One frame, one line, flushed.  Without the flush a frame can sit in
  ;; the stderr buffer while the extension waits for it -- which looks
  ;; exactly like a hung image.
  (format *stderr* "~A~A~A~%" sv-rs (sv-json->string obj) sv-rs)
  (flush-output-port *stderr*))

(define (sv-event name fields)
  (sv-emit (apply inlet 'event (symbol->string name) fields)))

;; ------------------------------------------------------------------
;; Guards and argument access
;; ------------------------------------------------------------------

;; CALLABLE, not procedure?.
;;
;; s7's procedure? is #f for a MACRO, and Snd defines at least one name the
;; bridge needs as one:
;;
;;   Xen_define_typed_procedure(S_define_envelope "-1", ...);
;;   Xen_eval_C_string("(define-macro (define-envelope a . b)
;;                        `(define-envelope-1 ',a ,@b))");
;;
;; -- snd-env.c, in the HAVE_SCHEME branch. So `define-envelope` is a macro
;; wrapping the real procedure, and asking procedure? about it answers "not
;; available in this Snd build" for something that works perfectly in the
;; REPL two lines away. A wrong answer that blames the build is worse than no
;; answer.
;;
;; The macro exists because its documented syntax takes the name UNQUOTED --
;; (define-envelope ramp '(0 0 1 1)) -- and the C function needs a symbol.
(define (sv-have? name)
  (and (defined? name)
       (let ((value (symbol->value name)))
         (or (procedure? value) (macro? value)))))

(define (sv-in-snd?)
  (sv-have? 'open-sound))

(define (sv-arg params key default)
  (let ((value (if (and (let? params) (defined? key params))
                   (let ((v (params key)))
                     (if (eq? v #<undefined>) default v))
                   default)))
    ;; The sound argument is normalised here rather than in every op: there
    ;; are a dozen ops taking 'snd and one of them forgetting would be a
    ;; failure three requests away from its cause.
    (if (eq? key 'snd) (sv-snd value) value)))

(define (sv-require name)
  (unless (sv-have? name)
    (error 'sv-unavailable
           (string-append (symbol->string name)
                          " is not available in this Snd build"))))

;; ------------------------------------------------------------------
;; Reduction of a channel to columns
;;
;; MIN AND MAX AND RMS, NOT MAX.  Reducing by the maximum loses the
;; lower half, and a symmetric signal comes out as a one-sided envelope
;; -- which still looks like a waveform, and that is what makes the
;; mistake durable.  With min and max a DC offset is visible as an
;; envelope that does not straddle zero, and that is one of the few
;; things a waveform view is actually for.  The RMS on top says how loud
;; the passage is; the gap between envelope and RMS is its dynamic
;; range, so a compressed passage and a merely loud one can be told
;; apart.
;;
;; The reduction happens HERE, not in the extension.  An eight minute
;; recording is twenty million samples and the canvas is eight hundred
;; pixels wide; whatever were transferred, almost all of it would be
;; thrown away on the other side.
;; ------------------------------------------------------------------

(define sv-block-size 65536)

(define (sv-reduce-channel snd chn start dur columns)
  (sv-require 'channel->float-vector)
  (let* ((cols (max 1 (min 4096 (round columns))))
         (dur (max 1 (round dur)))
         (start (max 0 (round start)))
         (mins (make-float-vector cols 0.0))
         (maxs (make-float-vector cols 0.0))
         (rmss (make-float-vector cols 0.0))
         (counts (make-int-vector cols 0))
         (peak 0.0)
         (clipped 0))
    (let loop ((pos 0))
      (when (< pos dur)
        (let* ((want (min sv-block-size (- dur pos)))
               (data ((symbol->value 'channel->float-vector)
                      (+ start pos) want snd chn)))
          (when (float-vector? data)
            (let ((len (min want (length data))))
              (do ((i 0 (+ i 1)))
                  ((= i len))
                (let* ((v (data i))
                       (col (min (- cols 1)
                                 (floor (/ (* (+ pos i) cols) dur))))
                       (n (counts col)))
                  (if (= n 0)
                      (begin (set! (mins col) v) (set! (maxs col) v))
                      (begin (when (< v (mins col)) (set! (mins col) v))
                             (when (> v (maxs col)) (set! (maxs col) v))))
                  (set! (rmss col) (+ (rmss col) (* v v)))
                  (set! (counts col) (+ n 1))
                  (let ((a (abs v)))
                    (when (> a peak) (set! peak a))
                    (when (>= a 1.0) (set! clipped (+ clipped 1))))))))
          (loop (+ pos want)))))
    (do ((i 0 (+ i 1)))
        ((= i cols))
      (let ((n (counts i)))
        (set! (rmss i) (if (> n 0) (sqrt (/ (rmss i) n)) 0.0))))
    (inlet 'columns cols
           'start start
           'dur dur
           'mins mins
           'maxs maxs
           'rms rmss
           'peak peak
           'clipped clipped)))

;; ------------------------------------------------------------------
;; Operations
;;
;; Each takes an inlet and returns something sv-json can write.  No
;; operation prints; printing is the frame's business.
;; ------------------------------------------------------------------


;; ------------------------------------------------------------------
;; Sound objects are not sound indices
;;
;; (sounds) returns a list of SOUND OBJECTS, and (selected-sound) returns
;; one too.  They print as "#<sound 1>", and a JSON writer that falls back
;; to object->string for things it does not recognise turns them into that
;; STRING -- which travels to the extension, comes back in the next request
;; as 'snd, and produces:
;;
;;   set! cursor second argument, "#<sound 1>", is a string but should be a
;;   sound object, an integer (sound index), or #f
;;
;; The failure is three requests away from the cause, in a different
;; process, and it does not mention (sounds) at all.  The panel meanwhile
;; drew nothing, which looked like a broken canvas.
;;
;; So every sound crossing the wire is an INTEGER, in both directions, and
;; that is normalised at exactly two points: here on the way out, and in
;; sv-snd on the way in.  Snd itself accepts either, which is precisely why
;; the mistake survives so long inside Snd and only breaks at the boundary.
;; ------------------------------------------------------------------

;; Regions and mixes are objects too, and print as "#<region 0>" and
;; "#<mix 3>" -- the same trap the sounds op fell into, so the same rule:
;; integers on the wire, converted at the boundary, and INTEGER? asked first
;; because region? and mix? answer "is this a valid region" and say #t for a
;; valid index as readily as for the object.
(define (sv-object-index value predicate converter)
  (cond ((integer? value) value)
        ((not (sv-in-snd?)) value)
        ((and (sv-have? predicate) ((symbol->value predicate) value))
         ((symbol->value converter) value))
        (else value)))

(define (sv-region-index r) (sv-object-index r 'region? 'region->integer))
(define (sv-mix-index m) (sv-object-index m 'mix? 'mix->integer))

(define (sv-region value)
  ;; On the way in: an integer from the panel becomes the object Snd's
  ;; region functions want.
  (if (and (integer? value) (sv-have? 'integer->region))
      ((symbol->value 'integer->region) value)
      value))

(define (sv-mix value)
  (if (and (integer? value) (sv-have? 'integer->mix))
      ((symbol->value 'integer->mix) value)
      value))

(define (sv-snd-index s)
  ;; INTEGER FIRST, and this is not tidiness.
  ;;
  ;; Snd's (sound? snd) answers "does this refer to an open sound", so it
  ;; says #t for the INDEX 0 as readily as for the object -- the reference is
  ;; explicit that "(cursor 0)" and "(cursor (integer->sound 0))" mean the
  ;; same thing, and that sound->integer exists "mainly to convert old code
  ;; to the current style".  Using sound? as the discriminator therefore sent
  ;; every integer through sound->integer, which rejects it:
  ;;
  ;;   sound->integer first argument, 0, is an integer but should be a sound
  ;;
  ;; Which arrives as a failed request for anything one clicks, so nothing is
  ;; selectable -- from a bug fixing the OPPOSITE confusion two hours
  ;; earlier.  The lesson is the shape of the predicate: sound? is about
  ;; validity, not about type, and only the s7 type predicates say which of
  ;; the two representations is in hand.
  (cond ((integer? s) s)
        ((not (sv-in-snd?)) s)
        ((and (sv-have? 'sound?) ((symbol->value 'sound?) s))
         ((symbol->value 'sound->integer) s))
        (else s)))

(define (sv-snd value)
  ;; On the way in. An integer is what we ask for and what we get, but a
  ;; string is what a mistake looks like, and turning it back into a number
  ;; is better than passing it to Snd to be rejected.
  (cond ((integer? value) value)
        ((and (string? value) (string->number value)) (string->number value))
        (else value)))

(define sv-ops (make-hash-table))

(define-macro (sv-define-op name args . body)
  `(set! (sv-ops ',name) (lambda ,args ,@body)))

(sv-define-op status (params)
  (inlet 'protocol sv-protocol-version
         'snd (sv-in-snd?)
         'sndVersion (if (sv-have? 'snd-version)
                         ((symbol->value 'snd-version))
                         "n/a")
         's7Version (*s7* 'version)
         'gui (and (sv-in-snd?)
                   (sv-have? 'main-widgets)
                   (let ((w ((symbol->value 'main-widgets))))
                     (and w (pair? w) (car w) #t)))
         'sampleRate (if (sv-have? 'default-output-srate)
                         ((symbol->value 'default-output-srate))
                         0)))

(sv-define-op eval (params)
  ;; The value AND the output, separately.  Snd's own functions
  ;; regularly do both -- (play) prints and returns -- and a REPL that
  ;; shows only one of the two is missing half the answer.
  ;;
  ;; (rootlet) IS NOT OPTIONAL.  eval-string evaluates in the CURRENT
  ;; environment, and the current environment here is the inside of this
  ;; handler.  Without it, a (define ...) sent from the editor defines the
  ;; name in a closure that is discarded when the request finishes: the
  ;; definition appears to succeed -- eval-string returns the symbol, the
  ;; REPL prints it -- and the very next request reports the name as
  ;; unbound.  Which reads as if Snd forgot it, and sends one looking at
  ;; the session and the process rather than at these three characters.
  ;;
  ;; Every request must land in the same environment for the same reason a
  ;; REPL is a REPL: what one form defines, the next form can use.
  (let* ((code (sv-arg params 'code ""))
         (out (open-output-string))
         (value #<unspecified>))
    (let-temporarily (((current-output-port) out))
      (set! value (eval-string code (rootlet))))
    (inlet 'value (object->string value)
           'output (get-output-string out))))

(sv-define-op sounds (params)
  (if (not (sv-in-snd?))
      #()
      (let ((sounds ((symbol->value 'sounds)))
            ;; Which sound Snd itself considers current. A panel that always
            ;; takes the first one shows whichever file was opened longest
            ;; ago -- and (new-sound) leaves an EMPTY sound behind at index
            ;; 0, so the first thing one sees after generating a sound is a
            ;; blank graph of the right file's stub.
            (selected (and (sv-have? 'selected-sound)
                           (catch #t
                             (lambda () ((symbol->value 'selected-sound)))
                             (lambda args #f)))))
        (if (not sounds)
            #()
            (map (lambda (s)
                   (inlet 'index (sv-snd-index s)
                          'fileName ((symbol->value 'file-name) s)
                          'shortName ((symbol->value 'short-file-name) s)
                          'channels ((symbol->value 'channels) s)
                          'frames ((symbol->value 'framples) s 0)
                          'srate ((symbol->value 'srate) s)
                          'editPosition ((symbol->value 'edit-position) s 0)
                          'edited (> ((symbol->value 'edit-position) s 0) 0)
                          'selected (eqv? (sv-snd-index s) (sv-snd-index selected))
                          ;; "Operations can be applied simultaneously to any
                          ;; other channels or sounds by using the 'sync'
                          ;; button." Sounds sharing a non-zero sync move and
                          ;; edit together, so the tree has to show it or a
                          ;; sound edited from elsewhere looks possessed.
                          'sync (catch #t
                                  (lambda () ((symbol->value 'sync) s))
                                  (lambda args 0))
                          ;; Reported rather than filtered out: an empty
                          ;; sound is a real thing to have -- (new-sound)
                          ;; makes one, and one fills it afterwards -- and
                          ;; hiding it would make the file one just created
                          ;; disappear from the list.
                          'empty (= 0 ((symbol->value 'framples) s 0))))
                 (if (list? sounds) sounds (list sounds)))))))

(sv-define-op waveform (params)
  (let* ((snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (frames ((symbol->value 'framples) snd chn))
         (start (max 0 (sv-arg params 'start 0)))
         (dur (let ((d (sv-arg params 'dur 0)))
                (if (<= d 0) (- frames start) (min d (- frames start)))))
         (columns (sv-arg params 'columns 800))
         (reduced (sv-reduce-channel snd chn start dur columns)))
    (varlet reduced
            'frames frames
            'srate ((symbol->value 'srate) snd)
            'snd snd
            'chn chn
            'cursor ((symbol->value 'cursor) snd chn)
            'editPosition ((symbol->value 'edit-position) snd chn)
            'marks (sv-marks-of snd chn)
            'selection (sv-selection-of snd chn))))

(define (sv-marks-of snd chn)
  (if (not (sv-have? 'marks))
      #()
      (let ((ms ((symbol->value 'marks) snd chn)))
        (map (lambda (m)
               (inlet 'id m
                      'sample ((symbol->value 'mark-sample) m)
                      'name (or ((symbol->value 'mark-name) m) "")
                      'sync ((symbol->value 'mark-sync) m)))
             (if (list? ms) ms (list ms))))))

(define (sv-selection-of snd chn)
  (if (and (sv-have? 'selection?)
           ((symbol->value 'selection?))
           ((symbol->value 'selection-member?) snd chn))
      (inlet 'active #t
             'start ((symbol->value 'selection-position) snd chn)
             'frames ((symbol->value 'selection-framples) snd chn))
      (inlet 'active #f 'start 0 'frames 0)))

(sv-define-op marks (params)
  (sv-marks-of (sv-arg params 'snd 0) (sv-arg params 'chn 0)))

(sv-define-op spectrum (params)
  ;; Snd's own snd-spectrum, not an FFT of our own: the window families
  ;; and the dB scaling are the ones the Snd GUI uses, so the picture in
  ;; VS Code and the picture in Snd agree.  Two different spectra of the
  ;; same passage would be worse than none.
  (sv-require 'snd-spectrum)
  (let* ((snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (start (max 0 (sv-arg params 'start 0)))
         (size (let ((n (sv-arg params 'size 4096)))
                 ;; snd-spectrum wants a power of two
                 (let loop ((p 64))
                   (if (>= p (min 65536 n)) p (loop (* p 2))))))
         (linear (sv-arg params 'linear #f))
         (window (sv-arg params 'window 'blackman2-window))
         (window-value (if (and (symbol? window) (defined? window))
                           (symbol->value window)
                           2))
         (data ((symbol->value 'channel->float-vector) start size snd chn)))
    (if (not (float-vector? data))
        (inlet 'available #f 'reason "no data at this position")
        (let ((spectrum ((symbol->value 'snd-spectrum)
                         data window-value size linear)))
          (inlet 'available #t
                 'start start
                 'size size
                 'linear linear
                 'srate ((symbol->value 'srate) snd)
                 'values spectrum)))))

(sv-define-op edits (params)
  (let* ((snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (top ((symbol->value 'edit-position) snd chn))
         (frags ((symbol->value 'edits) snd chn)))
    (inlet 'position top
           'undoable (car frags)
           'redoable (cadr frags)
           'list (let loop ((i 0) (acc ()))
                   (if (> i top)
                       (reverse acc)
                       (loop (+ i 1)
                             (cons (let ((f ((symbol->value 'edit-fragment) i snd chn)))
                                     (inlet 'position i
                                            'origin (if (pair? f) (car f) "")
                                            'type (if (and (pair? f) (pair? (cdr f)))
                                                      (cadr f) "")
                                            'start (if (>= (length f) 3) (list-ref f 2) 0)
                                            'frames (if (>= (length f) 4) (list-ref f 3) 0)))
                                   acc)))))))

(sv-define-op help (params)
  (let* ((name (sv-arg params 'name ""))
         (sym (and (> (length name) 0) (string->symbol name)))
         (text (and sym
                    (sv-have? 'snd-help)
                    ((symbol->value 'snd-help) sym))))
    (inlet 'name name
           'help (if (string? text) text "")
           'bound (and sym (defined? sym) #t)
           'signature (if (and sym (defined? sym)
                               (procedure? (symbol->value sym)))
                          (let ((sig (signature (symbol->value sym))))
                            (if sig (object->string sig) ""))
                          "")
           'documentation (if (and sym (defined? sym)
                                   (procedure? (symbol->value sym)))
                              (or (documentation (symbol->value sym)) "")
                              ""))))

(sv-define-op completions (params)
  ;; From the LIVE symbol table, not from a list baked into the
  ;; extension.  inf-snd.el completes against the names it scraped out
  ;; of snd-xref.c, so anything the user defines in the session is
  ;; invisible to it -- which is most of what one actually types.
  (let* ((prefix (sv-arg params 'prefix ""))
         (limit (sv-arg params 'limit 300))
         (plen (length prefix))
         (out ()))
    (for-each (lambda (sym)
                (when (and (< (length out) limit)
                           (let ((name (symbol->string sym)))
                             (and (>= (length name) plen)
                                  (string=? prefix (substring name 0 plen)))))
                  (set! out (cons (let ((name (symbol->string sym)))
                                    (inlet 'name name
                                           'kind (if (and (defined? sym)
                                                          (procedure? (symbol->value sym)))
                                                     "function"
                                                     "variable")))
                                  out))))
              (symbol-table))
    (reverse out)))

(sv-define-op apropos (params)
  (let* ((needle (sv-arg params 'text ""))
         (out ()))
    (for-each (lambda (sym)
                (when (and (< (length out) 200)
                           (string-position needle (symbol->string sym)))
                  (set! out (cons (symbol->string sym) out))))
              (symbol-table))
    (sort! out string<?)))

;; --- transport-level commands the GUI panels need -------------------

(sv-define-op cursor (params)
  (let ((snd (sv-arg params 'snd 0))
        (chn (sv-arg params 'chn 0))
        (sample (sv-arg params 'sample 0)))
    (set! ((symbol->value 'cursor) snd chn) sample)
    (inlet 'cursor ((symbol->value 'cursor) snd chn))))

(sv-define-op select (params)
  ;; THERE IS NO set-selection-position.  I invented it -- it looks like the
  ;; old-style name and Snd does have a few of those, so it reads as
  ;; plausible.  The call failed, the error went into a frame the panel
  ;; showed at the very bottom of a tall page, and dragging simply appeared
  ;; to do nothing.
  ;;
  ;; The real sequence is in Snd's own documentation, in the extract-channels
  ;; example:
  ;;
  ;;   (set! (selection-member? snd chan) #t)
  ;;   (set! (selection-position snd chan) 0)
  ;;   (set! (selection-framples snd chan) (framples snd chan))
  ;;
  ;; All three, in that order, and the order is not cosmetic:
  ;;
  ;; MEMBER? FIRST, because without it the channel is not part of any
  ;; selection and there is nothing for the other two to move.
  ;;
  ;; POSITION BEFORE FRAMPLES, because of what the reference says about
  ;; selection-position: "If changed, the selection end point stays the same,
  ;; while the length (selection-framples) changes to reflect the moved
  ;; origin."  Setting the length first and the start second therefore
  ;; discards the length -- a selection that lands in the right place with
  ;; the wrong extent, which looks like a rounding problem in the drag.
  (let ((snd (sv-arg params 'snd 0))
        (chn (sv-arg params 'chn 0))
        (start (sv-arg params 'start 0))
        (frames (sv-arg params 'frames 0)))
    (if (<= frames 0)
        (begin
          (if (sv-have? 'unselect-all)
              ((symbol->value 'unselect-all))
              (set! ((symbol->value 'selection-member?) snd chn) #f))
          (inlet 'active #f))
        (begin
          (set! ((symbol->value 'selection-member?) snd chn) #t)
          (set! ((symbol->value 'selection-position) snd chn) start)
          (set! ((symbol->value 'selection-framples) snd chn) frames)
          (sv-selection-of snd chn)))))

(sv-define-op play (params)
  (let ((snd (sv-arg params 'snd 0))
        (chn (sv-arg params 'chn #f))
        (start (sv-arg params 'start 0))
        (end (sv-arg params 'end #f)))
    ;; Told BEFORE play, not after: play-hook can fire before the call
    ;; returns, and a counter reset afterwards would throw away the first
    ;; buffers and put the playhead behind by however long the audio system
    ;; took to start.
    (sv-play-began snd (or chn 0) start)
    ;; KEYWORDS.  From the reference:
    ;;   play object :start :end :channel :edit-position :out-channel
    ;;               :with-sync :wait :stop :srate :channels
    ;; and "The object can be a string (sound filename), a sound object or
    ;; index, ...".  So the FIRST argument is the sound, and everything after
    ;; it is named.
    ;;
    ;; Called positionally, as (play start snd chn #f end), the start went in
    ;; as the object, the sound as :start, and the end sample landed on
    ;; :edit-position -- which produced
    ;;
    ;;   play: no such edpos: 88200 (from 88200), current edit: 1
    ;;
    ;; A message about the edit history for a mistake about argument names,
    ;; and the second one of exactly this shape today: save-selection was the
    ;; first.  Snd's newer API is keyword-based nearly everywhere, and the
    ;; positional form is the old style that mostly still works -- which is
    ;; what makes guessing it so tempting and so wrong.
    (if end
        ((symbol->value 'play) snd :start start :end end :channel (or chn #f))
        ((symbol->value 'play) snd :start start :channel (or chn #f)))
    (inlet 'playing #t 'start start 'interval (sv-play-interval))))

(sv-define-op stop (params)
  (when (sv-have? 'stop-playing) ((symbol->value 'stop-playing)))
  ;; stop-playing-hook fires on its own for a sound that ends by itself, but
  ;; not always for one stopped by hand -- so the event is sent here too.
  ;; Two 'stopped events are harmless; none leaves a playhead standing.
  (sv-play-ended)
  (inlet 'playing #f))

(sv-define-op undo (params)
  ((symbol->value 'undo) (sv-arg params 'count 1)
                         (sv-arg params 'snd 0)
                         (sv-arg params 'chn 0))
  (inlet 'position ((symbol->value 'edit-position)
                    (sv-arg params 'snd 0) (sv-arg params 'chn 0))))

(sv-define-op redo (params)
  ((symbol->value 'redo) (sv-arg params 'count 1)
                         (sv-arg params 'snd 0)
                         (sv-arg params 'chn 0))
  (inlet 'position ((symbol->value 'edit-position)
                    (sv-arg params 'snd 0) (sv-arg params 'chn 0))))

(sv-define-op open (params)
  (let ((file (sv-arg params 'file "")))
    (inlet 'snd ((symbol->value 'open-sound) file))))

(sv-define-op close (params)
  ((symbol->value 'close-sound) (sv-arg params 'snd 0))
  #t)

(sv-define-op save (params)
  ((symbol->value 'save-sound) (sv-arg params 'snd 0))
  #t)

(sv-define-op loadpath (params)
  ;; Put a directory on s7's *load-path*, so (load-from-path "v.scm") finds
  ;; Snd's own Scheme files.
  ;;
  ;; This is what makes the fm-violin available -- and the fm-violin is what
  ;; made the .snd files every example in the documentation opens. Those files
  ;; are not in the tarball: 676 entries, no audio. The instruments are, which
  ;; is the better half to have.
  ;;
  ;; Prepended, not appended, and only once: a path added on every session
  ;; start would grow *load-path* by one entry per restart, and the duplicate
  ;; that shadows nothing is exactly the kind of thing that looks harmless for
  ;; a hundred restarts.
  ;; *load-path*, not (*s7* 'load-path). The latter is not a field of *s7* in
  ;; this s7 -- it reads as #<undefined>, and setting it would have written a
  ;; field nobody consults while looking exactly like it worked. The load path
  ;; is an ordinary settable variable:
  ;;
  ;;   > *load-path*
  ;;   ()
  (let ((path (sv-arg params 'path "")))
    (when (and (> (length path) 0) (defined? '*load-path*))
      (let ((current (symbol->value '*load-path*)))
        (unless (member path current)
          ;; A plain set! on the variable, verified in s7 rather than assumed:
          ;; the symbol table also holds a set-*load-path* accessor, and going
          ;; through that would be a guess where a check was available.
          (eval (list 'set! '*load-path* (list 'quote (cons path current)))
                (rootlet)))))
    (inlet 'loadPath (if (defined? '*load-path*) (symbol->value '*load-path*) ()))))

(sv-define-op load (params)
  (let ((file (sv-arg params 'file "")))
    (inlet 'value (object->string (load file)))))

;; ------------------------------------------------------------------
;; Variables: the dialogs
;;
;; Snd's dialogs -- Transform Options, the control panel, Preferences,
;; the envelope editor -- are windows over VARIABLES.  "Blackman2" in the
;; window list is (set! (fft-window) blackman2-window); the sonogram
;; radio button is (set! (transform-graph-type) graph-as-sonogram).  So
;; the way to have those dialogs in VS Code is not to mirror the
;; windows: it is to read and write the same variables the windows read
;; and write.
;;
;; That has a consequence worth naming, because it is the reason this is
;; better than a screen mirror rather than merely different: with a Motif
;; build BOTH dialogs work, on the same state, and neither is a copy of
;; the other.  Change the window size in Snd's dialog and the VS Code
;; panel shows it on its next read.  A mirror of pixels could never do
;; that; it could only be looked at.
;;
;; Three complications, all of them real:
;;
;; ACCESSORS TAKE A SOUND.  The control panel variables (amp-control,
;; speed-control, the expand and reverb sets) belong to a sound, not to
;; the session, and their sound argument is optional -- (amp-control)
;; means the selected sound.  With no sound open the call raises.  So
;; every read is guarded individually and reports itself as unavailable
;; rather than failing the whole request: a Preferences panel must open
;; before a sound does.
;;
;; SOME VALUES ARE NOT NUMBERS.  transform-type returns a transform
;; OBJECT, not the integer the dialog shows.  It goes over the wire as
;; the integer, through transform->integer, and comes back through
;; integer->transform.  colormap is the same shape.  Passing the printed
;; object would give a panel that displays #<transform: fourier> in a
;; number field.
;;
;; WRITING IS (set! (f) v), NOT (set! f v).  These are dilambdas.  The
;; second form redefines the accessor -- and then the variable is gone
;; for the rest of the session, silently, with the panel still showing
;; the value it thinks it set.

(define (sv-var-value name snd)
  ;; A sound argument first, then without: the ones that take a sound
  ;; accept it, the global ones would reject it.
  (let ((accessor (symbol->value name)))
    (if (procedure? accessor)
        (catch #t
          (lambda () (accessor snd))
          (lambda (type info)
            (catch #t
              (lambda () (accessor))
              (lambda (type2 info2) (error 'sv-var-unreadable (symbol->string name))))))
        accessor)))

(define (sv-json-number-ok value) value)

(define (sv-var-encode value)
  ;; Objects the panels have to show as numbers.
  ;; Numbers first, for the reason spelled out in sv-snd-index: sound? says
  ;; #t for an index too, so asking it first sends every integer into
  ;; sound->integer, which rejects it.
  (cond ((number? value) (sv-json-number-ok value))
        ((and (sv-have? 'sound?) ((symbol->value 'sound?) value))
         ((symbol->value 'sound->integer) value))
        ((and (sv-have? 'transform?) ((symbol->value 'transform?) value))
         ((symbol->value 'transform->integer) value))
        ((and (sv-have? 'colormap?) ((symbol->value 'colormap?) value))
         ((symbol->value 'colormap->integer) value))
        ((or (boolean? value) (number? value) (string? value)) value)
        ((symbol? value) (symbol->string value))
        ((or (pair? value) (vector? value) (float-vector? value)) value)
        (else (object->string value))))

(sv-define-op getvars (params)
  ;; Names as one space-separated string, so that a panel with forty
  ;; fields is one request. Forty requests would each be a round trip
  ;; through the pipe, and the panel would visibly fill in.
  (let ((snd (sv-arg params 'snd 0))
        (names (sv-arg params 'names ""))
        (out ()))
    (for-each
     (lambda (name)
       (when (> (length name) 0)
         (let ((symbol (string->symbol name)))
           (set! out
                 (cons (if (not (defined? symbol))
                           (inlet 'name name 'available #f 'reason "not in this build")
                           (catch #t
                             (lambda ()
                               (inlet 'name name
                                      'available #t
                                      'value (sv-var-encode (sv-var-value symbol snd))))
                             (lambda (type info)
                               (inlet 'name name 'available #f 'reason "no sound"))))
                       out)))))
     (sv-split-words names))
    (reverse out)))

(define (sv-split-words text)
  (let ((out ()) (current ""))
    (let ((len (length text)))
      (do ((i 0 (+ i 1)))
          ((= i len))
        (let ((c (string-ref text i)))
          (if (char=? c #\space)
              (begin (when (> (length current) 0) (set! out (cons current out)))
                     (set! current ""))
              (set! current (string-append current (string c)))))))
    (when (> (length current) 0) (set! out (cons current out)))
    (reverse out)))

(sv-define-op setvar (params)
  ;; The value arrives as a Scheme literal built on the extension side
  ;; from a typed field, not as free text: a slider cannot produce
  ;; anything but a number, and a request that could carry arbitrary code
  ;; into a (set! ...) is a different kind of channel than this one.
  (let* ((name (sv-arg params 'name ""))
         (literal (sv-arg params 'value "#f"))
         (via (sv-arg params 'via ""))
         (snd (sv-arg params 'snd 0))
         (symbol (string->symbol name)))
    (unless (defined? symbol)
      (error 'sv-unavailable (string-append name " is not in this Snd build")))
    (let* ((wrapped (cond ((string=? via "transform")
                           (string-append "(integer->transform " literal ")"))
                          ((string=? via "colormap")
                           (string-append "(integer->colormap " literal ")"))
                          (else literal)))
           ;; (set! (f) v) and not (set! f v): these are dilambdas, and
           ;; the second form REDEFINES the accessor -- after which the
           ;; variable is gone for the rest of the session, silently.
           ;; set! on a global works from any environment, so this one does
           ;; not need (rootlet) -- but it gets it anyway, so that the rule
           ;; "eval-string always names its environment" has no exceptions
           ;; to remember.
           (form (string-append "(set! (" name (if (sv-var-takes-sound? symbol)
                                                   (string-append " " (object->string snd))
                                                   "")
                                ") " wrapped ")")))
      (eval-string form (rootlet))
      (inlet 'name name 'value (sv-var-encode (sv-var-value symbol snd))))))

(define (sv-var-takes-sound? symbol)
  ;; Decided by trying, not by a list: the set of sound-scoped variables
  ;; differs between Snd versions, and a hard-coded list would be wrong
  ;; on exactly the build nobody tested.
  (catch #t
    (lambda () ((symbol->value symbol) 0) #t)
    (lambda (type info) #f)))

(sv-define-op applycontrols (params)
  ;; The control panel's Apply: without it the controls only affect
  ;; playback, and the edit history stays empty. That difference is the
  ;; whole point of the button, and it is not obvious from the panel.
  (sv-require 'apply-controls)
  ((symbol->value 'apply-controls) (sv-arg params 'snd 0))
  (inlet 'editPosition ((symbol->value 'edit-position)
                        (sv-arg params 'snd 0) 0)))

(sv-define-op waveforms (params)
  ;; SEVERAL CHANNELS, ONE REQUEST, ONE TIME RANGE.
  ;;
  ;; This is the thing Snd's Motif window does that a per-channel panel
  ;; cannot, and the reason it has to be one op rather than a loop on the
  ;; other side: the axes are coupled BY CONSTRUCTION.  Ask channel by
  ;; channel and the answers arrive at different times, each computed
  ;; against whatever the range was when it left -- and during a drag or a
  ;; zoom the lanes then show slightly different windows of time.  Which
  ;; looks like phase drift.  On a multichannel recording, where reading
  ;; phase between channels is the entire reason for stacking them, a
  ;; picture that invents phase differences is worse than no picture.
  ;;
  ;; The range is decided once here, against the LONGEST channel, and every
  ;; lane is reduced against that same range.  A channel shorter than the
  ;; others -- which happens as soon as one of them is edited -- gets fewer
  ;; columns and says so, rather than being stretched to fit.
  (let* ((snd (sv-arg params 'snd 0))
         (requested (sv-arg params 'chns ""))
         (count (if (sv-have? 'channels) ((symbol->value 'channels) snd) 1))
         (chns (if (= (length requested) 0)
                   (let loop ((i (- count 1)) (acc ()))
                     (if (< i 0) acc (loop (- i 1) (cons i acc))))
                   (map string->number (sv-split-words requested))))
         (longest (let loop ((rest chns) (most 0))
                    (if (null? rest)
                        most
                        (loop (cdr rest)
                              (max most ((symbol->value 'framples) snd (car rest)))))))
         (start (max 0 (sv-arg params 'start 0)))
         (dur (let ((d (sv-arg params 'dur 0)))
                (if (<= d 0) (- longest start) (min d (- longest start)))))
         (columns (sv-arg params 'columns 800)))
    (inlet 'snd snd
           'srate ((symbol->value 'srate) snd)
           'fileName ((symbol->value 'short-file-name) snd)
           'frames longest
           'start start
           'dur dur
           'columns columns
           'channelStyle (if (sv-have? 'channel-style)
                             (catch #t
                               (lambda () ((symbol->value 'channel-style) snd))
                               (lambda args 0))
                             0)
           'channels
           (map (lambda (chn)
                  (let* ((frames ((symbol->value 'framples) snd chn))
                         ;; Clamped per channel, against the SHARED start.
                         ;; A channel that ends early ends early in the
                         ;; picture too.
                         (available (max 0 (min dur (- frames start))))
                         (reduced (if (> available 0)
                                      (sv-reduce-channel snd chn start available
                                                         (max 1 (round (* columns
                                                                          (/ available dur)))))
                                      (inlet 'columns 0
                                             'mins (make-float-vector 1 0.0)
                                             'maxs (make-float-vector 1 0.0)
                                             'rms (make-float-vector 1 0.0)
                                             'peak 0.0
                                             'clipped 0))))
                    (varlet reduced
                            'chn chn
                            'frames frames
                            ;; The fraction of the shared range this channel
                            ;; actually covers, so the lane can be drawn to
                            ;; its true width instead of stretched.
                            'coverage (if (> dur 0) (/ available dur) 0.0)
                            'cursor ((symbol->value 'cursor) snd chn)
                            'editPosition ((symbol->value 'edit-position) snd chn)
                            'marks (sv-marks-of snd chn)
                            'selection (sv-selection-of snd chn))))
                chns))))

(define (sv-enved-target-name)
  ;; enved-target is one of three constants. The panel speaks Bill's own
  ;; button labels -- amp, flt, src -- because those are what the dialog says
  ;; and what his documentation calls them.
  (catch #t
    (lambda ()
      (let ((v ((symbol->value 'enved-target))))
        (cond ((and (defined? 'enved-spectrum) (eqv? v (symbol->value 'enved-spectrum))) "flt")
              ((and (defined? 'enved-srate) (eqv? v (symbol->value 'enved-srate))) "src")
              (else "amp"))))
    (lambda args "amp")))

(define (sv-envelope? value)
  ;; What counts as an envelope: a list of an even number of reals, at least
  ;; two breakpoints. That is exactly what define-envelope stores -- it
  ;; defines an ordinary variable, as Snd's own funcs.scm shows on every
  ;; line -- and there is no Scheme-visible registry to ask instead: the
  ;; editor's list lives in all_envs/all_names in snd-env.c, C-side only.
  (and (pair? value)
       (even? (length value))
       (>= (length value) 4)
       (let loop ((rest value))
         (or (null? rest)
             (and (real? (car rest)) (loop (cdr rest)))))))

(define (sv-named-envelopes limit)
  (let ((out ()))
    (for-each
     (lambda (sym)
       (when (< (length out) limit)
         (catch #t
           (lambda ()
             (when (defined? sym)
               (let ((value (symbol->value sym)))
                 (when (sv-envelope? value)
                   (set! out (cons (inlet 'name (symbol->string sym) 'points value) out))))))
           (lambda args #f))))
     (symbol-table))
    (reverse out)))

(sv-define-op envelope (params)
  ;; Everything Bill's Edit Envelope dialog shows, in one request.
  ;;
  ;; His dialog is a window over enved-* variables, like the rest of Snd, so
  ;; the panel reads and writes those: with a Motif build both editors show
  ;; the same envelope, the same base, the same target.
  (let* ((snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (var (lambda (name fallback)
                (if (sv-have? name)
                    (catch #t (lambda () ((symbol->value name))) (lambda args fallback))
                    fallback))))
    (inlet 'envelope (var 'enved-envelope ())
           'base (var 'enved-base 1.0)
           'clip (var 'enved-clip? #f)
           'wave (var 'enved-wave? #f)
           'inDB (var 'enved-in-dB #f)
           'power (var 'enved-power 3.0)
           'filterOrder (var 'enved-filter-order 40)
           'target (if (sv-have? 'enved-target) (sv-enved-target-name) "amp")
           'style (catch #t
                    (lambda ()
                      (if (and (defined? 'envelope-exponential)
                               (eqv? ((symbol->value 'enved-style))
                                     (symbol->value 'envelope-exponential)))
                          "exponential"
                          "linear"))
                    (lambda args "linear"))
           ;; The named envelopes, for the list on the left of Bill's dialog.
           ;; 500, not 200. The scan stops after that many MATCHES, and a
           ;; session that has loaded one of Snd's own envelope files --
           ;; funcs.scm alone is about a hundred -- plus a few of its own can
           ;; pass 200. Being cut off shows as "my envelope is not in the
           ;; list", with nothing to suggest a limit was involved.
           'named (sv-named-envelopes (sv-arg params 'limit 500))
           'filter (if (sv-have? 'filter-control-envelope)
                       (catch #t (lambda () ((symbol->value 'filter-control-envelope) snd))
                              (lambda args ()))
                       ())
           'srate (if (sv-in-snd?) ((symbol->value 'srate) snd) 44100)
           'frames (if (sv-in-snd?) ((symbol->value 'framples) snd chn) 0)
           'selection (sv-selection-of snd chn)
           'editPosition (if (sv-in-snd?) ((symbol->value 'edit-position) snd chn) 0))))

(define (sv-breakpoints text)
  ;; "0 0 1 1" -> (0 0 1 1). Read as a LIST OF NUMBERS, not evaluated as
  ;; code: the panel produces numbers and nothing else, and a breakpoint list
  ;; that goes through eval is an eval op with a friendlier name.
  (let ((out ()))
    (for-each (lambda (word)
                (let ((n (string->number word)))
                  (if n
                      (set! out (cons (* 1.0 n) out))
                      (error 'sv-bad-envelope
                             (string-append "not a number in the envelope: " word)))))
              (sv-split-words text))
    (let ((points (reverse out)))
      (when (odd? (length points))
        (error 'sv-bad-envelope "an envelope needs an even number of values (x y x y ...)"))
      (when (< (length points) 4)
        (error 'sv-bad-envelope "an envelope needs at least two breakpoints"))
      points)))

(sv-define-op applyenvelope (params)
  ;; BILL'S MATRIX: three targets times three scopes.
  ;;
  ;;            sound                  selection            mix
  ;;   amp      env-sound              env-selection        mix-amp-env
  ;;   flt      filter-sound           filter-selection     --
  ;;   src      src-sound              src-selection        --
  ;;
  ;; Nine cells, seven of them real functions, and the two empty ones are
  ;; empty in Snd too -- a mix has an amplitude envelope and no filter or
  ;; sampling-rate envelope. They are refused by name rather than silently
  ;; falling back to the sound, which would apply an envelope to the whole
  ;; file when the user asked for one mix.
  ;;
  ;; Every one of these puts ONE entry in the edit history, which is why they
  ;; are used instead of walking the samples.
  (let* ((snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (target (sv-arg params 'target "amp"))
         (scope (sv-arg params 'scope "sound"))
         (base (sv-arg params 'base 1.0))
         (order (sv-arg params 'order 40))
         (mix (sv-mix (sv-arg params 'mix 0)))
         (points (sv-breakpoints (sv-arg params 'points ""))))
    (when (and (string=? scope "selection")
               (not (and (sv-have? 'selection?) ((symbol->value 'selection?)))))
      (error 'sv-no-selection "there is no selection to apply an envelope to"))
    (cond
     ;; --- amplitude
     ((and (string=? target "amp") (string=? scope "sound"))
      (sv-require 'env-sound)
      ;; env-sound env beg dur base s c e -- the base is positional here, and
      ;; it is the fourth argument, not the second.
      ((symbol->value 'env-sound) points 0 ((symbol->value 'framples) snd chn) base snd chn))
     ((and (string=? target "amp") (string=? scope "selection"))
      (sv-require 'env-selection)
      ((symbol->value 'env-selection) points base))
     ((and (string=? target "amp") (string=? scope "mix"))
      (sv-require 'mix-amp-env)
      (set! ((symbol->value 'mix-amp-env) mix) points))
     ;; --- spectrum, through an FIR filter of enved-filter-order taps
     ((and (string=? target "flt") (string=? scope "sound"))
      (sv-require 'filter-sound)
      ((symbol->value 'filter-sound) points order snd chn))
     ((and (string=? target "flt") (string=? scope "selection"))
      (sv-require 'filter-selection)
      ((symbol->value 'filter-selection) points order))
     ;; --- sampling rate: changes length and pitch together
     ((and (string=? target "src") (string=? scope "sound"))
      (sv-require 'src-sound)
      ((symbol->value 'src-sound) points snd chn))
     ((and (string=? target "src") (string=? scope "selection"))
      (sv-require 'src-selection)
      ((symbol->value 'src-selection) points))
     (else
      (error 'sv-no-such-target
             (string-append "Snd has no " target " envelope for a " scope
                            " -- a mix has an amplitude envelope only"))))
    (inlet 'target target 'scope scope 'applied #t
           'editPosition ((symbol->value 'edit-position) snd chn))))

(sv-define-op storeenvelope (params)
  ;; Into Snd's OWN editor state, without applying it. So a curve drawn here
  ;; is the curve Snd's envelope editor opens with, and the two are one
  ;; editor rather than two.
  (let ((points (sv-breakpoints (sv-arg params 'points "")))
        (base (sv-arg params 'base 1.0)))
    (when (sv-have? 'enved-envelope)
      (set! ((symbol->value 'enved-envelope)) points))
    (when (sv-have? 'enved-base)
      (set! ((symbol->value 'enved-base)) base))
    (inlet 'envelope points 'base base)))

(sv-define-op defineenvelope (params)
  ;; Bill's "define it" button: the curve gets a name and joins the list.
  ;;
  ;; define-envelope defines an ordinary variable -- his own funcs.scm is a
  ;; hundred lines of exactly this -- so a named envelope is usable anywhere
  ;; an envelope is, not only in the editor.
  (sv-require 'define-envelope)
  (let* ((name (sv-arg params 'name ""))
         (points (sv-breakpoints (sv-arg params 'points "")))
         (base (sv-arg params 'base 1.0)))
    (when (= (length name) 0) (error 'sv-bad-name "an envelope needs a name"))
    ;; The name is checked rather than interpolated blindly: it becomes a
    ;; variable, and this is the one place where panel text turns into a
    ;; symbol.
    (for-each (lambda (c)
                (when (or (char=? c #\() (char=? c #\)) (char=? c #\space)
                          (char=? c #\") (char=? c #\'))
                  (error 'sv-bad-name
                         (string-append "not a usable envelope name: " name))))
              (string->list name))
    ;; define-envelope-1 IS the procedure; `define-envelope` is a macro over
    ;; it that exists only to quote the name for you (snd-env.c). Calling the
    ;; procedure directly needs no eval and no form-building: the name arrives
    ;; as a symbol, which is what its type check accepts ("a string or
    ;; symbol"). The macro is the fallback, for a build without the -1 name.
    (cond ((sv-have? 'define-envelope-1)
           ((symbol->value 'define-envelope-1) (string->symbol name) points base))
          ((macro? (symbol->value 'define-envelope))
           (eval (list 'define-envelope (string->symbol name) (list 'quote points) base)
                 (rootlet)))
          (else
           ((symbol->value 'define-envelope) (string->symbol name) points base)))
    (inlet 'name name 'points points 'base base)))

(sv-define-op constants (params)
  ;; What fourier-transform, blackman2-window and graph-as-sonogram are
  ;; NUMERICALLY, in this build.
  ;;
  ;; The panels need the numbers to know which radio button is on, and the
  ;; honest way to get them is to ask. Baking the integers into the extension
  ;; would work until Snd inserts a transform in the middle of its list --
  ;; after which every panel would be one entry off, would still look
  ;; correct, and would set the wrong window on a spectrum whose picture
  ;; nobody can check by eye.
  ;;
  ;; So the panels declare SYMBOLS, resolve them once per session, and write
  ;; symbols back.
  (let ((out ()))
    (for-each
     (lambda (name)
       (when (> (length name) 0)
         (let ((symbol (string->symbol name)))
           (set! out (cons (inlet 'name name
                                  'available (and (defined? symbol) #t)
                                  'value (if (defined? symbol)
                                             (sv-var-encode
                                              (catch #t
                                                (lambda ()
                                                  (let ((v (symbol->value symbol)))
                                                    (if (procedure? v) (v) v)))
                                                (lambda (type info) -1)))
                                             -1))
                           out)))))
     (sv-split-words (sv-arg params 'names "")))
    (reverse out)))

(sv-define-op storeenvelope (params)
  ;; Into Snd's OWN editor state, without applying it. So a curve drawn here
  ;; is the curve Snd's envelope editor opens with, and the two are one
  ;; editor rather than two.
  (let ((points (sv-breakpoints (sv-arg params 'points "")))
        (base (sv-arg params 'base 1.0)))
    (when (sv-have? 'enved-envelope)
      (set! ((symbol->value 'enved-envelope)) points))
    (when (sv-have? 'enved-base)
      (set! ((symbol->value 'enved-base)) base))
    (inlet 'envelope points 'base base)))

;; ------------------------------------------------------------------
;; Base64
;;
;; A sonogram is columns x bins values: 600 by 256 is 153,600 numbers, and as
;; a JSON array of integers that is about 600 kB PER REDRAW -- through a pipe,
;; parsed, on every zoom and every drag.  One byte per cell instead, base64
;; encoded, is 205 kB of a single string, which JSON.parse handles as one
;; token and the webview turns into ImageData without touching it element by
;; element.
;;
;; One byte is also honest about the picture: a sonogram cell is a shade, and
;; a canvas has 256 of them.  Sending doubles would be sending precision that
;; is thrown away by the thing it is drawn on.
;; ------------------------------------------------------------------

(define sv-base64-alphabet
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")

(define (sv-base64 bytes)
  (let* ((len (length bytes))
         (out (open-output-string)))
    (let loop ((i 0))
      (if (>= i len)
          (get-output-string out)
          (let* ((b0 (bytes i))
                 (b1 (if (< (+ i 1) len) (bytes (+ i 1)) 0))
                 (b2 (if (< (+ i 2) len) (bytes (+ i 2)) 0))
                 (triple (+ (* b0 65536) (* b1 256) b2)))
            (write-char (string-ref sv-base64-alphabet (quotient triple 262144)) out)
            (write-char (string-ref sv-base64-alphabet
                                    (modulo (quotient triple 4096) 64)) out)
            (write-char (if (< (+ i 1) len)
                            (string-ref sv-base64-alphabet (modulo (quotient triple 64) 64))
                            #\=)
                        out)
            (write-char (if (< (+ i 2) len)
                            (string-ref sv-base64-alphabet (modulo triple 64))
                            #\=)
                        out)
            (loop (+ i 3)))))))

;; ------------------------------------------------------------------
;; Sonogram
;;
;; The last thing Snd's Motif window could do that this one could not.
;;
;; Snd's own sonogram is transform-graph-type set to graph-as-sonogram, drawn
;; by the GUI.  Headless there is no drawing, so the transforms happen here --
;; but through snd-spectrum, per column, exactly as the single-frame panel
;; does.  Which means the sonogram and the spectrum panel cannot disagree
;; about what a window or a dB floor is, and neither can disagree with Snd's
;; own transform dialog.  Three views, one set of variables.
;;
;; THE dB FLOOR IS min-dB, NOT A CHOICE OF MINE.  "If in decibels, the
;; minimum displayed is set by min-dB which defaults to -60."  Scaling to the
;; loudest cell present instead -- the obvious way to get a bright picture --
;; would make the same passage look different depending on what else is in the
;; window, and a sonogram whose colours mean something different at every zoom
;; level is decoration.
;; ------------------------------------------------------------------

(sv-define-op sonogram (params)
  (sv-require 'snd-spectrum)
  (sv-require 'channel->float-vector)
  (let* ((snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (frames ((symbol->value 'framples) snd chn))
         (start (max 0 (sv-arg params 'start 0)))
         (dur (let ((d (sv-arg params 'dur 0)))
                (if (<= d 0) (- frames start) (min d (- frames start)))))
         (columns (max 1 (min 1024 (round (sv-arg params 'columns 400)))))
         (size (let loop ((p 64))
                 (if (>= p (min 16384 (sv-arg params 'size 1024))) p (loop (* p 2)))))
         ;; 512 was a cap on the SONOGRAM, where one row is one pixel and more
         ;; rows than the panel is tall buy nothing. The spectrogram draws a
         ;; line per bin along the width, so the same cap throws away half the
         ;; resolution of a 2048-point transform for no reason -- "512 of 512
         ;; bins" for a size where 1024 exist.
         ;;
         ;; 2048 now, still capped: the array is columns times bins and an
         ;; uncapped bin count at 1024 columns is a megabyte of base64 per
         ;; redraw.
         (bins (max 8 (min 2048 (round (sv-arg params 'bins 256)))))
         (linear (sv-arg params 'linear #f))
         (window (sv-arg params 'window 'blackman2-window))
         (window-value (if (and (symbol? window) (defined? window))
                           (symbol->value window)
                           2))
         ;; -90, NOT min-dB.
         ;;
         ;; snd-spectrum's own floor is a literal in snd-sig.c:
         ;;
         ;;   lowest = 0.000001;  ... if (val < lowest) rdat[i] = 0.0;
         ;;   ... else rdat[i] = -90.0;  /* min_dB(ss)? or could channel
         ;;                                  case be less? */
         ;;
         ;; -- Bill Schottstaedt's own comment, wondering the same thing.
         ;; Bins whose raw magnitude falls under `lowest` are set to zero and
         ;; then to a flat -90; bins just above it are computed and can be
         ;; LOWER than -90 (measured here: -105.14). So -90 is not a floor in
         ;; the sense of a minimum, it is the value used for "did not reach
         ;; the threshold", and scaling against min-dB (-60) puts every real
         ;; measurement below -60 into the same black as the ones that were
         ;; never measured.
         (floor-dB -90.0)
         (usable (quotient size 2))
         (cells (make-int-vector (* columns bins) 0))
         (hop (/ dur columns)))
    (do ((col 0 (+ col 1)))
        ((= col columns))
      (let* ((at (min (max 0 (- frames size)) (round (+ start (* col hop)))))
             (data ((symbol->value 'channel->float-vector) at size snd chn)))
        (when (float-vector? data)
          (let ((spectrum ((symbol->value 'snd-spectrum)
                           data window-value size linear)))
            (when (float-vector? spectrum)
              (do ((row 0 (+ row 1)))
                  ((= row bins))
                ;; Each row is a BAND of bins, reduced by its maximum. A
                ;; partial is one or two bins wide; averaging the band would
                ;; dilute it by the width of the band and make thin partials
                ;; vanish at low vertical resolution -- which is the whole
                ;; resolution one usually has.
                (let* ((from (quotient (* row usable) bins))
                       (to (max (+ from 1) (quotient (* (+ row 1) usable) bins)))
                       (peak (let inner ((i from) (most -1000.0))
                               (if (>= i (min to usable))
                                   most
                                   (inner (+ i 1) (max most (spectrum i))))))
                       (level (if linear
                                  (min 1.0 (max 0.0 peak))
                                  ;; dB, with min-dB as the floor: 0 dB is
                                  ;; full, min-dB and below is empty.
                                  (min 1.0 (max 0.0 (- 1.0 (/ peak floor-dB)))))))
                  (set! (cells (+ (* col bins) row))
                        (min 255 (max 0 (round (* 255 level))))))))))))
    (inlet 'snd snd 'chn chn
           'start start 'dur dur
           'columns columns 'bins bins
           'size size
           'linear linear
           'floorDB floor-dB
           'srate ((symbol->value 'srate) snd)
           'frames frames
           ;; The viewing angles and scales, so the 3D view uses SND'S own
           ;; orientation rather than one of its own invention: change them in
           ;; Snd's Color/Orientation dialog, or in this extension's View
           ;; dialog, and both editors turn the surface the same way. Bill's
           ;; defaults are 90/0/358 with a z scale of 0.1 in Motif, and quite
           ;; different under OpenGL (300/320/0, z scale 1.0), which is why
           ;; they are read rather than assumed.
           'spectro (let ((var (lambda (name fallback)
                                 (if (sv-have? name)
                                     (catch #t
                                       (lambda () (* 1.0 ((symbol->value name))))
                                       (lambda args fallback))
                                     fallback))))
                      (inlet 'xAngle (var 'spectro-x-angle 90.0)
                             'yAngle (var 'spectro-y-angle 0.0)
                             'zAngle (var 'spectro-z-angle 358.0)
                             'xScale (var 'spectro-x-scale 1.0)
                             'yScale (var 'spectro-y-scale 1.0)
                             'zScale (var 'spectro-z-scale 0.1)
                             'hop (var 'spectro-hop 4.0)))
           ;; Column-major: one column is one transform, and the webview
           ;; walks columns to build the image.
           'cells (sv-base64 cells))))

;; ------------------------------------------------------------------
;; Wavogram
;;
;; The fourth of Snd's display types is time-domain data laid out as a
;; sequence of equally long traces.  The trace length is not cosmetic: as
;; snd.html says, successive peaks only line up when wavo-trace matches the
;; period in the material.  Consequently the bridge returns the traces, not
;; a flattened waveform from which the panel would have to guess the cuts.
;;
;; Snd's C renderer reads one trace after another.  wavo-hop is a screen-space
;; density (pixels between traces), so the webview tells us how many traces
;; fit at its current height and the bridge leaves their sample boundaries
;; untouched.  Long traces are sampled evenly for the wire; their start-to-
;; start distance remains exactly wavo-trace samples.
;; ------------------------------------------------------------------

(define (sv-wavo-value name snd chn fallback)
  (if (sv-have? name)
      (catch #t
        (lambda () ((symbol->value name) snd chn))
        (lambda args fallback))
      fallback))

(define (sv-wavo-trace snd chn start trace-length points)
  (let* ((data ((symbol->value 'channel->float-vector)
                start trace-length snd chn))
         (len (if (float-vector? data) (length data) 0))
         (count (if (> len 0) (min points len) 0))
         (out (make-float-vector count 0.0)))
    (when (> count 0)
      (do ((i 0 (+ i 1)))
          ((= i count))
        (let ((at (if (= count 1)
                      0
                      (round (/ (* i (- len 1)) (- count 1))))))
          (set! (out i) (data at)))))
    out))

(sv-define-op wavogram (params)
  (sv-require 'channel->float-vector)
  (let* ((snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (frames ((symbol->value 'framples) snd chn))
         (trace-length (max 2 (round (sv-wavo-value 'wavo-trace snd chn 64))))
         (hop (max 1 (round (sv-wavo-value 'wavo-hop snd chn 3))))
         (wanted (max 4 (min 256 (round (sv-arg params 'traces 64)))))
         (points (max 16 (min 2048 (round (sv-arg params 'points 512)))))
         (start (max 0 (min (max 0 (- frames 1))
                            (round (sv-arg params 'start 0)))))
         (available (max 0 (- frames start)))
         (count (if (> available 0)
                    (min wanted (max 1 (ceiling (/ available trace-length))))
                    0))
         (traces ()))
    (do ((i 0 (+ i 1)))
        ((= i count))
      (let ((at (+ start (* i trace-length))))
        (when (< at frames)
          (set! traces
                (cons (sv-wavo-trace snd chn at
                                     (min trace-length (- frames at)) points)
                      traces)))))
    (inlet 'snd snd
           'chn chn
           'fileName ((symbol->value 'short-file-name) snd)
           'srate ((symbol->value 'srate) snd)
           'frames frames
           'start start
           'traceLength trace-length
           'hop hop
           'points points
           'traces (reverse traces)
           ;; The same six orientation settings used by Snd's spectrogram
           ;; and wavogram.  One View dialog rotates both displays.
           'orientation
           (let ((var (lambda (name fallback)
                        (if (sv-have? name)
                            (catch #t
                              (lambda () (* 1.0 ((symbol->value name))))
                              (lambda args fallback))
                            fallback))))
             (inlet 'xAngle (var 'spectro-x-angle 90.0)
                    'yAngle (var 'spectro-y-angle 0.0)
                    'zAngle (var 'spectro-z-angle 358.0)
                    'xScale (var 'spectro-x-scale 1.0)
                    'yScale (var 'spectro-y-scale 1.0)
                    'zScale (var 'spectro-z-scale 0.1))))))

(sv-define-op setwavogram (params)
  (let* ((snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (trace (max 2 (min 1048576 (round (sv-arg params 'trace 64)))))
         (hop (max 1 (min 256 (round (sv-arg params 'hop 3))))))
    (sv-require 'wavo-trace)
    (sv-require 'wavo-hop)
    (sv-require 'time-graph-type)
    (unless (defined? 'graph-as-wavogram)
      (error 'sv-unavailable "graph-as-wavogram is not available in this Snd build"))
    ;; Build setter forms rather than replacing the accessor itself.  The
    ;; optional sound/channel arguments make the values visible in Snd's own
    ;; Motif graph immediately as well as in this panel.
    (eval (list 'set! (list 'wavo-trace snd chn) trace) (rootlet))
    (eval (list 'set! (list 'wavo-hop snd chn) hop) (rootlet))
    (eval (list 'set! (list 'time-graph-type snd chn)
                (symbol->value 'graph-as-wavogram))
          (rootlet))
    (inlet 'trace (sv-wavo-value 'wavo-trace snd chn trace)
           'hop (sv-wavo-value 'wavo-hop snd chn hop)
           'type ((symbol->value 'time-graph-type) snd chn))))

;; ------------------------------------------------------------------
;; File header and session state
;; ------------------------------------------------------------------

(define sv-header-types
  '(mus-next mus-aifc mus-riff mus-rf64 mus-aiff mus-nist mus-ircam mus-caff mus-raw))

(define sv-sample-types
  '(mus-lshort mus-bshort mus-lint mus-bint mus-lfloat mus-bfloat
    mus-ldouble mus-bdouble mus-mulaw mus-alaw mus-ubyte mus-byte))

(define (sv-named-constants names)
  (let loop ((rest names) (out ()))
    (if (null? rest)
        (reverse out)
        (let ((name (car rest)))
          (if (and (defined? name) (number? (symbol->value name)))
              (loop (cdr rest)
                    (cons (inlet 'name (symbol->string name)
                                 'value (symbol->value name))
                          out))
              (loop (cdr rest) out))))))

(define (sv-sound-edited? snd)
  (let ((count ((symbol->value 'channels) snd)))
    (let loop ((chn 0))
      (and (< chn count)
           (or (> ((symbol->value 'edit-position) snd chn) 0)
               (loop (+ chn 1)))))))

(define* (sv-header-info snd (comment-pending #f))
  (sv-require 'header-type)
  (sv-require 'sample-type)
  (inlet 'snd snd
         'fileName ((symbol->value 'file-name) snd)
         'shortName ((symbol->value 'short-file-name) snd)
         'headerType ((symbol->value 'header-type) snd)
         'sampleType ((symbol->value 'sample-type) snd)
         'srate ((symbol->value 'srate) snd)
         'channels ((symbol->value 'channels) snd)
         'dataLocation ((symbol->value 'data-location) snd)
         'dataSize ((symbol->value 'data-size) snd)
         'comment (or ((symbol->value 'comment) snd) "")
         'edited (sv-sound-edited? snd)
         'commentPending comment-pending
         'headerTypes (sv-named-constants sv-header-types)
         'sampleTypes (sv-named-constants sv-sample-types)))

(sv-define-op headerinfo (params)
  (sv-header-info (sv-arg params 'snd 0)))

(define (sv-valid-constant? value names)
  (and (number? value)
       (let loop ((rest names))
         (and (pair? rest)
              (or (and (defined? (car rest))
                       (= value (symbol->value (car rest))))
                  (loop (cdr rest)))))))

(define (sv-set-sound-field name snd value)
  (eval (list 'set! (list name snd) value) (rootlet)))

(sv-define-op editheader (params)
  ;; These are deliberately Snd's setters.  They alter the header and ask Snd
  ;; to reinterpret the existing bytes; they do not create an edit or invent
  ;; an undo history on the extension side.
  (let* ((snd (sv-arg params 'snd 0))
         (header (sv-arg params 'headerType ((symbol->value 'header-type) snd)))
         (sample (sv-arg params 'sampleType ((symbol->value 'sample-type) snd)))
         (rate (round (sv-arg params 'srate ((symbol->value 'srate) snd))))
         (chans (round (sv-arg params 'channels ((symbol->value 'channels) snd))))
         (location (round (sv-arg params 'dataLocation ((symbol->value 'data-location) snd))))
         (size (round (sv-arg params 'dataSize ((symbol->value 'data-size) snd))))
         ;; Snd reports "no comment" as #f while an HTML textarea reports it
         ;; as "".  Those are the same no-op; treating them as different asks
         ;; Snd to install an empty comment, which some header writers reject.
         (old-comment (or ((symbol->value 'comment) snd) ""))
         (comment (sv-arg params 'comment old-comment))
         (comment-changed (not (equal? comment old-comment)))
         (had-edits (sv-sound-edited? snd))
         (set-location (sv-arg params 'setLocation #f))
         (set-size (sv-arg params 'setSize #f)))
    (unless (sv-valid-constant? header sv-header-types)
      (error 'sv-bad-header "unknown or unwritable header type"))
    (unless (sv-valid-constant? sample sv-sample-types)
      (error 'sv-bad-header "unknown sample type"))
    (unless (and (> rate 0) (> chans 0) (>= location 0) (>= size 0))
      (error 'sv-bad-header "sample rate/channels must be positive; location/size cannot be negative"))
    ;; Header type first so Snd can choose the syntactically correct default
    ;; data location.  An unchanged location from the form must not overwrite
    ;; that choice; only an explicitly edited location is applied afterwards.
    (unless (= header ((symbol->value 'header-type) snd))
      (sv-set-sound-field 'header-type snd header))
    (unless (= sample ((symbol->value 'sample-type) snd))
      (sv-set-sound-field 'sample-type snd sample))
    (unless (= rate ((symbol->value 'srate) snd))
      (sv-set-sound-field 'srate snd rate))
    (unless (= chans ((symbol->value 'channels) snd))
      (sv-set-sound-field 'channels snd chans))
    (when set-location (sv-set-sound-field 'data-location snd location))
    (when set-size (sv-set-sound-field 'data-size snd size))
    ;; Snd's public comment setter keeps the value with the open sound and
    ;; writes it on the next Save Sound.  Unlike save-sound, it never folds
    ;; unrelated unsaved edits into a header operation behind the user's back.
    (when comment-changed
      (sv-set-sound-field 'comment snd comment))
    ;; With no sample edits to preserve, Save Sound is the public Snd path
    ;; that commits a changed comment to the header.  With edits present it
    ;; would also save those edits, which Edit Header explicitly must not do;
    ;; in that case the comment remains staged and the panel says so.
    (when (and comment-changed (not had-edits))
      (sv-require 'save-sound)
      ((symbol->value 'save-sound) snd))
    (sv-header-info snd (and comment-changed had-edits))))

(sv-define-op savestate (params)
  (sv-require 'save-state)
  (let ((file (sv-arg params 'file "")))
    (when (= (length file) 0)
      (error 'sv-bad-state-file "save-state needs a file name"))
    ((symbol->value 'save-state) file)
    (inlet 'file file)))

;; ------------------------------------------------------------------
;; Regions and mixes
;;
;; Snd's last two dialogs without a counterpart here. Both are lists of
;; objects with a handful of accessors, so both are trees rather than
;; windows -- which is the one thing this side can do better: Snd's region
;; browser and mix dialog are two more windows to arrange, and a tree is
;; simply there.
;;
;; A REGION is a copy of some samples, made by a selection (when
;; selection-creates-region is on) or by make-region. It outlives the
;; selection it came from, and there are only max-regions of them -- the
;; oldest is dropped when a new one arrives, which is worth knowing before
;; wondering where one went.
;;
;; A MIX is a piece of sound laid over a channel, still movable: position and
;; amplitude are settable and each change is an edit. That is the difference
;; from having mixed something in destructively, and it is why the tree shows
;; them at all.
;; ------------------------------------------------------------------

(sv-define-op regions (params)
  (if (not (and (sv-in-snd?) (sv-have? 'regions)))
      #()
      (let ((all ((symbol->value 'regions))))
        (map (lambda (r)
               (inlet 'index (sv-region-index r)
                      'frames (catch #t (lambda () ((symbol->value 'region-framples) r))
                                     (lambda args 0))
                      'channels (catch #t (lambda () ((symbol->value 'region-chans) r))
                                       (lambda args 1))
                      'srate (catch #t (lambda () ((symbol->value 'region-srate) r))
                                    (lambda args 0))
                      'position (catch #t (lambda () ((symbol->value 'region-position) r 0))
                                       (lambda args 0))
                      ;; region-home is where it came from: sound, channel,
                      ;; begin and end. Without it a region list is a row of
                      ;; numbers with no way back to the sound.
                      'home (catch #t
                              (lambda ()
                                (let ((h ((symbol->value 'region-home) r)))
                                  (if (pair? h)
                                      (object->string h)
                                      "")))
                              (lambda args ""))))
             (if (list? all) all (list all))))))

(sv-define-op regionaction (params)
  (let* ((action (sv-arg params 'action ""))
         (region (sv-region (sv-arg params 'region 0)))
         (snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (at (sv-arg params 'at 0)))
    (cond
     ((string=? action "play")
      (sv-require 'play)
      ;; A region is played by handing it to play as the object, exactly
      ;; like a sound: "The object can be a string, a sound object or index,
      ;; a region, a mix ...".
      ((symbol->value 'play) region)
      (inlet 'playing #t))
     ((string=? action "insert")
      (sv-require 'insert-region)
      ((symbol->value 'insert-region) region at snd chn)
      (inlet 'editPosition ((symbol->value 'edit-position) snd chn)))
     ((string=? action "mix")
      (sv-require 'mix-region)
      ((symbol->value 'mix-region) region at snd chn)
      (inlet 'editPosition ((symbol->value 'edit-position) snd chn)))
     ((string=? action "save")
      ;; KEYWORDS: save-region reg :file :sample-type :header-type :comment
      (sv-require 'save-region)
      (let ((file (sv-arg params 'file "")))
        ((symbol->value 'save-region) region :file file)
        (inlet 'file file)))
     ((string=? action "forget")
      (sv-require 'forget-region)
      ((symbol->value 'forget-region) region)
      (inlet 'forgotten #t))
     (else (error 'sv-unknown-action (string-append "not a region action: " action))))))

(sv-define-op mixes (params)
  (if (not (and (sv-in-snd?) (sv-have? 'mixes)))
      #()
      (let* ((snd (sv-arg params 'snd 0))
             (chn (sv-arg params 'chn 0))
             (all (catch #t
                    (lambda () ((symbol->value 'mixes) snd chn))
                    (lambda args ()))))
        (map (lambda (m)
               (inlet 'index (sv-mix-index m)
                      'position (catch #t (lambda () ((symbol->value 'mix-position) m))
                                       (lambda args 0))
                      'frames (catch #t (lambda () ((symbol->value 'mix-length) m))
                                     (lambda args 0))
                      'amp (catch #t (lambda () ((symbol->value 'mix-amp) m))
                                  (lambda args 1.0))
                      'name (catch #t (lambda () (or ((symbol->value 'mix-name) m) ""))
                                   (lambda args ""))
                      'home (catch #t
                              (lambda ()
                                (let ((h ((symbol->value 'mix-home) m)))
                                  (if (pair? h) (object->string h) "")))
                              (lambda args ""))))
             (if (list? all) all (list all))))))

(sv-define-op mixaction (params)
  (let* ((action (sv-arg params 'action ""))
         (mix (sv-mix (sv-arg params 'mix 0)))
         (snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0)))
    (cond
     ((string=? action "position")
      ;; Moving a mix is an EDIT, which is the whole point of a mix still
      ;; being a mix: it can be moved and the move can be undone.
      (set! ((symbol->value 'mix-position) mix) (sv-arg params 'value 0))
      (inlet 'position ((symbol->value 'mix-position) mix)
             'editPosition ((symbol->value 'edit-position) snd chn)))
     ((string=? action "amp")
      (set! ((symbol->value 'mix-amp) mix) (* 1.0 (sv-arg params 'value 1.0)))
      (inlet 'amp ((symbol->value 'mix-amp) mix)))
     ((string=? action "name")
      (set! ((symbol->value 'mix-name) mix) (sv-arg params 'text ""))
      (inlet 'name ((symbol->value 'mix-name) mix)))
     ((string=? action "play")
      (sv-require 'play)
      ((symbol->value 'play) mix)
      (inlet 'playing #t))
     (else (error 'sv-unknown-action (string-append "not a mix action: " action))))))

(sv-define-op markaction (params)
  ;; Marks follow the edit list -- "if the deleted mark was present in an
  ;; earlier edit, and you undo to that point, the mark comes back to life".
  ;; So adding and deleting marks is undoable like everything else, and the
  ;; tree does not need its own bookkeeping.
  (let* ((action (sv-arg params 'action ""))
         (snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0)))
    (cond
     ((string=? action "add")
      (sv-require 'add-mark)
      ;; add-mark sample snd chn name sync
      (let* ((name (sv-arg params 'text ""))
             (mark (if (> (length name) 0)
                       ((symbol->value 'add-mark) (sv-arg params 'sample 0) snd chn name)
                       ((symbol->value 'add-mark) (sv-arg params 'sample 0) snd chn))))
        (inlet 'sample ((symbol->value 'mark-sample) mark))))
     ((string=? action "delete")
      (sv-require 'delete-mark)
      ((symbol->value 'delete-mark) (sv-arg params 'mark 0))
      (inlet 'deleted #t))
     ((string=? action "name")
      (set! ((symbol->value 'mark-name) (sv-arg params 'mark 0)) (sv-arg params 'text ""))
      (inlet 'name (sv-arg params 'text "")))
     ((string=? action "move")
      (set! ((symbol->value 'mark-sample) (sv-arg params 'mark 0)) (sv-arg params 'sample 0))
      (inlet 'sample (sv-arg params 'sample 0)))
     (else (error 'sv-unknown-action (string-append "not a mark action: " action))))))

(sv-define-op sync (params)
  ;; Grouping sounds for simultaneous editing. From snd.html: sounds that
  ;; share a sync value other than 0 are edited together, and 0 means "on its
  ;; own". sync-max gives a value known to be unused, which is how one makes a
  ;; new group without collecting the existing ones by accident.
  (let ((snd (sv-arg params 'snd 0))
        (value (sv-arg params 'value 0)))
    ;; "new" arrives as a STRING, not a symbol: the wire format carries
    ;; numbers, booleans and strings, and inletLiteral quotes anything
    ;; textual. Comparing it with eq? against a symbol is always false, so
    ;; asking for a new group silently set the sync field to the string --
    ;; which Snd would then reject somewhere else entirely.
    (set! ((symbol->value 'sync) snd)
          (if (and (string? value) (string=? value "new"))
              (+ 1 ((symbol->value 'sync-max)))
              value))
    (inlet 'sync ((symbol->value 'sync) snd))))

;; ------------------------------------------------------------------
;; graph-hook and lisp-graph-hook: user drawing code
;;
;; This is the extension point that decides whether these panels are the same
;; editor or a parallel one. `display-bark-fft` in dsp.scm lives here, so does
;; `display-energy` in examp.scm, and so does whatever anybody has written for
;; their own work over twenty years. All of it works by calling `graph`:
;;
;;   (graph data "energy" x0 x1 y0 y1 snd chn #f)
;;
;; -- which in a GUI build draws into the third pane beside the time and fft
;; graphs, and in a headless build draws nowhere.
;;
;; So: WRAP `graph`. The original is kept and still called (harmless in nogui,
;; correct in a Motif build where both editors then show it), and the arguments
;; are recorded on the way past. Then the hook is run on demand and whatever it
;; drew comes back as data.
;;
;; Wrapping a Snd function that user code calls is a real intrusion and is
;; worth stating plainly rather than burying: after this, `graph` is not
;; exactly Snd's `graph`. It is Snd's `graph` plus a recorder. Nothing else in
;; this file redefines anything of Snd's.
;;
;; TWO HOOKS, TWO DIFFERENT CONTRACTS:
;;
;;   lisp-graph-hook (snd chn) -- "called just before the lisp graph is updated
;;   or redisplayed". Running it ourselves is what makes user drawing appear;
;;   it has no result to honour, and its functions expect to be called during
;;   a redraw, which is exactly when we call it.
;;
;;   graph-hook (snd chn y0 y1) -- "If it returns #t, the display is not
;;   updated." Here the result MATTERS, and honouring it is the one place this
;;   file reads a hook result rather than leaving it alone. That is not an
;;   exception to the observer rule but the other side of it: an observer must
;;   not WRITE a result; a caller standing in for Snd's own redraw must READ
;;   one, or a user function that says "do not draw this" is ignored.
;; ------------------------------------------------------------------

(define sv-graph-traces ())
(define sv-graph-original #f)
(define sv-graph-wrapped #f)

(define (sv-graph-points data limit)
  ;; A trace as numbers, sampled evenly to at most `limit` points. Not min/max
  ;; reduced like a waveform: this is a computed curve, and its shape is the
  ;; message -- an envelope of a spectrum has no meaningful "range within a
  ;; column", it has values.
  (catch #t
    (lambda ()
      (let* ((n (length data))
             (step (max 1 (round (/ n (max 1 limit)))))
             (out ()))
        (do ((i 0 (+ i step)))
            ((>= i n) (reverse out))
          (set! out (cons (* 1.0 (data i)) out)))))
    (lambda (type info) ())))

(define (sv-note-graph arguments)
  ;; `graph` takes data xlabel x0 x1 y0 y1 snd chn force-display show-axes.
  ;; data can be a float-vector, a LIST of float-vectors (several traces at
  ;; once, drawn in the superimposed-channel colours), or a list of numbers,
  ;; which Snd reads as an envelope -- "If 'data' is a list of numbers, it is
  ;; assumed to be an envelope (a list of breakpoints)".
  (let* ((data (if (pair? arguments) (car arguments) #f))
         (rest (if (pair? arguments) (cdr arguments) ()))
         (nth (lambda (i default)
                (let loop ((r rest) (k 0))
                  (cond ((null? r) default)
                        ((= k i) (if (car r) (car r) default))
                        (else (loop (cdr r) (+ k 1)))))))
         (label (nth 0 ""))
         (x0 (nth 1 0.0))
         (x1 (nth 2 1.0))
         (traces (cond ((float-vector? data) (list (sv-graph-points data 1024)))
                       ((and (pair? data) (float-vector? (car data)))
                        (map (lambda (v) (sv-graph-points v 1024)) data))
                       ((and (pair? data) (number? (car data)))
                        ;; An envelope: breakpoints, not a trace. Kept as it
                        ;; is so the panel can draw it as line segments rather
                        ;; than resampling a curve that has none.
                        (list (map (lambda (v) (* 1.0 v)) data)))
                       (else ()))))
    (when (pair? traces)
      (set! sv-graph-traces
            (cons (inlet 'label (if (string? label) label "")
                         'x0 (* 1.0 x0)
                         'x1 (* 1.0 x1)
                         'envelope (and (pair? data) (number? (car data)) #t)
                         'traces traces)
                  sv-graph-traces)))))

(define (sv-wrap-graph!)
  (unless sv-graph-wrapped
    (when (sv-have? 'graph)
      (catch #t
        (lambda ()
          (set! sv-graph-original (symbol->value 'graph))
          (eval (list 'define 'graph
                      (list 'lambda 'arguments
                            (list 'sv-note-graph 'arguments)
                            ;; The original still runs, in a catch: in a nogui
                            ;; build it may refuse for want of a widget, and a
                            ;; user's drawing function must not fail because of
                            ;; that -- it did its job by calling graph.
                            (list 'catch #t
                                  (list 'lambda ()
                                        (list 'apply 'sv-graph-original 'arguments))
                                  (list 'lambda '(type info) #f))))
                (rootlet))
          (set! sv-graph-wrapped #t))
        (lambda (type info) #f)))))

(sv-define-op lispgraph (params)
  ;; Run the user's lisp-graph-hook and return what it drew.
  (let ((snd (sv-arg params 'snd 0))
        (chn (sv-arg params 'chn 0)))
    (sv-wrap-graph!)
    (set! sv-graph-traces ())
    (let* ((hook (sv-hook-of 'lisp-graph-hook))
           (functions (if hook (hook-functions hook) ()))
           (failed #f))
      (when (pair? functions)
        ;; POSITIONALLY: an s7 hook is called (hook snd chn) and builds the
        ;; environment its functions read. Handing it an inlet binds the inlet
        ;; to the first argument and every field reads #f.
        (catch #t
          (lambda () (hook snd chn))
          (lambda (type info)
            (set! failed (object->string info)))))
      (inlet 'installed (length functions)
             'graphs (reverse sv-graph-traces)
             'failed (or failed #f)))))

(define (sv-graph-hook-suppresses? snd chn y0 y1)
  ;; graph-hook: "If it returns #t, the display is not updated."
  ;;
  ;; READ, not written. The panels stand in for Snd's own redraw here, and a
  ;; user function that says "do not draw this" has to be obeyed or it is
  ;; worse than not supporting the hook at all -- it would look supported.
  (let ((hook (sv-hook-of 'graph-hook)))
    (if (or (not hook) (null? (hook-functions hook)))
        #f
        (catch #t
          (lambda ()
            ;; Calling an s7 hook returns the RESULT, not the environment --
            ;; (h 0 1) gives back whatever the functions left in (h 'result),
            ;; already unwrapped. Expecting an environment and reading
            ;; 'result off it yields #f for every hook that ever fired, which
            ;; is a suppression check that never suppresses: the hook would
            ;; look supported and be ignored, the exact failure the comment
            ;; above warns about.
            (eq? (hook snd chn y0 y1) #t))
          (lambda (type info) #f)))))

;; ------------------------------------------------------------------
;; Find
;;
;; "Searches in Snd refer to the sound data ... The expression it asks for is
;; a function that takes one argument, the current sample value, and returns
;; #t when it finds a match. To look for the next sample that is greater than
;; .1, (lambda (y) (> y .1))."
;;
;; So Find is not a text search: it is a predicate applied to samples, and
;; the predicate can be a closure -- his own zero+ example keeps the previous
;; sample in a let and finds zero crossings. That is the whole point of it,
;; and it is why the expression has to be EVALUATED rather than parsed into
;; some little query language of mine: any restriction I invented would rule
;; out exactly the searches that make the feature worth having.
;;
;; The expression comes from a prompt the user typed into, like the REPL, so
;; evaluating it grants no access the REPL does not already have. What it must
;; not do is arrive from a panel button -- and it does not; the only caller is
;; the Find command.
;;
;; The scan is a do loop over a sampler, which is what the reference
;; recommends now that scan-channel is obsolete: "scan-channel is obsolete;
;; use a do loop with a sampler".

(sv-define-op find (params)
  (sv-require 'make-sampler)
  (let* ((snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (expr (sv-arg params 'expr ""))
         (backwards (sv-arg params 'backwards #f))
         (from (sv-arg params 'from (if (sv-in-snd?)
                                        ((symbol->value 'cursor) snd chn)
                                        0)))
         (frames ((symbol->value 'framples) snd chn))
         (predicate (eval-string expr (rootlet))))
    (unless (procedure? predicate)
      (error 'sv-bad-search
             "a search expression must evaluate to a procedure of one argument, like (lambda (y) (> y .1))"))
    ;; Snd's own search-procedure is set too, so C-s in a Motif window and
    ;; Find here look for the same thing -- one search, two front ends.
    (when (sv-have? 'search-procedure)
      (catch #t
        (lambda () (set! ((symbol->value 'search-procedure)) predicate))
        (lambda args #f)))
    (let* ((direction (if backwards -1 1))
           (start (max 0 (min (- frames 1) (+ from direction))))
           (reader ((symbol->value 'make-sampler) start snd chn direction))
           (limit (if backwards start (- frames start))))
      (let loop ((i 0))
        (if (>= i limit)
            (inlet 'found #f 'from from 'backwards backwards)
            (let* ((position (+ start (* direction i)))
                   (value ((symbol->value 'read-sample) reader)))
              (if (catch #t
                    (lambda () (and (predicate value) #t))
                    (lambda (type info)
                      (error 'sv-search-error
                             (string-append "the search expression failed on a sample: "
                                            (object->string info)))))
                  (begin
                    (set! ((symbol->value 'cursor) snd chn) position)
                    (inlet 'found #t 'sample position 'value value))
                  (loop (+ i 1)))))))))

;; ------------------------------------------------------------------
;; The keyboard, as Snd has it
;;
;; "Editing in Snd is modelled after Emacs in many regards. Each channel has a
;; cursor (a big "+"), a set of marks, and a list of edits ... Where an
;; operation has an obvious analog in text editing, I've tried to use the
;; associated Emacs command. To delete the sample at the cursor, for example,
;; use C-d."
;;
;; The panel had a mouse and buttons; this is the other half. Every entry
;; below is the function Snd's own key binding calls, and the chord is in the
;; comment so the table can be read against snd.html.
;;
;; A WHITELIST, again, and for the same reason as the edit buttons: a
;; keystroke that carries a function name to be evaluated is eval with a
;; keyboard in front of it.
;;
;; NUMERIC ARGUMENTS are Snd's too -- "All keyboard commands accept numerical
;; arguments, as in Emacs" -- and a float is multiplied by the sampling rate
;; before use, so C-u 2.1 C-f moves 2.1 seconds. That conversion happens here
;; rather than in the panel, because the sampling rate is Snd's to know.
;; ------------------------------------------------------------------

(define (sv-count params snd chn)
  ;; An integer is samples; a float is seconds, as in Snd.
  (let ((n (sv-arg params 'count 1)))
    (if (integer? n)
        n
        (round (* n ((symbol->value 'srate) snd))))))

(sv-define-op key (params)
  (let* ((action (sv-arg params 'action ""))
         (snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0))
         (count (sv-count params snd chn))
         (at (lambda () ((symbol->value 'cursor) snd chn)))
         (frames (lambda () ((symbol->value 'framples) snd chn)))
         (put (lambda (sample)
                (set! ((symbol->value 'cursor) snd chn)
                      (max 0 (min (- (frames) 1) sample))))))
    (cond
     ;; --- moving, which changes no samples
     ((string=? action "start") (put 0))                       ; C-a / <
     ((string=? action "end") (put (- (frames) 1)))             ; C-e / >
     ((string=? action "forward") (put (+ (at) count)))         ; C-f
     ((string=? action "backward") (put (- (at) count)))        ; C-b
     ;; "C-n move cursor ahead one 'line'" -- and a line in Snd is 128
     ;; samples, which is what C-k deletes. Not a guess: the same number
     ;; appears in both bindings in snd.html.
     ((string=? action "down") (put (+ (at) (* 128 count))))    ; C-n
     ((string=? action "up") (put (- (at) (* 128 count))))      ; C-p
     ((string=? action "next-mark")                             ; C-j
      (let ((ms (catch #t (lambda () ((symbol->value 'marks) snd chn)) (lambda args ()))))
        (let loop ((rest (if (list? ms) ms (list ms))))
          (cond ((null? rest) #f)
                ((> ((symbol->value 'mark-sample) (car rest)) (at))
                 (put ((symbol->value 'mark-sample) (car rest))))
                (else (loop (cdr rest)))))))
     ;; --- editing
     ((string=? action "delete-sample")                         ; C-d
      (sv-require 'delete-samples)
      ((symbol->value 'delete-samples) (at) count snd chn))
     ((string=? action "delete-previous")                       ; C-h
      (sv-require 'delete-samples)
      (let ((from (max 0 (- (at) count))))
        ((symbol->value 'delete-samples) from (- (at) from) snd chn)
        (put from)))
     ((string=? action "delete-line")                           ; C-k
      (sv-require 'delete-samples)
      ((symbol->value 'delete-samples) (at) (* 128 count) snd chn))
     ((string=? action "insert-zero")                           ; C-o
      (sv-require 'insert-silence)
      ((symbol->value 'insert-silence) (at) count snd chn))
     ((string=? action "zero-sample")                           ; C-z
      (let loop ((i 0))
        (when (< i count)
          (set! ((symbol->value 'sample) (+ (at) i) snd chn) 0.0)
          (loop (+ i 1)))))
     ((string=? action "mark")                                  ; C-m
      (sv-require 'add-mark)
      ((symbol->value 'add-mark) (at) snd chn))
     ((string=? action "paste")                                 ; C-y
      (sv-require 'insert-selection)
      ((symbol->value 'insert-selection) (at) snd chn))
     ((string=? action "delete-selection")                      ; C-w
      (sv-require 'delete-selection)
      ((symbol->value 'delete-selection)))
     ((string=? action "mix-selection")                         ; C-x q
      (sv-require 'mix-selection)
      ((symbol->value 'mix-selection) (at) snd chn))
     ((string=? action "smooth")                                ; C-x C-z
      (sv-require 'smooth-sound)
      ((symbol->value 'smooth-sound) (at) count snd chn))
     (else (error 'sv-unknown-key (string-append "not a key action: " action))))
    (inlet 'action action
           'cursor (at)
           'editPosition ((symbol->value 'edit-position) snd chn))))

;; ------------------------------------------------------------------
;; The Edit menu
;;
;; What turns the waveform panel from a view into an editor.  Every one of
;; these is a Snd function -- delete-selection, scale-selection-by,
;; src-selection -- and every one of them puts ONE entry in Snd's edit
;; history.  That is why they are here rather than in the webview: an
;; implementation in JavaScript would need its own undo stack, and Snd's
;; is the one that gets saved.
;;
;; The names are a whitelist and not a passthrough.  A generic
;; "run this edit function" op would be indistinguishable from eval, and
;; then the button on a panel could carry anything.  eval exists for the
;; REPL, where the user typed it.
;;
;; Missing from Snd's own Edit menu, deliberately: "Edit header".  Changing
;; the sample rate or channel count of an open sound is not an edit in the
;; history -- it reinterprets the samples -- and it belongs with saving,
;; not with cut and paste.

;; name, function, needs a selection?, and whether it takes a POSITION.
;;
;; The position column is the one that mattered.  From Snd's own reference:
;;
;;   insert-selection beg snd chn
;;   "The Edit:Insert selection menu choice is essentially
;;    (insert-selection (cursor))"
;;   mix-selection beg snd chn selection-chan
;;   "The Edit:Mix selection menu choice is essentially
;;    (mix-selection (cursor))"
;;
;; Called with no arguments, beg is 0 -- so "insert at cursor" pasted at the
;; start of the file regardless of where the cursor was.  Not an error, no
;; message: just the wrong place, which is the worst kind of wrong for an
;; edit.  delete, reverse and smooth genuinely take nothing, which is why
;; the mistake was invisible in the other buttons.
(define sv-edit-actions
  (list
   ;; name             function                      selection?  position?
   (list "delete"        'delete-selection             #t #f)
   (list "delete-smooth" 'delete-selection-and-smooth  #t #f)
   (list "insert"        'insert-selection             #t #t)
   (list "mix"           'mix-selection                #t #t)
   (list "reverse"       'reverse-selection            #t #f)
   (list "smooth"        'smooth-selection             #t #f)
   (list "select-all"    'select-all                   #f #f)
   (list "unselect-all"  'unselect-all                 #f #f)))

(sv-define-op edit (params)
  (let* ((action (sv-arg params 'action ""))
         (entry (assoc action sv-edit-actions))
         (snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0)))
    (unless entry
      (error 'sv-unknown-edit (string-append "not an edit action: " action)))
    (let ((name (cadr entry))
          (needs-selection (caddr entry))
          (takes-position (list-ref entry 3)))
      (sv-require name)
      ;; Checked here rather than left to Snd: without a selection several
      ;; of these operate on the whole channel instead of doing nothing,
      ;; which from a button press is indistinguishable from a misclick
      ;; that just deleted the file.
      (when (and needs-selection
                 (not (and (sv-have? 'selection?) ((symbol->value 'selection?)))))
        (error 'sv-no-selection (string-append action " needs a selection")))
      (if takes-position
          ;; The cursor of the channel being edited, exactly as Snd's own
          ;; Edit menu does it.
          ((symbol->value name) ((symbol->value 'cursor) snd chn) snd chn)
          ((symbol->value name)))
      (inlet 'action action
             'editPosition ((symbol->value 'edit-position) snd chn)
             'selection (sv-selection-of snd chn)))))

(sv-define-op scale (params)
  ;; Amplitude, as a factor or to a peak. Two functions rather than one
  ;; because "twice as loud" and "as loud as it can be" are different
  ;; intentions, and computing the factor for the second one on the
  ;; extension side would need the peak, which means a round trip that can
  ;; be stale by the time it is used.
  (let ((snd (sv-arg params 'snd 0))
        (chn (sv-arg params 'chn 0))
        (factor (sv-arg params 'factor #f))
        (peak (sv-arg params 'peak #f))
        (selection (sv-arg params 'selection #f)))
    (cond ((and selection factor)
           (sv-require 'scale-selection-by)
           ((symbol->value 'scale-selection-by) factor))
          ((and selection peak)
           (sv-require 'scale-selection-to)
           ((symbol->value 'scale-selection-to) peak))
          (factor
           (sv-require 'scale-channel)
           ((symbol->value 'scale-channel) factor 0 #f snd chn))
          (peak
           (sv-require 'scale-to)
           ((symbol->value 'scale-to) peak snd))
          (else (error 'sv-bad-args "scale needs a factor or a peak")))
    (inlet 'editPosition ((symbol->value 'edit-position) snd chn))))

(sv-define-op resample (params)
  ;; src-selection / src-channel: the sample-rate conversion that changes
  ;; length and pitch together. Snd's own, so the interpolation is Snd's.
  (let ((snd (sv-arg params 'snd 0))
        (chn (sv-arg params 'chn 0))
        (ratio (sv-arg params 'ratio 1.0))
        (selection (sv-arg params 'selection #f)))
    (if selection
        (begin (sv-require 'src-selection) ((symbol->value 'src-selection) ratio))
        (begin (sv-require 'src-channel)
               ((symbol->value 'src-channel) ratio 0 #f snd chn)))
    (inlet 'editPosition ((symbol->value 'edit-position) snd chn))))

(sv-define-op saveselection (params)
  ;; KEYWORDS, not positional. From the reference:
  ;;   save-selection :file :srate :sample-type (:header-type mus-next)
  ;;                  :comment :channel
  ;; A positional call puts the filename where :file's KEYWORD belongs, and
  ;; the file is written -- somewhere else, under Snd's default name.
  (sv-require 'save-selection)
  (let ((file (sv-arg params 'file "")))
    ((symbol->value 'save-selection) :file file)
    (inlet 'file file)))

;; ------------------------------------------------------------------
;; Dispatch
;; ------------------------------------------------------------------

(define (sv-request id op params)
  ;; catch #t around everything: an unbound Snd function, a bad sample
  ;; index, a reader error in evaluated code -- all of it has to come
  ;; back as a frame.  An error that escapes here reaches Snd's error
  ;; handler, prints into the listener and leaves the extension waiting
  ;; for an answer that will never come.  A hang, not an error message.
  (let ((err (open-output-string)))
    (let ((result
           (catch #t
             (lambda ()
               (let ((handler (sv-ops (if (symbol? op) op (string->symbol op)))))
                 (if (not handler)
                     (error 'sv-unknown-op (string-append "unknown op: "
                                                          (object->string op)))
                     (let-temporarily (((current-error-port) err))
                       (inlet 'ok #t 'value (handler (or params (inlet))))))))
             (lambda (type info)
               (inlet 'ok #f
                      'error (let ((port (open-output-string)))
                               (if (and (pair? info) (string? (car info)))
                                   (catch #t
                                     (lambda () (apply format port info))
                                     (lambda args (display info port)))
                                   (display info port))
                               (get-output-string port))
                      'errorType (symbol->string type))))))
      (sv-emit (varlet result
                       'id (if (string? id) id (object->string id))
                       'op (if (symbol? op) (symbol->string op) op)
                       'stderr (get-output-string err))))))

;; Short alias -- every request carries it, and in the Motif case Snd
;; reads the line, so shorter lines mean less to go wrong.
(define sv sv-request)

;; ------------------------------------------------------------------
;; Hooks: the editor should not have to poll
;; ------------------------------------------------------------------

;; Snd's THREE channel hooks, by name, from its own documentation:
;; "Channel-specific hooks: edit-hook (snd chn), undo-hook (snd chn),
;; after-edit-hook (snd chn) -- these are functions that return the hooks in
;; question associated with the specified channel."
;;
;; By name and not by inspection, because in s7 a hook IS a closure: trying
;; (hook-functions x) succeeds for any closure, so it cannot tell a hook
;; from a function that returns one. The list is short, documented, and has
;; not changed in years -- and a name added to it later is a smaller risk
;; than a predicate that quietly says yes to everything.
(define sv-channel-hook-names '(edit-hook undo-hook after-edit-hook))

(define (sv-hook? value)
  (and value
       (procedure? value)
       (catch #t
         (lambda () (list? (hook-functions value)))
         (lambda (type info) #f))))

(define (sv-hook-of name)
  ;; A GLOBAL hook only. Returns #f for the channel hooks even though they
  ;; look like hooks from here -- that is the whole point of this function.
  (and (defined? name)
       (not (memq name sv-channel-hook-names))
       (let ((value (catch #t (lambda () (symbol->value name)) (lambda args #f))))
         (and (sv-hook? value) value))))

(define (sv-add-hook! hook handler)
  ;; ADDITIVE, and at the FRONT is fine because in Scheme every function on a
  ;; hook runs and the order does not decide the outcome: "In Scheme, all
  ;; functions are run, each takes one argument, the hook environment, and any
  ;; return values are ignored. It is up to the individual functions to track
  ;; (hook 'result) if intermediate results matter."
  ;;
  ;; Which gives the rule this whole file follows: an observer installed from
  ;; here NEVER sets (hook 'result). Setting it would silently take over a
  ;; decision that belongs to the user's own hook functions -- cancelling an
  ;; edit, refusing an exit, suppressing a warning -- and a Snd user's ~/.snd
  ;; is mostly hook functions. Watching must not become deciding.
  (set! (hook-functions hook) (cons handler (hook-functions hook))))

;; ------------------------------------------------------------------
;; What the editor watches
;;
;; Snd's customization model is hooks, and until now the bridge installed two
;; of twenty-seven. The rest are events the panels and the tree were guessing
;; at, or not noticing at all.
;;
;; Each entry: the hook's name, the event to emit, and which of the hook's own
;; arguments to carry along -- the names are Snd's, read out of the hook
;; environment with (hook 'name), which is how Scheme hooks pass arguments.
(define sv-observed-hooks
  '((start-playing-hook   playing      (snd))
    ;; stop-playing-hook is NOT in this table, though it is the one the
    ;; playhead needed -- until now the playhead stopped because play-hook
    ;; stopped being called, which works and is an inference.
    ;;
    ;; It lives in sv-install-play-hooks, which already had a handler there to
    ;; reset the position, and that handler now emits the event as well. Two
    ;; handlers on one hook is perfectly legal in Snd -- every handler runs --
    ;; but two handlers each emitting 'stopped is one event too many, and the
    ;; reset has to happen BEFORE the panels hear about it or a refetch reads
    ;; the old playhead.
    ;;
    ;; Found by a test that COUNTED the handlers instead of trusting the
    ;; install-once flag: the flag guarded this table against itself and knew
    ;; nothing about the play code.
    (stop-playing-selection-hook stopped ())
    ;; after-open-hook and close-hook are NOT here. They are installed in
    ;; sv-install-hooks because opening also has to hang the edit watch on the
    ;; new channels, which this table has no way to express. Listing them in
    ;; both places would install two handlers, and Snd runs every handler on a
    ;; hook -- two 'edited events per edit, and the panels fetching a waveform
    ;; twice per keystroke. That double install has already cost an evening
    ;; once, in sv-watch-channel.
    (new-sound-hook       newsound     (name))
    ;; Marks and mixes move from places the editor cannot see -- a script, a
    ;; Motif window, a drag. Without these the tree is right only after the
    ;; next edit.
    (mark-hook            markchanged  (id snd chn reason))
    (mix-release-hook     mixmoved     (id samples))
    (mix-click-hook       mixclicked   (id))
    ;; Snd's own warnings go to the listener, and in a headless build to a
    ;; terminal that may not be open. They belong where a VS Code user looks.
    (snd-error-hook       snderror     (message))
    (snd-warning-hook     sndwarning   (message))
    (mus-error-hook       muserror     (type message))))

(define sv-installed-hooks (make-hash-table))

;; ------------------------------------------------------------------
;; Snd objects on the wire, one last time
;;
;; A hook argument is whatever Snd passes it, and Snd passes OBJECTS:
;; after-open-hook gets a sound object, mark-hook a mark, mix-release-hook a
;; mix. Sent as they are, they encode as "#<sound 1>" -- a string where the
;; panel expects a number, so `typeof frame.snd === 'number'` is false and
;; nothing follows the new sound. Which is exactly the bug that opened this
;; whole project: (sounds) returning objects, encoded as "#<sound 1>", and
;; rejected three requests later.
;;
;; The ops learned this and convert at their boundary. The EVENT path never
;; did, because until today it only ever carried numbers that Snd had already
;; reduced.
;;
;; INTEGER? IS ASKED FIRST, and that is the other half of the same lesson:
;; sound?, mark?, mix? and region? are validity predicates, not type
;; predicates -- each says #t for a valid index as readily as for the object,
;; so asking sound? first sends integers through sound->integer, which refuses
;; them.
(define (sv-wire value)
  (cond ((integer? value) value)
        ((real? value) value)
        ((string? value) value)
        ((boolean? value) value)
        ((not (sv-in-snd?)) value)
        ((and (sv-have? 'sound?) (sv-have? 'sound->integer)
              (catch #t (lambda () ((symbol->value 'sound?) value)) (lambda args #f)))
         ((symbol->value 'sound->integer) value))
        ((and (sv-have? 'mark?) (sv-have? 'mark->integer)
              (catch #t (lambda () ((symbol->value 'mark?) value)) (lambda args #f)))
         ((symbol->value 'mark->integer) value))
        ((and (sv-have? 'mix?) (sv-have? 'mix->integer)
              (catch #t (lambda () ((symbol->value 'mix?) value)) (lambda args #f)))
         ((symbol->value 'mix->integer) value))
        ((and (sv-have? 'region?) (sv-have? 'region->integer)
              (catch #t (lambda () ((symbol->value 'region?) value)) (lambda args #f)))
         ((symbol->value 'region->integer) value))
        ;; Anything else as text rather than dropped: an event that mentions
        ;; something unrecognised is more use than an event that does not
        ;; arrive.
        (else (object->string value))))

(define (sv-hook-argument env name)
  ;; (hook 'name), guarded: not every hook carries every name in every build,
  ;; and a missing one must not take the handler down -- a handler that raises
  ;; inside a hook takes the operation the hook was reporting on with it.
  (catch #t
    (lambda () (if (defined? name env) (sv-wire (env name)) #f))
    (lambda args #f)))

(define (sv-observe-hooks)
  (for-each
   (lambda (entry)
     (let* ((name (car entry))
            (event (cadr entry))
            (arguments (caddr entry)))
       (unless (sv-installed-hooks name)
         (let ((hook (sv-hook-of name)))
           (when hook
             (catch #t
               (lambda ()
                 (sv-add-hook!
                  hook
                  (lambda (h)
                    ;; NO (set! (h 'result) ...) -- see sv-add-hook!.
                    (catch #t
                      (lambda ()
                        (sv-event event
                                  (let loop ((rest arguments) (out ()))
                                    (if (null? rest)
                                        (reverse out)
                                        (loop (cdr rest)
                                              (cons (sv-hook-argument h (car rest))
                                                    (cons (car rest) out)))))))
                      (lambda (type info) #f))))
                 (set! (sv-installed-hooks name) #t))
               (lambda (type info) #f)))))))
   sv-observed-hooks))

(define sv-watched-channels (make-hash-table))

(define (sv-watch-channel snd chn)
  ;; after-edit-hook IS NOT A GLOBAL HOOK.  It is one of Snd's three
  ;; channel-specific hooks -- edit-hook, undo-hook, after-edit-hook -- and
  ;; the name is a FUNCTION taking (snd chn) that returns the hook belonging
  ;; to that channel.  Treating it like a global hook is not a small
  ;; mistake: (hook-functions after-edit-hook) hands hook-functions the
  ;; accessor procedure, Snd says "hook must be a procedure created by
  ;; make-hook", and the load of this file stops THERE -- which took the
  ;; serving loop with it, after which Snd fell through to its own repl.scm,
  ;; which pulled in *libc*, which tried to compile libc_s7.c in whatever
  ;; the current directory happened to be.  One wrong hook, four screens of
  ;; unrelated-looking failure.
  ;;
  ;; So the edit watch is installed per channel, and per channel means when
  ;; the sound opens -- there is no channel to hang it on before that.
  ;; Once per channel. Snd calls every handler on a hook, so installing
  ;; twice means two 'edited events per edit, and the panels would fetch a
  ;; waveform twice for each keystroke of a Scheme loop. The double install
  ;; is not hypothetical: sounds already open are watched at load time, and
  ;; after-open-hook watches them again if the same sound is reopened.
  (let ((key (string-append (object->string snd) "." (object->string chn))))
    (if (sv-watched-channels key)
        #f
        (catch #t
          (lambda ()
            (and (sv-have? 'after-edit-hook)
                 (let ((hook ((symbol->value 'after-edit-hook) snd chn)))
                   (and (sv-hook? hook)
                        (begin
                          (sv-add-hook!
                           hook
                           ;; sv-wire, because `snd` here came from
                           ;; after-open-hook and is an OBJECT. This event has
                           ;; been carrying "#<sound 1>" since the day the edit
                           ;; watch was written; nothing noticed because the
                           ;; extension's handler refreshes everything and never
                           ;; reads the field. A field nobody reads is still
                           ;; wrong, and the first reader would have found it
                           ;; the hard way.
                           (lambda (h)
                             (sv-event 'edited (list 'snd (sv-wire snd) 'chn chn))))
                          (set! (sv-watched-channels key) #t))))))
          (lambda (type info) #f)))))

(define (sv-watch-sound snd)
  (catch #t
    (lambda ()
      (let ((count (if (sv-have? 'channels) ((symbol->value 'channels) snd) 1)))
        (do ((chn 0 (+ chn 1)))
            ((>= chn count))
          (sv-watch-channel snd chn))))
    (lambda (type info) #f)))


;; ------------------------------------------------------------------
;; Where playback has got to
;;
;; Snd's own answer to this is with-tracking-cursor, and it is a GUI answer:
;; the cursor is redrawn every cursor-update-interval seconds while the DAC
;; runs.  Without a GUI there is no redraw, so the value never moves -- which
;; is why the cursor sat still.
;;
;; What Snd offers underneath is play-hook, called each time a DAC buffer is
;; about to be filled, with that buffer's size.  Summing those sizes is the
;; position.  Two things follow from Snd's own documentation and are worth
;; stating rather than discovering:
;;
;; THE POSITION IS AHEAD OF THE SOUND.  Snd says so about its own cursor:
;; "Snd can't tell how many samples of buffering there are between itself and
;; the speakers ... its notion of where to place the tracking cursor can be
;; wrong by an almost arbitrary amount", and offers cursor-location-offset to
;; correct it.  We are counting the same buffers, so we inherit the same
;; error, and we apply the same correction.
;;
;; DO NOT EMIT PER BUFFER.  dac-size defaults to 256 frames, which at 44100
;; is 172 events per second, each a JSON frame down a pipe -- and Snd's own
;; note about cursor-update-interval is that too small a value causes audible
;; clicks, because the redraw competes with filling the buffer.  The same
;; applies here: this hook runs on the audio path.  So emission is throttled
;; to cursor-update-interval, which is Snd's own setting for exactly this
;; decision.
;; ------------------------------------------------------------------

(define sv-play-frames 0)      ; frames handed to the DAC since play began
(define sv-play-emitted 0)     ; frames at the last event
(define sv-play-origin 0)      ; where this playback started
(define sv-play-snd 0)
(define sv-play-chn 0)

(define (sv-play-interval)
  (let ((rate (if (sv-have? 'srate)
                  (catch #t (lambda () ((symbol->value 'srate) sv-play-snd))
                         (lambda args 44100))
                  44100))
        (seconds (if (and (defined? 'cursor-update-interval)
                          (sv-have? 'cursor-update-interval))
                     (catch #t (lambda () ((symbol->value 'cursor-update-interval)))
                            (lambda args 0.05))
                     0.05)))
    (max 256 (round (* rate (max 0.01 seconds))))))

(define (sv-play-offset)
  ;; Snd's own correction for the buffering it cannot see.
  (if (and (defined? 'cursor-location-offset) (sv-have? 'cursor-location-offset))
      (catch #t (lambda () ((symbol->value 'cursor-location-offset))) (lambda args 0))
      0))

(define (sv-play-note-buffer size)
  (set! sv-play-frames (+ sv-play-frames (if (integer? size) size 0)))
  (when (>= (- sv-play-frames sv-play-emitted) (sv-play-interval))
    (set! sv-play-emitted sv-play-frames)
    (sv-event 'playing
              (list 'snd sv-play-snd
                    'chn sv-play-chn
                    'frame (max 0 (- (+ sv-play-origin sv-play-frames)
                                     (sv-play-offset)))))))

(define (sv-play-began snd chn origin)
  (set! sv-play-snd (sv-snd-index snd))
  (set! sv-play-chn chn)
  (set! sv-play-origin origin)
  (set! sv-play-frames 0)
  (set! sv-play-emitted 0))

(define (sv-play-ended)
  (sv-event 'stopped (list 'snd sv-play-snd
                           'frame (+ sv-play-origin sv-play-frames)))
  (set! sv-play-frames 0)
  (set! sv-play-emitted 0))

(define sv-play-hooks-installed #f)

(define (sv-install-play-hooks)
  ;; Once. Snd calls every handler on a hook, so a second install counts
  ;; every DAC buffer twice and the playhead runs at double speed -- which
  ;; looks like a sample-rate mistake, not like a duplicate handler. The
  ;; channel watch had the same shape of bug; this is the same guard.
  (if sv-play-hooks-installed
      #f
      (catch #t
        (lambda ()
          (set! sv-play-hooks-installed #t)
          (let ((hook (sv-hook-of 'play-hook)))
            (when hook (sv-add-hook! hook (lambda (h) (sv-play-note-buffer (h 'size))))))
          (let ((hook (sv-hook-of 'stop-playing-hook)))
            (when hook
              ;; sv-play-ended EMITS the 'stopped event itself, with the final
              ;; frame -- which is why stop-playing-hook is not in
              ;; sv-observed-hooks and why nothing is emitted here. Adding an
              ;; emit alongside it was the same double-event bug one level
              ;; down, and the handler count did not catch that one: one
              ;; handler, two events.
              (sv-add-hook! hook (lambda (h) (sv-play-ended)))))
          #t)
        (lambda (type info)
          (sv-emit (inlet 'event "play-hook-install-failed"
                          'detail (object->string info)))
          #f))))

(define (sv-install-hooks)
  ;; Every hook is installed inside a catch, and the whole of this runs
  ;; inside one too.  Not defensiveness for its own sake: an error here
  ;; happens while this file is LOADING, so it does not produce a failed
  ;; request -- it stops the load, and everything after it silently does not
  ;; exist.  That is how one wrong hook name turned into the libc_s7 mess.
  (catch #t
    (lambda ()
      (let ((opened (sv-hook-of 'after-open-hook)))
        (when opened
          (sv-add-hook! opened
                        (lambda (h)
                          (let ((snd (h 'snd)))
                            ;; The edit watch can only be hung on a channel
                            ;; that exists, so it is hung here.
                            (sv-watch-sound snd)
                            ;; The INDEX, not the object: after-open-hook
                            ;; passes a sound object, and "#<sound 1>" on the
                            ;; wire is a string where the panels expect a
                            ;; number -- so nothing followed the new sound.
                            (sv-event 'opened (list 'snd (sv-wire snd))))))))
      (let ((closed (sv-hook-of 'close-hook)))
        (when closed
          (sv-add-hook! closed
                        (lambda (h) (sv-event 'closed (list 'snd (sv-wire (h 'snd))))))))
      (sv-install-play-hooks)
      ;; And the rest of Snd's hooks, as observers: they emit events and
      ;; decide nothing.
      (sv-observe-hooks)
      ;; Sounds already open when we loaded -- Snd opens files named on its
      ;; command line before it gets to -l.
      (when (sv-in-snd?)
        (let ((sounds (catch #t (lambda () ((symbol->value 'sounds))) (lambda args #f))))
          (when (list? sounds) (for-each sv-watch-sound sounds)))))
    (lambda (type info)
      (sv-emit (inlet 'event "hook-install-failed"
                      'errorType (symbol->string type)
                      'detail (object->string info))))))

;; ------------------------------------------------------------------
;; Serving
;; ------------------------------------------------------------------

(define (sv-handle-line line)
  (catch #t
    ;; (rootlet) here too, and for the same reason: a request is read in
    ;; whatever environment this function happens to be, and requests must
    ;; not be able to see each other's locals.
    (lambda () (eval-string line (rootlet)))
    (lambda (type info)
      (sv-emit (inlet 'event "protocol-error"
                      'errorType (symbol->string type)
                      'line line)))))

(define (sv-serve)
  ;; Headless only.  read-line blocks, which is exactly right without an
  ;; event loop and exactly wrong with one.
  (sv-event 'ready (list 'mode "nogui" 'protocol sv-protocol-version))
  (let loop ()
    (let ((line (read-line *stdin* #t)))
      (if (eof-object? line)
          (begin
            (sv-event 'bye ())
            ;; EOF means the extension is gone, so Snd must go too -- and it
            ;; must go HERE. Falling out of this loop instead lets Snd
            ;; continue its own startup into repl.scm, which requires
            ;; *libc*, which tries to compile libc_s7.c in the current
            ;; directory and leaves the wreckage there. Observed, not
            ;; imagined.
            (sv-exit))
          (begin
            (unless (or (= (length line) 0) (char=? (string-ref line 0) #\;))
              (sv-handle-line line))
            (loop))))))

(define (sv-exit)
  ;; Two attempts, because which one exists depends on the build and on
  ;; whether s7's exit has been shadowed. sv-have? is not enough on its own:
  ;; a name can be bound to something that is not callable.
  ;;
  ;; There used to be a third, snd-exit, which I invented -- caught by the
  ;; gate that checks these names against Snd's own index. It never ran,
  ;; because one of the first two always works; an invented name in a
  ;; fallback chain is invisible precisely because the chain succeeds
  ;; earlier.
  (catch #t (lambda () ((symbol->value 'exit))) (lambda args #f))
  (catch #t (lambda () ((symbol->value 'emergency-exit))) (lambda args #f))
  #f)

(define (sv-start)
  (sv-install-hooks)
  (let* ((gui (and (sv-in-snd?)
                   (sv-have? 'main-widgets)
                   (let ((w (catch #t (lambda () ((symbol->value 'main-widgets)))
                                   (lambda args #f))))
                     (and w (pair? w) (car w) #t)))))
    (if gui
        ;; Snd's own stdin callback does the reading; we only announce
        ;; ourselves and return control to the X loop.
        (sv-event 'ready (list 'mode "gui" 'protocol sv-protocol-version))
        (sv-serve))))

(if (defined? 'sv-no-autostart)
    (sv-event 'loaded (list 'protocol sv-protocol-version))
    (sv-start))
