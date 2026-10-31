#!/usr/bin/env bash
# Render dovecot.conf.template -> run/dovecot.conf
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
RUN="$DIR/run"
mkdir -p "$RUN"
sed -e "s#__RUN__#$RUN#g" -e "s#__DIR__#$DIR#g" -e "s#__USER__#$(id -un)#g" -e "s#__GROUP__#$(id -gn)#g" \
  "$DIR/dovecot.conf.template" > "$RUN/dovecot.conf"
