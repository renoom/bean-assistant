#!/usr/bin/env bash
# Console 健康检查 / 自愈脚本。
#
# 由 launchd 的 com.assistant.console.healthcheck 定时调用（默认每 30 秒一次）：
#   1. 探测 http://127.0.0.1:<port>/api/health
#      - 要求 HTTP 200、响应含 "ok":true，且响应里的 pid 与端口 LISTEN 进程一致，
#        避免端口被其他服务占用时把别人的 200 当成自己健康
#   2. 连续 threshold 次（默认 3 次）失败后，重启 Console 的 launchd 服务
#   3. 重启后仍不健康时，按“端口归属”决定兜底动作：
#      - 端口无监听：bootout + bootstrap 完整重启
#      - 监听进程属于本服务：kill -9 该 listener，交给 KeepAlive 拉起
#      - 端口被外部进程占用：只告警，不误杀，停止自动重启
#   4. 两次自动重启之间至少间隔 cooldown 秒，避免配置错误导致疯狂重启
#
# launchd 的 KeepAlive 只能处理“进程退出/崩溃”，本脚本负责“进程还活着但不健康”。
#
# 用法:
#   ./healthcheck-console-daemon.sh [选项]
#
# 选项:
#   --port <port>         Console 端口 (默认 3000)
#   --label <label>       Console 的 launchd Label (默认 com.assistant.console)
#   --threshold <n>       连续失败阈值 (默认 3)
#   --cooldown <sec>      两次自动重启的最小间隔 (默认 60)
#   --log-dir <dir>       日志目录 (默认 ~/Library/Logs/assistant-console)
#   --state-dir <dir>     状态文件目录 (默认同日志目录)
#   --plist <path>        未加载时用于 bootstrap 的 plist (默认 ~/Library/LaunchAgents/<label>.plist)
#   --dry-run             只记录将要执行的重启动作，不真正执行
#
# 同名大写环境变量（CONSOLE_PORT / CONSOLE_LABEL / CONSOLE_HEALTH_THRESHOLD /
# CONSOLE_HEALTH_COOLDOWN / CONSOLE_LOG_DIR / CONSOLE_STATE_DIR）可覆盖默认值。
#
# 退出码：0 表示健康或已执行自愈动作；1 表示本次探测失败但尚未达到重启阈值。

set -uo pipefail

PORT="${CONSOLE_PORT:-3000}"
LABEL="${CONSOLE_LABEL:-com.assistant.console}"
THRESHOLD="${CONSOLE_HEALTH_THRESHOLD:-3}"
COOLDOWN="${CONSOLE_HEALTH_COOLDOWN:-60}"
LOG_DIR="${CONSOLE_LOG_DIR:-$HOME/Library/Logs/assistant-console}"
STATE_DIR="${CONSOLE_STATE_DIR:-$LOG_DIR}"
PLIST="${CONSOLE_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
DRY_RUN="${CONSOLE_HEALTH_DRY_RUN:-0}"
CONSOLE_MARKER="${CONSOLE_MARKER:-src/bin.ts}"

usage() {
  sed -n '/^# Console 健康检查/,/^set -uo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)        PORT="${2:-}"; shift 2 || exit 2 ;;
    --label)       LABEL="${2:-}"; shift 2 || exit 2 ;;
    --threshold)   THRESHOLD="${2:-}"; shift 2 || exit 2 ;;
    --cooldown)    COOLDOWN="${2:-}"; shift 2 || exit 2 ;;
    --log-dir)     LOG_DIR="${2:-}"; shift 2 || exit 2 ;;
    --state-dir)   STATE_DIR="${2:-}"; shift 2 || exit 2 ;;
    --plist)       PLIST="${2:-}"; shift 2 || exit 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "未知参数: $1（--help 查看用法）" >&2; exit 2 ;;
  esac
done

case "$PORT" in ''|*[!0-9]*) echo "端口无效: $PORT" >&2; exit 2 ;; esac
case "$THRESHOLD" in ''|*[!0-9]*) echo "阈值无效: $THRESHOLD" >&2; exit 2 ;; esac
case "$COOLDOWN" in ''|*[!0-9]*) echo "冷却时间无效: $COOLDOWN" >&2; exit 2 ;; esac
[ "$THRESHOLD" -ge 1 ] || { echo "阈值必须 >= 1" >&2; exit 2; }

HEALTH_URL="http://127.0.0.1:$PORT/api/health"
LOG_FILE="$LOG_DIR/watchdog.log"
STATE_FILE="$STATE_DIR/console-health.state"
LOCK_DIR="$STATE_DIR/.healthcheck.lock"
DOMAIN="gui/$(id -u)"

mkdir -p "$LOG_DIR" "$STATE_DIR" 2>/dev/null || true
[ -f "$LOG_FILE" ] && chmod 600 "$LOG_FILE" 2>/dev/null || true

log() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') [healthcheck] $*"
  printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || printf '%s\n' "$line" >&2
}

# 健康监控自身日志超过 5MB 轮转一次；Console 日志超过 50MB 原地截断，
# 避免长期运行把磁盘写满（launchd 以追加方式写同一 fd，截断后继续追加）。
rotate_logs() {
  local size
  if [ -f "$LOG_FILE" ]; then
    size="$(wc -c < "$LOG_FILE" 2>/dev/null | tr -d ' ')"
    case "$size" in ''|*[!0-9]*) ;; *)
      [ "$size" -gt 5242880 ] && mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true ;;
    esac
  fi
  local f
  for f in "$LOG_DIR/console.out.log" "$LOG_DIR/console.err.log"; do
    [ -f "$f" ] || continue
    size="$(wc -c < "$f" 2>/dev/null | tr -d ' ')"
    case "$size" in ''|*[!0-9]*) continue ;; esac
    if [ "$size" -gt 52428800 ]; then
      : > "$f" 2>/dev/null || continue
      log "已截断超大 Console 日志 ${f}（>50MB）"
    fi
  done
}

# 防止 launchd 周期触发与手工执行重叠（脚本最长约 30 秒）。
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
    return 0
  fi
  local mtime age
  mtime="$(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0)"
  age=$(( $(date +%s) - mtime ))
  if [ "$age" -gt 120 ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
      return 0
    fi
  fi
  log "已有 healthcheck 实例在运行，跳过本次"
  return 1
}

# 健康判定：HTTP 200 + "ok":true + pid 与端口 LISTEN 进程一致。
# 返回值 0 健康；1 探测失败；2 拿到 200 但不是本进程（外部占用/旧版本）。
probe_health() {
  PROBE_BODY="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)" || return 1
  case "$PROBE_BODY" in
    *'"ok":true'*) ;;
    *) return 1 ;;
  esac

  HEALTH_PID="$(printf '%s' "$PROBE_BODY" | sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
  case "$HEALTH_PID" in
    ''|*[!0-9]*)
      log "健康接口没有 pid 字段（旧版本 Console？），按异常处理"
      return 2
      ;;
  esac

  LISTENER_PID="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1)"
  case "$LISTENER_PID" in
    ''|*[!0-9]*)
      log "健康接口返回 200，但端口 $PORT 没有 LISTEN 进程"
      return 2
      ;;
  esac

  if [ "$LISTENER_PID" != "$HEALTH_PID" ]; then
    log "健康接口 200 来自 pid=${HEALTH_PID}，但端口监听者是 pid=${LISTENER_PID}，判定不是本服务"
    return 2
  fi
  return 0
}

# 取 launchd 当前受控进程 pid。
managed_pid() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null \
    | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\).*/\1/p' \
    | head -n 1
}

# 判断某个 pid 是否属于 Console：命令行匹配，或等于 launchd 报告的 pid。
is_console_process() {
  local pid="$1" cmd jp
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  case "$cmd" in
    *"$CONSOLE_MARKER"*) return 0 ;;
  esac
  jp="$(managed_pid)"
  [ -n "$jp" ] && [ "$pid" = "$jp" ] && return 0
  return 1
}

restart_console() {
  log "连续失败达到 $THRESHOLD 次，开始重启 Console（${LABEL}）"

  if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    if [ -f "$PLIST" ]; then
      log "launchd 中未加载 ${LABEL}，尝试 bootstrap: $PLIST"
      launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || log "bootstrap 失败（继续尝试 kickstart）"
    fi
  fi

  if launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    log "已发送 launchctl kickstart -k"
  else
    log "launchctl kickstart 失败，等待下一轮重试"
  fi

  # 给 ThrottleInterval（10s）和 tsx 冷启动留出时间。
  sleep 15
  if probe_health; then
    log "重启后健康检查已恢复"
    LAST_RESULT=restarted
    return 0
  fi

  # 兜底：先确认端口归属，绝不误杀其他进程。
  local listener
  listener="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1)"
  case "$listener" in
    '')
      log "端口 $PORT 已无监听（进程可能完全挂死），执行 bootout + bootstrap 完整重启"
      launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
      sleep 2
      if [ -f "$PLIST" ]; then
        launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || log "bootstrap 失败"
      fi
      launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
      ;;
    *)
      if is_console_process "$listener"; then
        log "端口 LISTEN 进程 $listener 属于本服务但已无响应，执行 kill -9"
        kill -9 "$listener" 2>/dev/null || log "kill -9 $listener 失败"
      else
        log "错误：端口 $PORT 被其他进程占用（pid=${listener}），已停止自动重启以免误杀；请人工处理"
        LAST_RESULT=foreign
        return 0
      fi
      ;;
  esac

  sleep 8
  if probe_health; then
    log "SIGKILL/完整重启后健康检查已恢复"
    LAST_RESULT=restarted
  else
    log "仍不健康，请检查 Console 日志: $LOG_DIR/console.err.log"
    LAST_RESULT=fail
  fi
  return 0
}

# ── 状态读写 ────────────────────────────────────────────────────────────────

FAILURES=0
LAST_KICK=0
LAST_RESULT=unknown
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE" 2>/dev/null || true
fi
case "$FAILURES" in ''|*[!0-9]*) FAILURES=0 ;; esac
case "$LAST_KICK" in ''|*[!0-9]*) LAST_KICK=0 ;; esac

save_state() {
  local tmp="$STATE_FILE.$$"
  {
    printf 'FAILURES=%s\n' "$FAILURES"
    printf 'LAST_KICK=%s\n' "$LAST_KICK"
    printf 'LAST_CHECK=%s\n' "$(date +%s)"
    printf 'LAST_RESULT=%s\n' "$LAST_RESULT"
  } > "$tmp" 2>/dev/null && mv -f "$tmp" "$STATE_FILE" 2>/dev/null
  chmod 600 "$STATE_FILE" 2>/dev/null || true
}

# ── 主流程 ──────────────────────────────────────────────────────────────────

rotate_logs
acquire_lock || exit 0

if probe_health; then
  if [ "$FAILURES" -gt 0 ]; then
    log "健康检查已恢复（此前连续失败 $FAILURES 次）: $PROBE_BODY"
  fi
  FAILURES=0
  LAST_RESULT=ok
  save_state
  exit 0
fi

FAILURES=$((FAILURES + 1))
LAST_RESULT=fail
log "健康检查失败 ($FAILURES/$THRESHOLD): $HEALTH_URL"

if [ "$FAILURES" -lt "$THRESHOLD" ]; then
  save_state
  exit 1
fi

NOW="$(date +%s)"
if [ "$LAST_KICK" -gt 0 ] && [ $((NOW - LAST_KICK)) -lt "$COOLDOWN" ]; then
  log "距上次自动重启仅 $((NOW - LAST_KICK))s（冷却 ${COOLDOWN}s），本次不重启"
  save_state
  exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
  log "[dry-run] 将执行: launchctl kickstart -k $DOMAIN/$LABEL"
  log "[dry-run] 若 15s 后仍不健康：无监听则 bootout+bootstrap；本服务监听无响应则 kill -9 listener；外部进程占用则只告警"
  FAILURES=0
  LAST_KICK="$NOW"
  LAST_RESULT=restarted
  save_state
  exit 0
fi

restart_console
FAILURES=0
LAST_KICK="$NOW"
save_state
exit 0
