param([ValidateSet('Start', 'Stop')][string]$Action, [string]$NodeHome = '', [string]$AcceptanceRoot = '', [string]$AllowedHost = '', [switch]$NonInteractive)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Runtime.ps1"
. "$PSScriptRoot/Tools.ps1"
. "$PSScriptRoot/ShortcutTools.ps1"
try {
    $root = (Resolve-Path "$PSScriptRoot/../..").Path
    $message = Invoke-MugiDesktopAction $Action $root $NodeHome $AcceptanceRoot $AllowedHost
    Write-Host $message
    if (!$NonInteractive) { Start-Sleep -Seconds 3 }
} catch {
    Write-Host "Mugi $Action failed: $($_.Exception.Message)" -ForegroundColor Red
    if (!$NonInteractive) { $null = Read-Host 'Press Enter to close (no settings were reset)' }
    exit 1
}
