#!/usr/bin/env bash
# Console macOS launchd 守护进程安装脚本。
#
# 安装两个 LaunchAgent：
#   1. <label>              Console 主进程：登录自启 + 进程退出/崩溃后自动重启（KeepAlive）
#   2. <label>.healthcheck  /api/health 探活：连续失败自动重启，进程挂死时 kill -9 兜底
#
# 用法: ./install-console-daemon.sh
#
# 环境变量:
#   CONSOLE_HOST=0.0.0.0
#   CONSOLE_PORT=3000
#   CONSOLE_ASSISTANT_HOST=127.0.0.1
#   CONSOLE_LABEL=com.assistant.console
#   CONSOLE_HEALTH_WATCHDOG=1     1=安装健康监控（默认）；0=只装主进程
#   CONSOLE_HEALTH_INTERVAL=30    探活间隔（秒）
#   CONSOLE_HEALTH_THRESHOLD=3    连续失败多少次后自动重启
#   CONSOLE_HEALTH_COOLDOWN=60    两次自动重启之间的最小间隔（秒）
#   NODE_BIN=/absolute/path/to/node
#   DRY_RUN=1                     只生成 plist 到 /tmp，不安装

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONSOLE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LABEL="${CONSOLE_LABEL:-com.assistant.console}"
WATCHDOG_LABEL="${CONSOLE_HEALTH_LABEL:-$LABEL.healthcheck}"
HOST="${CONSOLE_HOST:-0.0.0.0}"
PORT="${CONSOLE_PORT:-3000}"
ASSISTANT_HOST="${CONSOLE_ASSISTANT_HOST:-127.0.0.1}"
HEALTH_WATCHDOG="${CONSOLE_HEALTH_WATCHDOG:-1}"
HEALTH_INTERVAL="${CONSOLE_HEALTH_INTERVAL:-30}"
HEALTH_THRESHOLD="${CONSOLE_HEALTH_THRESHOLD:-3}"
HEALTH_COOLDOWN="${CONSOLE_HEALTH_COOLDOWN:-60}"
HEALTH_SCRIPT="$SCRIPT_DIR/healthcheck-console-daemon.sh"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
UID_VALUE="$(id -u)"
DOMAIN="gui/$UID_VALUE"
DRY_RUN="${DRY_RUN:-0}"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "找不到可执行的 node，请先安装 Node.js 或设置 NODE_BIN。" >&2
  exit 1
fi

if [ ! -d "$CONSOLE_DIR/node_modules/tsx" ]; then
  echo "找不到 tsx 依赖: $CONSOLE_DIR/node_modules/tsx" >&2
  echo "请先在 console 目录执行 pnpm install。" >&2
  exit 1
fi

if [ "$HEALTH_WATCHDOG" = "1" ] && [ ! -f "$HEALTH_SCRIPT" ]; then
  echo "找不到健康检查脚本: $HEALTH_SCRIPT" >&2
  exit 1
fi

case "$HEALTH_INTERVAL" in ''|*[!0-9]*) echo "CONSOLE_HEALTH_INTERVAL 无效: $HEALTH_INTERVAL" >&2; exit 1 ;; esac
case "$HEALTH_THRESHOLD" in ''|*[!0-9]*) echo "CONSOLE_HEALTH_THRESHOLD 无效: $HEALTH_THRESHOLD" >&2; exit 1 ;; esac
case "$HEALTH_COOLDOWN" in ''|*[!0-9]*) echo "CONSOLE_HEALTH_COOLDOWN 无效: $HEALTH_COOLDOWN" >&2; exit 1 ;; esac
[ "$HEALTH_INTERVAL" -ge 5 ] || { echo "CONSOLE_HEALTH_INTERVAL 不能小于 5 秒" >&2; exit 1; }
[ "$HEALTH_THRESHOLD" -ge 1 ] || { echo "CONSOLE_HEALTH_THRESHOLD 不能小于 1" >&2; exit 1; }

if [ "$DRY_RUN" = "1" ]; then
  PLIST_PATH="/tmp/$LABEL.plist"
  WATCHDOG_PLIST_PATH="/tmp/$WATCHDOG_LABEL.plist"
  LOG_DIR="/tmp/assistant-console-logs"
else
  PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
  WATCHDOG_PLIST_PATH="$HOME/Library/LaunchAgents/$WATCHDOG_LABEL.plist"
  LOG_DIR="$HOME/Library/Logs/assistant-console"
fi

# launchd 进程受 macOS TCC 限制，无法读取 ~/Documents 下的脚本；
# 健康检查脚本安装时复制到 Application Support，由 plist 引用副本。
if [ "$DRY_RUN" = "1" ]; then
  SUPPORT_DIR="/tmp/assistant-console-support"
else
  SUPPORT_DIR="$HOME/Library/Application Support/assistant-console"
fi
INSTALLED_HEALTH_SCRIPT="$SUPPORT_DIR/healthcheck-console-daemon.sh"

OUT_LOG="$LOG_DIR/console.out.log"
ERR_LOG="$LOG_DIR/console.err.log"
WATCHDOG_OUT_LOG="$LOG_DIR/watchdog.out.log"
WATCHDOG_ERR_LOG="$LOG_DIR/watchdog.err.log"

mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR" 2>/dev/null || true
# 预创建并收紧日志权限：Console 首次启动可能把完整 API Key 打印到 stdout。
for f in "$OUT_LOG" "$ERR_LOG" "$WATCHDOG_OUT_LOG" "$WATCHDOG_ERR_LOG"; do
  [ -f "$f" ] || touch "$f"
  chmod 600 "$f" 2>/dev/null || true
done

# 健康监控自身的 stdout/stderr 每次安装重置，避免旧报错误导；
# Console 的日志保留，便于排查历史崩溃。
if [ "$DRY_RUN" != "1" ]; then
  : > "$WATCHDOG_OUT_LOG"
  : > "$WATCHDOG_ERR_LOG"
fi

if [ "$DRY_RUN" != "1" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  if [ "$HEALTH_WATCHDOG" = "1" ]; then
    mkdir -p "$SUPPORT_DIR"
    chmod 700 "$SUPPORT_DIR" 2>/dev/null || true
    install -m 700 "$HEALTH_SCRIPT" "$INSTALLED_HEALTH_SCRIPT"
  fi
fi

# ── Console 主进程 plist ───────────────────────────────────────────────────
cat > "$PLIST_PATH" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>--import</string>
    <string>tsx</string>
    <string>$CONSOLE_DIR/src/bin.ts</string>
    <string>--host</string>
    <string>$HOST</string>
    <string>--port</string>
    <string>$PORT</string>
    <string>--assistant-host</string>
    <string>$ASSISTANT_HOST</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$CONSOLE_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>$(dirname "$NODE_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>20</integer>
  <key>StandardOutPath</key>
  <string>$OUT_LOG</string>
  <key>StandardErrorPath</key>
  <string>$ERR_LOG</string>
</dict>
</plist>
PLIST_EOF

plutil -lint "$PLIST_PATH"

# ── 健康监控 plist ─────────────────────────────────────────────────────────
if [ "$HEALTH_WATCHDOG" = "1" ]; then
  cat > "$WATCHDOG_PLIST_PATH" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$WATCHDOG_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALLED_HEALTH_SCRIPT</string>
    <string>--port</string>
    <string>$PORT</string>
    <string>--label</string>
    <string>$LABEL</string>
    <string>--threshold</string>
    <string>$HEALTH_THRESHOLD</string>
    <string>--cooldown</string>
    <string>$HEALTH_COOLDOWN</string>
    <string>--log-dir</string>
    <string>$LOG_DIR</string>
    <string>--state-dir</string>
    <string>$LOG_DIR</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>$HEALTH_INTERVAL</integer>
  <key>StandardOutPath</key>
  <string>$WATCHDOG_OUT_LOG</string>
  <key>StandardErrorPath</key>
  <string>$WATCHDOG_ERR_LOG</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF

  plutil -lint "$WATCHDOG_PLIST_PATH"
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "已生成 plist:"
  echo "  Console:   $PLIST_PATH"
  [ "$HEALTH_WATCHDOG" = "1" ] && echo "  健康监控:  $WATCHDOG_PLIST_PATH"
  echo "DRY_RUN=1，未安装 launchd 服务。"
  exit 0
fi

# ── 安装 ───────────────────────────────────────────────────────────────────

# 端口占用预检：只接管 Console 自己的监听进程，绝不误杀其他服务。
OWNED_LISTENERS=""
FOREIGN_LISTENERS=""
for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
  case "$(ps -o command= -p "$pid" 2>/dev/null || true)" in
    *"src/bin.ts"*) OWNED_LISTENERS="$OWNED_LISTENERS $pid" ;;
    *) FOREIGN_LISTENERS="$FOREIGN_LISTENERS $pid" ;;
  esac
done
if [ -n "$FOREIGN_LISTENERS" ]; then
  echo "端口 $PORT 已被其他进程占用，拒绝安装（避免误杀）:" >&2
  for pid in $FOREIGN_LISTENERS; do
    echo "  pid=$pid  $(ps -o command= -p "$pid" 2>/dev/null || true)" >&2
  done
  echo "请先停掉该进程，或换一个 CONSOLE_PORT 再安装。" >&2
  exit 1
fi

launchctl bootout "$DOMAIN/$WATCHDOG_LABEL" 2>/dev/null || true
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

if [ -n "$OWNED_LISTENERS" ]; then
  echo "停止占用端口 $PORT 的旧 Console 进程:$OWNED_LISTENERS"
  # shellcheck disable=SC2086
  kill $OWNED_LISTENERS 2>/dev/null || true
fi
for _ in $(seq 1 20); do
  if [ -z "$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)" ]; then
    break
  fi
  sleep 1
done

# 清理上一轮可能残留的锁与状态，保证本次是干净启动。
rm -rf "$LOG_DIR/.healthcheck.lock" 2>/dev/null || true
rm -f "$LOG_DIR/console-health.state" 2>/dev/null || true

launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
if ! launchctl bootstrap "$DOMAIN" "$PLIST_PATH"; then
  echo "launchctl bootstrap 失败，最近错误日志（${ERR_LOG}）:" >&2
  tail -n 20 "$ERR_LOG" 2>/dev/null | sed 's/^/    /' >&2 || true
  exit 1
fi

# 安装成功判定：health 200 + 200 的 pid 与端口 LISTEN 者一致 + launchd job running。
HPID=""
LPID=""
JSTATE=""
INSTALL_OK=0
for _ in $(seq 1 25); do
  BODY="$(curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
  HPID="$(printf '%s' "$BODY" | sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' || true)"
  LPID="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  JSTATE="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*state = \(.*\)/\1/p' | head -n 1 || true)"
  if [ -n "$HPID" ] && [ "$HPID" = "$LPID" ] && [ "$JSTATE" = "running" ]; then
    INSTALL_OK=1
    break
  fi
  sleep 1
done

if [ "$INSTALL_OK" != "1" ]; then
  echo >&2
  echo "安装失败：Console 未在预期时间内就绪。" >&2
  echo "  launchd state: ${JSTATE:-unknown}" >&2
  echo "  health pid:    ${HPID:-none} / listener pid: ${LPID:-none}" >&2
  echo "  最近错误日志（${ERR_LOG}）:" >&2
  tail -n 20 "$ERR_LOG" 2>/dev/null | sed 's/^/    /' >&2 || true
  exit 1
fi

if [ "$HEALTH_WATCHDOG" = "1" ]; then
  launchctl enable "$DOMAIN/$WATCHDOG_LABEL" 2>/dev/null || true
  if ! launchctl bootstrap "$DOMAIN" "$WATCHDOG_PLIST_PATH"; then
    echo "健康监控 bootstrap 失败，错误日志（${WATCHDOG_ERR_LOG}）:" >&2
    tail -n 20 "$WATCHDOG_ERR_LOG" 2>/dev/null | sed 's/^/    /' >&2 || true
    exit 1
  fi
fi

echo
echo "安装完成。"
echo "Console Label: $LABEL"
echo "Console Plist: $PLIST_PATH"
echo "日志目录:      $LOG_DIR"
echo
echo "端口 $PORT:"
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || echo "  没有监听"
echo "健康检查: HTTP 200 (pid=$HPID)"
echo

if [ "$HEALTH_WATCHDOG" = "1" ]; then
  echo "健康监控: 已启用（每 ${HEALTH_INTERVAL}s 探活，连续 ${HEALTH_THRESHOLD} 次失败自动重启）"
  echo "  监控 Label: $WATCHDOG_LABEL"
  echo "  监控脚本:   $INSTALLED_HEALTH_SCRIPT"
  echo "  监控日志:   $LOG_DIR/watchdog.log"
else
  echo "健康监控: 未启用（CONSOLE_HEALTH_WATCHDOG=0）"
fi
echo
echo "查看状态: $SCRIPT_DIR/status-console-daemon.sh"
