# Desktop entry points reuse the existing ownership/Acceptance boundaries. PowerShell 5.1 compatible.
function ConvertTo-MugiArgument([string]$Value) {
    if ($Value -match '["\r\n\x00]') { throw 'Invalid command-line argument.' }
    # Windows argv parsing doubles trailing backslashes before the closing quote.
    return '"' + [regex]::Replace($Value, '(\\+)$', '$1$1') + '"'
}
function Get-MugiPowerShell {
    return (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe')
}
function Assert-MugiShortcutHost([string]$AllowedHost) {
    if ($AllowedHost -and $AllowedHost -notmatch '^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$') {
        throw 'AllowedHost must be one exact DNS name, without scheme, port or wildcard.'
    }
}
function Test-MugiAcceptanceHealth {
    try {
        $h = Invoke-RestMethod 'http://127.0.0.1:3006/api/health' -TimeoutSec 2
        $r = Invoke-RestMethod 'http://127.0.0.1:3006/api/runtime' -TimeoutSec 2
        return ($h.ok -eq $true -and $h.service -eq 'mugi' -and $h.mode -eq 'production' -and $h.runMode -eq 'acceptance' -and
            $r.mode -eq 'acceptance' -and $r.externalServices -eq $false -and $r.browserSpeech -eq $false)
    } catch { return $false }
}
function Invoke-MugiDesktopAction([string]$Action, [string]$Root, [string]$NodeHome, [string]$AcceptanceRoot, [string]$AllowedHost) {
    if ($Action -notin @('Start', 'Stop')) { throw 'Choose Start or Stop.' }
    Assert-MugiShortcutHost $AllowedHost
    $layout = Resolve-MugiLayout $Root 'Acceptance' $AcceptanceRoot $false
    $scripts = Join-Path $Root 'scripts/windows'
    if ($Action -eq 'Stop') {
        & (Join-Path $scripts 'Stop.ps1') -Mode Acceptance -AcceptanceRoot $layout.AcceptanceRoot
        return 'Mugi stopped. Tailscale configuration is unchanged.'
    }
    $tools = Resolve-MugiNode $NodeHome
    if (!(Test-Path -LiteralPath (Join-Path $Root 'dist-server/production.js'))) { throw 'Run Install.ps1 before using Start.' }
    if (!(Test-Path -LiteralPath (Join-Path $layout.AcceptanceRoot 'acceptance-root.json'))) { throw 'Run Install.ps1 with this AcceptanceRoot first.' }
    $lock = [System.IO.File]::Open((Join-Path $layout.Runtime 'desktop-start.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $child = $null
    try {
        $record = Read-MugiRecord (Join-Path $layout.Runtime 'host.json')
        if ($record) {
            if ($record.Role -ne 'host') { throw 'Unexpected supervisor record.' }
            $existing = Get-MugiProcess $record
            if ($existing) {
                try {
                    if (!(Test-MugiAcceptanceHealth)) { throw 'Mugi is already running but not healthy. Inspect its window/logs; no duplicate was started.' }
                    return 'Mugi is already running in Acceptance mode.'
                } finally { $existing.Dispose() }
            }
        }
        $arguments = @('-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', (Join-Path $scripts 'Start.ps1'),
            '-NodeHome', $tools.Directory, '-Mode', 'Acceptance', '-AcceptanceRoot', $layout.AcceptanceRoot)
        if ($AllowedHost) { $arguments += @('-AllowedHost', $AllowedHost) }
        $line = ($arguments | ForEach-Object { ConvertTo-MugiArgument $_ }) -join ' '
        # A separate -File process is required for Start.ps1's CIM ownership proof. No -NoExit, hidden process or elevation.
        $child = Start-Process -FilePath (Get-MugiPowerShell) -ArgumentList $line -WorkingDirectory $Root -WindowStyle Minimized -PassThru
        $deadline = [datetime]::UtcNow.AddSeconds(45)
        while ([datetime]::UtcNow -lt $deadline) {
            if ($child.HasExited) { throw 'Mugi did not start. Check runtime logs; the port may already be occupied.' }
            $record = Read-MugiRecord (Join-Path $layout.Runtime 'host.json')
            if ($record -and $record.Pid -eq $child.Id -and (Test-MugiAcceptanceHealth)) {
                return 'Mugi ready (Acceptance, port 3006). Keep its minimized server window open. Phone Tailscale must be connected.'
            }
            Start-Sleep -Milliseconds 500
        }
        throw 'Startup did not become healthy in 45 seconds. Inspect the server window/logs, or use Mugi Stop. No unrelated process was stopped.'
    } finally {
        if ($child) { $child.Dispose() }
        $lock.Dispose()
    }
}
