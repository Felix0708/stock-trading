#!/bin/sh
set -eu

cd "$(dirname "$0")"
env_file=${1:-${SIGNAL_ENV_FILE:-.env.signal}}
[ -f "$env_file" ] || { printf '공통 신호 서버 설정 파일 없음: %s\n' "$env_file" >&2; exit 1; }
lock_file=${TMPDIR:-/tmp}/stock-trading-signal.lock
/usr/bin/shlock -f "$lock_file" -p "$$" || { printf '공통 신호 서버가 이미 실행 중입니다.\n'; exit 0; }

exec node --import tsx --env-file="$env_file" bot.ts
