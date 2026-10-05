#!/usr/bin/env bash
#
# Starts the X Ads Sales Console and opens it in a browser.
#
# The .command extension is the point: on macOS this file can be double-clicked in Finder, which
# opens Terminal and runs it. A rep never has to type a command or know what npm is. It is an
# ordinary shell script, so `./start-console.command` works too.
#
# Safe to run repeatedly. Dependencies install on the first run, the app rebuilds only when its
# source has changed, and if the console is already running this just opens the browser.

set -euo pipefail

cd "$(dirname "$0")"
APP_DIR="$PWD/web"

# Fixed, and not negotiable: the callback URL registered with X names this exact port, so moving to
# a free one would break authorization in a way that is very hard to diagnose from the error X gives.
PORT=3000
URL="http://127.0.0.1:${PORT}"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'

say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$BOLD" "$OFF" "$*"; }
warn() { printf '%s!%s  %s\n' "$YELLOW" "$OFF" "$*"; }

# Errors have to survive a double-click: Terminal closes the window on exit and the message is gone.
# Holding the window open until a keypress is the difference between a readable error and none.
die() {
  printf '\n%sCould not start the console%s\n\n' "$RED$BOLD" "$OFF"
  printf '%s\n' "$@"
  printf '\n%sPress return to close this window.%s\n' "$DIM" "$OFF"
  read -r _ || true
  exit 1
}

open_browser() {
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  else say "Open ${URL} in your browser."
  fi
}

# ---------------------------------------------------------------- preflight

command -v node >/dev/null 2>&1 || die \
  "Node.js is not installed, and the console needs it to run." \
  "" \
  "Install the LTS version from https://nodejs.org — take the default options," \
  "then double-click this file again."

node -e 'const [a,b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 9) ? 0 : 1)' || die \
  "Node.js $(node -v) is too old; the console needs 20.9 or newer." \
  "" \
  "Install the current LTS version from https://nodejs.org, then double-click this file again."

[ -d "$APP_DIR" ] || die \
  "This script expects a 'web' folder next to it, and there isn't one." \
  "" \
  "Make sure the whole folder was copied, not just this file."

# ------------------------------------------------- already running on the port

port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
  else
    # No lsof: treat a refused connection as free. Less precise, but it only has to be right
    # often enough to produce a better message than a crash from the server itself.
    curl -s -o /dev/null -m 2 "$URL" 2>/dev/null
  fi
}

if port_busy; then
  # Distinguishing our own console from some other program matters: one is success, the other needs
  # the rep to go and close something. /api/connection is unauthenticated and always answers.
  if curl -sf -m 5 "${URL}/api/connection" >/dev/null 2>&1; then
    say ""
    printf '%s The console is already running.%s\n' "$GREEN$BOLD" "$OFF"
    say "Opening ${URL}"
    open_browser
    exit 0
  fi
  die \
    "Something else on this machine is already using port ${PORT}." \
    "" \
    "The console has to use that exact port, because it is the address you" \
    "registered with X when you set up your developer app." \
    "" \
    "Quit whatever else is running on port ${PORT} and try again. If you are not" \
    "sure what it is, restarting your computer will clear it."
fi

cd "$APP_DIR"

# ---------------------------------------------------------------- dependencies

# Keyed to the lockfile rather than to the folder merely existing, so an update that changes
# dependencies reinstalls instead of failing later with a confusing missing-module error.
LOCK_STAMP="node_modules/.console-deps"
LOCK_HASH="$(shasum -a 256 package-lock.json | cut -d' ' -f1)"

if [ ! -d node_modules ] || [ "$(cat "$LOCK_STAMP" 2>/dev/null || true)" != "$LOCK_HASH" ]; then
  step "Installing what the console needs. First run only, usually a minute or two."
  # Quietened deliberately. npm's normal output includes engine warnings about transitive
  # dependencies that have no bearing on anything, and they read as broken to someone who has
  # never seen npm before. The full log is kept for when it genuinely fails.
  npm install --no-audit --no-fund --loglevel=error >/tmp/x-ads-console-install.log 2>&1 || {
    tail -20 /tmp/x-ads-console-install.log
    die "Installing failed, which is almost always the network." \
        "" \
        "Check your connection (and VPN, if you use one) and try again." \
        "The full log is at /tmp/x-ads-console-install.log."
  }
  printf '%s' "$LOCK_HASH" > "$LOCK_STAMP"
fi

# ---------------------------------------------------------------- build

# A rep never edits the source, so this normally runs once and is skipped forever after. Keyed to
# any source file being newer than the last successful build, which also covers the case where
# someone does pull an update.
BUILD_STAMP=".next/.console-build"
needs_build=1
if [ -f "$BUILD_STAMP" ]; then
  changed="$(find app lib components next.config.ts tsconfig.json package-lock.json \
    -type f -newer "$BUILD_STAMP" -print -quit 2>/dev/null || true)"
  [ -z "$changed" ] && needs_build=0
fi

if [ "$needs_build" = 1 ]; then
  step "Preparing the console. First run only, about a minute."
  npm run build >/tmp/x-ads-console-build.log 2>&1 || {
    tail -25 /tmp/x-ads-console-build.log
    die "The console failed to build. The last few lines are above, and the full log is at" \
        "/tmp/x-ads-console-build.log."
  }
  touch "$BUILD_STAMP"
fi

# ---------------------------------------------------------------- run

export APP_ORIGIN="$URL"

step "Starting the console"
npm run start -- --port "$PORT" --hostname 127.0.0.1 >/tmp/x-ads-console.log 2>&1 &
SERVER_PID=$!

# Without this, quitting Terminal or pressing Ctrl-C would leave the server running and the next
# run would report the port as taken by something unidentified.
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  if curl -sf -m 2 "${URL}/api/connection" >/dev/null 2>&1; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || {
    tail -25 /tmp/x-ads-console.log
    die "The console stopped while starting up. The last few lines are above."
  }
  sleep 1
done

curl -sf -m 2 "${URL}/api/connection" >/dev/null 2>&1 || die \
  "The console did not finish starting up. The log is at /tmp/x-ads-console.log."

say ""
printf '%s  X Ads Sales Console is running%s\n' "$GREEN$BOLD" "$OFF"
say ""
say "  ${URL}"
say ""
printf '%s  Leave this window open while you use it.%s\n' "$DIM" "$OFF"
printf '%s  Closing it, or pressing Ctrl-C, stops the console.%s\n' "$DIM" "$OFF"
say ""

open_browser
wait "$SERVER_PID"
