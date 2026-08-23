#!/bin/sh
set -eu

cd "$(dirname "$0")"
env_file=${1:-${ACCOUNT_EXECUTOR_ENV_FILE:-.env.account}}
[ -f "$env_file" ] || { printf '계좌 주문 실행기 설정 파일 없음: %s\n' "$env_file" >&2; exit 1; }

signal_env=${SIGNAL_ENV_FILE:-.env.signal}
if [ -f "$signal_env" ] && [ "$signal_env" != "$env_file" ]; then
  exec node --env-file="$signal_env" --env-file="$env_file" kis-discord-consumer.js
fi

exec node --env-file="$env_file" kis-discord-consumer.js
