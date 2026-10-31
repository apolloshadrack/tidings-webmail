#!/usr/bin/env bash
# Wipe all dev mail and start fresh with seed data.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/stop.sh"
rm -rf "$DIR/run"
"$DIR/start.sh"
node "$DIR/seed.mjs"
