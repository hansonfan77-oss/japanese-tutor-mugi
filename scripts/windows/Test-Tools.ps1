# Windows CI: use real Node/npm in a path containing spaces, with isolated fixtures only.
param([string]$SourceNodeHome = '')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Tools.ps1"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
$nodeHome = Join-Path $testRoot 'Node 24 ZIP with spaces'
$checkout = Join-Path $testRoot 'Acceptance checkout'
$data = Join-Path $testRoot 'Acceptance data'
$priorLocal = $env:LOCALAPPDATA
$priorPath = $env:PATH
$priorMode = $env:MUGI_RUN_MODE
$priorAcceptance = $env:MUGI_ACCEPTANCE_ROOT
$priorLocation = Get-Location
$script:checks = 0
$supervisor = $null
$unrelated = $null
function Assert-Check($Condition, [string]$Message) { if (!$Condition) { throw "FAIL: $Message" }; $script:checks++ }
function Assert-Rejected([scriptblock]$Action, [string]$Message) {
    $failed = $false; try { & $Action | Out-Null } catch { $failed = $true }; Assert-Check $failed $Message
}
try {
    if (!$SourceNodeHome) { $SourceNodeHome = Split-Path ((Get-Command node.exe -CommandType Application | Select-Object -First 1).Source) }
    New-Item -ItemType Directory -Force $nodeHome, $checkout | Out-Null
    Copy-Item (Join-Path $SourceNodeHome 'node.exe') (Join-Path $nodeHome 'node.exe')
    New-Item -ItemType Directory -Force (Join-Path $nodeHome 'node_modules') | Out-Null
    Copy-Item (Join-Path $SourceNodeHome 'node_modules/npm') (Join-Path $nodeHome 'node_modules/npm') -Recurse
    $tools = Resolve-MugiNode $nodeHome
    Assert-Check ($tools.Node -eq (Join-Path $nodeHome 'node.exe')) 'explicit node path selected'
    Assert-Rejected { Resolve-MugiNode '' } 'missing NodeHome does not use system Node'
    Assert-Rejected { Resolve-MugiNode $checkout } 'incomplete ZIP rejected'
    $env:LOCALAPPDATA = Join-Path $testRoot 'LocalAppData'
    $layout = Resolve-MugiLayout $checkout 'Acceptance' $data
    $env:MUGI_RUN_MODE = 'acceptance'; $env:MUGI_ACCEPTANCE_ROOT = $data
    Set-Location $checkout
    # npm run invokes a child by name. Its node and npm_cli must still come from our ZIP.
    $package = @{ scripts = @{ verify = 'node -e "require(''fs'').writeFileSync(''selected.json'',JSON.stringify({node:process.execPath,npm:process.env.npm_execpath}))"' } }
    $package | ConvertTo-Json -Depth 4 | Set-Content 'package.json' -Encoding ASCII
    Invoke-MugiNpm $tools @('run', 'verify')
    $selected = Get-Content 'selected.json' -Raw | ConvertFrom-Json
    Assert-Check ($selected.node -eq $tools.Node) 'npm child uses selected Node despite spaces'
    Assert-Check ($selected.npm -eq $tools.NpmCli) 'npm CLI belongs to selected ZIP'
    Assert-Check ($env:PATH -eq $priorPath) 'process PATH restored after npm'
    Assert-Check ($layout.Port -eq 3006 -and $layout.Runtime -eq (Join-Path $data 'runtime')) 'acceptance port and runtime isolated'
    Assert-Check ($layout.Data -ne (Join-Path $env:LOCALAPPDATA 'MugiTutor')) 'OAuth data does not use normal account'
    Assert-Rejected { Resolve-MugiLayout $checkout 'Normal' '' } 'acceptance checkout cannot silently become normal'
    $other = Join-Path $testRoot 'Other checkout'; New-Item -ItemType Directory $other | Out-Null
    Assert-Rejected { Resolve-MugiLayout $other 'Acceptance' $data } 'another checkout cannot share acceptance data'
    Set-Content (Join-Path $other '.env.local') 'fake-production-key'
    Assert-Rejected { Resolve-MugiLayout $other 'Acceptance' (Join-Path $testRoot 'unused') } 'dirty checkout refused without reading keys'
    Assert-Check ((Get-Content (Join-Path $other '.env.local') -Raw).Trim() -eq 'fake-production-key') 'formal sentinel unchanged'
    $normal = Join-Path $testRoot 'Normal checkout'; New-Item -ItemType Directory $normal | Out-Null
    $normalLayout = Resolve-MugiLayout $normal 'Normal' ''
    Assert-Check ($normalLayout.Port -eq 3004 -and $normalLayout.Data -eq (Join-Path $env:LOCALAPPDATA 'MugiTutor')) 'explicit normal preserves legacy layout'
    $stopped = Join-Path $testRoot 'Never started'; New-Item -ItemType Directory $stopped | Out-Null
    $null = Resolve-MugiLayout $stopped 'Acceptance' (Join-Path $testRoot 'never data') $false
    Assert-Check (!(Test-Path (Join-Path $stopped '.mugi-acceptance'))) 'Stop layout does not claim an unstarted checkout'
    # Exercise the actual supervisor, CIM identity checks and selected ZIP child on the Windows runner.
    $sourceRoot = (Resolve-Path "$PSScriptRoot/../..").Path
    $fixtureScripts = Join-Path $checkout 'scripts/windows'
    New-Item -ItemType Directory -Force $fixtureScripts | Out-Null
    foreach ($name in @('Install.ps1', 'Start.ps1', 'Stop.ps1', 'Runtime.ps1', 'Tools.ps1')) { Copy-Item (Join-Path $PSScriptRoot $name) (Join-Path $fixtureScripts $name) }
    Copy-Item (Join-Path $sourceRoot 'dist') (Join-Path $checkout 'dist') -Recurse
    Copy-Item (Join-Path $sourceRoot 'dist-server') (Join-Path $checkout 'dist-server') -Recurse
    New-Item -ItemType Junction -Path (Join-Path $checkout 'node_modules') -Target (Join-Path $sourceRoot 'node_modules') | Out-Null
    $shellName = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' }
    $startScript = Join-Path $fixtureScripts 'Start.ps1'
    $supervisor = Start-Process (Join-Path $PSHOME $shellName) -ArgumentList @('-NoProfile', '-File', ('"' + $startScript + '"'), '-NodeHome', ('"' + $nodeHome + '"'), '-AcceptanceRoot', ('"' + $data + '"')) -PassThru -RedirectStandardOutput (Join-Path $testRoot 'supervisor-out.txt') -RedirectStandardError (Join-Path $testRoot 'supervisor-err.txt')
    $ready = $false
    for ($i = 0; $i -lt 45; $i++) {
        if ($supervisor.HasExited) { $detail = Get-Content (Join-Path $testRoot 'supervisor-err.txt') -Raw; throw "Fixture supervisor exited before readiness: $detail" }
        try { $health = Invoke-RestMethod 'http://127.0.0.1:3006/api/health' -TimeoutSec 2; $ready = $health.runMode -eq 'acceptance' -and (Test-Path -LiteralPath (Join-Path $data 'runtime/server.json')) } catch { }
        if ($ready) { break }; Start-Sleep -Seconds 1
    }
    Assert-Check $ready 'actual Windows supervisor starts acceptance bundle using ZIP path with spaces'
    $record = Get-Content (Join-Path $data 'runtime/server.json') -Raw | ConvertFrom-Json
    Assert-Check ($record.Executable -eq $tools.Node) 'actual Node child executable matches selected ZIP'
    Assert-Check (!(Test-Path (Join-Path $checkout '.runtime'))) 'runtime control and logs stay outside checkout'
    $unrelatedScript = Join-Path $testRoot 'unrelated.js'; Set-Content $unrelatedScript 'setInterval(() => {}, 1000);' -Encoding ASCII
    $unrelated = Start-Process $tools.Node -ArgumentList ('"' + $unrelatedScript + '"') -PassThru
    & (Join-Path $fixtureScripts 'Stop.ps1') -AcceptanceRoot $data
    Assert-Check ($supervisor.WaitForExit(10000)) 'actual supervisor stops cooperatively'
    Assert-Check (!$unrelated.HasExited) 'other Node process survives Stop'
    Assert-Check (!(Test-Path (Join-Path $data 'runtime/server.json'))) 'owned control records cleaned after stop'
    Write-Host "PASS: $script:checks ZIP toolchain and layout checks on PowerShell $($PSVersionTable.PSVersion)."
} finally {
    if ($supervisor -and !$supervisor.HasExited) {
        try { & (Join-Path $checkout 'scripts/windows/Stop.ps1') -AcceptanceRoot $data } catch { }
        if (!$supervisor.HasExited) { $supervisor.Kill(); $null = $supervisor.WaitForExit(10000) }
    }
    if ($unrelated -and !$unrelated.HasExited) { $unrelated.Kill(); $null = $unrelated.WaitForExit(10000) }
    # Remove only the test-created junction itself, never the dependency checkout behind it.
    $junction = Join-Path $checkout 'node_modules'
    if (Test-Path -LiteralPath $junction) { [System.IO.Directory]::Delete($junction) }
    Set-Location $priorLocation
    $env:LOCALAPPDATA = $priorLocal; $env:PATH = $priorPath
    $env:MUGI_RUN_MODE = $priorMode; $env:MUGI_ACCEPTANCE_ROOT = $priorAcceptance
    Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
