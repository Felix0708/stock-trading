#!/bin/sh
set -eu

cd "$(dirname "$0")"
env_file=${1:-${ACCOUNT_EXECUTOR_ENV_FILE:-.env.account}}
[ -f "$env_file" ] || { printf '계좌 주문 실행기 설정 파일 없음: %s\n' "$env_file" >&2; exit 1; }
lock_name=stock-trading-executor.lock
if [ "$env_file" != ".env.account" ]; then
  env_name=$(basename "$env_file")
  env_name=$(printf '%s' "$env_name" | tr -c 'A-Za-z0-9._-' '_')
  lock_name=stock-trading-executor-${env_name}.lock
fi
lock_file=${TMPDIR:-/tmp}/$lock_name
/usr/bin/shlock -f "$lock_file" -p "$$" || { printf '계좌 주문 실행기가 이미 실행 중입니다.\n'; exit 0; }

signal_env=${SIGNAL_ENV_FILE:-.env.signal}
if [ -f "$signal_env" ] && [ "$signal_env" != "$env_file" ]; then
  exec node --import tsx --env-file="$signal_env" --env-file="$env_file" src/executor/account-executor.ts
fi

exec node --import tsx --env-file="$env_file" src/executor/account-executor.ts
