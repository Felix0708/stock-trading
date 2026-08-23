#!/bin/sh
set -eu

cd "$(dirname "$0")"
env_file=${1:-${SIGNAL_ENV_FILE:-.env.signal}}
[ -f "$env_file" ] || { printf '설정 파일 없음: %s\n' "$env_file" >&2; exit 1; }

public_url=${NGROK_PUBLIC_URL:-$(node --env-file="$env_file" -p 'process.env.NGROK_PUBLIC_URL || ""')}
: "${public_url:?NGROK_PUBLIC_URL을 설정 파일에 입력하세요}"

attempt=0
while [ ! -s .webhook-token ] && [ "$attempt" -lt 10 ]; do
  attempt=$((attempt + 1))
  sleep 1
done
[ -s .webhook-token ] || { printf '웹훅 비밀 파일이 없습니다. 메인 탭이 정상 기동했는지 확인하세요.\n' >&2; exit 1; }

token=$(tr -d '\r\n' < .webhook-token)
printf '%s/webhook/%s' "$public_url" "$token" | pbcopy
printf '\nTradingView 웹훅 URL 복사 완료: %s/webhook/<secret>\n\n' "$public_url"

exec ngrok http 8787 --url "$public_url"
