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

; ---------------------------------------------------------------------------
; Leave nothing behind that the user did not make.
;
; The browser engine is downloaded on first run into %LOCALAPPDATA%\lobster\lobium rather than
; shipped in the installer, so NSIS has no uninstall log entry for it. Without this, uninstalling
; leaves ~800 MB on disk with no visible owner and no way for the user to know what it was. It is a
; pure cache - re-downloadable, identical for everyone, containing nothing the user created - so it
; is removed unconditionally and silently.
;
; PROFILES ARE DIFFERENT and are never removed without being asked. They are cookies, sessions,
; saved logins and configured fingerprints - the user's actual work, often not reproducible. Plenty
; of people uninstall to reinstall a fixed build and would be destroyed by a silent wipe. So the
; question is asked once, defaults to NO, and is skipped entirely in a silent uninstall, where
; there is nobody to answer it and consent cannot be assumed.
; ---------------------------------------------------------------------------
!macro NSIS_HOOK_POSTUNINSTALL
  SetDetailsPrint both

  ; The engine cache: always.
  RMDir /r "$LOCALAPPDATA\lobster\lobium"
  RMDir "$LOCALAPPDATA\lobster"

  ; Profiles and settings: only on an explicit yes from a real person.
  ;
  ; Plain NSIS branches rather than LogicLib's ${If}/${FileExists}: this macro is injected into a
  ; generated installer.nsi whose include list is Tauri's to change, and a missing !include breaks
  ; the whole installer build rather than just this block. IfFileExists/MessageBox are core
  ; instructions that are always available.
  ;
  ; Note $APPDATA, not $LOCALAPPDATA: Tauri's app_data_dir() is dirs::data_dir()/<identifier>, which
  ; on Windows is Roaming. The engine above genuinely is under Local - the two are different
  ; directories and deleting the wrong one would either miss 800 MB or destroy the profiles.
  IfSilent lobster_keep_data
  IfFileExists "$APPDATA\com.lobster.browser\*.*" 0 lobster_keep_data
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Also delete your Lobster profiles and settings?$\r$\n$\r$\nThis removes every profile, its cookies and its saved logins. It cannot be undone.$\r$\n$\r$\nChoose No to keep them for a future reinstall." \
    IDYES lobster_purge_data IDNO lobster_keep_data
  lobster_purge_data:
    RMDir /r "$APPDATA\com.lobster.browser"
  lobster_keep_data:
!macroend
