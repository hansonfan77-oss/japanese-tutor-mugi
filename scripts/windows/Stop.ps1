$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $root
# Verify process command lines and executable identity before using saved PIDs (PID reuse protection).
foreach ($entry in @(@('host.pid', (Join-Path $root 'scripts/windows/Start.ps1'), 'powershell|pwsh'), @('server.pid', (Join-Path $root 'dist-server/production.js'), '^node\.exe$'))) {
  $file = Join-Path '.runtime' $entry[0]
  if (!(Test-Path $file)) { continue }
  $processId = [int](Get-Content $file -Raw)
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
  if ($p) {
    if ($p.Name -notmatch $entry[2] -or !$p.CommandLine.Contains($entry[1])) { throw "PID identity uncertain: $processId. Inspect manually." }
    Stop-Process -Id $processId
  }
  Remove-Item $file -ErrorAction SilentlyContinue
}
Write-Host 'Mugi supervisor/server stopped. Tailscale Serve configuration is unchanged.'
