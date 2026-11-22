<#
.SYNOPSIS
  Installs Vade Agent as a Windows service on a club gaming PC.
.DESCRIPTION
  Double click install.cmd (it asks for administrator rights).
  The club key and admin IP come from agent.json next to this script
  (the admin panel writes it with "Export agent package"), or from parameters:
    install.cmd -ClubKey <key> [-AdminIp 10.70.4.10] [-Port 7420] [-KeepLegacyTask]
  Messages are in English on purpose: Windows PowerShell 5.1 misreads non-ASCII scripts.
#>
param(
  [string]$ClubKey,
  [string]$AdminIp,
  [int]$Port = 0,
  [switch]$KeepLegacyTask,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$scriptPath = $MyInvocation.MyCommand.Path
$here = Split-Path -Parent $scriptPath
$installDir = Join-Path $env:ProgramFiles 'VadeAgent'
$dataDir = Join-Path $env:ProgramData 'VadeAgent'
$serviceId = 'VadeAgent'
$ruleName = 'Vade Agent'

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }

# ---- administrator rights -------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$scriptPath`"")
  if ($ClubKey) { $argList += @('-ClubKey', $ClubKey) }
  if ($AdminIp) { $argList += @('-AdminIp', $AdminIp) }
  if ($Port -gt 0) { $argList += @('-Port', $Port) }
  if ($KeepLegacyTask) { $argList += '-KeepLegacyTask' }
  Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList $argList
  exit
}

$failed = $false
try {
  # ---- configuration ------------------------------------------------------
  Write-Step 'Reading configuration'
  $cfg = @{ clubKey = ''; port = 7420; bind = '0.0.0.0'; allowFrom = @() }
  foreach ($cfgName in @('preconfig.json', 'agent.json')) {
    $cfgFile = Join-Path $here $cfgName
    if (Test-Path -LiteralPath $cfgFile) {
      $j = Get-Content -LiteralPath $cfgFile -Raw | ConvertFrom-Json
      if ($j.clubKey) { $cfg.clubKey = [string]$j.clubKey }
      if ($j.port) { $cfg.port = [int]$j.port }
      if ($j.allowFrom -and @($j.allowFrom).Count -gt 0) {
        $cfg.allowFrom = @($j.allowFrom)
      } elseif ($j.adminIp) {
        $cfg.allowFrom = @([string]$j.adminIp)
      }
      if ($j.noPause -eq $true) { $NoPause = $true }
      break
    }
  }
  if ($ClubKey) { $cfg.clubKey = $ClubKey }
  if ($AdminIp) { $cfg.allowFrom = @($AdminIp) }
  if ($Port -gt 0) { $cfg.port = $Port }
  if (-not $cfg.clubKey) {
    throw 'Club key is missing. In the admin panel use Settings -> "Export agent package", or run: install.cmd -ClubKey <key>'
  }

  # ---- Windows 11 Smart App Control blocks unsigned executables -------------
  $sac = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState
  if ($sac -eq 1) {
    Write-Host 'WARNING: Smart App Control is ON. Unsigned VadeAgent.exe / VadeAgentService.exe may be blocked.' -ForegroundColor Yellow
    Write-Host '         If the service does not start: sign the files, or turn Smart App Control off.' -ForegroundColor Yellow
  }

  # ---- stop an older installation -----------------------------------------
  $svcExe = Join-Path $installDir 'VadeAgentService.exe'
  if (Get-Service -Name $serviceId -ErrorAction SilentlyContinue) {
    Write-Step 'Stopping the installed agent'
    if (Test-Path -LiteralPath $svcExe) {
      & $svcExe stop | Out-Null
      & $svcExe uninstall | Out-Null
    } else {
      & sc.exe stop $serviceId | Out-Null
      & sc.exe delete $serviceId | Out-Null
    }
    Start-Sleep -Seconds 3
  }

  # ---- program files ------------------------------------------------------
  Write-Step "Copying files to $installDir"
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  foreach ($f in 'VadeAgent.exe', 'VadeAgentService.exe', 'VadeAgentService.xml', 'uninstall.ps1', 'uninstall.cmd') {
    Copy-Item -LiteralPath (Join-Path $here $f) -Destination $installDir -Force
  }

  # ---- Windows Defender exclusions (protects OTA updates of unsigned VadeAgent.exe)
  Write-Step 'Windows Defender: adding exclusions for VadeAgent folders'
  try {
    Add-MpPreference -ExclusionPath "C:\Program Files\VadeAgent", "C:\ProgramData\VadeAgent" -ErrorAction Stop
    Write-Host "    Added Defender exclusions: C:\Program Files\VadeAgent, C:\ProgramData\VadeAgent"
  } catch {
    Write-Host "    Skipped Defender exclusions: $($_.Exception.Message)" -ForegroundColor DarkGray
  }

  # ---- data folder: SYSTEM + Administrators only (players must not read the club key)
  Write-Step "Writing $dataDir\agent.json"
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  & icacls.exe $dataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  $json = [ordered]@{ clubKey = $cfg.clubKey; port = $cfg.port; bind = $cfg.bind; allowFrom = @($cfg.allowFrom) } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $dataDir 'agent.json'), $json, (New-Object Text.UTF8Encoding $false))

  # ---- the old club_night_sleep.bat task would fight over C:\steamcmd\steamapps
  if (-not $KeepLegacyTask) {
    foreach ($t in 'Club Night', 'Steam Night Update') {
      if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $t -Confirm:$false
        Write-Host "    Removed the old scheduled task '$t' (replaced by Vade Agent)"
      }
    }
  }

  # ---- power policy (the agent re-applies it on every start) ---------------
  Write-Step 'Power policy: hibernation on, wake timers on, no password after wake (SENET)'
  & powercfg.exe /hibernate on | Out-Null
  & powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
  & powercfg.exe /setdcvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
  & powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0 | Out-Null
  & powercfg.exe /setdcvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0 | Out-Null
  & powercfg.exe /setactive SCHEME_CURRENT | Out-Null
  # Group Policy "Require a password when a computer wakes" = off (wins over the power scheme)
  $wakePolicyKey = 'HKLM\SOFTWARE\Policies\Microsoft\Power\PowerSettings\0e796bdb-100d-47d6-a2d5-f7d2daa51f51'
  foreach ($v in 'ACSettingIndex', 'DCSettingIndex') {
    & reg.exe add $wakePolicyKey /v $v /t REG_DWORD /d 0 /f | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "    WARNING: reg add $wakePolicyKey /v $v failed (code $LASTEXITCODE)" -ForegroundColor Yellow }
  }

  # ---- Wake-on-LAN on the network adapters (best effort, depends on the driver)
  Write-Step 'Enabling Wake-on-LAN on network adapters'
  Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
    $n = $_.Name
    try { Set-NetAdapterPowerManagement -Name $n -WakeOnMagicPacket Enabled -ErrorAction Stop } catch { }
    try { Set-NetAdapterAdvancedProperty -Name $n -RegistryKeyword '*WakeOnMagicPacket' -RegistryValue 1 -NoRestart -ErrorAction Stop } catch { }
    try { & powercfg.exe /deviceenablewake "$($_.InterfaceDescription)" 2>$null | Out-Null } catch { }
    Write-Host "    $n ($($_.InterfaceDescription))"
  }

  # ---- firewall -----------------------------------------------------------
  $remote = if ($cfg.allowFrom.Count -gt 0) { $cfg.allowFrom } else { 'LocalSubnet' }
  Write-Step "Firewall: allow TCP $($cfg.port) from $($remote -join ', ')"
  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $cfg.port -Action Allow `
    -RemoteAddress $remote -Profile Any -Program (Join-Path $installDir 'VadeAgent.exe') | Out-Null

  # ---- service ------------------------------------------------------------
  Write-Step 'Installing and starting the service'
  & $svcExe install | Out-Null
  & $svcExe start | Out-Null
  Start-Sleep -Seconds 3
  $svc = Get-Service -Name $serviceId
  if ($svc.Status -ne 'Running') { throw "Service state is $($svc.Status). See $dataDir\logs" }

  Write-Host ''
  Write-Host "DONE. Vade Agent is running, port $($cfg.port)." -ForegroundColor Green
  Write-Host "Log: $dataDir\logs\agent.log"
  Write-Host 'Next: in the admin panel select this PC and run "SteamCMD login" once.'
} catch {
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  $failed = $true
}
if (-not $NoPause) { Read-Host 'Press Enter to close' | Out-Null }
if ($failed) { exit 1 }
