<#
.SYNOPSIS
    Sets up a fresh machine: installs every VS Code extension listed in
    vscode-extensions.txt, then builds this repo and installs the resulting .vsix.

.DESCRIPTION
    Run this once on a new computer and it restores the whole VS Code setup:

    1. Installs each extension from vscode-extensions.txt with --force, so you
       always end up on the newest marketplace version. No versions are pinned
       anywhere, and nothing is version-checked.
    2. Runs npm install, compiles the TypeScript, packages a .vsix with @vscode/vsce
       and installs it with --force, so the freshest local build always wins.
    3. Prints a summary and lists anything that has to be installed by hand.

    Requires the `code` CLI on PATH (VS Code -> "Shell Command: Install 'code' command
    in PATH") plus Node.js / npm for the build half.

.PARAMETER Export
    Rewrites vscode-extensions.txt from the extensions currently installed on this
    machine instead of installing anything. Run it after adding an extension you
    want to keep.

.PARAMETER SkipExtensions
    Only build and install this repo's extension.

.PARAMETER SkipBuild
    Only install the marketplace extensions.

.EXAMPLE
    .\Install-DevEnvironment.ps1

.EXAMPLE
    .\Install-DevEnvironment.ps1 -Export
#>
[CmdletBinding()]
param(
    [switch]$Export,
    [switch]$SkipExtensions,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
$ListPath = Join-Path $RepoRoot "vscode-extensions.txt"
$ManifestPath = Join-Path $env:USERPROFILE ".vscode\extensions\extensions.json"
$VsixPath = Join-Path $RepoRoot "zekelin-dotnet-tools.vsix"

function Write-Step($text) {
    Write-Host "`n=== $text ===" -ForegroundColor Cyan
}

# The extension this repo builds - never install it from the marketplace.
function Get-OwnExtensionId {
    $pkg = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
    return "$($pkg.publisher).$($pkg.name)"
}

# extensions.json is read directly because `code --list-extensions` can hang
# while a VS Code window is running.
function Get-InstalledExtensions {
    if (-not (Test-Path $ManifestPath)) {
        Write-Host "No VS Code extension manifest at $ManifestPath" -ForegroundColor Yellow
        return @()
    }
    return Get-Content $ManifestPath -Raw | ConvertFrom-Json
}

if ($Export) {
    Write-Step "Exporting installed extensions"

    $ownId = Get-OwnExtensionId
    $installed = Get-InstalledExtensions
    if ($installed.Count -eq 0) {
        Write-Host "Nothing to export." -ForegroundColor Red
        exit 1
    }

    $fromGallery = $installed |
        Where-Object { $_.metadata.source -eq "gallery" -and $_.identifier.id -ne $ownId } |
        ForEach-Object { $_.identifier.id } |
        Sort-Object -Unique

    $fromVsix = $installed |
        Where-Object { $_.metadata.source -ne "gallery" -and $_.identifier.id -ne $ownId } |
        ForEach-Object { $_.identifier.id } |
        Sort-Object -Unique

    $lines = @(
        "# VS Code extensions installed by Install-DevEnvironment.ps1."
        "# One marketplace extension id per line - no versions, the newest one is always installed."
        "# Blank lines and # comments are ignored."
        "# Regenerate from the current machine with: .\Install-DevEnvironment.ps1 -Export"
        ""
    )
    $lines += $fromGallery

    if ($fromVsix.Count -gt 0) {
        $lines += ""
        $lines += "# --- Installed from a .vsix, not from the marketplace ---"
        $lines += "# The script cannot fetch these; it only reminds you to install them by hand."
        $lines += ($fromVsix | ForEach-Object { "# $_" })
    }

    Set-Content -Path $ListPath -Value $lines -Encoding UTF8
    Write-Host "Wrote $($fromGallery.Count) marketplace extension(s) to $ListPath" -ForegroundColor Green
    if ($fromVsix.Count -gt 0) {
        Write-Host "Listed $($fromVsix.Count) .vsix-only extension(s) as comments." -ForegroundColor Yellow
    }
    exit 0
}

if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
    Write-Host "The 'code' CLI is not on PATH." -ForegroundColor Red
    Write-Host "Open VS Code, run 'Shell Command: Install code command in PATH', then rerun this script." -ForegroundColor Yellow
    exit 1
}

$failed = @()
$manual = @()
$cliBroken = $false

if (-not $SkipExtensions) {
    Write-Step "Installing VS Code extensions"

    if (-not (Test-Path $ListPath)) {
        Write-Host "Extension list not found: $ListPath" -ForegroundColor Red
        exit 1
    }

    $raw = Get-Content $ListPath
    $ids = $raw | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") }
    $manual = $raw |
        Where-Object { $_ -match '^\s*#\s*([\w-]+\.[\w-]+)\s*$' } |
        ForEach-Object { $Matches[1] }

    if ($ids.Count -eq 0) {
        Write-Host "No extensions listed in $ListPath" -ForegroundColor Yellow
    }

    # Three failures in a row means the CLI itself is down, not the extensions -
    # bail out instead of repeating the same error for every id.
    $streak = 0
    $i = 0
    foreach ($id in $ids) {
        $i++
        Write-Host "`n($i/$($ids.Count)) $id" -ForegroundColor Yellow
        & code --install-extension $id --force
        if ($LASTEXITCODE -eq 0) {
            $streak = 0
            continue
        }

        Write-Host "  FAILED: $id" -ForegroundColor Red
        $failed += $id
        $streak++
        if ($streak -ge 3) {
            $cliBroken = $true
            Write-Host "`nThe 'code' CLI failed three times in a row - it looks broken, not the extensions." -ForegroundColor Red
            Write-Host "Close VS Code completely (check Task Manager), reopen it once, then rerun this script." -ForegroundColor Yellow
            break
        }
    }
}

if (-not $SkipBuild) {
    Write-Step "Building and installing this extension"

    Push-Location $RepoRoot
    try {
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
            throw "npm is not on PATH - install Node.js first (https://nodejs.org)."
        }

        # npm ci needs a lockfile and wipes node_modules; fall back for a partial checkout.
        if (Test-Path (Join-Path $RepoRoot "package-lock.json")) {
            Write-Host "`nnpm ci ..." -ForegroundColor Yellow
            npm ci
        } else {
            Write-Host "`nnpm install ..." -ForegroundColor Yellow
            npm install
        }
        if ($LASTEXITCODE -ne 0) { throw "Dependency install failed." }

        Write-Host "`nCompiling TypeScript ..." -ForegroundColor Yellow
        npx tsc -p ./
        if ($LASTEXITCODE -ne 0) { throw "TypeScript compilation failed." }

        Write-Host "`nPackaging $VsixPath ..." -ForegroundColor Yellow
        npx --yes @vscode/vsce package --allow-missing-repository --skip-license -o $VsixPath
        if ($LASTEXITCODE -ne 0) { throw "vsce package failed." }

        Write-Host "`nInstalling $VsixPath ..." -ForegroundColor Yellow
        & code --install-extension $VsixPath --force
        if ($LASTEXITCODE -ne 0) { throw "Failed to install $VsixPath" }

        Write-Host "Installed zekelin-dotnet-tools." -ForegroundColor Green
    } catch {
        Write-Host "`nBuild step failed: $_" -ForegroundColor Red
        $failed += "build: $_"
    } finally {
        Pop-Location
    }
}

Write-Step "Summary"

if ($failed.Count -eq 0) {
    Write-Host "Everything installed." -ForegroundColor Green
} else {
    Write-Host "$($failed.Count) item(s) failed:" -ForegroundColor Red
    $failed | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
}

if ($cliBroken) {
    Write-Host "`nThe 'code' CLI stopped responding partway through." -ForegroundColor Yellow
    Write-Host "Fully close VS Code, reopen it once so it finishes any pending update, then rerun." -ForegroundColor Yellow
}

if ($manual.Count -gt 0) {
    Write-Host "`nInstall these by hand (not on the marketplace):" -ForegroundColor Yellow
    $manual | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
}

Write-Host "`nReload VS Code to activate everything." -ForegroundColor Cyan

if ($failed.Count -gt 0) { exit 1 }
