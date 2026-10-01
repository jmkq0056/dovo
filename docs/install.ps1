# Maut code installer for Windows.
#
#   irm https://jmkq0056.github.io/maut-code/install.ps1 | iex
#
# Downloads the latest Maut code release, installs it for the current user (no admin rights,
# no wizard), adds it to the Start menu, the desktop, Explorer's context menu and PATH, offers to
# install Claude Code if it's missing, and opens Maut code. Running it again updates in place.
#
# For CI: MAUT_INSTALLER=<path to a local setup .exe> skips the download; MAUT_NO_OPEN=1 skips
# launching and the Claude Code prompt.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest's progress bar makes downloads crawl
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'jmkq0056/maut-code'
$asset = 'Maut-code-Setup-x64.exe'

function Write-Step($message) { Write-Host "  > $message" -ForegroundColor DarkCyan }

if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
	throw "Maut code for Windows is built for x64; this PC reports $env:PROCESSOR_ARCHITECTURE."
}

Write-Host ''
Write-Host '  Maut code' -ForegroundColor Red
Write-Host ''

if ($env:MAUT_INSTALLER) {
	$installer = (Resolve-Path $env:MAUT_INSTALLER).Path
	$version = 'local build'
	$keepInstaller = $true
} else {
	Write-Step 'Finding the latest release'
	$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'maut-installer' }
	$download = $release.assets | Where-Object { $_.name -eq $asset } | Select-Object -First 1
	if (-not $download) {
		throw "Release $($release.tag_name) has no Windows installer yet. See https://github.com/$repo/releases"
	}
	$version = $release.tag_name
	$installer = Join-Path $env:TEMP "maut-code-setup-$version.exe"
	$keepInstaller = $false
	Write-Step "Downloading $version ($([math]::Round($download.size / 1MB)) MB)"
	Invoke-WebRequest $download.browser_download_url -OutFile $installer -UseBasicParsing
}

# A running copy would keep the old files locked.
Get-Process 'Maut code' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Step 'Installing'
$tasks = 'desktopicon,addcontextmenufiles,addcontextmenufolders,associatewithfiles,addtopath,!runcode'
$process = Start-Process $installer -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/MERGETASKS=$tasks" -Wait -PassThru
if (-not $keepInstaller) {
	Remove-Item $installer -Force -ErrorAction SilentlyContinue
}
if ($process.ExitCode -ne 0) {
	throw "The installer exited with code $($process.ExitCode)."
}

$exe = Join-Path $env:LOCALAPPDATA 'Programs\Maut code\Maut code.exe'
if (-not (Test-Path $exe)) {
	throw "Installed, but $exe is missing."
}

# Maut opens Claude Code in its terminal on launch, so make sure it's there.
if (-not $env:MAUT_NO_OPEN -and -not (Get-Command claude -ErrorAction SilentlyContinue)) {
	$answer = Read-Host '  Claude Code is not installed. Install it now? [Y/n]'
	if ($answer -notmatch '^[nN]') {
		Write-Step 'Installing Claude Code'
		Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
	}
}

if (-not $env:MAUT_NO_OPEN) {
	Write-Step 'Opening Maut code'
	Start-Process $exe
}

Write-Host ''
Write-Host "  Maut code $version is installed." -ForegroundColor Green
Write-Host '  Start menu: Maut code. Terminal: maut-code <folder> (open a new terminal first).'
Write-Host ''
