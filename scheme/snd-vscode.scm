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

(define (sv-have? name)
  (and (defined? name) (procedure? (symbol->value name))))

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

(sv-define-op envelope (params)
  ;; The envelope editor's state. enved-envelope is a list of x y pairs
  ;; flattened -- the same shape env-channel wants, so the panel can hand
  ;; it straight back.
  (let ((target (sv-arg params 'target "")))
    (inlet 'envelope (if (sv-have? 'enved-envelope)
                         ((symbol->value 'enved-envelope))
                         ())
           'target (if (sv-have? 'enved-target)
                       (object->string ((symbol->value 'enved-target)))
                       "")
           'base (if (sv-have? 'enved-base) ((symbol->value 'enved-base)) 1.0)
           'clip (if (sv-have? 'enved-clip?) ((symbol->value 'enved-clip?)) #f))))

(sv-define-op setenvelope (params)
  ;; Written through env-channel, which puts ONE entry in the edit
  ;; history -- the same entry Snd's own envelope editor produces. A
  ;; sample-by-sample scale from the panel would produce thousands, and
  ;; undo would stop being usable.
  (sv-require 'env-channel)
  (let* ((points (sv-arg params 'points ""))
         (snd (sv-arg params 'snd 0))
         (chn (sv-arg params 'chn 0)))
    ((symbol->value 'env-channel) (eval-string (string-append "(list " points ")") (rootlet))
     0 #f snd chn)
    (inlet 'editPosition ((symbol->value 'edit-position) snd chn))))

(sv-define-op constants (params)
  ;; What fourier-transform, blackman2-window and graph-as-sonogram are
  ;; NUMERICALLY, in this build.
  ;;
  ;; The panels need the numbers to know which radio button is on, and
  ;; the honest way to get them is to ask. Baking the integers into the
  ;; extension would work until Snd inserts a transform in the middle of
  ;; its list -- after which every panel would be one entry off, would
  ;; still look correct, and would set the wrong window on a spectrum
  ;; whose picture nobody can check by eye.
  ;;
  ;; So the panels declare SYMBOLS, resolve them once per session, and
  ;; write symbols back.
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
         (bins (max 8 (min 512 (round (sv-arg params 'bins 256)))))
         (linear (sv-arg params 'linear #f))
         (window (sv-arg params 'window 'blackman2-window))
         (window-value (if (and (symbol? window) (defined? window))
                           (symbol->value window)
                           2))
         (floor-dB (let ((v (if (and (defined? 'min-dB) (sv-have? 'min-dB))
                                (catch #t (lambda () ((symbol->value 'min-dB)))
                                       (lambda args -60.0))
                                -60.0)))
                     (if (>= v 0) -60.0 v)))
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
           ;; Column-major: one column is one transform, and the webview
           ;; walks columns to build the image.
           'cells (sv-base64 cells))))

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
  (set! (hook-functions hook) (cons handler (hook-functions hook))))

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
                           (lambda (h) (sv-event 'edited (list 'snd snd 'chn chn))))
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
            (when hook (sv-add-hook! hook (lambda (h) (sv-play-ended)))))
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
                            (sv-event 'opened (list 'snd snd)))))))
      (let ((closed (sv-hook-of 'close-hook)))
        (when closed
          (sv-add-hook! closed (lambda (h) (sv-event 'closed (list 'snd (h 'snd)))))))
      (sv-install-play-hooks)
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
