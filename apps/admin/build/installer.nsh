; Force-closes any running Vade Launcher background/tray instance before NSIS
; copies or removes files, preventing NSIS error ": 2" on upgrades.
!macro _vadeStopRunningApp
  nsExec::ExecToLog 'taskkill /F /IM "Vade Launcher.exe" /T'
  Sleep 1000
!macroend

!macro customInit
  !insertmacro _vadeStopRunningApp
!macroend

!macro customUnInit
  !insertmacro _vadeStopRunningApp
!macroend

!macro customCheckAppRunning
  !insertmacro _vadeStopRunningApp
!macroend
