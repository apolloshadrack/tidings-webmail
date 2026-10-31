#!/usr/bin/env bash
# Stop the Tidings dev mail stack. Idempotent.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
RUN="$DIR/run"
if [ -f "$RUN/smtp.pid" ]; then
  kill "$(cat "$RUN/smtp.pid")" 2>/dev/null && echo "dev smtp stopped"
  rm -f "$RUN/smtp.pid"
fi
if [ -f "$RUN/base/master.pid" ] && kill -0 "$(cat "$RUN/base/master.pid")" 2>/dev/null; then
  kill "$(cat "$RUN/base/master.pid")"
  for i in $(seq 1 25); do kill -0 "$(cat "$RUN/base/master.pid" 2>/dev/null)" 2>/dev/null || break; sleep 0.2; done
  echo "dovecot stopped"
fi
exit 0
