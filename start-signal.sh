#!/bin/sh
set -eu

cd "$(dirname "$0")"
env_file=${1:-${SIGNAL_ENV_FILE:-.env.signal}}
[ -f "$env_file" ] || { printf '공통 신호 서버 설정 파일 없음: %s\n' "$env_file" >&2; exit 1; }

exec node --env-file="$env_file" bot.js
