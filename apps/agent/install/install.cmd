@echo off
rem Vade Agent installer. Double click, or: install.cmd -ClubKey <key> -AdminIp <ip>
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
