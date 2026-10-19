#!/usr/bin/env bash
# assistant-vn 启动/测试助手脚本
#
#   ./run.sh                  连真实助手（默认 :3101）
#   ./run.sh --port=3102      指定助手端口
#   ./run.sh demo             离线演示，不连助手、不花 token
#   ./run.sh test             跑单元测试（无网络）
#   ./run.sh probe            只读探针，验证 SSE 链路（不发消息、不花 token）
#   ./run.sh shot out.png     截自己的图（配合 demo 用于调样式）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 找 Godot：优先 PATH，其次常见安装位置（含 Steam 版）
find_godot() {
  if command -v godot >/dev/null 2>&1; then command -v godot; return; fi
  local candidates=(
    "$HOME/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot"
    "/Applications/Godot.app/Contents/MacOS/Godot"
    "$HOME/Applications/Godot.app/Contents/MacOS/Godot"
  )
  for c in "${candidates[@]}"; do
    [[ -x "$c" ]] && { echo "$c"; return; }
  done
  echo "找不到 Godot 可执行文件，请把它加进 PATH。" >&2
  exit 1
}

GODOT="$(find_godot)"
CMD="${1:-run}"

case "$CMD" in
  test)
    exec "$GODOT" --headless --path "$HERE" res://tests/run_tests.tscn
    ;;
  probe)
    shift || true
    exec "$GODOT" --headless --path "$HERE" res://tests/probe_live.tscn -- "$@"
    ;;
  demo)
    shift || true
    exec "$GODOT" --path "$HERE" --resolution 1280x720 -- --demo "$@"
    ;;
  shot)
    OUT="${2:-/tmp/vn.png}"
    exec "$GODOT" --path "$HERE" --resolution 1280x720 -- \
      --demo "--screenshot=$OUT" --screenshot-delay=6
    ;;
  import)
    exec "$GODOT" --headless --path "$HERE" --import
    ;;
  *)
    exec "$GODOT" --path "$HERE" --resolution 1280x720 -- "$@"
    ;;
esac
