#!/bin/zsh

set -euo pipefail
unsetopt BG_NICE

APP_DIR="/Users/jsugihara/Documents/Codex/2026-07-14/build"
APP_URL="http://localhost:3000"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

cd "$APP_DIR"

if /usr/bin/curl --silent --fail --max-time 2 "$APP_URL" >/dev/null 2>&1; then
  echo "Meeting Room is already running."
  /usr/bin/open "$APP_URL"
  exit 0
fi

echo "Building the latest Meeting Room application..."
/usr/bin/env npm run build

echo "Starting Meeting Room at $APP_URL"
(
  for attempt in {1..30}; do
    if /usr/bin/curl --silent --fail --max-time 1 "$APP_URL" >/dev/null 2>&1; then
      /usr/bin/open "$APP_URL"
      exit 0
    fi
    /bin/sleep 1
  done
) &

/usr/bin/env npm start
