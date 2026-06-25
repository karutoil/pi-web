#Requires -Version 5.1
<#
# ============================================================
# PI Web — native service installer / manager  v1.0.0
# Platform: Windows (NSSM service, Scheduled-Task fallback)
# Usage:    .\install.ps1 [command] [flags]
#
# Commands:
#   install     fetch (git clone OR copy local) + build + register service
#   update      git pull (or re-copy local) + rebuild + restart
#   uninstall   stop + remove service + remove app files (state kept)
#   start|stop|restart|status|logs   service lifecycle
#   doctor      self-check
#   (no args)   interactive menu
#
# Flags:
#   -Source git[:ref]          clone from origin (default: git:main)
#   -Source local:C:\path      build from a local checkout
#   -InstallDir PATH           app code location (default %LOCALAPPDATA%\pi-web)
#   -Port N                    bind port (default 33647 — matches docker HOST_PORT)
#   -BindHost H                bind host (default 127.0.0.1)
#   -Domain https://pi.example.com  pre-set public origin (skips the deploy prompt)
#   -NoDomain                       force localhost mode (skips the deploy prompt)
#   -DryRun                    show actions, make no changes
#   -NoDeps                    skip auto-installing git/rg/bun
#   -Purge                     uninstall: also drop %USERPROFILE%\.pi-web
# ============================================================
#>

[CmdletBinding()]
param(
  [string]$Command = "",
  [string]$Source = "",
  [string]$InstallDir = "",
  [int]$Port = 0,
  [string]$BindHost = "",
  [string]$Domain = "",
  [switch]$NoDomain,
  [switch]$DryRun,
  [switch]$NoDeps,
  [switch]$Purge
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)

$App = @{
  Name       = "pi-web"
  GitUrl     = "https://github.com/karutoil/pi-web.git"
  DefaultRef = "main"
  SvcName    = "pi-web"
  TaskName   = "PIWeb"
}

if (-not $InstallDir) { $InstallDir = "$env:LOCALAPPDATA\pi-web" }
$OptPort = if ($Port -gt 0) { $Port } else { 0 }
$OptHost = $BindHost
$Src     = $Source
$EnvFile = "$env:USERPROFILE\.config\pi-web\env.cmd"
$LogDir  = "$InstallDir\.logs"
$script:UseTask = $false

# ── Output helpers ───────────────────────────────────────────
function W-Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function W-Err($m)  { Write-Host "  [X]  $m" -ForegroundColor Red }
function W-Info($m) { Write-Host "  [i]  $m" -ForegroundColor Cyan }
function W-Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function W-Step($m) { Write-Host "`n  -- $m --" -ForegroundColor Blue }

function Have($c) { return [bool](Get-Command $c -ErrorAction SilentlyContinue) }

# ── Dependencies ─────────────────────────────────────────────
function Ensure-GitRg {
  $miss = @()
  if (-not (Have git)) { $miss += "Git.Git" }
  if (-not (Have rg))  { $miss += "BurntSushi.ripgrep.MSVC" }
  if ($miss.Count -eq 0) { W-Ok "git + ripgrep present"; return }
  if ($NoDeps) { W-Err "Missing deps and -NoDeps set: $miss"; exit 1 }
  W-Step "Installing system deps via winget"
  if (-not (Have winget)) { W-Err "winget not found. Install Git for Windows + ripgrep manually."; exit 1 }
  foreach ($p in $miss) { winget install --id $p -e --accept-source-agreements --accept-package-agreements }
  $env:PATH = [Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [Environment]::GetEnvironmentVariable("PATH","User")
  W-Ok "deps installed"
}

function Ensure-Bun {
  if (Have bun) { W-Ok "bun present ($(bun --version))"; return }
  if ($NoDeps) { W-Err "bun missing and -NoDeps set"; exit 1 }
  W-Step "Installing Bun"
  # ponytail: official PowerShell installer from bun.sh
  $env:BUN_INSTALL = "$env:USERPROFILE\.bun"
  & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
  $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
  if (-not (Have bun)) { W-Err "Bun install failed"; exit 1 }
  W-Ok "bun installed"
}

function Resolve-BunBin {
  $b = (Get-Command bun -ErrorAction SilentlyContinue).Source
  if (-not $b) { W-Err "bun not found"; exit 1 }
  return $b
}

# ── Source: git or local ─────────────────────────────────────
function Fetch-Code {
  W-Step "Acquiring source"
  $parent = Split-Path $InstallDir -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  if ($DryRun) { W-Info "[dry-run] code -> $InstallDir"; return }

  if ($Src -like "git:*") {
    $ref = $Src.Substring(4); if (-not $ref) { $ref = $App.DefaultRef }
    if (Test-Path "$InstallDir\.git") {
      W-Info "Existing checkout - resetting to origin/$ref"
      git -C $InstallDir fetch --all --tags
      $null = git -C $InstallDir checkout $ref 2>&1
      if ($LASTEXITCODE) { git -C $InstallDir checkout -B $ref "origin/$ref" }
      $null = git -C $InstallDir reset --hard "origin/$ref" 2>&1
      if ($LASTEXITCODE) { git -C $InstallDir pull --ff-only }
    } else {
      if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
      W-Info "Cloning $($App.GitUrl) (ref: $ref)"
      git clone $App.GitUrl $InstallDir
      $null = git -C $InstallDir checkout $ref 2>&1
    }
    W-Ok "source ready (git: $ref)"
  }
  elseif ($Src -like "local:*") {
    $s = $Src.Substring(6)
    if (-not (Test-Path $s)) { W-Err "local source not found: $s"; exit 1 }
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    # ponytail: robocopy mirrors with excludes; /XD excludes dirs
    robocopy $s $InstallDir /MIR /XD node_modules .git dist /XF .pi-web.db 2>$null | Out-Null
    W-Ok "source ready (local: $s)"
  }
  else { W-Err "bad -Source: $Src"; exit 1 }
}

function Build-App {
  W-Step "Building (production)"
  if ($DryRun) { W-Info "[dry-run] bun install + bun run build"; return }
  Push-Location $InstallDir
  try {
    bun install
    if ($LASTEXITCODE) { throw "bun install failed" }
    bun run build
    if ($LASTEXITCODE) { throw "bun run build failed" }
  }
  finally { Pop-Location }
  W-Ok "build complete"
}

# ── Env file ─────────────────────────────────────────────────
function Get-DeployConfig {
  # --Domain / -NoDomain on the CLI already decided; don't re-prompt.
  if ($Domain) { $script:DeployDomain = $Domain; $script:DeployOrigin = ""; W-Info "domain mode: $Domain"; return }
  if ($NoDomain) { $script:DeployDomain = ""; W-Info "localhost mode (-NoDomain)"; return }
  if ($DryRun) { W-Info "[dry-run] deploy: $($Domain)"; return }
  Write-Host "`n  Deployment target" -ForegroundColor White
  Write-Host "  PI Web can run on localhost only, or behind a public domain" -ForegroundColor DarkGray
  Write-Host "  (reverse proxy). DNS + TLS cert + proxy config are yours to set up" -ForegroundColor DarkGray
  Write-Host "  - this only configures the app's origin/auth." -ForegroundColor DarkGray
  $a = Read-Host "`n  Will PI Web be behind a public domain? [y/N]"
  if ($a -eq 'y') {
    $d = Read-Host "  Public origin URL (https://pi.example.com)"
    if (-not $d) { $d = "https://pi.example.com" }
    $script:DeployDomain = $d.TrimEnd('/')
    $b = Read-Host "  Serve the client from a DIFFERENT domain? (advanced) [y/N]"
    if ($b -eq 'y') {
      $o = Read-Host "  Extra trusted origin (https://app.example.com)"
      $script:DeployOrigin = $o.TrimEnd('/')
    } else { $script:DeployOrigin = "" }
  } else {
    $script:DeployDomain = ""
    W-Info "localhost mode: HOST=127.0.0.1, auth auto (off on loopback)."
  }
}

function Write-EnvFile {
  W-Step "Writing env file"
  $db = "$env:USERPROFILE\.pi-web\.pi-web.db"
  New-Item -ItemType Directory -Force -Path (Split-Path $EnvFile -Parent) | Out-Null
  New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.pi-web" | Out-Null
  if ($DryRun) { W-Info "[dry-run] would write $EnvFile"; return }

  if ($script:DeployDomain) {
    $h = "0.0.0.0"; $p = if ($OptPort -gt 0) { $OptPort } else { 33647 }
    $lines = @(
      "@echo off",
      "REM PI Web service environment - edit, then: .\install.ps1 restart",
      "set HOST=$h",
      "set PORT=$p",
      "set NODE_ENV=production",
      "set PI_WEB_DB_PATH=$db",
      "",
      "REM --- Public domain (behind a reverse proxy) ---",
      "REM You handle DNS + TLS cert + the proxy (nginx/caddy) terminating HTTPS",
      "REM and forwarding to 127.0.0.1:$p. The values below let the app trust",
      "REM the public origin and mark cookies Secure.",
      "set PI_WEB_AUTH=on",
      "set BETTER_AUTH_URL=$($script:DeployDomain)",
      "set PI_WEB_SECURE_COOKIES=on"
    )
    if ($script:DeployOrigin) { $lines += "set PI_WEB_ORIGIN=$($script:DeployOrigin)" }
    $lines += "REM set PI_WEB_ADMIN_EMAIL=you@example.com  (optional first-run seed)"
  } else {
    $h = if ($OptHost) { $OptHost } else { "127.0.0.1" }; $p = if ($OptPort -gt 0) { $OptPort } else { 33647 }
    $lines = @(
      "@echo off",
      "REM PI Web service environment - edit, then: .\install.ps1 restart",
      "set HOST=$h",
      "set PORT=$p",
      "set NODE_ENV=production",
      "set PI_WEB_DB_PATH=$db",
      "",
      "REM --- Expose beyond localhost (edit + restart) ---",
      "REM set HOST=0.0.0.0, PI_WEB_AUTH=on, BETTER_AUTH_URL=https://pi.example.com,",
      "REM PI_WEB_SECURE_COOKIES=on, PI_WEB_ORIGIN=https://app.example.com"
    )
  }
  Set-Content -Path $EnvFile -Value $lines -Encoding ASCII
  W-Ok "env: $EnvFile"
}

# ── Runtime wrapper ─────────────────────────────────────────
function Write-Wrapper {
  $bun = Resolve-BunBin
  if ($DryRun) { W-Info "[dry-run] would write $InstallDir\run-service.cmd"; return }
  # ponytail: cmd wrapper sources the env file then execs bun
  $content = @"
@echo off
if exist "%USERPROFILE%\.config\pi-web\env.cmd" call "%USERPROFILE%\.config\pi-web\env.cmd"
cd /d "$InstallDir"
"$bun" run --cwd packages\server start
"@
  Set-Content -Path "$InstallDir\run-service.cmd" -Value $content -Encoding ASCII
  W-Ok "wrapper: $InstallDir\run-service.cmd"
}

# ── Service: NSSM (preferred) ────────────────────────────────
function Get-Nssm { return (Get-Command nssm -ErrorAction SilentlyContinue).Source }

function Register-Service {
  W-Step "Registering service"
  $nssm = Get-Nssm
  $wrapper = "$InstallDir\run-service.cmd"
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  if ($nssm) {
    W-Info "Using NSSM ($nssm)"
    & $nssm install $App.SvcName $wrapper 2>$null
    & $nssm set $App.SvcName AppDirectory $InstallDir
    & $nssm set $App.SvcName AppStdout "$LogDir\pi-web.out.log"
    & $nssm set $App.SvcName AppStderr "$LogDir\pi-web.err.log"
    & $nssm set $App.SvcName AppRotateFiles 1
    & $nssm set $App.SvcName Start SERVICE_AUTO_START
    & $nssm start $App.SvcName 2>$null
    W-Ok "NSSM service '$($App.SvcName)' started"
    $script:UseTask = $false
  } else {
    # ponytail: no third-party dep - Scheduled Task at logon, runs as current user.
    W-Warn "NSSM not found - using Scheduled Task (runs at logon as you)."
    W-Warn "For always-on-without-login, install NSSM: winget install NSSM.NSSM (or scoop install nssm)"
    $action = New-ScheduledTaskAction -Execute $wrapper
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $App.TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $App.TaskName
    W-Ok "Scheduled Task '$($App.TaskName)' started"
    $script:UseTask = $true
  }
}

function Unregister-Service {
  $nssm = Get-Nssm
  if ($nssm) {
    $null = & $nssm status $App.SvcName 2>&1
    if ($LASTEXITCODE -eq 0) {
      & $nssm stop $App.SvcName 2>$null
      & $nssm remove $App.SvcName confirm 2>$null
      W-Ok "NSSM service removed"
      return
    }
  }
  if (Get-ScheduledTask -TaskName $App.TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $App.TaskName 2>$null
    Unregister-ScheduledTask -TaskName $App.TaskName -Confirm:$false
    W-Ok "Scheduled Task removed"
  }
}

# ── Lifecycle ────────────────────────────────────────────────
function Start-PiWeb   { $n = Get-Nssm; if ($n) { & $n start $App.SvcName 2>$null } else { Start-ScheduledTask -TaskName $App.TaskName } }
function Stop-PiWeb    { $n = Get-Nssm; if ($n) { & $n stop $App.SvcName 2>$null } else { Stop-ScheduledTask -TaskName $App.TaskName 2>$null } }
function Restart-PiWeb { Stop-PiWeb; Start-Sleep -Seconds 1; Start-PiWeb }

function Show-Status {
  W-Step "Status"
  $n = Get-Nssm
  if ($n) {
    & $n status $App.SvcName
  } else {
    $t = Get-ScheduledTask -TaskName $App.TaskName -ErrorAction SilentlyContinue
    if ($t) {
      W-Info "Task: $($t.TaskName)  State: $($t.State)"
    }
  }
  if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Select-String '^(set )?(HOST|PORT)=' | ForEach-Object { Write-Host "  $_" }
  }
}

function Show-Logs {
  $out = "$LogDir\pi-web.out.log"
  $err = "$LogDir\pi-web.err.log"
  if (Test-Path $out) { W-Info "stdout ($out):"; Get-Content $out -Tail 100 -Wait }
  elseif (Test-Path $err) { W-Info "stderr ($err):"; Get-Content $err -Tail 100 -Wait }
  else { W-Info "no logs yet" }
}

# ── Install / Update / Uninstall / Doctor ────────────────────
function Install-PiWeb {
  if (-not $Src) { $Src = "git:$($App.DefaultRef)" }
  Ensure-GitRg
  Ensure-Bun
  Fetch-Code
  Build-App
  Get-DeployConfig
  Write-EnvFile
  Write-Wrapper
  Register-Service
  Print-Summary
}

function Update-PiWeb {
  if (-not (Test-Path $InstallDir)) { W-Err "Not installed at $InstallDir"; exit 1 }
  Ensure-Bun
  Write-Wrapper
  Fetch-Code
  Build-App
  W-Step "Restarting service"
  Restart-PiWeb
  W-Ok "updated"
  Show-Status
}

function Uninstall-PiWeb {
  W-Step "Stopping + removing service"
  if ($DryRun) { W-Info "[dry-run] would remove service + $InstallDir" }
  Unregister-Service
  W-Step "Removing app files"
  if (-not $DryRun) {
    Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
    Remove-Item -Force $EnvFile -ErrorAction SilentlyContinue
    if ($Purge) {
      Remove-Item -Recurse -Force "$env:USERPROFILE\.pi-web" -ErrorAction SilentlyContinue
      W-Ok "purged ~/.pi-web"
    }
  }
  W-Ok "app removed (state at ~\.pi-web and ~\.pi preserved)"
}

function Test-PiWeb {
  W-Step "Self-check"
  if (Have bun) { W-Ok "bun: $(bun --version)" } else { W-Warn "bun missing" }
  if (Have git) { W-Ok "git present" } else { W-Warn "git missing" }
  if (Have rg)  { W-Ok "ripgrep present" } else { W-Warn "rg missing" }
  if (Test-Path $EnvFile) { W-Ok "env file: $EnvFile" } else { W-Warn "env file missing" }
  if (Test-Path "$InstallDir\run-service.cmd") { W-Ok "wrapper present" } else { W-Warn "wrapper missing" }
  $n = Get-Nssm
  if ($n) {
    W-Ok "NSSM: $n"
  } else {
    if (Get-ScheduledTask -TaskName $App.TaskName -ErrorAction SilentlyContinue) { W-Ok "Scheduled Task present" }
    else { W-Warn "no service/task registered" }
  }
}

function Print-Summary {
  $h = if ($OptHost) { $OptHost } else { "127.0.0.1" }
  $p = if ($OptPort -gt 0) { $OptPort } else { 33647 }
  Write-Host ""
  Write-Host "  +-----------------------------+" -ForegroundColor Green
  Write-Host "  |   PI Web installed! [OK]    |" -ForegroundColor Green
  Write-Host "  +-----------------------------+" -ForegroundColor Green
  Write-Host ""
  Write-Host "  Code:    $InstallDir"
  Write-Host "  Env:     $EnvFile  (edit, then .\install.ps1 restart)"
  Write-Host "  URL:     http://${h}:${p}"
  if (Get-Nssm) { Write-Host "  Manage:  nssm {start,stop,restart,status} $($App.SvcName)" }
  else { Write-Host "  Manage:  .\install.ps1 {start,stop,restart,status,logs}" }
  Write-Host ""
}

# ── Interactive menu ─────────────────────────────────────────
function Interactive-Menu {
  Write-Host "`n  PI Web service manager v1.0.0`n  ----------------------------------------`n" -ForegroundColor Cyan
  $opts = @("Install (git)","Install (local path)","Update","Uninstall","Start","Stop","Restart","Status","Logs","Doctor","Exit")
  for ($i = 0; $i -lt $opts.Count; $i++) { Write-Host "    $($i+1)) $($opts[$i])" }
  $c = Read-Host "`n  Choice [11]"
  if (-not $c) { $c = 11 }
  switch ($c) {
    1  { $Src = "git:$($App.DefaultRef)"; Install-PiWeb }
    2  { $p = Read-Host "Path to local pi-web checkout"; $Src = "local:$p"; Install-PiWeb }
    3  { Update-PiWeb }
    4  { $a = Read-Host "Also purge ~/.pi-web (DB)? [y/N]"; if ($a -eq 'y') { $Purge = $true }; Uninstall-PiWeb }
    5  { Start-PiWeb; W-Ok "started" }
    6  { Stop-PiWeb; W-Ok "stopped" }
    7  { Restart-PiWeb; W-Ok "restarted" }
    8  { Show-Status }
    9  { Show-Logs }
    10 { Test-PiWeb }
    default { W-Info "bye" }
  }
}

# ── Dispatch ─────────────────────────────────────────────────
if (-not $Command) { Interactive-Menu; return }

switch ($Command.ToLower()) {
  "install"   { Install-PiWeb }
  "update"    { Update-PiWeb }
  "uninstall" { Uninstall-PiWeb }
  "start"     { Start-PiWeb; W-Ok "started" }
  "stop"      { Stop-PiWeb; W-Ok "stopped" }
  "restart"   { Restart-PiWeb; W-Ok "restarted" }
  "status"    { Show-Status }
  "logs"      { Show-Logs }
  "doctor"    { Test-PiWeb }
  default     {
    Write-Host "Commands: install update uninstall start stop restart status logs doctor"
  }
}
