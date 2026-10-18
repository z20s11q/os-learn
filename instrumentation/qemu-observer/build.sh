#!/usr/bin/env bash
#
# T05a/T05b 观察扩展的幂等构建脚本。
#
# 目标：把 instrumentation/qemu-observer 的内容应用到锁定版本的 QEMU 源码树并重建，
# 任何一步的输入散列不符时立即中止，而不是带着未知改动继续编译。
#
# 幂等性来源：
#   1. 先校验本仓库内基线副本、新增源码、每个补丁自身的散列（防手工改动）；
#   2. 新增源码文件（monitor/x-oslab-observer.c 等）是仓库自有文件，每次构建都从
#      仓库同步到源码树，散列一致就跳过——它们不属于任何补丁，源码树里的副本不
#      是它们的权威版本；
#   3. 再按 baseline.json 的 patchedSha256 判断源码树是否已打补丁，
#      全 pristine 才按顺序打补丁，全 patched 则跳过，部分应用直接报错；
#   4. 编译完成后把二进制散列与 build.lock.json 比对并报告是否一致。
#
# 可复现性验证：
#   OSLAB_QEMU_REPLAY=1 时会额外把上游源码包解到临时目录，按同样顺序复制新增文件、
#   应用全部补丁，再逐文件比对散列。这一步证明「补丁 + 新增源码」本身能重建出
#   基线记录的内容，而不是只证明当前工作树没被改动。
#
# 用法：
#   instrumentation/qemu-observer/build.sh
#
# 可用环境变量覆盖：
#   OSLAB_QEMU_TARBALL  上游源码包路径（默认 /tmp/oslab-qemu-8.2.10.tar.xz）
#   OSLAB_QEMU_SOURCE   源码树目录（默认 artifacts/build/qemu-source）
#   OSLAB_QEMU_BUILD    构建目录（默认 artifacts/build/qemu）
#   OSLAB_QEMU_JOBS     ninja 并行度（默认 nproc）
#   OSLAB_QEMU_REPLAY   置 1 时执行补丁重放验证
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

TARBALL="${OSLAB_QEMU_TARBALL:-/tmp/oslab-qemu-8.2.10.tar.xz}"
SOURCE="${OSLAB_QEMU_SOURCE:-$ROOT/artifacts/build/qemu-source}"
BUILD="${OSLAB_QEMU_BUILD:-$ROOT/artifacts/build/qemu}"
JOBS="${OSLAB_QEMU_JOBS:-$(nproc)}"
REPLAY="${OSLAB_QEMU_REPLAY:-0}"

BASELINE="$HERE/baseline.json"
LOCK="$HERE/build.lock.json"
BINARY="$BUILD/qemu-system-x86_64"

PATCHES=()

say() { printf '%s\n' "$*"; }
fail() { printf '\n构建中止: %s\n' "$*" >&2; exit 1; }
sha256() { sha256sum "$1" | awk '{print $1}'; }

[ -f "$BASELINE" ] || fail "缺少 $BASELINE"
[ -f "$LOCK" ] || fail "缺少 $LOCK"

# baseline.json -> TSV 行，交给 bash 读取（避免依赖 jq）
baseline_tsv() {
  python3 - "$BASELINE" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
upstream = data["upstream"]
print("upstream\t%s\t%s\t%s" % (
    upstream["version"], upstream["tarballFilename"], upstream["tarballSha256"]))
for item in data["modified"]:
    print("modified\t%s\t%s\t%s\t%s" % (
        item["path"], item["pristineCopy"], item["pristineSha256"], item["patchedSha256"]))
for item in data["added"]:
    print("added\t%s\t%s\t%s" % (item["path"], item["repoPath"], item["sha256"]))
for item in data["patches"]:
    print("patch\t%s\t%s" % (item["path"], item["sha256"]))
PY
}

say "== 1. 校验仓库内基线材料 =="
UPSTREAM_VERSION=""
UPSTREAM_SHA=""
while IFS=$'\t' read -r kind a b c d; do
  case "$kind" in
    upstream)
      UPSTREAM_VERSION="$a"
      UPSTREAM_SHA="$c"
      say "   上游 QEMU 版本 $a（源码包 $b）"
      ;;
    modified)
      [ -f "$HERE/$b" ] || fail "缺少基线副本 $b"
      actual="$(sha256 "$HERE/$b")"
      [ "$actual" = "$c" ] || fail "基线副本 $b 散列不符: 期望 $c 实际 $actual"
      ;;
    added)
      [ -f "$HERE/$b" ] || fail "缺少新增源码 $b"
      actual="$(sha256 "$HERE/$b")"
      [ "$actual" = "$c" ] || fail "新增源码 $b 散列不符: 期望 $c 实际 $actual"
      ;;
    patch)
      [ -f "$HERE/$a" ] || fail "缺少补丁 $a"
      actual="$(sha256 "$HERE/$a")"
      [ "$actual" = "$b" ] || fail "补丁 $a 散列不符: 期望 $b 实际 $actual"
      PATCHES+=("$a")
      ;;
  esac
done < <(baseline_tsv)
[ "${#PATCHES[@]}" -gt 0 ] || fail "baseline.json 里没有任何补丁"
say "   基线副本、新增源码、${#PATCHES[@]} 个补丁的散列全部一致"

say "== 2. 准备源码树 =="
if [ ! -f "$SOURCE/monitor/qmp-cmds.c" ]; then
  [ -f "$TARBALL" ] || fail "既没有源码树 $SOURCE，也没有源码包 $TARBALL"
  actual="$(sha256 "$TARBALL")"
  [ "$actual" = "$UPSTREAM_SHA" ] || fail "源码包散列不符: 期望 $UPSTREAM_SHA 实际 $actual"
  mkdir -p "$(dirname "$SOURCE")"
  tmpdir="$(mktemp -d)"
  tar -xf "$TARBALL" -C "$tmpdir"
  extracted="$(find "$tmpdir" -maxdepth 1 -mindepth 1 -type d | head -1)"
  [ -n "$extracted" ] || fail "源码包解压后没有找到顶层目录"
  rm -rf "$SOURCE"
  mv "$extracted" "$SOURCE"
  rm -rf "$tmpdir"
  say "   已从 $TARBALL 解压出源码树"
else
  say "   复用已存在的源码树 $SOURCE"
fi
[ "$(cat "$SOURCE/VERSION" 2>/dev/null)" = "$UPSTREAM_VERSION" ] \
  || fail "源码树 VERSION 不是 $UPSTREAM_VERSION"

say "== 2b. 同步新增源码文件 =="
while IFS=$'\t' read -r kind path repo_path hash; do
  [ "$kind" = "added" ] || continue
  if [ -f "$SOURCE/$path" ] && [ "$(sha256 "$SOURCE/$path")" = "$hash" ]; then
    continue
  fi
  cp "$HERE/$repo_path" "$SOURCE/$path"
  say "   已更新 $repo_path -> $path"
done < <(baseline_tsv)

say "== 3. 判断补丁状态 =="
pristine_count=0
patched_count=0
total_count=0
while IFS=$'\t' read -r kind path pristine_copy pristine_sha patched_sha; do
  [ "$kind" = "modified" ] || continue
  total_count=$((total_count + 1))
  actual="$(sha256 "$SOURCE/$path")"
  if [ "$actual" = "$patched_sha" ]; then
    patched_count=$((patched_count + 1))
  elif [ "$actual" = "$pristine_sha" ]; then
    pristine_count=$((pristine_count + 1))
  else
    fail "$SOURCE/$path 既不是原始版本也不是已打补丁版本（实际 $actual）"
  fi
done < <(baseline_tsv)

if [ "$pristine_count" = "$total_count" ]; then
  say "   源码树为原始状态，开始应用 ${#PATCHES[@]} 个补丁"
  for p in "${PATCHES[@]}"; do
    ( cd "$SOURCE" && patch -p1 --forward < "$HERE/$p" ) || fail "应用补丁 $p 失败"
    say "   已应用 $p"
  done
elif [ "$patched_count" = "$total_count" ]; then
  say "   源码树已处于打补丁状态，跳过应用"
else
  fail "补丁只应用了一部分（原始 $pristine_count / 已应用 $patched_count / 共 $total_count）"
fi

say "== 4. 校验落盘结果 =="
while IFS=$'\t' read -r kind path pristine_copy pristine_sha patched_sha; do
  [ "$kind" = "modified" ] || continue
  actual="$(sha256 "$SOURCE/$path")"
  [ "$actual" = "$patched_sha" ] || fail "$path 打补丁后散列不符: 期望 $patched_sha 实际 $actual"
done < <(baseline_tsv)
while IFS=$'\t' read -r kind path repo_path hash; do
  [ "$kind" = "added" ] || continue
  actual="$(sha256 "$SOURCE/$path")"
  [ "$actual" = "$hash" ] || fail "$path 复制后散列不符: 期望 $hash 实际 $actual"
done < <(baseline_tsv)
say "   源码树内容与基线记录一致"

if [ "$REPLAY" = "1" ]; then
  say "== 4b. 从上游源码包重放补丁（可复现性验证） =="
  [ -f "$TARBALL" ] || fail "重放验证需要上游源码包 $TARBALL"
  actual="$(sha256 "$TARBALL")"
  [ "$actual" = "$UPSTREAM_SHA" ] || fail "源码包散列不符: 期望 $UPSTREAM_SHA 实际 $actual"
  replay_dir="$(mktemp -d)"
  tar -xf "$TARBALL" -C "$replay_dir"
  replay_src="$(find "$replay_dir" -maxdepth 1 -mindepth 1 -type d | head -1)"
  [ -n "$replay_src" ] || fail "重放目录里没有源码树"
  while IFS=$'\t' read -r kind path repo_path hash; do
    [ "$kind" = "added" ] || continue
    cp "$HERE/$repo_path" "$replay_src/$path"
  done < <(baseline_tsv)
  for p in "${PATCHES[@]}"; do
    ( cd "$replay_src" && patch -p1 --forward < "$HERE/$p" >/dev/null ) \
      || fail "重放补丁 $p 失败"
  done
  mismatch=0
  while IFS=$'\t' read -r kind path pristine_copy pristine_sha patched_sha; do
    [ "$kind" = "modified" ] || continue
    actual="$(sha256 "$replay_src/$path")"
    if [ "$actual" != "$patched_sha" ]; then
      say "   不一致 $path: 期望 $patched_sha 实际 $actual"
      mismatch=1
    fi
  done < <(baseline_tsv)
  while IFS=$'\t' read -r kind path repo_path hash; do
    [ "$kind" = "added" ] || continue
    actual="$(sha256 "$replay_src/$path")"
    if [ "$actual" != "$hash" ]; then
      say "   不一致 $path: 期望 $hash 实际 $actual"
      mismatch=1
    fi
  done < <(baseline_tsv)
  rm -rf "$replay_dir"
  [ "$mismatch" = "0" ] || fail "重放结果与基线不符，补丁不再能重建基线内容"
  say "   从原始源码重放补丁后，全部文件散列与基线一致"
fi

say "== 5. 编译 =="
[ -d "$BUILD" ] || fail "构建目录不存在: $BUILD（需要先用 T01 的 configure 生成）"
ninja -C "$BUILD" -j "$JOBS"
[ -f "$BINARY" ] || fail "编译结束但没有 $BINARY"

say "== 6. 与构建记录比对 =="
actual="$(sha256 "$BINARY")"
expected="$(python3 - "$LOCK" <<'PY'
import json
import sys

print(json.load(open(sys.argv[1], encoding="utf-8"))["binary"]["sha256"])
PY
)"
say "   二进制        $BINARY"
say "   实际散列      $actual"
say "   构建记录散列  $expected"
if [ "$actual" = "$expected" ]; then
  say "   结果一致，观察扩展构建与锁定记录相符"
else
  say "   结果不一致：源码或工具链有漂移，请复核 build.lock.json 后再更新记录"
  exit 3
fi

say ""
say "下一步验证："
say "  node instrumentation/qemu-observer/verify-observer.mjs"
say "  node instrumentation/qemu-observer/verify-observer-events.mjs"
say "  node instrumentation/qemu-observer/verify-observer-dma.mjs"
say "  node instrumentation/qemu-observer/verify-observer-devices.mjs"
say "  node instrumentation/qemu-observer/verify-observer-barrier.mjs"
say "  node scripts/verify-observer-service.mjs"
say "  node scripts/verify-observer-events-service.mjs"