#!/bin/sh
set -eu

cd "$(dirname "$0")"
project_dir=$(pwd)
account_env=
if [ -f .env.account ]; then account_env=.env.account
fi

if [ "${START_ALL_DRY_RUN:-false}" = true ]; then
  printf '공통 신호 서버: sh start-signal.sh\n'
  printf '웹훅 터널: sh start-tunnel.sh\n'
  [ -n "$account_env" ] && printf '계좌 주문 실행기: sh start-executor.sh\n'
  exit 0
fi

osascript - "$project_dir" "$account_env" <<'APPLESCRIPT'
on run argv
  set projectDir to item 1 of argv
  set accountEnv to item 2 of argv
  tell application "iTerm"
    activate
    set tradingWindow to (create window with default profile)
    tell current session of tradingWindow
      write text "cd " & quoted form of projectDir & " && sh start-signal.sh"
      set name to "공통 신호 서버"
    end tell
    tell tradingWindow
      set tunnelTab to (create tab with default profile)
      tell current session of tunnelTab
        write text "cd " & quoted form of projectDir & " && sh start-tunnel.sh"
        set name to "웹훅 터널"
      end tell
      if accountEnv is not "" then
        set kisTab to (create tab with default profile)
        tell current session of kisTab
          write text "cd " & quoted form of projectDir & " && sh start-executor.sh"
          set name to "계좌 주문 실행기"
        end tell
      end if
    end tell
  end tell
end run
APPLESCRIPT
