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

  ; ---------------------------------------------------------------------------
  ; Remove an engine left in the install directory by an older, EMBEDDED build.
  ;
  ; For one release the installer carried the Lobium runtime and Tauri unpacked it to
  ; $INSTDIR\lobium. The engine is downloaded on first run again, so this installer never writes
  ; that directory - and NSIS only removes what its own uninstall log records, so upgrading from
  ; that release leaves ~580 MB behind with nothing owning it.
  ;
  ; Leaving it is not merely wasteful, it is WRONG, and silently so. ensure_lobium_env's first
  ; candidate is <resources>\lobium\chrome.exe; Tauri's resource directory on Windows IS $INSTDIR;
  ; and that candidate is accepted on the file merely EXISTING - unlike the managed cache, which is
  ; used only when its version stamp matches the manifest. So the upgraded app binds the OLD engine,
  ; skips the first-run download entirely, and keeps running the very binary the upgrade was
  ; published to replace. Measured 2026-08-26: the orphan left by the embedded build contains no
  ; device-frame code at all, so an Android profile still opens with no phone stage on an
  ; installation that looks completely up to date.
  ;
  ; Safe unconditionally: this runs BEFORE extraction, so a future build that does embed an engine
  ; simply writes its own afterwards.
  ; ---------------------------------------------------------------------------
  ; VERIFY THE REMOVAL. RMDir /r skips files it cannot open and only sets the error flag, so an
  ; unchecked call silently succeeds when the old engine is still RUNNING - chrome.exe survives, the
  ; installer exits 0, and the app binds the stale engine anyway. Tested: with chrome.exe held open,
  ; every other file under lobium\ was deleted, chrome.exe remained, and the install reported success.
  ; That is the precise failure this block exists to prevent, so it must not be the one it produces.
  ;
  ; Tauri's own CheckIfAppIsRunning only ever targets ${MAINBINARYNAME}.exe, and it runs AFTER this
  ; hook, so nothing else releases an engine lock. chrome.exe is the file that decides binding
  ; (ensure_lobium_env accepts <resources>\lobium\chrome.exe on existence alone), so that is the one
  ; to re-test.
  ;
  ; Deliberately NOT an image-name kill of chrome.exe: this machine is administered over a remote
  ; desktop session and killing by image name would take the operator's session with it. Ask the user
  ; to close it instead, and abort rather than install something that will silently run the old engine.
  IfFileExists "$INSTDIR\lobium\*.*" 0 lobster_no_stale_engine
    SetDetailsPrint both
    DetailPrint "Removing a browser engine left by a previous version..."
    SetDetailsPrint none
    RMDir /r "$INSTDIR\lobium"
    IfFileExists "$INSTDIR\lobium\chrome.exe" 0 lobster_no_stale_engine
      IfSilent lobster_stale_engine_silent
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
        "Setup could not remove the browser engine from the previous version, because it is still in use.$\r$\n$\r$\nClose Lobster Browser and any open profile windows, then choose Retry.$\r$\n$\r$\nContinuing would leave the old engine in place and this update would keep using it." \
        IDRETRY lobster_retry_stale_engine
      Abort "Setup cannot continue while the previous browser engine is in use."
      lobster_retry_stale_engine:
        RMDir /r "$INSTDIR\lobium"
        IfFileExists "$INSTDIR\lobium\chrome.exe" 0 lobster_no_stale_engine
        Abort "The previous browser engine is still in use. Close Lobster Browser and run Setup again."
      lobster_stale_engine_silent:
        ; No one to ask. Failing loudly beats installing an update that silently runs the old engine.
        SetErrorLevel 2
        Abort "Setup cannot continue: the previous browser engine is in use."
  lobster_no_stale_engine:
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
