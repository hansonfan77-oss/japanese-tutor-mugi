param([string]$AllowedHost = '')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $root
New-Item -ItemType Directory -Force '.runtime' | Out-Null
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe '.runtime' /inheritance:r /grant:r "${sid}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict runtime log directory permissions.' }
if (Test-Path '.runtime/host.pid') { throw 'Host PID file exists. Run Stop.ps1 and check processes first.' }
if (!(Test-Path 'dist-server/production.js')) { throw 'Run Install.ps1 first.' }
# Run a visible supervisor. Task Scheduler can launch it at logon under this same user.
Set-Content '.runtime/host.pid' $PID
$env:MUGI_ALLOWED_HOSTS = $AllowedHost
$env:MUGI_DATA_DIR = Join-Path $env:LOCALAPPDATA 'MugiTutor'
$env:MUGI_PORT = '3004'
$failures = 0
try {
  while ($failures -lt 5) {
    # Keep at most 5 timestamped log pairs. Logs are private local files; do not upload them blindly.
    Get-ChildItem '.runtime' -Filter '*.log' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 8 | Remove-Item
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $child = Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"' + (Join-Path $root 'dist-server/production.js') + '"') -WorkingDirectory $root -PassThru -RedirectStandardOutput ".runtime/$stamp-out.log" -RedirectStandardError ".runtime/$stamp-err.log"
    Set-Content '.runtime/server.pid' $child.Id
    $healthy = $false
    # Check readiness and ongoing liveness, not only a PID. No keys or user data are logged.
    $misses = 0
    while (!$child.HasExited) {
      Start-Sleep -Seconds 10
      if ($child.HasExited) { break }
      try {
        $h = Invoke-RestMethod 'http://127.0.0.1:3004/api/health' -TimeoutSec 5
        if ($h.ok -ne $true -or $h.mode -ne 'production') { throw 'Unexpected health response' }
        $healthy = $true; $misses = 0
      } catch { $misses++ }
      if ($misses -ge 3) { Stop-Process -Id $child.Id; break }
    }
    $failures++
    Write-Host "Mugi stopped (attempt $failures/5; readiness observed: $healthy). Retrying in 10 seconds."
    Start-Sleep -Seconds 10
  }
  throw 'Restart limit reached. Inspect .runtime logs before restarting.'
} finally {
  if ($child -and !$child.HasExited) { Stop-Process -Id $child.Id -ErrorAction SilentlyContinue }
  Remove-Item '.runtime/host.pid', '.runtime/server.pid' -ErrorAction SilentlyContinue
}
