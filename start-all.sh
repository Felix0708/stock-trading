#!/bin/sh
set -eu

cd "$(dirname "$0")"

node --env-file=.env bot.js &
bot_pid=$!
public_url=${NGROK_PUBLIC_URL:-$(node --env-file=.env -p 'process.env.NGROK_PUBLIC_URL || ""')}
: "${public_url:?Set NGROK_PUBLIC_URL in .env}"
token=$(tr -d '\r\n' < .webhook-token)
printf '%s/webhook/%s' "$public_url" "$token" | pbcopy
printf '\nTradingView 웹훅 URL 복사 완료: %s/webhook/<secret>\n\n' "$public_url"

cleanup() {
  trap - EXIT INT TERM
  kill "$bot_pid" 2>/dev/null || true
  wait "$bot_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ngrok http 8787 --url "$public_url"
