#!/bin/sh
# Sourced from the project root; do not change the user's global Node default.
required_node=$(tr -d '\r\n' < .nvmrc)
if [ "$(node --version 2>/dev/null || true)" != "$required_node" ]; then
  project_node_bin="${NVM_DIR:-$HOME/.nvm}/versions/node/$required_node/bin"
  if [ -x "$project_node_bin/node" ]; then
    PATH="$project_node_bin:$PATH"
    export PATH
  fi
fi
if [ "$(node --version 2>/dev/null || true)" != "$required_node" ]; then
  printf 'Node %s가 필요합니다. 프로젝트 폴더에서 nvm install && nvm use 후 다시 실행하세요.\n' "$required_node" >&2
  exit 1
fi
