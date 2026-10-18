#!/usr/bin/env bash
# 幂等启动 Linux Observatory 实验室服务。
#
#   ./start.sh            # 已运行则直接返回成功；否则启动并等待 /api/health
#   ./start.sh --build    # 强制先构建前端再启动
#
# 环境变量：LAB_PORT（默认 13029）、LAB_HOST（默认 0.0.0.0）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${LAB_PORT:-13029}"
HOST="${LAB_HOST:-0.0.0.0}"
PIDFILE="$ROOT/var/lab-server-${PORT}.pid"
LOGFILE="$ROOT/var/log/lab-server-${PORT}.log"
ENTRY="$ROOT/services/lab-server/main.mjs"
HEALTH="http://127.0.0.1:${PORT}/api/health"
BUILD_ONLY=0
[[ "${1:-}" == "--build" ]] && BUILD_ONLY=1

mkdir -p "$ROOT/var/log" "$ROOT/var/sessions"

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
  # 既接受绝对入口，也接受在仓库根目录用相对入口手工启动的进程。
  [[ "$args" == *"$ROOT/"* || "$cwd" == "$ROOT" ]]
}

health_ok() {
  curl -fsS --max-time 2 "$HEALTH" 2>/dev/null | grep -q '"service":"linux-observatory"'
}

pids_on_port() {
  ss -ltnp 2>/dev/null | grep -F ":${PORT} " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
}

discover_pid() {
  local pid
  for pid in $(pids_on_port); do
    if pid_is_ours "$pid"; then
      echo "$pid"
      return 0
    fi
  done
  return 1
}

# 1. 已有 PID 且进程是我们的：幂等返回。
if [[ -f "$PIDFILE" ]]; then
  OLD_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if pid_is_ours "$OLD_PID"; then
    if health_ok; then
      echo "Linux Observatory 已在运行 (pid=$OLD_PID)"
      echo "  页面: http://127.0.0.1:${PORT}/lab/"
      echo "  日志: $LOGFILE"
      exit 0
    fi
    echo "进程 $OLD_PID 存在但健康检查未通过，等待 3 秒后重试…"
    sleep 3
    if health_ok; then
      echo "Linux Observatory 已在运行 (pid=$OLD_PID)"
      exit 0
    fi
    echo "错误：进程 $OLD_PID 在运行但 $HEALTH 不可用。先执行 ./stop.sh 清理。" >&2
    exit 1
  fi
  rm -f "$PIDFILE"
fi

# 2. 按端口健康检查识别已运行的服务，并补记可定位的 PID。
if health_ok; then
  FOUND_PID="$(discover_pid || true)"
  if [[ -n "$FOUND_PID" ]]; then
    echo "$FOUND_PID" >"$PIDFILE"
    echo "Linux Observatory 已在端口 ${PORT} 运行 (pid=$FOUND_PID)"
  else
    echo "Linux Observatory 已在端口 ${PORT} 运行（未找到 $PIDFILE，按幂等状态处理）"
  fi
  echo "  页面: http://127.0.0.1:${PORT}/lab/"
  echo "  日志: $LOGFILE"
  exit 0
fi

# 3. 端口被其他进程占用时报错退出。
if ss -ltnp 2>/dev/null | grep -q ":${PORT} "; then
  echo "错误：端口 ${PORT} 已被其他进程占用，未启动。" >&2
  ss -ltnp 2>/dev/null | grep ":${PORT} " >&2 || true
  exit 1
fi

# 4. 构建前端（缺失、源码比产物新、或显式 --build）。
NEEDS_BUILD=0
if [[ "$BUILD_ONLY" -eq 1 || ! -f "$ROOT/apps/debugger-web/dist/index.html" ]]; then
  NEEDS_BUILD=1
elif [[ -n "$(find "$ROOT/apps/debugger-web/src" "$ROOT/apps/debugger-web/index.html" "$ROOT/apps/debugger-web/vite.config.ts" -newer "$ROOT/apps/debugger-web/dist/index.html" -print -quit 2>/dev/null)" ]]; then
  NEEDS_BUILD=1
fi
if [[ "$NEEDS_BUILD" -eq 1 ]]; then
  echo "构建前端…"
  (cd "$ROOT" && npm run build)
fi

# 5. 启动并等待健康检查。
echo "启动 Linux Observatory (${HOST}:${PORT})…"
nohup env LAB_PORT="$PORT" LAB_HOST="$HOST" node "$ENTRY" >>"$LOGFILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" >"$PIDFILE"

for _ in $(seq 1 60); do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo "错误：服务进程 $NEW_PID 已退出，最近日志：" >&2
    tail -n 30 "$LOGFILE" >&2 || true
    rm -f "$PIDFILE"
    exit 1
  fi
  if health_ok; then
    echo "启动成功 (pid=$NEW_PID)"
    echo "  页面: http://127.0.0.1:${PORT}/lab/"
    echo "  日志: $LOGFILE"
    exit 0
  fi
  sleep 0.5
done

echo "错误：30 秒内健康检查未通过，最近日志：" >&2
tail -n 30 "$LOGFILE" >&2 || true
exit 1
