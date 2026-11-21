<#
.SYNOPSIS
  Removes Vade Agent from this PC. Game files and SteamCMD are never touched.
  uninstall.cmd [-Purge]   (-Purge also deletes C:\ProgramData\VadeAgent: logs, state, club key)
#>
param(
  [switch]$Purge,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$scriptPath = $MyInvocation.MyCommand.Path
$installDir = Join-Path $env:ProgramFiles 'VadeAgent'
$dataDir = Join-Path $env:ProgramData 'VadeAgent'
$serviceId = 'VadeAgent'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$scriptPath`"")
  if ($Purge) { $argList += '-Purge' }
  Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList $argList
  exit
}

$failed = $false
try {
  $svcExe = Join-Path $installDir 'VadeAgentService.exe'
  if (Get-Service -Name $serviceId -ErrorAction SilentlyContinue) {
    Write-Host '==> Stopping and removing the service'
    if (Test-Path -LiteralPath $svcExe) {
      & $svcExe stop | Out-Null
      & $svcExe uninstall | Out-Null
    } else {
      & sc.exe stop $serviceId | Out-Null
      & sc.exe delete $serviceId | Out-Null
    }
    Start-Sleep -Seconds 3
  }

  Write-Host '==> Removing firewall rule and wake timer task'
  Get-NetFirewallRule -DisplayName 'Vade Agent' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Unregister-ScheduledTask -TaskPath '\VadeAgent\' -TaskName 'VadeAgent Wake' -Confirm:$false -ErrorAction SilentlyContinue
  # player-session reporter of the occupancy detector
  Stop-ScheduledTask -TaskPath '\VadeAgent\' -TaskName 'VadeAgent Presence' -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskPath '\VadeAgent\' -TaskName 'VadeAgent Presence' -Confirm:$false -ErrorAction SilentlyContinue

  # A temporary SteamCMD junction must never stay behind (rd without /s removes only the link).
  $steamcmdDir = 'C:\steamcmd'
  $stateFile = Join-Path $dataDir 'state.json'
  if (Test-Path -LiteralPath $stateFile) {
    try { $steamcmdDir = (Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json).config.maintenance.steamcmdDir } catch { }
  }
  if ($steamcmdDir) {
    $slot = Join-Path $steamcmdDir 'steamapps'
    $item = Get-Item -LiteralPath $slot -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      & cmd.exe /d /c rd "$slot"
      Write-Host "    Removed junction $slot"
    }
  }

  Write-Host "==> Deleting $installDir"
  if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
  if ($Purge -and (Test-Path -LiteralPath $dataDir)) {
    Write-Host "==> Deleting $dataDir"
    Remove-Item -LiteralPath $dataDir -Recurse -Force
  }
  Write-Host 'DONE. Vade Agent removed.' -ForegroundColor Green
} catch {
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  $failed = $true
}
if (-not $NoPause) { Read-Host 'Press Enter to close' | Out-Null }
if ($failed) { exit 1 }
