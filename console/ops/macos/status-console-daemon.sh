#!/usr/bin/env bash
# 查看 Console launchd 守护进程与健康监控状态。
# 用法: ./status-console-daemon.sh

set -uo pipefail

LABEL="${CONSOLE_LABEL:-com.assistant.console}"
WATCHDOG_LABEL="${CONSOLE_HEALTH_LABEL:-$LABEL.healthcheck}"
PORT="${CONSOLE_PORT:-3000}"
UID_VALUE="$(id -u)"
DOMAIN="gui/$UID_VALUE"
LOG_DIR="${CONSOLE_LOG_DIR:-$HOME/Library/Logs/assistant-console}"
STATE_FILE="$LOG_DIR/console-health.state"
HEALTH_URL="http://127.0.0.1:$PORT/api/health"

show_agent() {
  local label="$1" title="$2"
  echo "=== $title ($label) ==="
  if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
    # 只取顶层字段（缩进恰好一个 tab），跳过嵌套子服务的 state = active。
    launchctl print "$DOMAIN/$label" 2>/dev/null \
      | grep -E '^[[:space:]](state|pid|program|runs|last exit code|last exit status) = ' \
      | sed 's/^[[:space:]]*/  /'
  else
    echo "  launchd 中没有找到 ${label}（未安装或已卸载）"
  fi
}

show_agent "$LABEL" "Console 主进程"
echo
show_agent "$WATCHDOG_LABEL" "健康监控"
echo

echo "=== 健康检查 ==="
BODY="$(curl -fsS -m 3 "$HEALTH_URL" 2>/dev/null)" && echo "  $BODY" || echo "  健康检查失败: $HEALTH_URL"
echo

echo "=== 端口 $PORT ==="
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || echo "  端口 $PORT 没有监听"
echo

echo "=== 健康监控状态文件 ==="
if [ -f "$STATE_FILE" ]; then
  sed 's/^/  /' "$STATE_FILE"
else
  echo "  还没有状态文件（监控尚未运行过）"
fi
echo

echo "=== 最近健康监控日志 ==="
tail -n 15 "$LOG_DIR/watchdog.log" 2>/dev/null | sed 's/^/  /' || echo "  暂无"
echo

echo "=== Console 日志尾部 ==="
echo "  out: $LOG_DIR/console.out.log"
tail -n 10 "$LOG_DIR/console.out.log" 2>/dev/null | sed 's/^/  /' || true
echo "  err: $LOG_DIR/console.err.log"
tail -n 10 "$LOG_DIR/console.err.log" 2>/dev/null | sed 's/^/  /' || true
