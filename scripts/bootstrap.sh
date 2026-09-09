#!/usr/bin/env bash
#
# Prerequisite installer for a fresh machine.
#
# Checks everything this project needs, installs whatever is missing using the
# system's own package manager, then hands off to "npm run setup".
#
# This is shell rather than Node on purpose: it has to be able to install Node
# itself, so it cannot assume Node exists.
#
# It will not touch the system without telling you first. Every command that
# needs root is printed and confirmed before it runs; --dry-run shows the plan
# and changes nothing.
#
# Usage:
#   ./scripts/bootstrap.sh              check, then ask before installing
#   ./scripts/bootstrap.sh --dry-run    show what it would do, change nothing
#   ./scripts/bootstrap.sh --yes        no prompts (for scripted installs)
#   ./scripts/bootstrap.sh --no-setup   install prerequisites only
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIN_NODE_MAJOR=20

DRY_RUN=0
ASSUME_YES=0
RUN_SETUP=1
WITH_BROWSER=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --yes|-y)       ASSUME_YES=1 ;;
    --no-setup)     RUN_SETUP=0 ;;
    --with-browser) WITH_BROWSER=1 ;;
    --help|-h)
      sed -n '3,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2 ;;
  esac
done

# ---------- output helpers ----------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi
ok()      { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
missing() { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
note()    { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
heading() { printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------- detect the platform ----------
heading "Detecting this machine"

OS="$(uname -s)"
DISTRO=""
PKG=""
INSTALL_CMD=""
UPDATE_CMD=""

case "$OS" in
  Linux)
    if [ -r /etc/os-release ]; then
      # shellcheck disable=SC1091
      . /etc/os-release
      DISTRO="${PRETTY_NAME:-${NAME:-Linux}}"
    else
      DISTRO="Linux"
    fi
    if   have apt-get; then PKG="apt";    UPDATE_CMD="apt-get update";       INSTALL_CMD="apt-get install -y"
    elif have dnf;     then PKG="dnf";    UPDATE_CMD="";                     INSTALL_CMD="dnf install -y"
    elif have yum;     then PKG="yum";    UPDATE_CMD="";                     INSTALL_CMD="yum install -y"
    elif have pacman;  then PKG="pacman"; UPDATE_CMD="pacman -Sy";           INSTALL_CMD="pacman -S --noconfirm"
    elif have zypper;  then PKG="zypper"; UPDATE_CMD="";                     INSTALL_CMD="zypper install -y"
    elif have apk;     then PKG="apk";    UPDATE_CMD="apk update";           INSTALL_CMD="apk add"
    fi
    ;;
  Darwin)
    DISTRO="macOS $(sw_vers -productVersion 2>/dev/null || echo '')"
    if have brew; then PKG="brew"; UPDATE_CMD=""; INSTALL_CMD="brew install"; fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    DISTRO="Windows"
    ;;
esac

ok "OS: ${DISTRO:-$OS}"
if [ -n "$PKG" ]; then
  ok "package manager: $PKG"
elif [ "$OS" = "Darwin" ]; then
  note "Homebrew not found. Install it from https://brew.sh, then run this again."
elif [ "$DISTRO" = "Windows" ]; then
  note "On Windows, run this inside WSL (recommended) or install Node from https://nodejs.org"
else
  note "no supported package manager found; anything missing must be installed by hand"
fi

# Root handling: prefer sudo, accept already being root, cope with neither.
SUDO=""
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  ok "running as root"
elif have sudo; then
  SUDO="sudo"
  ok "sudo is available (you may be asked for your password)"
else
  note "not root and no sudo; system packages cannot be installed automatically"
fi

# ---------- work out what is missing ----------
heading "Checking what this project needs"

TO_INSTALL=()      # package names for the detected manager
NEED_NODE=0
PROBLEMS=0

pkg_name() {
  # Map a logical requirement to this platform's package name.
  local want="$1"
  case "$PKG:$want" in
    apt:compiler)    echo "build-essential" ;;
    dnf:compiler|yum:compiler) echo "gcc-c++ make" ;;
    pacman:compiler) echo "base-devel" ;;
    zypper:compiler) echo "gcc-c++ make" ;;
    apk:compiler)    echo "build-base" ;;
    brew:compiler)   echo "" ;;              # Xcode command line tools, handled separately
    *:python)        echo "python3" ;;
    *:git)           echo "git" ;;
    *:curl)          echo "curl" ;;
    *:sqlite)        if [ "$PKG" = "apt" ]; then echo "sqlite3"; else echo "sqlite"; fi ;;
    *)               echo "$want" ;;
  esac
}

require() {
  # require <command> <logical-package> <why> [optional]
  local cmd="$1" logical="$2" why="$3" optional="${4:-}"
  if have "$cmd"; then
    ok "$cmd — $why"
    return
  fi
  if [ -n "$optional" ]; then
    note "$cmd is missing — $why (optional)"
  else
    missing "$cmd is missing — $why"
    PROBLEMS=$((PROBLEMS + 1))
  fi
  local name
  name="$(pkg_name "$logical")"
  [ -n "$name" ] && TO_INSTALL+=($name)
}

# --- Node, checked by version rather than presence ---
if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge "$MIN_NODE_MAJOR" ]; then
    ok "node $(node -v) — runs the server"
  else
    missing "node $(node -v) is too old; need v${MIN_NODE_MAJOR} or newer"
    NEED_NODE=1
    PROBLEMS=$((PROBLEMS + 1))
  fi
else
  missing "node is missing — runs the server"
  NEED_NODE=1
  PROBLEMS=$((PROBLEMS + 1))
fi

if have npm; then
  ok "npm $(npm -v) — installs dependencies"
else
  missing "npm is missing — installs dependencies"
  NEED_NODE=1
  PROBLEMS=$((PROBLEMS + 1))
fi

require git    git      "clones and versions the project"
require curl   curl     "downloads the tunnel client"

# better-sqlite3 ships prebuilt binaries for common platforms; the toolchain
# is only needed when it has to compile. Treated as optional so a machine with
# a working prebuild is not forced to install a compiler it will never use.
if have c++ || have g++ || have clang++; then
  ok "C++ compiler — only needed if better-sqlite3 has no prebuilt binary"
else
  note "no C++ compiler — usually fine, but needed if better-sqlite3 must compile"
  name="$(pkg_name compiler)"; [ -n "$name" ] && TO_INSTALL+=($name)
fi
require python3 python  "used by node-gyp when compiling native modules" optional
require sqlite3 sqlite  "lets you inspect the database by hand" optional

# ---------- the plan ----------
heading "Plan"

if [ "$NEED_NODE" -eq 0 ] && [ ${#TO_INSTALL[@]} -eq 0 ]; then
  ok "nothing to install; this machine already has everything"
else
  [ "$NEED_NODE" -eq 1 ] && echo "  install Node.js ${MIN_NODE_MAJOR}+ (and npm)"
  if [ ${#TO_INSTALL[@]} -gt 0 ]; then
    # De-duplicate while preserving order.
    UNIQUE=()
    for p in "${TO_INSTALL[@]}"; do
      skip=0
      for u in "${UNIQUE[@]:-}"; do [ "$p" = "$u" ] && skip=1 && break; done
      [ "$skip" -eq 0 ] && UNIQUE+=("$p")
    done
    TO_INSTALL=("${UNIQUE[@]}")
    echo "  install system packages: ${TO_INSTALL[*]}"
    if [ -n "$PKG" ]; then
      [ -n "$UPDATE_CMD" ] && echo "      ${DIM}${SUDO:+$SUDO }$UPDATE_CMD${RESET}"
      echo "      ${DIM}${SUDO:+$SUDO }$INSTALL_CMD ${TO_INSTALL[*]}${RESET}"
    fi
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n%sDry run: nothing was changed.%s\n' "$BOLD" "$RESET"
  exit 0
fi

needs_work=0
{ [ "$NEED_NODE" -eq 1 ] || [ ${#TO_INSTALL[@]} -gt 0 ]; } && needs_work=1

if [ "$needs_work" -eq 1 ]; then
  if [ -z "$PKG" ] && [ "$NEED_NODE" -eq 0 ]; then
    printf '\n%sNo package manager available; install the items above by hand.%s\n' "$YELLOW" "$RESET"
    exit 1
  fi
  if [ "$ASSUME_YES" -eq 0 ]; then
    printf '\nProceed with the installation above? [y/N] '
    read -r reply </dev/tty || reply=""
    case "$reply" in
      [yY]|[yY][eE][sS]) ;;
      *) echo "Nothing was changed."; exit 1 ;;
    esac
  fi
fi

# ---------- install system packages ----------
if [ ${#TO_INSTALL[@]} -gt 0 ] && [ -n "$PKG" ]; then
  heading "Installing system packages"
  if [ -n "$UPDATE_CMD" ]; then
    # shellcheck disable=SC2086
    $SUDO $UPDATE_CMD || note "package index update failed; continuing anyway"
  fi
  # shellcheck disable=SC2086
  if $SUDO $INSTALL_CMD "${TO_INSTALL[@]}"; then
    ok "system packages installed"
  else
    missing "installing system packages failed"
    exit 1
  fi
fi

# ---------- install Node ----------
if [ "$NEED_NODE" -eq 1 ]; then
  heading "Installing Node.js ${MIN_NODE_MAJOR}+"

  installed=0
  case "$PKG" in
    apt)
      # NodeSource, because Debian and Ubuntu both ship a Node too old for this.
      if $SUDO bash -c "curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x | bash -" \
         && $SUDO apt-get install -y nodejs; then installed=1; fi ;;
    dnf|yum)
      if $SUDO bash -c "curl -fsSL https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x | bash -" \
         && $SUDO "$PKG" install -y nodejs; then installed=1; fi ;;
    pacman)
      $SUDO pacman -S --noconfirm nodejs npm && installed=1 ;;
    zypper)
      $SUDO zypper install -y nodejs npm && installed=1 ;;
    apk)
      $SUDO apk add nodejs npm && installed=1 ;;
    brew)
      brew install node && installed=1 ;;
  esac

  # nvm needs no root, so it is the fallback when everything else fails or
  # when there is no way to become root at all.
  if [ "$installed" -eq 0 ]; then
    note "package-manager install did not work; falling back to nvm (no root needed)"
    if curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash; then
      export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
      # shellcheck disable=SC1091
      [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
      if nvm install "$MIN_NODE_MAJOR" && nvm use "$MIN_NODE_MAJOR"; then
        installed=1
        note "Node was installed through nvm. Open a new terminal, or run:"
        note "  export NVM_DIR=\"\$HOME/.nvm\" && . \"\$NVM_DIR/nvm.sh\""
      fi
    fi
  fi

  if [ "$installed" -eq 1 ] && have node; then
    ok "node $(node -v)"
  else
    missing "could not install Node automatically. Install it from https://nodejs.org and run this again."
    exit 1
  fi
fi

# ---------- optional: browser for the UI tests ----------
if [ "$WITH_BROWSER" -eq 1 ]; then
  heading "Installing the browser used by the UI tests"
  if (cd "$REPO_ROOT" && npx --yes playwright install chromium); then
    ok "Chromium installed"
    (cd "$REPO_ROOT" && $SUDO npx --yes playwright install-deps chromium) \
      || note "system libraries for Chromium were not installed; the UI test may not run"
  else
    note "could not install Chromium; 'npm run ui-test' will not work until it is"
  fi
fi

# ---------- verify ----------
heading "Verifying"
for tool in node npm git; do
  if have "$tool"; then ok "$tool $($tool --version 2>/dev/null | head -1)"; else missing "$tool still missing"; exit 1; fi
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt "$MIN_NODE_MAJOR" ]; then
  missing "node is still older than v${MIN_NODE_MAJOR}; open a new terminal and run this again"
  exit 1
fi

# ---------- hand off ----------
if [ "$RUN_SETUP" -eq 1 ]; then
  heading "Setting up the project"
  cd "$REPO_ROOT" || exit 1
  if [ "$ASSUME_YES" -eq 1 ]; then
    node scripts/setup.mjs "$@"
  else
    node scripts/setup.mjs
  fi
else
  printf '\n%sPrerequisites are in place. Next:%s\n  npm run setup\n' "$BOLD" "$RESET"
fi
