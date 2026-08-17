; NSIS hooks for the Lobster Browser installer.
;
; Wired via `bundle.windows.nsis.installerHooks` in tauri.windows.conf.json. Tauri inserts these
; macros into its own generated installer.nsi at fixed points, which is how the wizard is customised
; WITHOUT forking that template - a fork would have to be re-reconciled on every Tauri upgrade, and
; silently rots when upstream changes the surrounding script.

; ---------------------------------------------------------------------------
; Silence the per-file extraction log.
;
; NSIS prints a line like "Extract: node.exe... 100%" for every file it writes, and the app ships
; roughly 20 payload entries plus a vendored Node runtime. Scrolling paths at the user is noise:
; it exposes internal layout, it is the visual signature of an installer from 2003, and nobody has
; ever made a decision based on it. A progress bar answers the only question being asked, which is
; "how much longer".
;
; `none` rather than `textonly`: with textonly the status line still narrates each filename, which
; is the same noise on one line instead of many.
;
; This suppresses OUTPUT only. Nothing about what is installed changes, and a genuine failure still
; raises its own error dialog rather than being swallowed here.
; ---------------------------------------------------------------------------
!macro NSIS_HOOK_PREINSTALL
  SetDetailsPrint none
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Restore before the page finishes, so anything Tauri prints after this point - and the final
  ; "Completed" line the user does expect - is not swallowed too.
  SetDetailsPrint both
!macroend

; The same courtesy on the way out: an uninstall should not narrate every file it deletes either.
!macro NSIS_HOOK_PREUNINSTALL
  SetDetailsPrint none
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  SetDetailsPrint both
!macroend
