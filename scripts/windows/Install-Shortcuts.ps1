param([string]$NodeHome = '', [string]$AcceptanceRoot = '', [string]$AllowedHost = '', [string]$DesktopDirectory = '')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Tools.ps1"
. "$PSScriptRoot/ShortcutTools.ps1"
$root = (Resolve-Path "$PSScriptRoot/../..").Path
$tools = Resolve-MugiNode $NodeHome
Assert-MugiShortcutHost $AllowedHost
$layout = Resolve-MugiLayout $root 'Acceptance' $AcceptanceRoot $false
if (!(Test-Path -LiteralPath (Join-Path $root 'dist-server/production.js')) -or
    !(Test-Path -LiteralPath (Join-Path $layout.AcceptanceRoot 'acceptance-root.json'))) {
    throw 'Run Install.ps1 -Mode Acceptance with these paths first.'
}
if (!$DesktopDirectory) { $DesktopDirectory = [Environment]::GetFolderPath('Desktop') }
$desktop = (Resolve-Path -LiteralPath $DesktopDirectory).Path
if (!(Test-Path -LiteralPath $desktop -PathType Container)) { throw 'DesktopDirectory must be an existing directory.' }
$shell = New-Object -ComObject WScript.Shell
$target = Get-MugiPowerShell
$entry = Join-Path $PSScriptRoot 'Desktop.ps1'
$description = 'Mugi managed Acceptance shortcut v1'
$links = @()
try {
    # Preflight both names before writing either; never overwrite someone else's desktop shortcut.
    foreach ($action in @('Start', 'Stop')) {
        $path = Join-Path $desktop "Mugi $action (Acceptance).lnk"
        $shortcut = $shell.CreateShortcut($path)
        if ((Test-Path -LiteralPath $path) -and ($shortcut.Description -ne $description -or $shortcut.WorkingDirectory -ne $root -or $shortcut.TargetPath -ne $target)) {
            throw "Shortcut already exists and is not managed by this checkout: $path"
        }
        $values = @('-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', $entry, '-Action', $action, '-AcceptanceRoot', $layout.AcceptanceRoot)
        if ($action -eq 'Start') { $values += @('-NodeHome', $tools.Directory); if ($AllowedHost) { $values += @('-AllowedHost', $AllowedHost) } }
        $shortcut.TargetPath = $target
        $shortcut.Arguments = ($values | ForEach-Object { ConvertTo-MugiArgument $_ }) -join ' '
        $shortcut.WorkingDirectory = $root
        $shortcut.Description = $description
        $shortcut.WindowStyle = 1
        $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll," + $(if ($action -eq 'Start') { '137' } else { '131' })
        $links += $shortcut
    }
    foreach ($shortcut in $links) { $shortcut.Save() }
    Write-Host "Created Mugi Start / Stop (Acceptance) in: $desktop"
    Write-Host 'No server was started. No autostart, Tailscale, PATH or permanent execution-policy changes.'
} finally {
    foreach ($shortcut in $links) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
    $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}
