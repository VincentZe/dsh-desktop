# Builds the dsh-desktop shell and its luna_ui dependency.
param(
    [string]$LunaUiDir = (Join-Path $PSScriptRoot "..\..\webview2-shell"),
    [string]$WebView2Root = $env:WEBVIEW2_ROOT
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $root "..")).Path
$build = Join-Path $root "build"

if (-not (Test-Path (Join-Path $LunaUiDir "CMakeLists.txt"))) {
    Write-Error "LunaUI framework not found at $LunaUiDir (pass -LunaUiDir <path>)"
}
if (-not $WebView2Root -or -not (Test-Path $WebView2Root)) {
    Write-Error "WebView2 SDK not found (pass -WebView2Root <path> or set WEBVIEW2_ROOT)"
}

cmake -S $root -B $build -A x64 `
    -DWEBVIEW2_ROOT="$WebView2Root" `
    -DLUNA_UI_DIR="$LunaUiDir" | Out-Host
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

cmake --build $build --config Release | Out-Host
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$portable = Join-Path $build "portable"
if (Test-Path -LiteralPath $portable) {
    Remove-Item -LiteralPath $portable -Recurse -Force
}
New-Item -ItemType Directory -Path $portable | Out-Null

Push-Location $repoRoot
try {
    pnpm run build:lib:host | Out-Host
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    pnpm run build:lib:client | Out-Host
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    pnpm run build:web | Out-Host
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    node --import tsx/esm (Join-Path $root "build-runtime.ts") `
        --staging (Join-Path $build ".dsh-web-staging") `
        --output (Join-Path $portable "dsh\dsh-web.exe") | Out-Host
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

Copy-Item -LiteralPath (Join-Path $build "Release\dsh-desktop.exe") -Destination $portable
Copy-Item -LiteralPath (Join-Path $build "Release\WebView2Loader.dll") -Destination $portable
Copy-Item -LiteralPath (Join-Path $root "config.portable.json") -Destination (Join-Path $portable "config.json")

Write-Host ""
Write-Host "Portable package: $portable"
Write-Host "Fixed Web runtime: $(Join-Path $portable "dsh\dsh-web.exe")"
Write-Host ""
Write-Host "Built: $build\Release\dsh-desktop.exe"
Write-Host "Run: $portable\dsh-desktop.exe"
