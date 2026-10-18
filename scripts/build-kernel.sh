#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SOURCE="$ROOT/src/linux-6.12.112"
BUILD="$ROOT/artifacts/build/linux"
mkdir -p "$BUILD" "$ROOT/artifacts/logs"
if [[ ! -f "$BUILD/.config" ]]; then
  make -C "$SOURCE" O="$BUILD" x86_64_defconfig
  "$SOURCE/scripts/config" --file "$BUILD/.config" \
    -d DEBUG_INFO_NONE -e DEBUG_INFO_DWARF4 -e GDB_SCRIPTS -e KALLSYMS_ALL \
    -e UNWINDER_FRAME_POINTER -d UNWINDER_ORC -d RANDOMIZE_BASE -d RANDOMIZE_MEMORY \
    -d X86_5LEVEL -d PAGE_TABLE_ISOLATION -d MODULES -d SYSTEM_TRUSTED_KEYRING \
    -d SYSTEM_REVOCATION_LIST -d SECURITY_LOCKDOWN_LSM -d DEBUG_INFO_BTF \
    -d DRM -d SOUND -d SND -d WLAN -d WIRELESS -d NET -d BLUETOOTH \
    -d USB_SUPPORT -d IOMMU_SUPPORT -d HYPERVISOR_GUEST -d XEN \
    -d TRANSPARENT_HUGEPAGE -e BLK_DEV_INITRD -e RD_GZIP \
    -e VIRTIO -e VIRTIO_PCI -e VIRTIO_BLK -e EXT2_FS \
    -e DEVTMPFS -e DEVTMPFS_MOUNT -e PROC_FS -e SYSFS -e TMPFS \
    -e VT -e VT_CONSOLE -e VGA_CONSOLE -e SERIAL_8250_CONSOLE \
    -e INPUT_EVDEV -e KEYBOARD_ATKBD -e SERIO_I8042 \
    -e FTRACE -e TRACEPOINTS -e FTRACE_SYSCALLS -e SCHED_TRACER \
    -e FUNCTION_TRACER -e IKCONFIG -e IKCONFIG_PROC \
    --set-str LOCALVERSION '-observatory' --set-str SYSTEM_TRUSTED_KEYS ''
  make -C "$SOURCE" O="$BUILD" olddefconfig
fi
make -C "$SOURCE" O="$BUILD" -j"${LAB_JOBS:-16}" bzImage vmlinux scripts_gdb > "$ROOT/artifacts/logs/kernel-build.log" 2>&1
cp "$BUILD/arch/x86/boot/bzImage" "$ROOT/artifacts/bzImage"
cp "$BUILD/.config" "$ROOT/labs/linux-x86_64/kernel.config"
