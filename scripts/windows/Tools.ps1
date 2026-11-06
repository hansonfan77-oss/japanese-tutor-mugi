# Explicit ZIP toolchain selection. No machine/user PATH or execution policy changes.
function Resolve-MugiNode([string]$NodeHome) {
    if (!$NodeHome -or ![System.IO.Path]::IsPathRooted($NodeHome)) { throw 'Pass -NodeHome with the absolute extracted Node.js 24 ZIP directory (containing node.exe).' }
    $directory = (Resolve-Path -LiteralPath $NodeHome).Path
    $node = Join-Path $directory 'node.exe'
    $npmCli = Join-Path $directory 'node_modules/npm/bin/npm-cli.js'
    if (!(Test-Path -LiteralPath $node -PathType Leaf) -or !(Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw 'NodeHome must contain node.exe and node_modules/npm/bin/npm-cli.js. Extract the complete official ZIP.' }
    $version = & $node --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v24\.\d+\.\d+$') { throw "Expected Node.js 24 in NodeHome, found '$version'. System Node.js 22 is not selected automatically." }
    Write-Host "Selected Node: $node ($version)"
    return [pscustomobject]@{ Node = $node; NpmCli = $npmCli; Directory = $directory; Version = $version }
}
function Invoke-MugiNpm($Toolchain, [string[]]$NpmArguments) {
    $previousPath = $env:PATH
    try {
        # Only this process/its npm children see the selected node first; restore after invocation.
        $env:PATH = $Toolchain.Directory + [System.IO.Path]::PathSeparator + $previousPath
        $options = @()
        if ($env:MUGI_RUN_MODE -eq 'acceptance') {
            if (!$env:MUGI_ACCEPTANCE_ROOT) { throw 'Acceptance npm requires MUGI_ACCEPTANCE_ROOT.' }
            $npmState = Join-Path $env:MUGI_ACCEPTANCE_ROOT 'state'
            $emptyConfig = Join-Path $npmState 'npm-empty.conf'
            if (!(Test-Path -LiteralPath $emptyConfig)) { New-Item -ItemType File $emptyConfig | Out-Null }
            $globalConfig = Join-Path $npmState 'npm-global-empty.conf'
            if (!(Test-Path -LiteralPath $globalConfig)) { New-Item -ItemType File $globalConfig | Out-Null }
            $options = @('--userconfig', $emptyConfig, '--globalconfig', $globalConfig, '--cache', (Join-Path $npmState 'npm-cache'), '--registry', 'https://registry.npmjs.org')
        }
        & $Toolchain.Node $Toolchain.NpmCli @options @NpmArguments
        if ($LASTEXITCODE -ne 0) { throw "Selected Node/npm failed (exit $LASTEXITCODE)." }
    } finally { $env:PATH = $previousPath }
}
function Assert-MugiNoReparse([string]$Path) {
    $cursor = [System.IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Acceptance paths cannot use symlinks/junctions. Choose a plain local directory.' }
        }
        $cursor = [System.IO.Path]::GetDirectoryName($cursor)
    }
}
function Resolve-MugiLayout([string]$Root, [string]$Mode, [string]$AcceptanceRoot, [bool]$Initialize = $true) {
    if ($Mode -notin @('Acceptance', 'Normal')) { throw 'Choose Acceptance or Normal explicitly; no fallback mode.' }
    $marker = Join-Path $Root '.mugi-acceptance'
    if ($Mode -eq 'Normal') {
        if (Test-Path -LiteralPath $marker) { throw 'This is an acceptance checkout. Use a separate checkout for Normal mode; no data is migrated.' }
        return [pscustomobject]@{ Runtime = (Join-Path $Root '.runtime'); Data = (Join-Path $env:LOCALAPPDATA 'MugiTutor'); AcceptanceRoot = ''; Port = 3004 }
    }
    # Inspect names only. Never load/copy a production .env, cache, account or usage file.
    foreach ($item in Get-ChildItem -LiteralPath $Root -Force) {
        if (($item.Name -match '^\.env(\.|$)' -and $item.Name -ne '.env.example') -or $item.Name -in @('.usage', '.tts-cache', '.tts-keep', '.runtime', 'voicevox_engine', '.npmrc')) {
            throw 'Acceptance requires a fresh dedicated clone without .env, usage, caches, runtime or engines. Do not delete production data; clone into a new directory.'
        }
    }
    if (!$AcceptanceRoot) {
        $hash = [System.Security.Cryptography.SHA256]::Create()
        try { $bytes = $hash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant())) }
        finally { $hash.Dispose() }
        $id = ([System.BitConverter]::ToString($bytes)).Replace('-', '').Substring(0, 16)
        $AcceptanceRoot = Join-Path $env:LOCALAPPDATA "MugiTutor-Acceptance/$id"
    }
    if (![System.IO.Path]::IsPathRooted($AcceptanceRoot)) { throw 'AcceptanceRoot must be an absolute dedicated directory.' }
    $target = [System.IO.Path]::GetFullPath($AcceptanceRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    if ($target -eq $rootPath -or $target.StartsWith($rootPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or $rootPath.StartsWith($target + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'AcceptanceRoot must be outside the checkout.' }
    $normalAccount = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'MugiTutor'))
    if ($target -eq $normalAccount -or $target.StartsWith($normalAccount + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or $normalAccount.StartsWith($target + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'AcceptanceRoot cannot overlap the normal MugiTutor account.' }
    Assert-MugiNoReparse $target
    if (!$Initialize -and !(Test-Path -LiteralPath $target)) { return [pscustomobject]@{ Runtime = (Join-Path $target 'runtime'); Data = (Join-Path $target 'state/oauth'); AcceptanceRoot = $target; Port = 3006 } }
    New-Item -ItemType Directory -Force $target | Out-Null
    $ownerFile = Join-Path $target 'acceptance-root.json'
    if (!(Test-Path -LiteralPath $ownerFile)) {
        if (!$Initialize) { throw 'No acceptance root marker. Refusing to stop an unknown directory.' }
        if (@(Get-ChildItem -LiteralPath $target -Force).Count) { throw 'AcceptanceRoot is not empty or marked; choose a new directory. Nothing was copied or overwritten.' }
        @{ schema = 1; checkout = $Root } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ownerFile -Encoding UTF8
    }
    $owner = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
    if ($owner.schema -ne 1 -or $owner.checkout -ne $Root) { throw 'AcceptanceRoot belongs to another checkout.' }
    foreach ($item in Get-ChildItem -LiteralPath $target -Force -Recurse) { if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Acceptance data cannot contain symlinks/junctions.' } }
    foreach ($part in @('runtime', 'state')) { Assert-MugiNoReparse (Join-Path $target $part); New-Item -ItemType Directory -Force (Join-Path $target $part) | Out-Null }
    if ($Initialize) { Set-Content -LiteralPath $marker 'acceptance' -Encoding ASCII }
    return [pscustomobject]@{ Runtime = (Join-Path $target 'runtime'); Data = (Join-Path $target 'state/oauth'); AcceptanceRoot = $target; Port = 3006 }
}
