#!/usr/bin/env bash
# 幂等停止 Linux Observatory 实验室服务。
#
#   ./stop.sh        # 已停止时直接返回成功
#
# 只停止本仓库的 services/lab-server/main.mjs；先 SIGTERM 让服务关闭 QEMU/GDB，
# 超时才 SIGKILL。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${LAB_PORT:-13029}"
PIDFILE="$ROOT/var/lab-server-${PORT}.pid"
HEALTH="http://127.0.0.1:${PORT}/api/health"

pid_is_ours() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local args cwd exe
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ "$args" == *"services/lab-server/main.mjs"* ]] || return 1
  exe="${args%% *}"
  [[ "$(basename "$exe")" == "node" ]] || return 1
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ "$args" == *"$ROOT/"* || "$cwd" == "$ROOT" ]]
}

stop_pid() {
  local pid="$1"
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  echo "停止 pid=$pid…"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 100); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  echo "警告：pid=$pid 10 秒内未退出，发送 SIGKILL（可能留下 QEMU/GDB，请检查 var/sessions）" >&2
  kill -KILL "$pid" 2>/dev/null || true
  sleep 0.2
  return 0
}

STOPPED=0
if [[ -f "$PIDFILE" ]]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if pid_is_ours "$PID"; then
    stop_pid "$PID"
    STOPPED=1
  fi
  rm -f "$PIDFILE"
fi

# 按“监听本端口 + 服务入口 + 仓库根目录”定位待停止进程。
for PID in $(ss -ltnp 2>/dev/null | grep -F ":${PORT} " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
  if pid_is_ours "$PID"; then
    stop_pid "$PID"
    STOPPED=1
  fi
done

if [[ "$STOPPED" -eq 0 ]]; then
  echo "Linux Observatory 未在运行"
else
  echo "Linux Observatory 已停止"
fi

# 幂等：确认本端口的服务响应已结束后返回成功。
if curl -fsS --max-time 2 "$HEALTH" 2>/dev/null | grep -q '"service":"linux-observatory"'; then
  echo "警告：端口 ${PORT} 仍有 Linux Observatory 响应，可能由其他进程启动。" >&2
  exit 1
fi
exit 0
