/**
 * 会话进程与覆盖层管理（T03a）。
 *
 * 要求：每会话独立目录和覆盖层；启动 QEMU 与 GDB，连接 Unix socket；
 * 保留 argv 与日志；退出时清理子进程。
 *
 * 使用 T01 锁定的 QEMU（artifacts/build/qemu/qemu-system-x86_64），
 * 不用宿主 /usr/libexec/qemu-kvm，保证版本与能力探测一致。
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function defaultQemuPath(root) {
  return process.env.LAB_QEMU ?? path.join(root, 'artifacts/build/qemu/qemu-system-x86_64');
}

export class LabProcess {
  constructor({ root, sessionDir, profile, qemuPath, extraArgs = [], diskFault = null }) {
    this.root = root;
    this.dir = sessionDir;
    this.profile = profile;
    this.qemuPath = qemuPath ?? defaultQemuPath(root);
    this.extraArgs = extraArgs;
    /**
     * 可选的一次性写故障（只给需要「真实未完成请求」场景的验收用）。
     *
     * 为什么需要它：任何一次 `capture` 都建立在 VM 停止之上，而停止动作本身
     * 会 drain 块层并把在途请求做完，因此屏障处几乎读不到 `host-io-pending`
     * 的块请求。唯一能在屏障处留下「已提交、还没对客体可见」的请求的真实路径
     * 是宿主 I/O 出错 + `werror=stop`：请求被挂到设备队列 `s->rq` 上，本次不完成，
     * 而客体缓冲区在请求完成前一直有效——那一刻的字节才是这一笔写的载荷。
     *
     * 形状：`{ sector, errno = 5, iotype = 'write', once = true }`，`sector` 是
     * 512 字节单位的目标扇区；规则一次性，命中后自毁，重提交即成功。
     */
    this.diskFault = diskFault;
    this.paths = {
      qmp: path.join(this.dir, 'qmp.sock'),
      gdb: path.join(this.dir, 'gdb.sock'),
      serial: path.join(this.dir, 'serial.sock'),
      qemuLog: path.join(this.dir, 'qemu.log'),
      launch: path.join(this.dir, 'launch.json'),
      disk: path.join(this.dir, 'rootfs.qcow2'),
      blkdebug: path.join(this.dir, 'blkdebug.conf'),
      trace: path.join(this.dir, 'qemu-trace.log'),
    };
    this.launch = null;
    this.exitInfo = null;
  }

  /**
   * 写 blkdebug 规则文件。`event = "none"` 的规则在节点打开时就被激活（
   * `blkdebug_open()` 末尾会发一次 BLKDBG_NONE），再配合 `sector` 作用域，
   * 故障只在命中该扇区那一次写时生效——开机过程中的低地址写不会被误伤。
   */
  writeDiskFault() {
    if (this.diskFault === null) return null;
    const { sector, errno = 5, iotype = 'write', once = true } = this.diskFault;
    const text = [
      '# 由 lab-server 写入（diskFault）：一次性注入一个写错误。',
      '# event = "none" 让规则在节点打开时进入 active_rules；sector 限定命中范围。',
      '[inject-error]',
      'event = "none"',
      `iotype = "${iotype}"`,
      `errno = "${errno}"`,
      `once = "${once ? 'on' : 'off'}"`,
      `sector = "${sector}"`,
      '',
    ].join('\n');
    fs.writeFileSync(this.paths.blkdebug, text);
    return { path: this.paths.blkdebug, sector, errno, iotype, once, text };
  }


  /** 建立基于原始根盘的 qcow2 覆盖层，避免多会话互相写坏基线。 */
  createOverlay() {
    const base = path.join(this.root, 'artifacts/rootfs.img');
    if (!fs.existsSync(base)) throw new Error('缺少 artifacts/rootfs.img，请先运行 scripts/build-rootfs.sh');
    fs.rmSync(this.paths.disk, { force: true });
    execFileSync(
      'qemu-img',
      ['create', '-f', 'qcow2', '-F', 'raw', '-b', base, this.paths.disk],
      { stdio: 'ignore' },
    );
    return this.paths.disk;
  }

  buildArgs() {
    const root = this.root;
    /*
     * 有 diskFault 时把 blkdebug 放在 qcow2 **之上**（链路：virtio-blk → blkdebug
     * → qcow2 → 覆盖层文件），并给这块盘配上 werror=stop。
     *
     * 位置为什么关键：blkdebug 的 `sector` 用的是**它自己看到的偏移**。它若挂在
     * qcow2 下面（`file=blkdebug:conf:image,format=qcow2` 那种写法），看到的是
     * 宿主覆盖层文件的偏移——稀疏文件里那只有几十 KB 到几 MB，客体写的 64 MiB
     * 位置永远对不上，故障静默不触发。放在 qcow2 上面，偏移域就是设备偏移
     * （客体 LBA × 512），「按客体扇区注入故障」这句话才成立。
     *
     * werror=stop 的作用：宿主写错误不再回一个错误状态了事，而是把请求挂在
     * 设备队列 s->rq 里、让 VM 停下——这才留下「已提交、还没对客体可见」的
     * 可观测请求。
     */
    const fault = this.diskFault === null ? null : this.writeDiskFault();
    const diskArg = fault === null
      ? `file=${this.paths.disk},format=qcow2,if=none,id=rootdisk`
      : 'file.driver=blkdebug'
        + `,file.config=${this.paths.blkdebug}`
        + ',file.image.driver=qcow2'
        + ',file.image.file.driver=file'
        + `,file.image.file.filename=${this.paths.disk}`
        + ',if=none,id=rootdisk,werror=stop';
    const args = [
      '-machine', 'pc',
      '-cpu', 'qemu64',
      '-accel', 'tcg,thread=single',
      '-smp', '1',
      '-m', '512',
      '-display', 'none',
      '-nodefaults',
      '-device', 'VGA',
      '-device', 'isa-serial,chardev=serial0',
      '-chardev', `socket,id=serial0,path=${this.paths.serial},server=on,wait=off`,
      '-qmp', `unix:${this.paths.qmp},server=on,wait=off`,
      '-chardev', `socket,id=gdb0,path=${this.paths.gdb},server=on,wait=off`,
      '-gdb', 'chardev:gdb0',
      '-drive', diskArg,
      '-device', 'virtio-blk-pci,drive=rootdisk,id=rootblk',
      '-S',
      '-no-reboot',
    ];

    if (this.profile === 'full-boot') {
      args.push(
        '-drive', `file=${path.join(root, 'artifacts/boot.iso')},format=raw,media=cdrom,if=ide,readonly=on`,
        '-boot', 'order=d',
      );
    } else {
      args.push(
        '-kernel', path.join(root, 'artifacts/bzImage'),
        '-initrd', path.join(root, 'artifacts/initramfs.cpio.gz'),
        '-append', 'nokaslr norandmaps pti=off console=tty0 console=ttyS0,115200 rdinit=/init loglevel=5',
      );
    }

    // trace 默认关闭：默认开启会显著影响性能，且当前 trace 不覆盖 virtio 块请求
    if (process.env.LAB_TRACE === '1') {
      args.push('-trace', `enable=dma_*,file=${this.paths.trace}`);
    }
    args.push(...this.extraArgs);
    return args;
  }

  /** 启动 QEMU 并等待两个 Unix socket 就绪。 */
  async start({ readyTimeoutMs = 15000 } = {}) {
    if (!fs.existsSync(this.qemuPath)) {
      throw new Error(`未找到锁定的 QEMU: ${this.qemuPath}`);
    }
    fs.mkdirSync(this.dir, { recursive: true });
    this.createOverlay();

    const args = this.buildArgs();
    this.launch = {
      binary: this.qemuPath,
      args,
      profile: this.profile,
      diskFault: this.diskFault === null ? null : { ...this.diskFault, path: this.paths.blkdebug },
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.paths.launch, `${JSON.stringify(this.launch, null, 2)}\n`);

    const log = fs.openSync(this.paths.qemuLog, 'a');
    this.proc = spawn(this.qemuPath, args, { cwd: this.root, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    this.proc.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
    });

    await this.waitForSocket(this.paths.qmp, readyTimeoutMs);
    await this.waitForSocket(this.paths.gdb, readyTimeoutMs);
    return this.launch;
  }

  async waitForSocket(socketPath, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(socketPath)) return;
      if (this.exitInfo) {
        throw new Error(`QEMU 提前退出 (${this.exitInfo.signal ?? this.exitInfo.code})：${this.readLogTail()}`);
      }
      await sleep(50);
    }
    throw new Error(`等待 socket 超时: ${socketPath}；${this.readLogTail()}`);
  }

  readLogTail(maxBytes = 2000) {
    try {
      const content = fs.readFileSync(this.paths.qemuLog, 'utf8');
      return content.slice(-maxBytes);
    } catch {
      return '（没有 QEMU 日志）';
    }
  }

  get alive() {
    return this.proc !== null && !this.proc.killed && this.exitInfo === null;
  }

  /** 清理子进程；调用方负责先关 GDB 与 QMP 连接。 */
  async stop({ graceMs = 3000 } = {}) {
    if (!this.proc || this.proc.killed) return;
    if (this.exitInfo) return;
    this.proc.kill('SIGTERM');
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && !this.exitInfo) await sleep(50);
    if (!this.exitInfo) this.proc.kill('SIGKILL');
  }
}
