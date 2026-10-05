; Uninstall hooks for the NSIS installer.
;
; The voice cache and the log live in %LOCALAPPDATA%\Kotoba; the installer never
; recorded them, so the default uninstaller would leave them behind. Learner
; progress (%APPDATA%\Kotoba) is kept: it is the user's, and reinstalling
; shouldn't wipe months of study.

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\Kotoba\tts-cache"
  Delete "$LOCALAPPDATA\Kotoba\kotoba.log"
!macroend
