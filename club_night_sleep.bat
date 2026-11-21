@echo off
title Club night: cleanup + game update
setlocal EnableExtensions EnableDelayedExpansion

:: ================= SETTINGS =================
:: Number of this PC in the club: 1, 2, 3 ... 29 (no leading zero).
::   ASK = the file asks for the number during setup, nothing to edit per PC.
set "PC_NUM=ASK"
:: Daily start time of PC number 1, HH:MM 24h, two digits.
:: PC 2 starts STEP_MIN minutes later, PC 3 two steps later and so on.
set "START_TIME=11:00"
:: Minutes between two PCs
set "STEP_MIN=1"
:: What to do with the PC when the work is finished:
::   none     = leave the PC on
::   sleep    = put the PC to sleep, it wakes up by itself next day
::   shutdown = turn the PC off, it can wake up only by Wake-on-LAN or BIOS timer
set "AFTER=hibernate"
:: Club Steam account for SteamCMD. Password is NOT stored here.
set "STEAM_USER=vadekrarow"
:: Which games to update:
::   auto        = every game installed on this PC, in all Steam libraries
::   730 570 ... = only these AppIDs. 730 = CS2, 570 = Dota 2, 578080 = PUBG
set "APPS=auto"
:: 1 = verify game files every night, slow. 0 = update only
set "VALIDATE=0"
:: 1 = also delete Steam userdata = players' local game settings and cfg. 0 = keep
set "CLEAN_USERDATA=0"
:: 1 = delete Steam Workshop maps and mods in all libraries. 0 = keep
set "CLEAN_WORKSHOP=1"
:: Steam client folder
set "STEAM=C:\Program Files (x86)\Steam"
:: SteamCMD folder. This file copies itself here.
set "STEAMCMD_DIR=C:\steamcmd"
set "TASK_NAME=Club Night"
:: ============================================

set "LOG=%STEAMCMD_DIR%\club_night_log.txt"
set "OUT=%STEAMCMD_DIR%\last_output.txt"
set "SA=%STEAMCMD_DIR%\steamapps"
set "ERRS=0"

:: Admin rights
net session >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

if not exist "%STEAMCMD_DIR%" mkdir "%STEAMCMD_DIR%"

:: Started by the scheduler -> do the night work
if /i "%~1"=="run" goto :work

:: =====================================================
::   SETUP - when you start this file by double click
:: =====================================================
echo =============================================
echo   Club night task - setup
echo =============================================
echo.
if /i "%STEAM_USER%"=="CHANGE_ME" (
    echo First open this file in Notepad and set STEAM_USER.
    start "" notepad "%~f0"
    pause
    exit /b 1
)
if not exist "%STEAM%\steam.exe" (
    echo ERROR: Steam not found: "%STEAM%\steam.exe"
    echo Fix the STEAM line in the settings.
    pause
    exit /b 1
)

:askpc
set "PCOK=0"
if /i not "%PC_NUM%"=="ASK" (
    echo %PC_NUM%|findstr /r "^[1-9][0-9]*$" >nul && set "PCOK=1"
)
if "%PCOK%"=="0" (
    set "PC_NUM=ASK"
    set /p "PC_NUM=Enter the number of this PC, 1-99, no leading zero: "
    goto :askpc
)
call :calc_time
echo PC number %PC_NUM%: daily start at %RUN_TIME%, after the work: %AFTER%
echo.

echo [1/5] Copying this file to %STEAMCMD_DIR%
if /i not "%~f0"=="%STEAMCMD_DIR%\club_night.bat" (
    copy /y "%~f0" "%STEAMCMD_DIR%\club_night.bat" >nul
    if errorlevel 1 (
        echo ERROR: could not copy this file to %STEAMCMD_DIR%
        pause
        exit /b 1
    )
)

echo [2/5] Checking SteamCMD
call :get_steamcmd
if not exist "%STEAMCMD_DIR%\steamcmd.exe" (
    echo ERROR: could not download SteamCMD
    pause
    exit /b 1
)

echo [3/5] Steam login for %STEAM_USER%
echo       If asked, type the Steam password and then the Steam Guard code.
echo       The password is not shown while you type - this is normal.
"%STEAMCMD_DIR%\steamcmd.exe" +login %STEAM_USER% +quit
echo.

echo [4/5] Allowing the PC to wake up from sleep for the task
powercfg /hibernate on >nul 2>&1
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 >nul 2>&1
powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 >nul 2>&1
powercfg /setactive SCHEME_CURRENT >nul 2>&1

echo [5/5] Creating the scheduled task
echo       A window will ask for the WINDOWS password of this account.
schtasks /delete /tn "Steam Night Update" /f >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$__f=[IO.File]::ReadAllText('%~f0'); iex $__f.Substring($__f.LastIndexOf('::PSBEGIN') + 9)"
if errorlevel 1 (
    echo ERROR: could not create the scheduled task.
    pause
    exit /b 1
)

echo.
echo DONE. PC %PC_NUM%: every day at %RUN_TIME% - close Steam, clean TEMP and Steam logins, update games.
echo Log file: %LOG%
echo.
choice /c YN /m "Run the night task now to test it"
if errorlevel 2 exit /b

> "%STEAMCMD_DIR%\skip_after.flag" echo test
schtasks /run /tn "%TASK_NAME%" >nul
echo.
echo Test is running. Big game updates can take a long time.
echo You can close this window - the task keeps working.
echo Download progress: %OUT%
:waitloop
ping -n 11 127.0.0.1 >nul
set "ST="
for /f %%S in ('powershell -NoProfile -Command "(Get-ScheduledTask -TaskName $env:TASK_NAME).State"') do set "ST=%%S"
if /i "%ST%"=="Running" (
    <nul set /p "=."
    goto :waitloop
)
echo.
echo ----- end of the log -----
powershell -NoProfile -Command "Get-Content -LiteralPath $env:LOG -Tail 25"
echo.
pause
exit /b

:: =====================================================
::   NIGHT WORK - started by the scheduler
:: =====================================================
:work
if exist "%LOG%" for %%F in ("%LOG%") do if %%~zF GTR 2000000 del "%LOG%"
call :log "===== START - Windows user %USERNAME% ====="
if not exist "%STEAM%\steam.exe" (
    call :log "ERROR: Steam not found - nothing was done"
    exit /b 1
)

:: keep the PC awake while the work runs (separate hidden PowerShell, see the end of the file)
> "%STEAMCMD_DIR%\awake.flag" echo 1
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command "$__f=[IO.File]::ReadAllText('%STEAMCMD_DIR%\club_night.bat'); $__a=$__f.IndexOf('::PS'+'AWAKE')+9; $__b=$__f.IndexOf('::PS'+'AWAKEEND'); iex $__f.Substring($__a,$__b-$__a)"

call :log "[1/5] Closing Steam"
taskkill /f /im steam.exe >nul 2>&1
taskkill /f /im steamwebhelper.exe >nul 2>&1
taskkill /f /im gameoverlayui.exe >nul 2>&1
:: wait 5 seconds - timeout does not work inside scheduled tasks
ping -n 6 127.0.0.1 >nul

call :log "[2/5] Cleaning TEMP of all Windows users"
for /d %%U in ("C:\Users\*") do (
    if exist "%%U\AppData\Local\Temp" (
        del /f /s /q "%%U\AppData\Local\Temp\*" >nul 2>&1
        for /d %%D in ("%%U\AppData\Local\Temp\*") do rd /s /q "%%D" >nul 2>&1
    )
)
del /f /s /q "%SystemRoot%\Temp\*" >nul 2>&1
for /d %%D in ("%SystemRoot%\Temp\*") do rd /s /q "%%D" >nul 2>&1

call :log "[3/5] Removing saved Steam logins"
if exist "%STEAM%\config\loginusers.vdf" del /f /q "%STEAM%\config\loginusers.vdf" >nul 2>&1
del /f /q "%STEAM%\ssfn*" >nul 2>&1
for /d %%U in ("C:\Users\*") do (
    if exist "%%U\AppData\Local\Steam\local.vdf" del /f /q "%%U\AppData\Local\Steam\local.vdf" >nul 2>&1
)
:: registry of users that are logged in now
for /f %%K in ('reg query HKU 2^>nul ^| findstr /i "S-1-5-21-" ^| findstr /v /i "_Classes"') do call :clean_reg "%%K"
:: registry of users that are logged out
for /d %%U in ("C:\Users\*") do (
    if exist "%%U\NTUSER.DAT" (
        reg load "HKU\ClubTmp" "%%U\NTUSER.DAT" >nul 2>&1
        if not errorlevel 1 (
            call :clean_reg "HKU\ClubTmp"
            reg unload "HKU\ClubTmp" >nul 2>&1
        )
    )
)

call :log "[4/5] Cleaning Steam cache"
for %%F in (htmlcache appcache logs dumps depotcache) do (
    if exist "%STEAM%\%%F" rd /s /q "%STEAM%\%%F" >nul 2>&1
)
for /d %%U in ("C:\Users\*") do (
    if exist "%%U\AppData\Local\Steam\htmlcache" rd /s /q "%%U\AppData\Local\Steam\htmlcache" >nul 2>&1
)
if "%CLEAN_USERDATA%"=="1" if exist "%STEAM%\userdata" rd /s /q "%STEAM%\userdata" >nul 2>&1

call :log "[5/5] Updating games"
call :get_steamcmd
if not exist "%STEAMCMD_DIR%\steamcmd.exe" (
    call :log "ERROR: SteamCMD not found and could not be downloaded"
    set /a ERRS+=1
    goto :finish
)
set "VAL="
if "%VALIDATE%"=="1" set "VAL= validate"

:: find all Steam libraries - games can be on C:, D: and so on
set "LIBFILE=%STEAM%\steamapps\libraryfolders.vdf"
if not exist "%LIBFILE%" set "LIBFILE=%STEAM%\config\libraryfolders.vdf"
set "NLIB=0"
if exist "%LIBFILE%" (
    for /f "usebackq tokens=1,*" %%a in ("%LIBFILE%") do (
        if /i "%%~a"=="path" (
            set "L=%%~b"
            set "L=!L:\\=\!"
            set /a NLIB+=1
            call :update_lib "!L!"
        )
    )
)
if "%NLIB%"=="0" call :update_lib "%STEAM%"

:finish
if "%ERRS%"=="0" (
    call :log "RESULT: OK"
) else (
    call :log "RESULT: %ERRS% errors - see lines above"
)
call :log "===== END ====="

del "%STEAMCMD_DIR%\awake.flag" >nul 2>&1
if exist "%STEAMCMD_DIR%\skip_after.flag" (
    del "%STEAMCMD_DIR%\skip_after.flag" >nul 2>&1
    call :log "Test run - the PC stays on"
    exit /b
)
if /i "%AFTER%"=="sleep" call :do_sleep
if /i "%AFTER%"=="hibernate" call :do_hibernate
if /i "%AFTER%"=="shutdown" call :do_shutdown
exit /b


:: =====================================================
::   SUBROUTINES
:: =====================================================

:log
>> "%LOG%" echo [%date% %time%] %~1
echo %~1
exit /b

:calc_time
:: RUN_TIME = START_TIME + (PC_NUM - 1) * STEP_MIN
for /f "tokens=1,2 delims=:" %%a in ("%START_TIME%") do (
    set /a "SH=1%%a-100"
    set /a "SM=1%%b-100"
)
set /a "TOT=(SH*60+SM+(PC_NUM-1)*STEP_MIN) %% 1440"
set /a "RH=TOT/60"
set /a "RM=TOT%%60"
set "HH=0!RH!"
set "MM=0!RM!"
set "RUN_TIME=!HH:~-2!:!MM:~-2!"
exit /b

:do_sleep
call :log "The PC goes to sleep in 30 seconds"
ping -n 31 127.0.0.1 >nul
powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend',$false,$false)"
exit /b

:do_hibernate
call :log "The PC goes to hibernate in 30 seconds"
ping -n 31 127.0.0.1 >nul
shutdown /h
exit /b

:do_shutdown
call :log "The PC turns off in 60 seconds"
shutdown /s /f /t 60
exit /b

:get_steamcmd
if exist "%STEAMCMD_DIR%\steamcmd.exe" exit /b
curl -s -L -o "%STEAMCMD_DIR%\steamcmd.zip" https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip
tar -xf "%STEAMCMD_DIR%\steamcmd.zip" -C "%STEAMCMD_DIR%"
del "%STEAMCMD_DIR%\steamcmd.zip" >nul 2>&1
exit /b

:clean_reg
reg query "%~1\Software\Valve\Steam" >nul 2>&1
if errorlevel 1 exit /b
reg delete "%~1\Software\Valve\Steam" /v AutoLoginUser /f >nul 2>&1
reg add "%~1\Software\Valve\Steam" /v RememberPassword /t REG_DWORD /d 0 /f >nul 2>&1
exit /b

:unlink
:: removes the temporary link C:\steamcmd\steamapps - never deletes game files
fsutil reparsepoint query "%SA%" >nul 2>&1
if not errorlevel 1 (
    rd "%SA%" >nul 2>&1
    exit /b
)
if exist "%SA%" ren "%SA%" "steamapps_old_%RANDOM%" >nul 2>&1
exit /b

:update_lib
set "LIB=%~1"
if not exist "%LIB%\steamapps" exit /b
if "%CLEAN_WORKSHOP%"=="1" (
    if exist "%LIB%\steamapps\workshop" (
        call :log "  Cleaning Steam Workshop in %LIB%"
        if exist "%LIB%\steamapps\workshop\content" rd /s /q "%LIB%\steamapps\workshop\content" >nul 2>&1
        if exist "%LIB%\steamapps\workshop\downloads" rd /s /q "%LIB%\steamapps\workshop\downloads" >nul 2>&1
        if exist "%LIB%\steamapps\workshop\temp" rd /s /q "%LIB%\steamapps\workshop\temp" >nul 2>&1
        del /f /q "%LIB%\steamapps\workshop\appworkshop_*.acf" >nul 2>&1
    )
)
set "IDS="
for %%M in ("%LIB%\steamapps\appmanifest_*.acf") do (
    set "ID=%%~nM"
    set "ID=!ID:appmanifest_=!"
    set "TAKE=0"
    if /i "%APPS%"=="auto" set "TAKE=1"
    for %%X in (%APPS%) do if "%%X"=="!ID!" set "TAKE=1"
    if "!TAKE!"=="1" set "IDS=!IDS! !ID!"
)
if not defined IDS exit /b
call :log "  Library: %LIB%"
call :log "  Games:!IDS!"

set "CMDS="
for %%I in (!IDS!) do set "CMDS=!CMDS! +app_update %%I!VAL!"

:: SteamCMD updates games in its own steamapps folder.
:: A temporary link points it to this library, so games are updated IN PLACE
:: and the Steam client sees them as up to date.
call :unlink
if exist "%SA%" (
    call :log "  ERROR: %SA% is in the way"
    set /a ERRS+=1
    exit /b
)
mklink /J "%SA%" "%LIB%\steamapps" >nul 2>&1
if errorlevel 1 (
    call :log "  ERROR: could not link %LIB%\steamapps"
    set /a ERRS+=1
    exit /b
)
"%STEAMCMD_DIR%\steamcmd.exe" +@NoPromptForPassword 1 +login %STEAM_USER% !CMDS! +quit > "%OUT%" 2>&1
call :unlink

findstr /l /i /c:"Cached credentials not found" /c:"Steam Public...FAILED" /c:"Login Failure" /c:"Not logged on" "%OUT%" >nul
if not errorlevel 1 (
    call :log "  LOGIN ERROR - start club_night.bat by hand and log in to Steam again"
    set /a ERRS+=1
    exit /b
)
for %%I in (!IDS!) do (
    findstr /l /i /c:"App '%%I' fully installed" /c:"App '%%I' already up to date" "%OUT%" >nul
    if not errorlevel 1 (
        call :log "  %%I: OK"
    ) else (
        findstr /l /i /c:"'%%I' (No subscription)" "%OUT%" >nul
        if not errorlevel 1 (
            call :log "  %%I: skipped - the club account does not own this game"
        ) else (
            call :log "  %%I: ERROR - see last_output.txt"
            set /a ERRS+=1
        )
    )
)
exit /b


:: =====================================================
::   PowerShell part 1: keeps the PC awake while the night work runs.
::   Never run by cmd - read by the work step above.
:: =====================================================
::PSAWAKE
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
$flag = Join-Path $env:STEAMCMD_DIR 'awake.flag'
$end = (Get-Date).AddHours(8)
while ((Test-Path -LiteralPath $flag) -and ((Get-Date) -lt $end)) {
    [void][W.P]::SetThreadExecutionState(2147483649)
    Start-Sleep -Seconds 20
}
[void][W.P]::SetThreadExecutionState(2147483648)
::PSAWAKEEND

:: =====================================================
::   PowerShell part 2: creates the scheduled task.
::   Never run by cmd - read by the setup step above.
:: =====================================================
::PSBEGIN
$ErrorActionPreference = 'Stop'
$dir = $env:STEAMCMD_DIR
$act = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $dir + '\club_night.bat" run') -WorkingDirectory $dir
$trg = New-ScheduledTaskTrigger -Daily -At $env:RUN_TIME
$cfg = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 8) -MultipleInstances IgnoreNew
$user = "$env:USERDOMAIN\$env:USERNAME"
$ok = $false
for ($i = 1; ($i -le 3) -and (-not $ok); $i++) {
    $cred = Get-Credential -UserName $user -Message "Windows password of $user. The night task runs under this account."
    if (-not $cred) { break }
    try {
        Register-ScheduledTask -TaskName $env:TASK_NAME -Action $act -Trigger $trg -Settings $cfg -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Highest -Force | Out-Null
        $ok = $true
        Write-Host "      Task created. It runs as $user."
    } catch {
        Write-Host "      Wrong password, or this Windows account has no password. Try again."
    }
}
if (-not $ok) {
    $prn = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $env:TASK_NAME -Action $act -Trigger $trg -Settings $cfg -Principal $prn -Force | Out-Null
    Write-Host "      Task created as SYSTEM."
    Write-Host "      If the test shows LOGIN ERROR: set a Windows password for $user and run setup again."
}
