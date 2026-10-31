#!/usr/bin/env bash
# Start the Tidings dev mail stack (Dovecot + dev SMTP). Idempotent.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
RUN="$DIR/run"
DOVECOT_PREFIX="${DOVECOT_PREFIX:-$(brew --prefix dovecot 2>/dev/null || echo /opt/homebrew/opt/dovecot)}"
DOVECOT="$DOVECOT_PREFIX/sbin/dovecot"
[ -x "$DOVECOT" ] || { echo "Dovecot not found at $DOVECOT (brew install dovecot, or set DOVECOT_PREFIX)"; exit 1; }
mkdir -p "$RUN/mail" "$RUN/outbound"
"$DIR/render.sh"

if [ -f "$RUN/base/master.pid" ] && kill -0 "$(cat "$RUN/base/master.pid")" 2>/dev/null; then
  echo "dovecot already running (pid $(cat "$RUN/base/master.pid"))"
else
  "$DOVECOT" -c "$RUN/dovecot.conf" </dev/null >>"$RUN/dovecot.log" 2>&1
  echo "dovecot started"
fi

if [ -f "$RUN/smtp.pid" ] && kill -0 "$(cat "$RUN/smtp.pid")" 2>/dev/null; then
  echo "dev smtp already running (pid $(cat "$RUN/smtp.pid"))"
else
  nohup node "$DIR/smtp.mjs" </dev/null >>"$RUN/smtp.log" 2>&1 &
  echo $! > "$RUN/smtp.pid"
  echo "dev smtp started (pid $!)"
fi

for i in $(seq 1 50); do
  if (exec 3<>/dev/tcp/127.0.0.1/1143) 2>/dev/null && (exec 3<>/dev/tcp/127.0.0.1/2525) 2>/dev/null; then
    echo "ready: IMAP 127.0.0.1:1143  SMTP 127.0.0.1:2525  ManageSieve 127.0.0.1:14190  LMTP 127.0.0.1:12024"
    exit 0
  fi
  sleep 0.2
done
echo "timed out waiting for IMAP/SMTP; see $RUN/dovecot.log and $RUN/smtp.log"
exit 1
