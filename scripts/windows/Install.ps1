param([string]$NodeHome = '', [ValidateSet('Acceptance', 'Normal')][string]$Mode = 'Acceptance', [string]$AcceptanceRoot = '')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Runtime.ps1"
. "$PSScriptRoot/Tools.ps1"
$root = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $root
$tools = Resolve-MugiNode $NodeHome
$layout = Resolve-MugiLayout $root $Mode $AcceptanceRoot
$directory = $layout.Runtime
$env:MUGI_RUN_MODE = $Mode.ToLowerInvariant()
$env:MUGI_ACCEPTANCE_ROOT = $layout.AcceptanceRoot
New-Item -ItemType Directory -Force $directory | Out-Null
$lock = Open-MugiLock $directory
try {
    Assert-MugiLegacyStopped $directory
    Clear-MugiStaleHost $directory
    $r = Read-MugiRecord (Join-Path $directory 'server.json')
    if ($r) {
        $p = Get-MugiProcess $r
        if ($p) { $p.Dispose(); throw 'An owned orphan Node is alive. Run Stop.ps1 first.' }
        Remove-Item -LiteralPath (Join-Path $directory 'server.json')
    }
    Invoke-MugiNpm $tools @('ci', '--no-audit', '--no-fund')
    Invoke-MugiNpm $tools @('run', 'build')
    Write-Host 'Installed. No paid services were enabled.'
} finally { $lock.Dispose() }
