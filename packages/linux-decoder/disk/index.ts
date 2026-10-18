/**
 * `packages/linux-decoder/disk/` 的对外出口：把盘面字节解析成 ext2 结构。
 *
 * 三层，按"离字节的距离"分：
 *
 * - `source.ts`：**盘面字节从哪来**。离线镜像、活体会话的逻辑扇区版本、合成镜像
 *   都实现同一个 `DiskByteSource`，所以"同一套 ext2 解析跑在三种来源上"是类型保证的。
 *   这里也是唯一定义 LBA（512 字节扇区）换算的地方。
 * - `ext2.ts`：**这张盘是什么**。超级块与块组描述符，含特性位判定
 *   （INCOMPAT 有不认识的位就不继续解，与内核一致）。
 * - `ext2-tree.ts`：**盘上某个文件的内容在哪**。inode、目录项、路径查找、
 *   文件偏移 → 块 → LBA。
 */

export * from './source.ts';
export * from './ext2.ts';
export * from './ext2-tree.ts';
