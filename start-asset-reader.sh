#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")"
lock_file=${TMPDIR:-/tmp}/stock-trading-asset-reader.lock
/usr/bin/shlock -f "$lock_file" -p "$$" || exit 0
. ./scripts/use-project-node.sh
exec node scripts/run-service.cjs --import tsx --env-file=.env.account scripts/read-assets.ts --watch --send
