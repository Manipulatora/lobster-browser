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
; ===================================================================================================
; LOBSTER INSTALLER THEME
;
; Everything below is presentation. It runs from `installerHooks`, which Tauri `!include`s at the TOP
; of its generated installer.nsi (line 31), i.e. BEFORE MUI2 reads any of these defines. That
; ordering is what makes a full restyle possible without forking the 975-line template — a fork would
; have to be re-reconciled on every Tauri upgrade and rots silently when upstream moves.
;
; WHAT IS AND IS NOT POSSIBLE HERE, so nobody re-litigates it later:
;
;   * Colours, fonts, control geometry and the progress bar's own colours: yes, all below.
;   * A GRADIENT or ANIMATED ("shimmering") progress bar: NO. PBM_SETBARCOLOR is ignored while
;     visual styles are enabled, and turning styles off to force it yields the Windows 2000 bar.
;     Owner-drawing is the only other route and NSIS cannot do it: the System plugin is
;     single-threaded and its callbacks fire only while the script is inside another call
;     (NSIS Docs/System/System.html), so there is no WM_PAINT, no WM_DRAWITEM and no timer.
;     Animation requires a bespoke installer binary. Do not spend a day rediscovering this.
;
; The palette is the product's own, from apps/desktop/src/styles.css and gen-installer-art.ps1:
;   ink   0E061A  near-black violet      brand 7C3AED  primary violet
;   deep  4C1D95  brand-800              text  F5F3FF  brand-50
; ===================================================================================================

!define LOBSTER_INK    "0E061A"
!define LOBSTER_TEXT   "F5F3FF"
!define LOBSTER_DIM    "B9A9E8"
!define LOBSTER_BRAND  "7C3AED"
; The bottom branding strip: present, but it should recede rather than compete with the title.
!define LOBSTER_FAINT  "6E5A9C"

; MUI reads these when it lays the pages out. BGCOLOR/TEXTCOLOR recolour the page canvas; the
; INSTFILESPAGE pair recolours the log control that the install page still owns even though
; SetDetailsPrint keeps it empty; "smooth" removes the segmented 1990s blocks from the bar.
!define MUI_BGCOLOR "${LOBSTER_INK}"
!define MUI_TEXTCOLOR "${LOBSTER_TEXT}"
!define MUI_INSTFILESPAGE_COLORS "${LOBSTER_TEXT} ${LOBSTER_INK}"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
; The licence box is left on its default light background ON PURPOSE. MUI exposes only
; LicenseBkColor (background); there is no text-colour define, and the RichEdit paints its own
; text black. Darkening the background alone made the legal text dark-on-dark and unreadable, so
; it reads as a light document panel inside the dark frame - a deliberate choice, not an omission.

; The welcome/finish pages are the two with the tall sidebar; recolour their text so it is legible
; on the dark art rather than the default black on black.
!define MUI_WELCOMEFINISHPAGE_INI_3TEXTCOLOR "${LOBSTER_TEXT}"

!define MUI_CUSTOMFUNCTION_GUIINIT LobsterStyleWindow
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.LobsterStyleWindow

; The per-page restyle.
;
; WHY THIS IS PER PAGE AND NOT ONE-SHOT. MUI_CUSTOMFUNCTION_GUIINIT fires exactly once, at
; .onGUIInit. MUI then rebuilds the header title, subtitle and branding controls every time it
; switches page, repainting over anything set earlier - which is why the welcome page looked right
; while the licence and progress pages showed black-on-dark text, a title overlapping the header and
; a doubled copyright line. The fix is MUI_PAGE_CUSTOMFUNCTION_SHOW, re-applied before every page
; (installer.template.nsi re-defines it ahead of each one, because MUI undefines it after each).

Var LobsterFontUi
Var LobsterFontTitle
Var LobsterFontsReady

!macro LOBSTER_MAKE_FONTS
  ${If} $LobsterFontsReady != 1
    ; Segoe UI Variable is the Windows 11 UI face; on Windows 10 the name does not resolve and GDI
    ; substitutes Segoe UI, which is the correct fallback - so no version check is needed.
    System::Call 'gdi32::CreateFontW(i -21, i 0, i 0, i 0, i 600, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "Segoe UI Variable Display") i .r0'
    StrCpy $LobsterFontTitle $0
    System::Call 'gdi32::CreateFontW(i -13, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "Segoe UI Variable Text") i .r0'
    StrCpy $LobsterFontUi $0
    StrCpy $LobsterFontsReady 1
  ${EndIf}
!macroend

; Apply font + palette to one control, by dialog id, on a given parent. Silently ignores ids that do
; not exist on this page - the id set differs per page and that is expected.
!macro LOBSTER_CTL PARENT ID FONT FG BG
  GetDlgItem $0 ${PARENT} ${ID}
  ${If} $0 <> 0
    ${If} ${FONT} != 0
      SendMessage $0 ${WM_SETFONT} ${FONT} 1
    ${EndIf}
    SetCtlColors $0 "${FG}" "${BG}"
  ${EndIf}
!macroend

; Everything a page can contain. Applied on every page; missing ids are skipped.
!macro LOBSTER_PAINT
  !insertmacro LOBSTER_MAKE_FONTS
  ; The outer window. Carries the strip the buttons sit on, which MUI_BGCOLOR does not reach.
  SetCtlColors $HWNDPARENT "${LOBSTER_TEXT}" "${LOBSTER_INK}"
  FindWindow $1 "#32770" "" $HWNDPARENT      ; the inner page dialog
  SetCtlColors $1 "${LOBSTER_TEXT}" "${LOBSTER_INK}"

  ; --- outer frame: buttons and the branding strip ---
  !insertmacro LOBSTER_CTL $HWNDPARENT 1    $LobsterFontUi    "${LOBSTER_TEXT}" "${LOBSTER_INK}"
  !insertmacro LOBSTER_CTL $HWNDPARENT 2    $LobsterFontUi    "${LOBSTER_DIM}"  "${LOBSTER_INK}"
  !insertmacro LOBSTER_CTL $HWNDPARENT 3    $LobsterFontUi    "${LOBSTER_DIM}"  "${LOBSTER_INK}"
  ; 1256 is the branding strip. It DOUBLE-PAINTS - MUI redraws the text without erasing the
  ; background, so it renders twice, offset. It carries nothing the user needs and the brief asks
  ; for no setup detail, so it is hidden rather than fought.
  GetDlgItem $0 $HWNDPARENT 1256
  ${If} $0 <> 0
    ShowWindow $0 ${SW_HIDE}
  ${EndIf}
  ; Header title/subtitle and the strip behind them.
  !insertmacro LOBSTER_CTL $HWNDPARENT 1037 $LobsterFontTitle "${LOBSTER_TEXT}" "${LOBSTER_INK}"
  !insertmacro LOBSTER_CTL $HWNDPARENT 1038 $LobsterFontUi    "${LOBSTER_DIM}"  "${LOBSTER_INK}"
  !insertmacro LOBSTER_CTL $HWNDPARENT 1034 $LobsterFontUi    "${LOBSTER_TEXT}" "${LOBSTER_INK}"
  !insertmacro LOBSTER_CTL $HWNDPARENT 1039 $LobsterFontUi    "${LOBSTER_TEXT}" "${LOBSTER_INK}"
  ; Nudge the header title and subtitle in from the frame. With MUI_HEADERIMAGE removed the header
  ; controls sit flush at x=0 and the first glyph is clipped by the window edge. SetWindowPos with
  ; SWP_NOSIZE|SWP_NOZORDER (0x0005) moves without touching size or z-order.
  GetDlgItem $0 $HWNDPARENT 1037
  ${If} $0 <> 0
    System::Call "user32::SetWindowPos(p $0, p 0, i 18, i 8, i 0, i 0, i 0x0005)"
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1038
  ${If} $0 <> 0
    System::Call "user32::SetWindowPos(p $0, p 0, i 20, i 32, i 0, i 0, i 0x0005)"
  ${EndIf}
  ; Hairline separators: default to a light 3D edge that reads as a scratch on a dark panel.
  !insertmacro LOBSTER_CTL $HWNDPARENT 1035 0 "${LOBSTER_INK}" "${LOBSTER_INK}"
  !insertmacro LOBSTER_CTL $HWNDPARENT 1036 0 "${LOBSTER_INK}" "${LOBSTER_INK}"
  !insertmacro LOBSTER_CTL $HWNDPARENT 1045 0 "${LOBSTER_INK}" "${LOBSTER_INK}"
  !insertmacro LOBSTER_CTL $HWNDPARENT 1044 $LobsterFontUi "${LOBSTER_TEXT}" "${LOBSTER_INK}"

  ; --- inner page controls ---
  ; 1000 licence RichEdit, 1006 welcome/finish body, 1016 the (empty) log list, 1027/1031 headings,
  ; 1004 status line above the bar. 1259 is the welcome/finish title on the sidebar page.
  !insertmacro LOBSTER_CTL $1 1000 $LobsterFontUi    "${LOBSTER_TEXT}" "${LOBSTER_INK}"
  !insertmacro LOBSTER_CTL $1 1006 $LobsterFontUi    "${LOBSTER_TEXT}" "${LOBSTER_INK}"
  !insertmacro LOBSTER_CTL $1 1016 $LobsterFontUi    "${LOBSTER_DIM}"  "${LOBSTER_INK}"
  !insertmacro LOBSTER_CTL $1 1004 $LobsterFontUi    "${LOBSTER_DIM}"  "${LOBSTER_INK}"
  !insertmacro LOBSTER_CTL $1 1027 $LobsterFontUi    "${LOBSTER_TEXT}" "${LOBSTER_INK}"
  !insertmacro LOBSTER_CTL $1 1031 $LobsterFontUi    "${LOBSTER_TEXT}" "${LOBSTER_INK}"
  !insertmacro LOBSTER_CTL $1 1259 $LobsterFontTitle "${LOBSTER_TEXT}" "${LOBSTER_INK}"
!macroend

Function LobsterStylePage
  !insertmacro LOBSTER_PAINT
FunctionEnd

Function un.LobsterStylePage
  !insertmacro LOBSTER_PAINT
FunctionEnd

Function LobsterStyleWindow
  !insertmacro LOBSTER_PAINT
FunctionEnd

Function un.LobsterStyleWindow
  !insertmacro LOBSTER_PAINT
FunctionEnd

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
