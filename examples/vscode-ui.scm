;;; vscode-ui.scm -- declarative controls rendered by snd-vscode
;;;
;;; Load after starting the extension:
;;;   (load "examples/vscode-ui.scm")
;;; Then open Snd Custom UI in the Explorer and select "VS Code effect".

(define vscode-ui-gain 1.0)
(define vscode-ui-reverse #f)

(define vscode-ui-demo
  (vscode-ui-dialog
   "VS Code effect"
   (lambda ()
     (when vscode-ui-reverse (reverse-channel))
     (scale-channel vscode-ui-gain))
   (lambda ()
     (snd-print "This dialog is owned by s7 and rendered by VS Code."))
   (lambda ()
     (set! vscode-ui-gain 1.0)
     (set! vscode-ui-reverse #f))))

(vscode-ui-slider
 vscode-ui-demo "Gain" 0.0 vscode-ui-gain 2.0
 (lambda (value) (set! vscode-ui-gain value))
 0.01)

(vscode-ui-toggle
 vscode-ui-demo "Reverse first" vscode-ui-reverse
 (lambda (value) (set! vscode-ui-reverse value)))

(vscode-ui-select
 vscode-ui-demo "Preset" "unity" '("quiet" "unity" "hot")
 (lambda (value)
   (set! vscode-ui-gain
         (cond ((string=? value "quiet") 0.5)
               ((string=? value "hot") 1.5)
               (else 1.0)))))

(vscode-ui-envelope
 vscode-ui-demo "Envelope" '((0.0 0.0) (0.15 1.0) (1.0 0.0))
 (lambda (value) (snd-print (format #f "envelope: ~S" value))))

(vscode-ui-activate vscode-ui-demo)
