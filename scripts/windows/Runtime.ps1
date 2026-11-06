# Shared Windows runtime primitives. Keep syntax compatible with Windows PowerShell 5.1.
Set-StrictMode -Version 2.0
function Open-MugiLock([string]$Directory) {
    # FileShare.None is released by Windows even after a crash; the file itself may remain.
    return [System.IO.File]::Open((Join-Path $Directory 'owner.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
}
function Read-MugiRecord([string]$Path) {
    if (!(Test-Path -LiteralPath $Path)) { return $null }
    $r = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($r.Schema -ne 1 -or $r.Role -notin @('host', 'server') -or $r.Pid -le 0 -or
        $r.StartTicks -le 0 -or !$r.Executable -or !$r.CommandLine -or $r.Owner -notmatch '^[a-f0-9]{32}$') {
        throw "Invalid ownership record: $Path. Inspect manually."
    }
    return $r
}
function New-MugiRecord($Process, [string]$Role, [string]$Argument, [string]$Owner, [string]$StopFile = '') {
    # Hold an OS process handle and record creation time, not just a reusable PID.
    $null = $Process.Handle
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.Id)"
    if (!$cim -or !$cim.ExecutablePath -or !$cim.CommandLine -or !$cim.CommandLine.Contains($Argument)) {
        throw 'Cannot establish process ownership. Start with -File and an absolute script path.'
    }
    return [pscustomobject]@{
        Schema = 1; Role = $Role; Pid = $Process.Id; StartTicks = $Process.StartTime.ToUniversalTime().Ticks
        Executable = $cim.ExecutablePath; CommandLine = $cim.CommandLine; Owner = $Owner; StopFile = $StopFile
    }
}
function Save-MugiRecord([string]$Path, $Record) {
    $temp = "$Path.tmp"
    $Record | ConvertTo-Json -Compress | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $Path -Force
}
function Get-MugiProcess($Record) {
    $p = Get-Process -Id $Record.Pid -ErrorAction SilentlyContinue
    if (!$p) { return $null }
    try {
        $null = $p.Handle
        # A different start time proves PID reuse; never kill this replacement process.
        if ($p.StartTime.ToUniversalTime().Ticks -ne $Record.StartTicks) { $p.Dispose(); return $null }
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($Record.Pid)"
        if (!$cim -or !$cim.ExecutablePath -or !$cim.CommandLine) { throw 'Cannot inspect recorded process; refusing recovery.' }
        if ($cim.ExecutablePath -ne $Record.Executable -or $cim.CommandLine -cne $Record.CommandLine) {
            throw 'Process identity mismatch; refusing to stop any process.'
        }
        return $p
    } catch { $p.Dispose(); throw }
}
function Stop-MugiServer($Record) {
    if ($Record.Role -ne 'server' -or [System.IO.Path]::GetFileName($Record.Executable) -ne 'node.exe' -or
        !$Record.CommandLine.Contains("--mugi-owner=$($Record.Owner)")) { throw 'Not an owned Mugi Node process.' }
    $p = Get-MugiProcess $Record
    if ($p) {
        try {
            # Ask the owned Node to drain requests and flush usage before a bounded force-stop.
            if ($Record.StopFile) {
                New-Item -ItemType File -Force $Record.StopFile | Out-Null
                if ($p.WaitForExit(15000)) { Remove-Item -LiteralPath $Record.StopFile -ErrorAction SilentlyContinue; return }
            }
            $p.Kill()
            if (!$p.WaitForExit(10000)) { throw 'Owned Node did not stop.' }
            if ($Record.StopFile) { Remove-Item -LiteralPath $Record.StopFile -ErrorAction SilentlyContinue }
        }
        finally { $p.Dispose() }
    }
}
function Assert-MugiLegacyStopped([string]$Directory) {
    foreach ($name in @('host.pid', 'server.pid')) {
        $path = Join-Path $Directory $name
        if (!(Test-Path -LiteralPath $path)) { continue }
        $value = (Get-Content -LiteralPath $path -Raw).Trim()
        if ($value -notmatch '^\d+$') { throw "Invalid legacy PID file: $path" }
        $p = Get-Process -Id ([int]$value) -ErrorAction SilentlyContinue
        if ($p) { $p.Dispose(); throw 'Legacy PID is live but has no creation-time proof. Inspect and stop manually; no process was killed.' }
        Remove-Item -LiteralPath $path
    }
}
function Clear-MugiStaleHost([string]$Directory) {
    $path = Join-Path $Directory 'host.json'
    $r = Read-MugiRecord $path
    if ($r) {
        $p = Get-MugiProcess $r
        if ($p) { $p.Dispose(); throw 'Recorded supervisor is alive. Refusing a duplicate start/install.' }
        Remove-Item -LiteralPath $path
    }
}
function Get-MugiFailureCount([int]$Previous, [double]$HealthySeconds, [double]$ResetAfter = 300) {
    # Five consecutive short failures trip the breaker. A healthy five-minute run resets the history.
    if ($HealthySeconds -ge $ResetAfter) { return 1 }
    return $Previous + 1
}
