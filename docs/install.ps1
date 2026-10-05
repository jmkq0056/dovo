# Dovo installer for Windows.
#
#   irm https://jmkq0056.github.io/dovo/install.ps1 | iex
#
# Downloads the latest Dovo release, installs it for the current user (no admin rights,
# no wizard), adds it to the Start menu, the desktop, Explorer's context menu and PATH, offers to
# install Claude Code if it's missing, and opens Dovo. Running it again updates in place.
# Coming from Maut code (Dovo's old name): your settings and extensions move over and the old
# app is uninstalled.
#
# For CI: DOVO_INSTALLER=<path to a local setup .exe> skips the download; DOVO_NO_OPEN=1 skips
# launching and the Claude Code prompt.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest's progress bar makes downloads crawl
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'jmkq0056/dovo'
$asset = 'Dovo-Setup-x64.exe'

function Write-Step($message) { Write-Host "  > $message" -ForegroundColor DarkCyan }

if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
	throw "Dovo for Windows is built for x64; this PC reports $env:PROCESSOR_ARCHITECTURE."
}

Write-Host ''
Write-Host '  Dovo' -ForegroundColor Yellow
Write-Host ''

if ($env:DOVO_INSTALLER) {
	$installer = (Resolve-Path $env:DOVO_INSTALLER).Path
	$version = 'local build'
	$keepInstaller = $true
} else {
	Write-Step 'Finding the latest release'
	$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'dovo-installer' }
	$download = $release.assets | Where-Object { $_.name -eq $asset } | Select-Object -First 1
	if (-not $download) {
		throw "Release $($release.tag_name) has no Windows installer yet. See https://github.com/$repo/releases"
	}
	$version = $release.tag_name
	$installer = Join-Path $env:TEMP "dovo-setup-$version.exe"
	$keepInstaller = $false
	Write-Step "Downloading $version ($([math]::Round($download.size / 1MB)) MB)"
	Invoke-WebRequest $download.browser_download_url -OutFile $installer -UseBasicParsing
}

# A running copy would keep the old files locked.
Get-Process 'Dovo', 'Maut code' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Coming from Maut code: bring your settings, state and extensions along before it goes.
$oldData = Join-Path $env:APPDATA 'Maut code'
$newData = Join-Path $env:APPDATA 'Dovo'
if ((Test-Path $oldData) -and -not (Test-Path $newData)) {
	Write-Step 'Moving your Maut code settings to Dovo'
	Copy-Item $oldData $newData -Recurse -Force
}
$oldHome = Join-Path $env:USERPROFILE '.maut-code'
$newHome = Join-Path $env:USERPROFILE '.dovo'
if ((Test-Path $oldHome) -and -not (Test-Path $newHome)) {
	Copy-Item $oldHome $newHome -Recurse -Force
	$extensionsJson = Join-Path $newHome 'extensions\extensions.json'
	if (Test-Path $extensionsJson) {
		(Get-Content $extensionsJson -Raw) -replace '\.maut-code', '.dovo' | Set-Content $extensionsJson -NoNewline
	}
}

Write-Step 'Installing'
$tasks = 'desktopicon,addcontextmenufiles,addcontextmenufolders,associatewithfiles,addtopath,!runcode'
try {
	$process = Start-Process $installer -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/MERGETASKS=$tasks" -Wait -PassThru
} catch {
	if (-not $keepInstaller) {
		Remove-Item $installer -Force -ErrorAction SilentlyContinue
	}
	# Windows refuses to start the installer: Smart App Control or a company app-control policy
	# (the message is in the system language, so recognise it by its error code too).
	# 4551 is ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION: "An Application Control policy has blocked this file".
	$native = $_.Exception.NativeErrorCode, $_.Exception.InnerException.NativeErrorCode
	$blocked = $native -contains 4551 -or $_.Exception.Message -match 'Application Control|policy|politik|Richtlinie'
	if ($blocked) {
		Write-Host ''
		Write-Host '  Windows blocked the Dovo installer.' -ForegroundColor Yellow
		Write-Host '  Dovo is not code-signed yet, and Smart App Control (Windows 11) or an'
		Write-Host '  app-control policy from your organisation only lets signed apps start.'
		Write-Host ''
		Write-Host '  What you can do:'
		Write-Host '   - On a work PC: ask your IT department to allow Dovo.'
		Write-Host '   - On your own PC: Windows Security > App & browser control > Smart App Control.'
		Write-Host '     Turning it off lets unsigned apps run; on some Windows versions it cannot be'
		Write-Host '     turned back on without resetting Windows, so decide with that in mind.'
		Write-Host "   - Or wait for a signed release: https://github.com/$repo/releases"
		Write-Host ''
		throw 'Windows blocked the installer (it is not code-signed yet).'
	}
	throw
}
if (-not $keepInstaller) {
	Remove-Item $installer -Force -ErrorAction SilentlyContinue
}
if ($process.ExitCode -ne 0) {
	throw "The installer exited with code $($process.ExitCode)."
}

$exe = Join-Path $env:LOCALAPPDATA 'Programs\Dovo\Dovo.exe'
if (-not (Test-Path $exe)) {
	throw "Installed, but $exe is missing."
}

# Retire Maut code: its uninstaller also removes its Start menu entry, context menu and PATH entry.
$oldUninstaller = Join-Path $env:LOCALAPPDATA 'Programs\Maut code\unins000.exe'
if (Test-Path $oldUninstaller) {
	Write-Step 'Uninstalling Maut code (Dovo''s old name)'
	Start-Process $oldUninstaller -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -ErrorAction SilentlyContinue
}

# Dovo opens Claude Code in its terminal on launch, so make sure it's there.
if (-not $env:DOVO_NO_OPEN -and -not (Get-Command claude -ErrorAction SilentlyContinue)) {
	$answer = Read-Host '  Claude Code is not installed. Install it now? [Y/n]'
	if ($answer -notmatch '^[nN]') {
		Write-Step 'Installing Claude Code'
		Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
	}
}

if (-not $env:DOVO_NO_OPEN) {
	Write-Step 'Opening Dovo'
	Start-Process $exe
}

Write-Host ''
Write-Host "  Dovo $version is installed." -ForegroundColor Green
Write-Host '  Start menu: Dovo. Terminal: dovo <folder> (open a new terminal first).'
Write-Host ''
