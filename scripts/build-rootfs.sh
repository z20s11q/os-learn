#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BB="$ROOT/artifacts/build/busybox"
ROOTFS="$ROOT/artifacts/build/rootfs"
INITRD="$ROOT/artifacts/build/initramfs"
if [[ ! -x "$BB/busybox" ]]; then
  mkdir -p "$BB"
  tar -xjf /tmp/oslab-busybox-1.37.0.tar.bz2 -C "$BB" --strip-components=1
  make -C "$BB" defconfig > "$ROOT/artifacts/logs/busybox-build.log" 2>&1
  sed -i 's/# CONFIG_STATIC is not set/CONFIG_STATIC=y/' "$BB/.config"
  make -C "$BB" -j16 >> "$ROOT/artifacts/logs/busybox-build.log" 2>&1
fi
mkdir -p "$ROOTFS" "$INITRD"
make -C "$BB" CONFIG_PREFIX="$ROOTFS" install >> "$ROOT/artifacts/logs/busybox-build.log" 2>&1
for d in dev proc sys tmp run data etc root newroot; do mkdir -p "$ROOTFS/$d"; done
chmod 1777 "$ROOTFS/tmp"
gcc -static -g3 -O0 -fno-pie -no-pie -fno-omit-frame-pointer "$ROOT/labs/linux-x86_64/lab.c" -o "$ROOT/artifacts/lab.elf"
cp "$ROOT/artifacts/lab.elf" "$ROOTFS/bin/lab"
for name in read write memory cow fork-exec mmap-file fault schedule tty alloc signal; do ln -sf lab "$ROOTFS/bin/lab-$name"; done
cat > "$ROOTFS/etc/inittab" <<'INITTAB'
::sysinit:/etc/rcS
tty1::askfirst:/bin/sh -l
ttyS0::respawn:/bin/cttyhack /bin/sh -l
::ctrlaltdel:/sbin/reboot
::shutdown:/bin/sync
INITTAB
cat > "$ROOTFS/etc/rcS" <<'RCS'
#!/bin/sh
mount -t proc proc /proc 2>/dev/null
mount -t sysfs sysfs /sys 2>/dev/null
mount -t devtmpfs devtmpfs /dev 2>/dev/null
mkdir -p /dev/pts /sys/kernel/debug /sys/kernel/tracing
mount -t devpts devpts /dev/pts
mount -t debugfs debugfs /sys/kernel/debug
mount -t tracefs tracefs /sys/kernel/tracing
hostname linux-lab
printf '\nLinux Observatory / Linux 6.12.112\n'
printf 'Real kernel, real processes, real virtio disk.\n'
printf 'Try: cat /data/hello.txt; lab-read; lab-memory; lab-cow\n\n'
RCS
chmod +x "$ROOTFS/etc/rcS"
cat > "$ROOTFS/etc/profile" <<'PROFILE'
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export PS1='linux-lab:\w# '
export TERM=linux
cd /root
PROFILE
printf 'Hello from the real Linux virtio disk!\nThis file lives on ext2, not in the web page.\n' > "$ROOTFS/data/hello.txt"
python3 - "$ROOTFS/data/probe.bin" <<'PY'
import sys
with open(sys.argv[1],'wb') as f:
 for i in range(512):f.write((f'Linux disk probe block {i:04d}\n'.encode()).ljust(4096,b'.'))
PY
truncate -s 96M "$ROOT/artifacts/rootfs.img"
mke2fs -q -F -t ext2 -b 4096 -d "$ROOTFS" "$ROOT/artifacts/rootfs.img"
mkdir -p "$INITRD"/{bin,dev,proc,sys,newroot}
cp "$BB/busybox" "$INITRD/bin/busybox"
for name in sh mount switch_root sleep; do ln -sf busybox "$INITRD/bin/$name"; done
cat > "$INITRD/init" <<'INIT'
#!/bin/sh
/bin/mount -t devtmpfs devtmpfs /dev
/bin/mount -t proc proc /proc
/bin/mount -t sysfs sysfs /sys
while [ ! -b /dev/vda ]; do /bin/sleep 0.1; done
/bin/mount -t ext2 /dev/vda /newroot || exec /bin/sh
/bin/mount --move /dev /newroot/dev
/bin/mount --move /proc /newroot/proc
/bin/mount --move /sys /newroot/sys
exec /bin/switch_root /newroot /sbin/init
INIT
chmod +x "$INITRD/init"
(cd "$INITRD" && find . -print0 | cpio --null -o --format=newc 2>/dev/null | gzip -1) > "$ROOT/artifacts/initramfs.cpio.gz"
