!macro customHeader
  !include "LogicLib.nsh"
  !include "nsDialogs.nsh"
!macroend

!macro customPageAfterChangeDir
  Var desktopShortcutCheckbox
  Var startMenuShortcutCheckbox
  Var createDesktopShortcut
  Var createStartMenuShortcut

  Page custom ShortcutOptionsPage ShortcutOptionsPageLeave

  Function ShortcutOptionsPage
    nsDialogs::Create 1018
    Pop $0

    ${NSD_CreateLabel} 0 0 100% 15u "Shortcuts"
    Pop $0
    ${NSD_CreateLabel} 0 18u 100% 18u "Choose where to create shortcuts for Claude Instance Manager"
    Pop $0

    ${NSD_CreateCheckbox} 0 45u 100% 12u "Create a desktop shortcut"
    Pop $desktopShortcutCheckbox
    ${If} ${isUpdated}
      ${If} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
        ${NSD_SetState} $desktopShortcutCheckbox ${BST_CHECKED}
      ${EndIf}
    ${Else}
      ${NSD_SetState} $desktopShortcutCheckbox ${BST_CHECKED}
    ${EndIf}

    ${NSD_CreateCheckbox} 0 66u 100% 12u "Create a Start menu shortcut"
    Pop $startMenuShortcutCheckbox
    ${If} ${isUpdated}
      ${If} ${FileExists} "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
        ${NSD_SetState} $startMenuShortcutCheckbox ${BST_CHECKED}
      ${EndIf}
    ${Else}
      ${NSD_SetState} $startMenuShortcutCheckbox ${BST_CHECKED}
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function ShortcutOptionsPageLeave
    ${NSD_GetState} $desktopShortcutCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $createDesktopShortcut "1"
    ${Else}
      StrCpy $createDesktopShortcut "0"
    ${EndIf}

    ${NSD_GetState} $startMenuShortcutCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $createStartMenuShortcut "1"
    ${Else}
      StrCpy $createStartMenuShortcut "0"
    ${EndIf}
  FunctionEnd
!macroend

!macro customInstall
  ${If} $createDesktopShortcut == "1"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${Else}
    Delete "$newDesktopLink"
    Delete "$oldDesktopLink"
  ${EndIf}

  ${If} $createStartMenuShortcut == "1"
    !insertmacro createMenuDirectory
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${Else}
    Delete "$newStartMenuLink"
    Delete "$oldStartMenuLink"
    !insertmacro cleanupOldMenuDirectory
  ${EndIf}
!macroend

!macro customUnInstall
  WinShell::UninstShortcut "$newDesktopLink"
  WinShell::UninstShortcut "$oldDesktopLink"
  Delete "$newDesktopLink"
  Delete "$oldDesktopLink"

  WinShell::UninstShortcut "$newStartMenuLink"
  WinShell::UninstShortcut "$oldStartMenuLink"
  Delete "$newStartMenuLink"
  Delete "$oldStartMenuLink"
  !ifdef MENU_FILENAME
    RMDir "$SMPROGRAMS\${MENU_FILENAME}"
  !endif
  ReadRegStr $R1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" MenuDirectory
  ${IfNot} $R1 == ""
    RMDir "$SMPROGRAMS\$R1"
  ${EndIf}
!macroend
