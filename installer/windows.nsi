Unicode True
!include "MUI2.nsh"

!define APP_NAME "ZIENTSOV LATYNKA"
!define APP_VERSION "0.4.9"
!define APP_PUBLISHER "Зєнцов Дмитро Володимирович"
!define APP_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZIENTSOV_LATYNKA"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "ZIENTSOV_LATYNKA_Setup_v0.4.9.exe"
InstallDir "$LOCALAPPDATA\Programs\ZIENTSOV LATYNKA"
InstallDirRegKey HKCU "Software\ZIENTSOV_LATYNKA" "InstallDir"
RequestExecutionLevel user
SetCompressor zlib
BrandingText "ZIENTSOV LATYNKA · Зєнцов Дмитро Володимирович"
Icon "payload_v046\app\assets\ZIENTSOV_LATYNKA.ico"
UninstallIcon "payload_v046\app\assets\ZIENTSOV_LATYNKA.ico"

!define MUI_ABORTWARNING
!define MUI_ICON "payload_v046\app\assets\ZIENTSOV_LATYNKA.ico"
!define MUI_UNICON "payload_v046\app\assets\ZIENTSOV_LATYNKA.ico"
!define MUI_WELCOMEPAGE_TITLE "Встановлення ZIENTSOV LATYNKA ${APP_VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Український словник, перевірка правопису та транслітератор.$\r$\n$\r$\nМайстер допоможе встановити застосунок на цей комп’ютер."
!define MUI_DIRECTORYPAGE_TEXT_TOP "Оберіть папку для встановлення ZIENTSOV LATYNKA."
!define MUI_FINISHPAGE_RUN "$INSTDIR\START_ZIENTSOV_LATYNKA.vbs"
!define MUI_FINISHPAGE_RUN_TEXT "Запустити ZIENTSOV LATYNKA"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_FINISHPAGE_LINK "Власник: Зєнцов Дмитро Володимирович"
!define MUI_FINISHPAGE_LINK_LOCATION "mailto:zencovdmitro@gmail.com"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Ukrainian"

Function StopRunningApp
  IfFileExists "$INSTDIR\runtime.pid" 0 done
  FileOpen $0 "$INSTDIR\runtime.pid" r
  FileRead $0 $1
  FileClose $0
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /PID $1 /T /F'
  Delete "$INSTDIR\runtime.pid"
done:
FunctionEnd

Function LaunchApp
  Exec '"$SYSDIR\wscript.exe" "$INSTDIR\START_ZIENTSOV_LATYNKA.vbs"'
FunctionEnd

Section "ZIENTSOV LATYNKA" SEC_MAIN
  Call StopRunningApp
  SetOutPath "$INSTDIR"
  File /r "payload_v046\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\ZIENTSOV LATYNKA"
  CreateShortcut "$SMPROGRAMS\ZIENTSOV LATYNKA\ZIENTSOV LATYNKA.lnk" "$INSTDIR\START_ZIENTSOV_LATYNKA.vbs" "" "$INSTDIR\app\assets\ZIENTSOV_LATYNKA.ico"
  CreateShortcut "$SMPROGRAMS\ZIENTSOV LATYNKA\Видалити ZIENTSOV LATYNKA.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\ZIENTSOV LATYNKA.lnk" "$INSTDIR\START_ZIENTSOV_LATYNKA.vbs" "" "$INSTDIR\app\assets\ZIENTSOV_LATYNKA.ico"

  WriteRegStr HKCU "Software\ZIENTSOV_LATYNKA" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${APP_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${APP_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${APP_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${APP_KEY}" "DisplayIcon" "$INSTDIR\app\assets\ZIENTSOV_LATYNKA.ico"
  WriteRegStr HKCU "${APP_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${APP_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${APP_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${APP_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${APP_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Call un.StopRunningApp
  Delete "$DESKTOP\ZIENTSOV LATYNKA.lnk"
  RMDir /r "$SMPROGRAMS\ZIENTSOV LATYNKA"
  DeleteRegKey HKCU "${APP_KEY}"
  DeleteRegKey HKCU "Software\ZIENTSOV_LATYNKA"
  RMDir /r "$INSTDIR"
SectionEnd

Function un.StopRunningApp
  IfFileExists "$INSTDIR\runtime.pid" 0 done
  FileOpen $0 "$INSTDIR\runtime.pid" r
  FileRead $0 $1
  FileClose $0
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /PID $1 /T /F'
  Delete "$INSTDIR\runtime.pid"
done:
FunctionEnd
