@echo off
rem Vade Agent uninstaller. Add -Purge to also delete logs, state and the club key.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
