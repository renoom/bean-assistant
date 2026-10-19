#!/usr/bin/env bash
# 把 StageChannelSdk 同步进 demo 工程。
#
# Godot 只识别工程内 res://addons/ 下的 addon，无法直接引用仓库里的 sdk/ 目录，
# 因此以 SDK 为唯一源、在运行/测试前复制一份到 examples/godot-demo/addons/。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$HERE/../../sdk/godot/addons/stage_channel_sdk"
DST="$HERE/addons/stage_channel_sdk"

if [[ ! -d "$SRC" ]]; then
  echo "找不到 StageChannelSdk：$SRC" >&2
  exit 1
fi

mkdir -p "$HERE/addons"
rm -rf "$DST"
cp -R "$SRC" "$DST"
echo "synced StageChannelSdk -> $DST"
