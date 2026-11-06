$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot/../..")
if (Test-Path '.runtime/host.pid') { throw 'Stop Mugi before installing/building.' }
$major = [int]((& node -p 'process.versions.node.split(".")[0]') | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0 -or $major -lt 22) { throw 'Install Node.js 24 LTS first.' }
& npm.cmd ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
Write-Host 'Installed. Configure optional AI access locally; no paid services were enabled.'
