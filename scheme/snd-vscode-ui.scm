;;; snd-vscode-ui.scm -- a GUI vocabulary for headless Snd
;;;
;;; This file is loaded BEFORE ~/.snd.  It deliberately starts no server and
;;; writes no protocol frames by itself: the main bridge is loaded last, after
;;; the user's init files and startup sounds.  UI created during startup stays
;;; in the registry and is returned by the first `uiwidgets` request.
;;;
;;; Snd owns widget state and callback closures.  VS Code owns pixels.  Only a
;;; declarative, JSON-safe description crosses the pipe; no callback source is
;;; ever serialised or eval'ed on the extension side.

(unless (provided? 'snd-vscode-ui)
  (provide 'snd-vscode-ui)

  (define sv-ui-widgets (make-hash-table))
  (define sv-ui-callbacks (make-hash-table))
  (define sv-ui-order ())
  (define sv-ui-pages (make-hash-table))
  (define sv-ui-next-id 0)

  (define (sv-ui-new-id prefix)
    (set! sv-ui-next-id (+ sv-ui-next-id 1))
    (string-append prefix "-" (number->string sv-ui-next-id)))

  (define (sv-ui-parent-id parent)
    (cond ((let? parent) (parent 'id))
          ((string? parent) parent)
          (else #f)))

  (define (sv-ui-public widget)
    ;; Keep this list explicit.  A callback accidentally added to the public
    ;; object would stringify as #<procedure> and look harmless while leaking
    ;; an implementation detail into a protocol that must remain data-only.
    (inlet 'id (widget 'id)
           'kind (widget 'kind)
           'label (widget 'label)
           'parent (widget 'parent)
           'value (widget 'value)
           'minimum (widget 'minimum)
           'maximum (widget 'maximum)
           'step (widget 'step)
           'options (widget 'options)
           'enabled (widget 'enabled)
           'visible (widget 'visible)
           'managed (widget 'managed)
           'description (widget 'description)))

  (define (sv-ui-notify action widget)
    ;; During init the main bridge does not exist yet.  Nothing is lost: the
    ;; extension asks for the complete registry after the ready event.
    (when (defined? 'sv-emit)
      ((symbol->value 'sv-emit)
       (inlet 'event "ui" 'action action 'widget (sv-ui-public widget)))))

  (define* (vscode-ui-create kind label
                             (parent #f)
                             (value #f)
                             (minimum #f)
                             (maximum #f)
                             (step #f)
                             (options ())
                             (enabled #t)
                             (visible #t)
                             (managed #t)
                             (description "")
                             (activate #f)
                             (change #f)
                             (submit #f)
                             (reset #f)
                             (help #f)
                             (close #f))
    (let* ((id (sv-ui-new-id (if (symbol? kind) (symbol->string kind) kind)))
           (widget (inlet 'id id
                          'kind (if (symbol? kind) (symbol->string kind) kind)
                          'label (cond ((not label) "")
                                       ((string? label) label)
                                       (else (object->string label)))
                          'parent (sv-ui-parent-id parent)
                          'value value
                          'minimum minimum
                          'maximum maximum
                          'step step
                          'options options
                          'enabled enabled
                          'visible visible
                          'managed managed
                          'description description)))
      (set! (sv-ui-widgets id) widget)
      (set! sv-ui-order (append sv-ui-order (list id)))
      (for-each
       (lambda (entry)
         (when (procedure? (cdr entry))
           (set! (sv-ui-callbacks (string-append id ":" (symbol->string (car entry))))
                 (cdr entry))))
       (list (cons 'activate activate) (cons 'change change)
             (cons 'submit submit) (cons 'reset reset)
             (cons 'help help) (cons 'close close)))
      (sv-ui-notify "create" widget)
      widget))

  (define (vscode-ui-widget? value)
    (and (let? value)
         (catch #t
           (lambda () (and (string? (value 'id)) (sv-ui-widgets (value 'id))))
           (lambda args #f))))

  (define (vscode-ui-widgets)
    (let ((out ()))
      (for-each
       (lambda (id)
         (let ((widget (sv-ui-widgets id)))
           (when widget (set! out (cons (sv-ui-public widget) out)))))
       sv-ui-order)
      (reverse out)))

  (define* (vscode-ui-update widget
                             (label #<unspecified>)
                             (value #<unspecified>)
                             (enabled #<unspecified>)
                             (visible #<unspecified>)
                             (managed #<unspecified>)
                             (description #<unspecified>))
    (unless (vscode-ui-widget? widget)
      (error 'wrong-type-arg "vscode-ui-update expects a VS Code UI widget"))
    (unless (eq? label #<unspecified>)
      (set! (widget 'label) (if (string? label) label (object->string label))))
    (unless (eq? value #<unspecified>) (set! (widget 'value) value))
    (unless (eq? enabled #<unspecified>) (set! (widget 'enabled) enabled))
    (unless (eq? visible #<unspecified>) (set! (widget 'visible) visible))
    (unless (eq? managed #<unspecified>) (set! (widget 'managed) managed))
    (unless (eq? description #<unspecified>) (set! (widget 'description) description))
    (sv-ui-notify "update" widget)
    widget)

  (define (vscode-ui-remove widget)
    (when (vscode-ui-widget? widget)
      (let ((id (widget 'id)))
        ;; Remove descendants first.  A stale child with a missing parent is
        ;; otherwise still visible in a flat snapshot after a window reload.
        (for-each
         (lambda (child-id)
           (let ((child (sv-ui-widgets child-id)))
             (when (and child (equal? (child 'parent) id))
               (vscode-ui-remove child))))
         (copy sv-ui-order))
        (set! (sv-ui-widgets id) #f)
        (set! sv-ui-order (remove id sv-ui-order))
        (when (defined? 'sv-emit)
          ((symbol->value 'sv-emit)
           (inlet 'event "ui" 'action "remove" 'id id)))))
    #f)

  (define (sv-ui-call callback widget value action)
    (let* ((ary (arity callback))
           (lo (if ary (car ary) 0))
           (hi (if ary (cdr ary) 0))
           (info (inlet 'value value 'action action 'widget widget)))
      ;; Motif callbacks take (widget context info); small Snd helpers often
      ;; take the new value, and menu callbacks take no arguments.
      (cond ((and (<= lo 3) (>= hi 3)) (callback widget #f info))
            ((and (<= lo 1) (>= hi 1)) (callback value))
            (else (callback)))))

  (define (vscode-ui-action id action value)
    (let ((widget (sv-ui-widgets id)))
      (unless widget (error 'no-such-widget (string-append "no VS Code widget: " id)))
      (cond ((string=? action "open")
             (set! (widget 'managed) #t)
             (set! (widget 'visible) #t)
             (sv-ui-notify "update" widget))
            ((string=? action "close")
             (set! (widget 'managed) #f)
             (sv-ui-notify "update" widget)))
      (when (or (string=? action "change") (string=? action "input"))
        (set! (widget 'value) value)
        (sv-ui-notify "update" widget))
      (let* ((name (cond ((or (string=? action "click") (string=? action "open")) "activate")
                         ((string=? action "input") "change")
                         (else action)))
             (callback (sv-ui-callbacks (string-append id ":" name))))
        (if callback
            (sv-ui-call callback widget value action)
            #f))
      (sv-ui-public widget)))

  ;; ------------------------------------------------------------------
  ;; Public, toolkit-independent UI vocabulary

  (define* (vscode-ui-menu label (callback #f))
    (vscode-ui-create 'menu label :activate callback))

  (define* (vscode-ui-menu-item menu label callback (position -1))
    (if label
        (vscode-ui-create 'menu-item label :parent menu :activate callback
                          :description (if (number? position)
                                           (string-append "position " (number->string position)) ""))
        (vscode-ui-create 'separator "" :parent menu)))

  (define* (vscode-ui-dialog title
                             (ok-callback #f)
                             (help-callback #f)
                             (reset-callback #f)
                             (target-ok-callback #f))
    (let ((dialog (vscode-ui-create 'dialog title :managed #f)))
      (vscode-ui-create 'button "DoIt" :parent dialog :activate ok-callback
                        :enabled (if (procedure? target-ok-callback)
                                     (target-ok-callback) #t))
      (when reset-callback
        (vscode-ui-create 'button "Reset" :parent dialog :activate reset-callback))
      (when help-callback
        (vscode-ui-create 'button "Help" :parent dialog :activate help-callback))
      (vscode-ui-create 'button "Close" :parent dialog
                        :activate (lambda args (vscode-ui-update dialog :managed #f)))
      dialog))

  (define* (vscode-ui-slider parent label minimum value maximum callback (step 1))
    (vscode-ui-create 'slider label :parent parent :value value
                      :minimum minimum :maximum maximum :step step :change callback))

  (define* (vscode-ui-toggle parent label value callback)
    (vscode-ui-create 'toggle label :parent parent :value value :change callback))

  (define* (vscode-ui-text parent label value callback)
    (vscode-ui-create 'text label :parent parent :value value :change callback))

  (define* (vscode-ui-select parent label value options callback)
    (vscode-ui-create 'select label :parent parent :value value
                      :options options :change callback))

  (define* (vscode-ui-envelope parent label value callback)
    (vscode-ui-create 'envelope label :parent parent :value value :change callback))

  (define (vscode-ui-activate widget)
    (vscode-ui-update widget :managed #t :visible #t))

  ;; ------------------------------------------------------------------
  ;; Snd's high-level menu and instrument-display compatibility surface.
  ;; A nogui Snd still exports several of these names, but their implementations
  ;; have no widget to create.  Presence alone therefore says nothing.  Keep a
  ;; real xm/xg implementation and replace the inert headless surface.

  (define sv-ui-native-toolkit? (or (provided? 'xm) (provided? 'xg)))

  (when (or (not sv-ui-native-toolkit?) (not (defined? 'add-to-main-menu)))
    (define* (add-to-main-menu label (callback #f))
      (vscode-ui-menu label callback)))

  (when (or (not sv-ui-native-toolkit?) (not (defined? 'add-to-menu)))
    (define* (add-to-menu menu label callback (position -1))
      (vscode-ui-menu-item menu label callback position)))

  (when (or (not sv-ui-native-toolkit?) (not (defined? 'change-label)))
    (define (change-label widget new-label)
      (vscode-ui-update widget :label new-label)))

  (when (or (not sv-ui-native-toolkit?) (not (defined? 'change-menu-label)))
    (define (change-menu-label widget new-label)
      (vscode-ui-update widget :label new-label)))

  (when (or (not sv-ui-native-toolkit?) (not (defined? 'make-variable-display)))
    (define* (make-variable-display page-name variable-name (type 'text) (range '(0.0 1.0)))
      (let ((page (sv-ui-pages page-name)))
        (unless page
          (set! page (vscode-ui-create 'instrument page-name :managed #t))
          (set! (sv-ui-pages page-name) page))
        (vscode-ui-create
         (case type ((meter) 'meter) ((scale) 'slider) ((graph) 'graph) (else 'value))
         variable-name :parent page :value 0.0
         :minimum (if (pair? range) (car range) #f)
         :maximum (if (and (pair? range) (pair? (cdr range))) (cadr range) #f)))))

  (when (or (not sv-ui-native-toolkit?) (not (defined? 'variable-display)))
    (define (variable-display value widget)
      (vscode-ui-update widget :value value)
      value))

  (when (or (not sv-ui-native-toolkit?) (not (defined? 'variable-display-reset)))
    (define (variable-display-reset widget)
      (vscode-ui-update widget :value 0.0)
      widget))

  ;; A small *motif* compatibility environment is useful even when we do not
  ;; claim raw Xt compatibility.  Snd's menu scripts fetch these helpers from
  ;; *motif* but choose their non-X branch when neither 'xm nor 'xg is
  ;; provided.  This lets fft-menu.scm, marks-menu.scm and special-menu.scm run
  ;; unchanged in a headless session.
  (define (sv-ui-update-label callbacks)
    (for-each (lambda (callback) (callback)) callbacks))

  (define (sv-ui-add-sliders dialog specs)
    (map (lambda (spec)
           (let ((label (list-ref spec 0))
                 (low (list-ref spec 1))
                 (initial (list-ref spec 2))
                 (high (list-ref spec 3))
                 (callback (list-ref spec 4))
                 (scale (if (> (length spec) 5) (list-ref spec 5) 1)))
             (vscode-ui-slider dialog label low initial high callback (/ 1.0 scale))))
         specs))

  (define (sv-ui-set-values widget values)
    (let loop ((rest values))
      (when (and (pair? rest) (pair? (cdr rest)))
        (let ((key (car rest)) (value (cadr rest)))
          (cond ((or (eq? key 'XmNvalue) (eq? key 'value))
                 (vscode-ui-update widget :value value))
                ((or (eq? key 'XmNlabelString) (eq? key 'label))
                 (vscode-ui-update widget :label value))))
        (loop (cddr rest))))
    widget)

  (when (or (not sv-ui-native-toolkit?) (not (defined? '*motif*)))
    (define *motif*
      (sublet (rootlet)
              'update-label sv-ui-update-label
              'change-label change-label
              'make-effect-dialog vscode-ui-dialog
              'add-sliders sv-ui-add-sliders
              'activate-dialog vscode-ui-activate
              'select-file (lambda args #f)
              '.value (lambda (info) (info 'value))
              'XmNvalue 'XmNvalue
              'XtSetValues sv-ui-set-values)))
  )
