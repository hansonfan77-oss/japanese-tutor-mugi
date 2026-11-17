param([string]$NodeHome = '', [ValidateSet('Acceptance', 'Normal')][string]$Mode = 'Acceptance', [string]$AcceptanceRoot = '', [string]$AllowedHost = '')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Runtime.ps1"
. "$PSScriptRoot/Tools.ps1"
$root = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $root
$tools = Resolve-MugiNode $NodeHome
$layout = Resolve-MugiLayout $root $Mode $AcceptanceRoot
$directory = $layout.Runtime
New-Item -ItemType Directory -Force $directory | Out-Null
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $directory /inheritance:r /grant:r "*${sid}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict runtime directory permissions.' }
$lock = Open-MugiLock $directory
$owner = [guid]::NewGuid().ToString('N')
$hostPath = Join-Path $directory 'host.json'
$serverPath = Join-Path $directory 'server.json'
$stopPath = Join-Path $directory "stop-$owner.request"
$child = $null
$childRecord = $null
$hostSaved = $false
try {
    Assert-MugiLegacyStopped $directory
    Clear-MugiStaleHost $directory
    $orphan = Read-MugiRecord $serverPath
    if ($orphan) { Stop-MugiServer $orphan; Remove-Item -LiteralPath $serverPath }
    if (!(Test-Path 'dist-server/production.js')) { throw 'Run Install.ps1 first.' }
    $node = $tools.Node
    # Refuse a port collision before launch; never terminate the process holding it.
    $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $layout.Port)
    try { $probe.Start() } finally { $probe.Stop() }
    $hostProcess = Get-Process -Id $PID
    try { $hostRecord = New-MugiRecord $hostProcess 'host' (Join-Path $PSScriptRoot 'Start.ps1') $owner }
    finally { $hostProcess.Dispose() }
    Save-MugiRecord $hostPath $hostRecord
    $hostSaved = $true
    $env:MUGI_ALLOWED_HOSTS = $AllowedHost
    $env:MUGI_DATA_DIR = $layout.Data
    $env:MUGI_RUN_MODE = $Mode.ToLowerInvariant()
    $env:MUGI_ACCEPTANCE_ROOT = $layout.AcceptanceRoot
    $env:MUGI_PORT = [string]$layout.Port
    Write-Host "Mugi $Mode mode; loopback port $($layout.Port); isolated runtime: $directory"
    $failures = 0
    while ($failures -lt 5 -and !(Test-Path -LiteralPath $stopPath)) {
        # Release process handles from prior runs; healthy restarts may continue for months.
        if ($child) { $child.Dispose(); $child = $null; $childRecord = $null }
        Get-ChildItem $directory -Filter '*.log' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 8 | Remove-Item
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $nodeStopPath = Join-Path $directory "node-stop-$owner.request"
        Remove-Item -LiteralPath $nodeStopPath -ErrorAction SilentlyContinue
        $arguments = '"' + (Join-Path $root 'dist-server/production.js') + '" --mugi-owner=' + $owner
        $child = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -PassThru -RedirectStandardOutput "$directory/$stamp-out.log" -RedirectStandardError "$directory/$stamp-err.log"
        try {
            $childRecord = New-MugiRecord $child 'server' ("--mugi-owner=" + $owner) $owner $nodeStopPath
            Save-MugiRecord $serverPath $childRecord
        } catch {
            # This is the Process object we just created, never a PID read from a file.
            if (!$child.HasExited) { $child.Kill(); $null = $child.WaitForExit(10000) }
            throw
        }
        $healthySince = $null
        $healthySeconds = 0
        $misses = 0
        $nextHealth = [datetime]::UtcNow
        while (!$child.HasExited -and !(Test-Path -LiteralPath $stopPath)) {
            Start-Sleep -Seconds 1
            if ($child.HasExited) { break }
            if ([datetime]::UtcNow -lt $nextHealth) { continue }
            $nextHealth = [datetime]::UtcNow.AddSeconds(10)
            try {
                $h = Invoke-RestMethod "http://127.0.0.1:$($layout.Port)/api/health" -TimeoutSec 5
                if ($h.ok -ne $true -or $h.mode -ne 'production' -or $h.runMode -ne $Mode.ToLowerInvariant()) { throw 'Unexpected health response' }
                if ($null -eq $healthySince) { $healthySince = [datetime]::UtcNow }
                $healthySeconds = [Math]::Max($healthySeconds, ([datetime]::UtcNow - $healthySince).TotalSeconds)
                $misses = 0
            } catch { $misses++; $healthySince = $null }
            if ($misses -ge 3) { Stop-MugiServer $childRecord; break }
        }
        if (Test-Path -LiteralPath $stopPath) { break }
        $failures = Get-MugiFailureCount $failures $healthySeconds
        if ($failures -ge 5) { throw 'Five consecutive short failures. Inspect logs before restarting.' }
        Write-Host "Mugi exited; consecutive short failure count: $failures/5. Retrying in 10 seconds."
        for ($i = 0; $i -lt 10 -and !(Test-Path -LiteralPath $stopPath); $i++) { Start-Sleep -Seconds 1 }
    }
} finally {
    try {
        if ($childRecord) { Stop-MugiServer $childRecord }
        if ($hostSaved) {
            Remove-Item -LiteralPath $hostPath, $serverPath, $stopPath -ErrorAction SilentlyContinue
        }
    } finally {
        if ($child) { $child.Dispose() }
        $lock.Dispose()
    }
}
