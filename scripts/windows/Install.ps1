$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Runtime.ps1"
$root = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $root
$directory = Join-Path $root '.runtime'
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
    $nodeVersion = & node.exe --version
    if ($LASTEXITCODE -ne 0) { throw 'Install Node.js 24 LTS first.' }
    $major = [int]($nodeVersion.TrimStart('v').Split('.')[0])
    if ($major -lt 24) { throw 'Node.js 24 LTS or newer required for this setup.' }
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
    Write-Host 'Installed. No paid services were enabled.'
} finally { $lock.Dispose() }
