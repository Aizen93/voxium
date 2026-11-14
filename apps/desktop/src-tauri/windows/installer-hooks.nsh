; Installer hooks of every Windows build of the desktop app: tauri.conf.json
; names this file (bundle > windows > nsis > installerHooks), so the official
; release and a build made for another server (`pnpm tauri:build`) both run it.
;
; Windows shows the notifications of an installed desktop app only when a
; Start Menu shortcut carries the app's identifier (its AppUserModelID). The
; installer writes the identifier on a shortcut it creates, and leaves a
; shortcut that already points at the app as it is. A build for another
; server has an identifier of its own, and it installs in place of the
; official app (same product name): whichever build is installed over the
; other, or updates it in place, the shortcuts that point at the app are
; given the identifier of the build being installed here. A shortcut that
; points anywhere else is not touched.
!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5

  !if "${STARTMENUFOLDER}" != ""
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    ${EndIf}
  !endif

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}

  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}

  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
