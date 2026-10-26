# Builds the Windows installer: packages the Electron app into installer\payload and compiles installer\DshNoDeps.iss.
# Usage:  .\installer\build.ps1 -Iscc "C:\path\to\ISCC.exe" [-Version 1.2.3]
# Needs Node.js (npm) on the PATH. Inno Setup 6 is only a build tool; it is not needed to run the app or the installer.
param(
    [Parameter(Mandatory = $true)][string]$Iscc,
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$payload = Join-Path $PSScriptRoot 'payload'

if ($Version -and $Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') {
    throw "Version '$Version' must look like 1.2.3 or 1.2.3-rc.1"
}

if (Test-Path $payload) { Remove-Item -Recurse -Force $payload }

$builderArgs = @('electron-builder', '--win', '--x64', '--dir', '--publish', 'never')
$isccArgs = @()
if ($Version) {
    $builderArgs += "-c.extraMetadata.version=$Version"
    $isccArgs += "/DAppVersion=$Version"
}

Push-Location $root
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    npx @builderArgs
    if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }
}
finally { Pop-Location }

Copy-Item -Recurse (Join-Path $root 'dist\win-unpacked') $payload

& $Iscc @isccArgs (Join-Path $PSScriptRoot 'DshNoDeps.iss')
if ($LASTEXITCODE -ne 0) { throw 'ISCC failed' }

Get-Item (Join-Path $PSScriptRoot 'Output\DSH-NoDeps-Setup.exe') |
    Select-Object FullName, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }
