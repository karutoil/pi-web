#!/usr/bin/env bash
# ============================================================
# PI Web — native service installer / manager  v1.0.0
# Platform: Linux (systemd) + macOS (launchd)
# Usage:    bash install.sh [command] [flags]
#
# Commands:
#   install     fetch (git clone OR copy local) + build + register service
#   update      git pull (or re-copy local) + rebuild + restart
#   uninstall   stop + remove service + remove app files (state kept)
#   start|stop|restart|status|logs   service lifecycle
#   doctor      self-check (syntax + env + service file)
#   (no args)   interactive menu
#
# Flags:
#   --source git[:ref]          clone from origin (default: git:main)
#   --source local:/abs/path    build from a local checkout
#   --install-dir PATH          app code location (default below)
#   --port N                    bind port (default 33647 — matches docker HOST_PORT)
#   --host H                    bind host (default 127.0.0.1)
#   --domain https://pi.example.com  pre-set public origin (skips the deploy prompt)
#   --no-domain                       force localhost mode (skips the deploy prompt)
#   --dry-run                   show actions, make no changes
#   --no-deps                   skip auto-installing git/rg/bun
#   --purge                     uninstall: also drop ~/.pi-web (keeps ~/.pi)
# ============================================================
set -euo pipefail

# ── Configuration ────────────────────────────────────────────
APP_NAME="pi-web"
APP_VERSION="1.0.0"
GIT_URL="https://github.com/karutoil/pi-web.git"
DEFAULT_REF="main"
INSTALL_DIR="${PIWEB_INSTALL_DIR:-$HOME/.local/share/pi-web}"
ENV_DIR="${PIWEB_ENV_DIR:-$HOME/.config/pi-web}"
ENV_FILE="$ENV_DIR/env"
SERVICE_NAME="pi-web"
LAUNCHD_LABEL="dev.pi.web"
LOG_DIR="$INSTALL_DIR/.logs"

DRY_RUN=false
NO_DEPS=false
PURGE=false
SOURCE=""
REF="$DEFAULT_REF"
OPT_PORT=""
OPT_HOST=""

# ── Colors (graceful when piped) ─────────────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'
  BLU='\033[0;34m'; CYN='\033[0;36m'; BLD='\033[1m'; DIM='\033[2m'; RST='\033[0m'
else
  RED=''; GRN=''; YLW=''; BLU=''; CYN=''; BLD=''; DIM=''; RST=''
fi

ok()   { echo -e "  ${GRN}✓${RST} $1"; }
err()  { echo -e "  ${RED}✗${RST} $1" >&2; }
info() { echo -e "  ${CYN}ℹ${RST} $1"; }
warn() { echo -e "  ${YLW}⚠${RST} $1"; }
step() { echo -e "\n${BLD}${BLU}  ── $1 ──${RST}"; }

# ── Platform / distro detect ─────────────────────────────────
detect_platform() {
  case "$(uname -s)" in
    Linux*)  PLATFORM="linux" ;;
    Darwin*) PLATFORM="macos" ;;
    *)       err "Unsupported OS: $(uname -s) (use scripts/install.ps1 on Windows)"; exit 1 ;;
  esac
  ARCH="$(uname -m)"
  ok "Platform: ${PLATFORM} (${ARCH})"
  # ponytail: set the user-bus env vars when the runtime dir exists, so
  # systemctl --user works inside non-login shells (tmux, sudo -u, ssh w/o
  # pam_systemd). Missing these is the #1 cause of "$DBUS_SESSION_BUS_ADDRESS
  # ... not defined" after a successful build.
  if [ "$PLATFORM" = "linux" ]; then
    local uid; uid="$(id -u)"
    if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$uid" ]; then
      export XDG_RUNTIME_DIR="/run/user/$uid"
    fi
    if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -n "${XDG_RUNTIME_DIR:-}" ]; then
      export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
    fi
  fi
}

# Verify systemctl --user can reach the user bus — fail fast BEFORE the build
# rather than dying after a multi-minute compile.
require_systemd_user() {
  [ "$PLATFORM" = "linux" ] || return 0
  if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ ! -d "$XDG_RUNTIME_DIR" ]; then
    err "systemd --user bus not reachable: runtime dir missing."
    echo  >&2 "  This usually means your user manager isn't running. Fix with:"
    echo  >&2 "    sudo loginctl enable-linger $USER"
    echo  >&2 "    export XDG_RUNTIME_DIR=/run/user/$(id -u)"
    echo  >&2 "    export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus"
    echo  >&2 "  then re-run this script. (On WSL? enable systemd in /etc/wsl.conf.)"
    exit 1
  fi
  if ! systemctl --user status >/dev/null 2>&1; then
    err "systemctl --user failed to connect even with XDG_RUNTIME_DIR set."
    echo  >&2 "  Try: export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus"
    echo  >&2 "  then re-run. (On WSL? ensure systemd is enabled in /etc/wsl.conf.)"
    exit 1
  fi
  ok "systemd --user bus reachable"
}

distro_id() {
  # prints one of: arch, debian, ubuntu, fedora, (other)  — best-effort from /etc/os-release
  [ -r /etc/os-release ] || { echo "unknown"; return; }
  # shellcheck disable=SC1091
  . /etc/os-release 2>/dev/null || true
  local id="${ID:-}" like="${ID_LIKE:-}"
  case "$id/$like" in
    arch/*|*/arch)   echo "arch" ;;
    ubuntu/*|*/ubuntu) echo "ubuntu" ;;
    debian/*|*/debian) echo "debian" ;;
    fedora/*|*/fedora) echo "fedora" ;;
    *) echo "${id:-unknown}" ;;
  esac
}

# ── Privilege helpers ────────────────────────────────────────
have() { command -v "$1" &>/dev/null; }

maybe_sudo() {
  # only escalate when not root and the command needs it
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

# ── Dependency install (git, ripgrep, bun) ───────────────────
ensure_git_rg() {
  local missing=()
  have git || missing+=(git)
  have rg  || missing+=(ripgrep)
  [ ${#missing[@]} -eq 0 ] && { ok "git + ripgrep present"; return; }

  if $NO_DEPS; then
    err "Missing: ${missing[*]} (and --no-deps set). Install manually and re-run."
    exit 1
  fi

  step "Installing system deps: ${missing[*]}"
  if [ "$PLATFORM" = "macos" ]; then
    if have brew; then
      brew install "${missing[@]/ripgrep/ripgrep}" 2>/dev/null || brew install ripgrep
    else
      err "Homebrew not found. Install it from https://brew.sh, then: brew install ${missing[*]}"
      exit 1
    fi
  else
    case "$(distro_id)" in
      arch)   maybe_sudo pacman -S --needed --noconfirm "${missing[@]/ripgrep/ripgrep}" ;;
      ubuntu|debian) maybe_sudo apt-get update -y && maybe_sudo apt-get install -y "${missing[@]/ripgrep/ripgrep}" ;;
      fedora) maybe_sudo dnf install -y "${missing[@]/ripgrep/ripgrep}" ;;
      *) err "Unknown distro. Install manually: ${missing[*]}"; exit 1 ;;
    esac
  fi
  ok "deps installed"
}

ensure_bun() {
  if have bun; then ok "bun present ($(bun --version))"; return; fi
  if $NO_DEPS; then err "bun missing and --no-deps set"; exit 1; fi
  step "Installing Bun"
  # ponytail: curl installer is cross-distro and cross-arch; no per-OS packages.
  if have curl; then
    curl -fsSL https://bun.sh/install | bash
  elif have wget; then
    wget -qO- https://bun.sh/install | bash
  else
    err "Need curl or wget to install Bun"; exit 1
  fi
  # shellcheck disable=SC1091
  [ -f "$HOME/.bun/bin/bunenv" ] && . "$HOME/.bun/bin/bunenv" 2>/dev/null || true
  export PATH="$HOME/.bun/bin:$PATH"
  have bun || { err "Bun install failed — not on PATH"; exit 1; }
  ok "bun installed ($(bun --version))"
}

resolve_bun_bin() {
  BUN_BIN="$(command -v bun || true)"
  [ -n "$BUN_BIN" ] || { err "bun not found despite install"; exit 1; }
  # make absolute
  case "$BUN_BIN" in
    /*) ;;
    *)  BUN_BIN="$(cd "$(dirname "$BUN_BIN")" && pwd)/$(basename "$BUN_BIN")" ;;
  esac
}

# ── Source resolution: git or local ──────────────────────────
parse_source() {
  [ -n "$SOURCE" ] && return
  SOURCE="git:$REF"
}

# Persist the install source so `update` knows whether to git-pull or re-copy.
STATE_FILE="$ENV_DIR/source"
save_source() {
  mkdir -p "$ENV_DIR"
  echo "$SOURCE" > "$STATE_FILE"
}
load_source() {
  # CLI --source wins; otherwise recall what install recorded.
  [ -n "$SOURCE" ] && return
  if [ -f "$STATE_FILE" ]; then
    SOURCE="$(cat "$STATE_FILE")"
    ok "recall source: $SOURCE"
  else
    err "Don't know how this was installed ($STATE_FILE missing). Re-run with --source git or --source local:/path"
    exit 1
  fi
}

fetch_code() {
  step "Acquiring source"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if $DRY_RUN; then info "[dry-run] would place code at $INSTALL_DIR"; return; fi

  case "$SOURCE" in
    git:*)
      local ref="${SOURCE#git:}"
      ref="${ref:-$DEFAULT_REF}"
      if [ -d "$INSTALL_DIR/.git" ]; then
        info "Existing checkout at $INSTALL_DIR — resetting to origin/$ref"
        git -C "$INSTALL_DIR" fetch --all --tags
        git -C "$INSTALL_DIR" checkout "$ref" 2>/dev/null || git -C "$INSTALL_DIR" checkout -B "$ref" "origin/$ref"
        git -C "$INSTALL_DIR" reset --hard "origin/$ref" 2>/dev/null || git -C "$INSTALL_DIR" pull --ff-only
      else
        rm -rf "$INSTALL_DIR"
        info "Cloning $GIT_URL (ref: $ref)"
        git clone "$GIT_URL" "$INSTALL_DIR"
        git -C "$INSTALL_DIR" checkout "$ref" 2>/dev/null || true
      fi
      ok "source ready (git: $ref)"
      ;;
    local:*)
      local src="${SOURCE#local:}"
      src="${src/#\~/$HOME}"
      [ -d "$src" ] || { err "local source not found: $src"; exit 1; }
      src="$(cd "$src" && pwd)"
      rm -rf "$INSTALL_DIR"
      mkdir -p "$INSTALL_DIR"
      if have rsync; then
        rsync -a --delete \
          --exclude node_modules --exclude .git --exclude dist \
          --exclude '.pi-web*' --exclude '.logs' \
          "$src/" "$INSTALL_DIR/"
      else
        # ponytail: cp -a (single process, no pipe — a tar pipe under pipefail
        # can abort mid-copy on a warning about a socket/special file, leaving a
        # partial tree that breaks the build). Copy then prune the heavy/stale dirs.
        cp -a "$src"/. "$INSTALL_DIR"/
        rm -rf "$INSTALL_DIR"/node_modules "$INSTALL_DIR"/.git \
               "$INSTALL_DIR"/packages/*/node_modules "$INSTALL_DIR"/packages/*/dist
      fi
      ok "source ready (local: $src)"
      ;;
    *)
      err "bad --source: $SOURCE"; exit 1 ;;
  esac
}

build_app() {
  step "Building (production)"
  if $DRY_RUN; then info "[dry-run] bun install + bun run build in $INSTALL_DIR"; return; fi
  # Run in a subshell so a build failure doesn't abort the whole script before
  # we can clean up. set -e is inherited; on failure the || clause fires.
  if ! ( cd "$INSTALL_DIR" && bun install && bun run build ); then
    err "Build failed. Cleaning stale build artifacts so a retry starts fresh."
    # ponytail: rm only generated dirs, keep source + node_modules for a faster retry.
    rm -rf "$INSTALL_DIR"/packages/*/dist "$INSTALL_DIR"/packages/*/.tsbuildinfo "$INSTALL_DIR"/*.tsbuildinfo 2>/dev/null || true
    exit 1
  fi
  ok "build complete"
}

# ── Deployment config (interactive) ───────────────────────────
# Asks whether PI Web will sit behind a public domain (reverse proxy). When
# yes, writes the cross-origin/auth/secure-cookie env so the user doesn't
# have to edit the file by hand. DNS, TLS cert, and the proxy itself are on
# the user — we only set what the app needs to trust the public origin.
DEPLOY_DOMAIN=""            # e.g. https://pi.example.com (empty = localhost)
DEPLOY_EXTRA_ORIGIN=""       # optional secondary client origin
DEPLOY_FLAG=false           # true when --domain/--no-domain was given (skip prompt)

gather_deploy_config() {
  if $DRY_RUN; then
    info "[dry-run] deploy: ${DEPLOY_DOMAIN:-localhost}"
    return
  fi
  # --domain / --no-domain on the CLI already decided; don't re-prompt.
  if $DEPLOY_FLAG; then
    [ -n "$DEPLOY_DOMAIN" ] && info "domain mode: $DEPLOY_DOMAIN" || info "localhost mode (--no-domain)"
    return
  fi
  echo
  echo -e "  ${BLD}Deployment target${RST}"
  echo -e "  ${DIM}PI Web can run on localhost only, or behind a public domain${RST}"
  echo -e "  ${DIM}(reverse proxy like nginx/caddy). DNS + TLS cert + proxy config${RST}"
  echo -e "  ${DIM}are yours to set up — this only configures the app's origin/auth.${RST}"
  echo
  if confirm "Will PI Web be behind a public domain?"; then
    ask "Public origin URL (https://pi.example.com)" "https://pi.example.com" DEPLOY_DOMAIN
    DEPLOY_DOMAIN="${DEPLOY_DOMAIN%/}"
    if confirm "Serve the client from a DIFFERENT domain than the above? (advanced)"; then
      ask "Extra trusted origin (https://app.example.com)" "" DEPLOY_EXTRA_ORIGIN
      DEPLOY_EXTRA_ORIGIN="${DEPLOY_EXTRA_ORIGIN%/}"
    fi
  else
    DEPLOY_DOMAIN=""
    info "localhost mode: HOST=127.0.0.1, auth auto (off on loopback)."
  fi
}

# ── Env file ─────────────────────────────────────────────────
write_env_file() {
  step "Writing env file"
  local host port db_path
  local auth="" auth_url="" secure="" origin=""
  db_path="$HOME/.pi-web/.pi-web.db"

  if [ -n "$DEPLOY_DOMAIN" ]; then
    host="0.0.0.0"; port="${OPT_PORT:-33647}"
    auth="on"; auth_url="$DEPLOY_DOMAIN"; secure="on"
    [ -n "$DEPLOY_EXTRA_ORIGIN" ] && origin="$DEPLOY_EXTRA_ORIGIN"
  else
    host="${OPT_HOST:-127.0.0.1}"; port="${OPT_PORT:-33647}"
  fi

  mkdir -p "$ENV_DIR" "$HOME/.pi-web"
  if $DRY_RUN; then info "[dry-run] would write $ENV_FILE"; return; fi
  cat > "$ENV_FILE" <<EOF
# PI Web service environment — edit, then: bash install.sh restart
# Bind (server reads PORT; 0 = random, so PORT is REQUIRED)
HOST=$host
PORT=$port
NODE_ENV=production
PI_WEB_DB_PATH=$db_path
EOF
  if [ -n "$auth" ]; then
    cat >> "$ENV_FILE" <<EOF

# ── Public domain (behind a reverse proxy) ───────────────────
# You handle DNS + TLS cert + the proxy (nginx/caddy) terminating HTTPS and
# forwarding to 127.0.0.1:${port}. The values below let the app trust the
# public origin and mark cookies Secure.
PI_WEB_AUTH=$auth
BETTER_AUTH_URL=$auth_url
PI_WEB_SECURE_COOKIES=$secure
EOF
    [ -n "$origin" ] && echo "PI_WEB_ORIGIN=$origin" >> "$ENV_FILE"
    cat >> "$ENV_FILE" <<'EOF'
# PI_WEB_ADMIN_EMAIL=you@example.com   # optional first-run seed (else sign up via UI)
EOF
  else
    cat >> "$ENV_FILE" <<'EOF'

# ── Expose beyond localhost (edit + restart) ────────────────
# Set HOST=0.0.0.0 to bind all interfaces, and turn auth ON:
#   PI_WEB_AUTH=on
#   BETTER_AUTH_URL=https://pi.example.com   # public origin
#   PI_WEB_SECURE_COOKIES=on                 # behind a TLS-terminating proxy
#   PI_WEB_ORIGIN=https://app.example.com    # only if client is on another domain
EOF
  fi
  ok "env: $ENV_FILE"
}

# ── Runtime wrapper (single source of truth for env + exec) ──
write_wrapper() {
  resolve_bun_bin
  if $DRY_RUN; then info "[dry-run] would write $INSTALL_DIR/run-service.sh"; return; fi
  cat > "$INSTALL_DIR/run-service.sh" <<EOF
#!/usr/bin/env bash
# ponytail: generated by install.sh. Re-run install/update to refresh paths.
set -euo pipefail
[ -f "\$HOME/.config/pi-web/env" ] && { set -a; . "\$HOME/.config/pi-web/env"; set +a; }
cd "$INSTALL_DIR"
exec "$BUN_BIN" run --cwd packages/server start
EOF
  chmod +x "$INSTALL_DIR/run-service.sh"
  ok "wrapper: $INSTALL_DIR/run-service.sh"
}

# ── Service: Linux (systemd --user) ──────────────────────────
unit_path() { echo "$HOME/.config/systemd/user/${SERVICE_NAME}.service"; }

systemd_install_service() {
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$(unit_path)" <<EOF
[Unit]
Description=PI Web (production)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/.local/share/pi-web
ExecStart=%h/.local/share/pi-web/run-service.sh
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
  ok "unit: $(unit_path)"
}

enable_linger() {
  local u; u="$(id -un)"
  if loginctl show-user "$u" 2>/dev/null | grep -q 'Linger=yes'; then
    ok "linger already enabled"; return
  fi
  info "Enabling linger (so the service runs without an active login)"
  # ponytail: enable-linger often needs polkit/sudo. Try unprivileged, fall back to sudo.
  if loginctl enable-linger "$u" 2>/dev/null; then
    ok "linger enabled"
  elif maybe_sudo loginctl enable-linger "$u" 2>/dev/null; then
    ok "linger enabled (via sudo)"
  else
    warn "Could not enable linger. Service won't run at boot / after logout."
    warn "Run manually:  sudo loginctl enable-linger $u"
  fi
}

# ── Service: macOS (launchd LaunchAgent) ─────────────────────
plist_path() { echo "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"; }

launchd_install_service() {
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
  cat > "$(plist_path)" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_DIR}/run-service.sh</string>
  </array>
  <key>WorkingDirectory</key><string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/pi-web.out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/pi-web.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
</dict>
EOF
  ok "agent: $(plist_path)"
}

# ── Lifecycle ────────────────────────────────────────────────
svc_start()   { do_start; }
svc_stop()    { do_stop; }
svc_restart() { do_stop || true; do_start; }

do_start() {
  case "$PLATFORM" in
    linux)  systemctl --user start "$SERVICE_NAME" ;;
    macos)  launchctl load "$(plist_path)" 2>/dev/null || launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}" ;;
  esac
}
do_stop() {
  case "$PLATFORM" in
    linux)  systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true ;;
    macos) launchctl unload "$(plist_path)" 2>/dev/null || true ;;
  esac
}

svc_status() {
  step "Status"
  if $DRY_RUN; then info "[dry-run] status"; return; fi
  case "$PLATFORM" in
    linux) systemctl --user status "$SERVICE_NAME" --no-pager -l || true ;;
    macos)
      launchctl list | grep -i "$LAUNCHD_LABEL" || warn "not loaded"
      echo "  logs: $LOG_DIR/pi-web.out.log"
      ;;
  esac
  # show bound URL from env file if present
  [ -f "$ENV_FILE" ] && grep -E '^(HOST|PORT)=' "$ENV_FILE" | sed 's/^/  /' || true
}

svc_logs() {
  case "$PLATFORM" in
    linux)  journalctl --user -u "$SERVICE_NAME" --no-pager -n 200 "${@:--f}" ;;
    macos)  tail -n 200 "${@:--f}" "$LOG_DIR/pi-web.out.log" "$LOG_DIR/pi-web.err.log" 2>/dev/null || info "no logs yet" ;;
  esac
}

# ── Install ──────────────────────────────────────────────────
do_install() {
  detect_platform
  require_systemd_user   # fail fast before the build, not after
  ensure_git_rg
  ensure_bun
  parse_source
  fetch_code
  save_source
  build_app
  gather_deploy_config
  write_env_file
  write_wrapper
  step "Registering service"
  if $DRY_RUN; then
    info "[dry-run] would register + enable + start service ($PLATFORM)"
  else
    case "$PLATFORM" in
      linux)
        systemd_install_service
        systemctl --user daemon-reload
        enable_linger
        systemctl --user enable "$SERVICE_NAME"
        systemctl --user restart "$SERVICE_NAME" || systemctl --user start "$SERVICE_NAME"
        ;;
      macos)
        launchd_install_service
        launchctl unload "$(plist_path)" 2>/dev/null || true
        launchctl load "$(plist_path)"
        ;;
    esac
  fi
  print_summary
}

# ── Update ───────────────────────────────────────────────────
do_update() {
  detect_platform
  resolve_bun_bin
  if [ ! -d "$INSTALL_DIR" ]; then err "Not installed at $INSTALL_DIR — run install first"; exit 1; fi
  # recall how we installed, then refresh the code
  load_source
  write_wrapper
  fetch_code
  build_app
  step "Restarting service"
  $DRY_RUN && info "[dry-run] would restart service" || svc_restart
  ok "updated"
  svc_status
}

# ── Uninstall ────────────────────────────────────────────────
do_uninstall() {
  detect_platform
  step "Stopping + removing service"
  if $DRY_RUN; then
    info "[dry-run] would remove service + $INSTALL_DIR"
  else
    case "$PLATFORM" in
      linux)
        systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
        rm -f "$(unit_path)"
        systemctl --user daemon-reload
        ;;
      macos)
        launchctl unload "$(plist_path)" 2>/dev/null || true
        rm -f "$(plist_path)"
        ;;
    esac
  fi
  step "Removing app files"
  $DRY_RUN || rm -rf "$INSTALL_DIR"
  $DRY_RUN || rm -f "$ENV_FILE"
  ok "app removed (state at ~/.pi-web and ~/.pi preserved)"
  if $PURGE && ! $DRY_RUN; then
    rm -rf "$HOME/.pi-web"
    ok "purged ~/.pi-web (PI agent data at ~/.pi untouched)"
  fi
  echo
  info "Done. (Use --purge to also remove ~/.pi-web next time.)"
}

# ── Doctor (self-check) ──────────────────────────────────────
do_doctor() {
  step "Self-check"
  bash -n "$0" && ok "script syntax OK" || err "script syntax error"
  have bun && ok "bun: $(bun --version)" || warn "bun missing"
  have git && ok "git: $(git --version)" || warn "git missing"
  have rg  && ok "ripgrep present" || warn "rg missing"
  [ -f "$ENV_FILE" ] && ok "env file: $ENV_FILE" || warn "env file missing"
  [ -f "$INSTALL_DIR/run-service.sh" ] && ok "wrapper present" || warn "wrapper missing"
  case "$PLATFORM" in
    linux) [ -f "$(unit_path)" ] && ok "unit present" || warn "unit missing" ;;
    macos) [ -f "$(plist_path)" ] && ok "plist present" || warn "plist missing" ;;
  esac
}

# ── Summary ──────────────────────────────────────────────────
print_summary() {
  local host port
  host="${OPT_HOST:-127.0.0.1}"; port="${OPT_PORT:-33647}"
  echo
  echo -e "  ${GRN}${BLD}╔══════════════════════════════╗${RST}"
  echo -e "  ${GRN}${BLD}║   PI Web installed! ✓        ║${RST}"
  echo -e "  ${GRN}${BLD}╚══════════════════════════════╝${RST}"
  echo
  echo -e "  ${BLD}Code:${RST}     $INSTALL_DIR"
  echo -e "  ${BLD}Env:${RST}      $ENV_FILE  ${DIM}(edit HOST/PORT/auth, then restart)${RST}"
  echo -e "  ${BLD}URL:${RST}      http://${host}:${port}"
  case "$PLATFORM" in
    linux) echo -e "  ${BLD}Manage:${RST}  systemctl --user {start,stop,restart,status} $SERVICE_NAME" ;;
    macos) echo -e "  ${BLD}Manage:${RST}  launchctl {load,unload} $(plist_path)" ;;
  esac
  echo -e "            ${DIM}or: bash scripts/install.sh {start,stop,restart,status,logs}${RST}"
  echo
}

# Read from /dev/tty so interactive prompts work under `curl | bash`
# (where stdin is the script source, not your terminal). Falls back to stdin
# when /dev/tty is unavailable (CI, no controlling terminal).
read_tty() {
  if [ -e /dev/tty ]; then read -r "$@" </dev/tty
  else read -r "$@"; fi
}

# ── Interactive menu ─────────────────────────────────────────
ask() { local q=$1 d=$2 v=$3; echo -en "\n  ${BLD}?${RST} ${q} ${DIM}[${d}]${RST}: "; read_tty r; printf -v "$v" '%s' "${r:-$d}"; }
confirm() { echo -en "\n  ${BLD}?${RST} $1 ${DIM}[y/N]${RST}: "; read_tty a; [[ "${a,,}" == "y" ]]; }

interactive_menu() {
  echo
  echo -e "  ${BLD}PI Web service manager${RST} ${CYN}v${APP_VERSION}${RST}"
  echo -e "  $(printf '─%.0s' {1..40})"
  echo
  local opts=( "Install (git)" "Install (local path)" "Update" "Uninstall" \
               "Start" "Stop" "Restart" "Status" "Logs" "Doctor" "Exit" )
  for i in "${!opts[@]}"; do echo -e "    ${CYN}$((i+1))${RST}) ${opts[$i]}"; done
  echo -en "\n  Choice [11]: "; read_tty c; c="${c:-11}"
  case "$c" in
    1) SOURCE="git:main"; do_install ;;
    2) ask "Path to local pi-web checkout" "$(pwd)" p; SOURCE="local:$p"; do_install ;;
    3) do_update ;;
    4) confirm "Also purge ~/.pi-web (DB)?" && PURGE=true; do_uninstall ;;
    5) detect_platform; svc_start ;;
    6) detect_platform; svc_stop; ok "stopped" ;;
    7) detect_platform; svc_restart; ok "restarted" ;;
    8) detect_platform; svc_status ;;
    9) detect_platform; svc_logs -f ;;
    10) detect_platform; do_doctor ;;
    *) info "bye" ;;
  esac
}

# ── Arg parsing ──────────────────────────────────────────────
COMMAND=""
while [ $# -gt 0 ]; do
  case "$1" in
    install|update|uninstall|start|stop|restart|status|logs|doctor|help) COMMAND="$1" ;;
    --source)            SOURCE="$2"; shift ;;
    --source=*)          SOURCE="${1#--source=}" ;;
    --install-dir)       INSTALL_DIR="$2"; shift ;;
    --port)              OPT_PORT="$2"; shift ;;
    --host)              OPT_HOST="$2"; shift ;;
    --domain)            DEPLOY_DOMAIN="$2"; DEPLOY_FLAG=true; shift ;;
    --no-domain)         DEPLOY_DOMAIN=""; DEPLOY_FLAG=true ;;
    --dry-run)           DRY_RUN=true ;;
    --no-deps)           NO_DEPS=true ;;
    --purge)             PURGE=true ;;
    -h|--help)           COMMAND="help" ;;
    *) err "Unknown arg: $1"; COMMAND="help" ;;
  esac
  shift
done

usage() {
  sed -n '2,30p' "$0"
}

case "${COMMAND:-menu}" in
  install)   do_install ;;
  update)    do_update ;;
  uninstall) do_uninstall ;;
  start)     detect_platform; svc_start; ok "started" ;;
  stop)      detect_platform; svc_stop; ok "stopped" ;;
  restart)   detect_platform; svc_restart; ok "restarted" ;;
  status)    detect_platform; svc_status ;;
  logs)      detect_platform; svc_logs "$@" ;;
  doctor)    detect_platform; do_doctor ;;
  help)      usage ;;
  menu)      interactive_menu ;;
esac
