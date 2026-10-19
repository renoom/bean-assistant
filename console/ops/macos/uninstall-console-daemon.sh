#!/usr/bin/env bash
# 卸载 Console launchd 守护进程与健康监控。
# 用法: ./uninstall-console-daemon.sh
# 日志目录会保留，便于事后排查。

set -euo pipefail

LABEL="${CONSOLE_LABEL:-com.assistant.console}"
WATCHDOG_LABEL="${CONSOLE_HEALTH_LABEL:-$LABEL.healthcheck}"
PORT="${CONSOLE_PORT:-3000}"
UID_VALUE="$(id -u)"
DOMAIN="gui/$UID_VALUE"
LOG_DIR="${CONSOLE_LOG_DIR:-$HOME/Library/Logs/assistant-console}"

for target in "$WATCHDOG_LABEL" "$LABEL"; do
  launchctl bootout "$DOMAIN/$target" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$target.plist"
done

# bootout 是异步的，给它一点时间；确认没有再告警。
for target in "$WATCHDOG_LABEL" "$LABEL"; do
  for _ in $(seq 1 10); do
    if ! launchctl print "$DOMAIN/$target" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if launchctl print "$DOMAIN/$target" >/dev/null 2>&1; then
    echo "警告：${target} 仍处于 launchd 加载状态，可稍后执行 launchctl bootout $DOMAIN/$target" >&2
  fi
done

# 只停止属于 Console 的监听进程；端口上的其他服务不动，避免误杀。
for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
  case "$(ps -o command= -p "$pid" 2>/dev/null || true)" in
    *"src/bin.ts"*)
      echo "停止 Console 监听进程 pid=$pid"
      kill "$pid" 2>/dev/null || true
      ;;
    *)
      echo "跳过端口 $PORT 上的非 Console 进程 pid=${pid}（不做处理）" >&2
      ;;
  esac
done

SUPPORT_DIR="$HOME/Library/Application Support/assistant-console"
rm -f "$SUPPORT_DIR/healthcheck-console-daemon.sh" 2>/dev/null || true
rmdir "$SUPPORT_DIR" 2>/dev/null || true

rm -f "$LOG_DIR/console-health.state" "$LOG_DIR/.healthcheck.lock" 2>/dev/null || true
rmdir "$LOG_DIR/.healthcheck.lock" 2>/dev/null || true

echo "已卸载 $LABEL 与 ${WATCHDOG_LABEL}，端口 $PORT 已尝试停止。"
echo "日志目录保留在: $LOG_DIR"
