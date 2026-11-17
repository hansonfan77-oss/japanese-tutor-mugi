# Tests run without Windows API calls: same file in PS 5.1/7 CI. Never kills a real process.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Runtime.ps1"
$script:checks = 0
function Assert-True($Value, [string]$Message) {
    if (!$Value) { throw "FAIL: $Message" }; $script:checks++
}
function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $threw = $false
    try { & $Action } catch { $threw = $true }
    Assert-True $threw $Message
}
class FakeMugiProcess {
    [int]$Id = 4242
    [long]$Handle = 1
    [datetime]$StartTime = [datetime]'2026-01-01T00:00:00Z'
    [bool]$Killed = $false
    [bool]$Disposed = $false
    [void]Kill() { $this.Killed = $true }
    [bool]WaitForExit([int]$Timeout) { return $true }
    [void]Dispose() { $this.Disposed = $true }
}
# Shadow OS commands only inside this test script scope.
function Get-Process { param($Id, $ErrorAction) return $script:fake }
function Get-CimInstance { param($ClassName, $Filter) return $script:cim }
$owner = '0123456789abcdef0123456789abcdef'
$exe = Join-Path ([System.IO.Path]::GetTempPath()) 'node.exe'
$script:fake = [FakeMugiProcess]::new()
$script:cim = [pscustomobject]@{ ExecutablePath = $exe; CommandLine = "node production.js --mugi-owner=$owner" }
$r = New-MugiRecord $script:fake 'server' "--mugi-owner=$owner" $owner
Assert-True ($r.StartTicks -eq $script:fake.StartTime.ToUniversalTime().Ticks) 'record creation time'
Stop-MugiServer $r
Assert-True $script:fake.Killed 'stop exact owner'
$script:fake = [FakeMugiProcess]::new()
$script:fake.StartTime = $script:fake.StartTime.AddSeconds(1)
Stop-MugiServer $r
Assert-True (!$script:fake.Killed) 'PID reuse never killed'
$script:fake = [FakeMugiProcess]::new()
$script:cim.CommandLine = 'node unrelated.js'
Assert-Throws { Stop-MugiServer $r } 'mismatched command fails closed'
Assert-True (!$script:fake.Killed) 'unrelated node survives'
$script:cim.CommandLine = $null
Assert-Throws { Stop-MugiServer $r } 'inaccessible command fails closed'
$script:fake = $null
Stop-MugiServer $r
$hostRecord = [pscustomobject]@{ Role = 'host' }
Assert-Throws { Stop-MugiServer $hostRecord } 'cannot kill supervisor shell'
$failures = 0
for ($i = 1; $i -le 5; $i++) { $failures = Get-MugiFailureCount $failures 0 }
Assert-True ($failures -eq 5) 'five consecutive failures'
for ($i = 0; $i -lt 1000; $i++) { $failures = Get-MugiFailureCount $failures 301 }
Assert-True ($failures -eq 1) 'healthy long runs reset history indefinitely'
Assert-True ((Get-MugiFailureCount 3 299) -eq 4) 'short healthy run does not reset breaker'
$directory = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $directory | Out-Null
try {
    $lock = Open-MugiLock $directory
    try { Assert-Throws { $second = Open-MugiLock $directory; $second.Dispose() } 'exclusive lock blocks parallel install/start' }
    finally { $lock.Dispose() }
    $lock = Open-MugiLock $directory; $lock.Dispose()
    $path = Join-Path $directory 'server.json'
    Save-MugiRecord $path $r
    Assert-True ((Read-MugiRecord $path).Owner -eq $owner) 'atomic record round trip'
    '{"Schema":9}' | Set-Content $path
    Assert-Throws { Read-MugiRecord $path } 'corrupt record fails closed'
    Set-Content (Join-Path $directory 'server.pid') '4242'
    $script:fake = [FakeMugiProcess]::new()
    Assert-Throws { Assert-MugiLegacyStopped $directory } 'live legacy PID preserved'
    Assert-True (!$script:fake.Killed) 'legacy PID not killed'
    $script:fake = $null
    Assert-MugiLegacyStopped $directory
    Assert-True (!(Test-Path (Join-Path $directory 'server.pid'))) 'dead legacy PID cleaned'
    Save-MugiRecord (Join-Path $directory 'host.json') $r
    Clear-MugiStaleHost $directory
    Assert-True (!(Test-Path (Join-Path $directory 'host.json'))) 'dead host record cleaned'
    $script:fake = [FakeMugiProcess]::new()
    $script:cim.CommandLine = $r.CommandLine
    $r.StopFile = Join-Path $directory 'node-stop.request'
    Stop-MugiServer $r
    Assert-True (!$script:fake.Killed) 'graceful stop avoids force kill'
    Assert-True (!(Test-Path $r.StopFile)) 'graceful stop marker cleaned'
    foreach ($file in Get-ChildItem $PSScriptRoot -Filter '*.ps1') {
        $tokens = $null; $errors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
        Assert-True ($errors.Count -eq 0) "parse $($file.Name)"
    }
} finally { Remove-Item $directory -Recurse -Force }
Write-Host "PASS: $script:checks runtime assertions on PowerShell $($PSVersionTable.PSVersion). Windows live integration remains separate."
