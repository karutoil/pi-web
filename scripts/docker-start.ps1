#Requires -Version 7.0
# Cross-platform(ish) Docker starter for pi-web on Windows PowerShell.
# For Unix/macOS, use ./scripts/docker-start.sh.
param(
  [switch]$Build = $true,
  [switch]$Detach = $true
)

$ErrorActionPreference = 'Stop'

$PiBinaryDir = ""
try {
  $PiPath = (Get-Command pi -ErrorAction Stop).Source
  if ($PiPath) {
    $PiBinaryDir = Split-Path -Parent $PiPath
    Write-Host "Mounted pi binary directory: $PiBinaryDir"
  }
} catch {
  Write-Warning "pi binary not found on host. Agents and pi commands may not work inside the container."
}

$HomeDir = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
if (-not $HomeDir) {
  throw "Could not determine home directory (HOME or USERPROFILE required)."
}
# Docker Desktop volume mounts are safest with forward slashes, even on Windows.
$HomeDir = $HomeDir -replace '\\', '/'

$env:DOCKER_UID = if ($env:DOCKER_UID) { $env:DOCKER_UID } else { 1000 }
$env:DOCKER_GID = if ($env:DOCKER_GID) { $env:DOCKER_GID } else { 1000 }
$env:HOME = $HomeDir
$env:PI_BINARY_DIR = $PiBinaryDir

Set-Location (Join-Path $PSScriptRoot '..')

# Ensure host directories exist for Docker volume mounts
New-Item -ItemType Directory -Force -Path "$HomeDir/.pi" | Out-Null
New-Item -ItemType Directory -Force -Path "$HomeDir/.pi-web" | Out-Null

$composeArgs = @('compose', 'up')
if ($Build) { $composeArgs += '--build' }
if ($Detach) { $composeArgs += '-d' }

& docker @composeArgs
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed with exit code $LASTEXITCODE" }

$portOutput = docker compose port pi-web 3069
if ($LASTEXITCODE -ne 0 -or -not $portOutput) { throw "Could not determine published port" }

$RandomPort = ($portOutput -split ':')[-1]
Write-Host "PI Web running at http://localhost:$RandomPort"
