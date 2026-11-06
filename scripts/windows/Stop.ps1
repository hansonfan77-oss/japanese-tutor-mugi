$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Runtime.ps1"
$root = (Resolve-Path "$PSScriptRoot/../..").Path
$directory = Join-Path $root '.runtime'
if (!(Test-Path -LiteralPath $directory)) { Write-Host 'Mugi is stopped.'; return }
$hostPath = Join-Path $directory 'host.json'
$hostRecord = Read-MugiRecord $hostPath
if ($hostRecord) {
    $p = Get-MugiProcess $hostRecord
    if ($p) {
        # Cooperative stop prevents restart races and permits finally cleanup. Never force-kill a shell.
        try {
            New-Item -ItemType File -Force (Join-Path $directory "stop-$($hostRecord.Owner).request") | Out-Null
            if (!$p.WaitForExit(45000)) { throw 'Supervisor did not stop in 45s. Inspect manually; no other process was terminated.' }
        } finally { $p.Dispose() }
    }
}
# A crash releases the lock. Recover only a proven owned orphan; unrelated/reused PIDs are untouched.
$lock = Open-MugiLock $directory
try {
    Assert-MugiLegacyStopped $directory
    Clear-MugiStaleHost $directory
    $serverPath = Join-Path $directory 'server.json'
    $r = Read-MugiRecord $serverPath
    if ($r) { Stop-MugiServer $r; Remove-Item -LiteralPath $serverPath }
} finally { $lock.Dispose() }
Write-Host 'Mugi stopped. Tailscale Serve configuration is unchanged.'
