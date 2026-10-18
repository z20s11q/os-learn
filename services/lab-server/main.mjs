/**
 * 新实验平台服务入口。
 *
 * 提供 /api/* 的真实 Linux 调试接口与 /lab 静态入口。
 * 会话执行、采集和视图由 src/sessions 下的模块管理。
 */

import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { SessionRegistry, registerApi } from './src/controllers/api.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

export async function buildServer({ logger = true } = {}) {
  const app = Fastify({ logger, bodyLimit: 2 * 1024 * 1024 });
  const registry = new SessionRegistry({ root: ROOT });

  await registerApi(app, registry);

  // 已构建则提供 dist（vite 产物）；否则回退到源码目录，便于开发时直接调试
  const appRoot = path.join(ROOT, 'apps/debugger-web');
  const webRoot = fs.existsSync(path.join(appRoot, 'dist')) ? path.join(appRoot, 'dist') : appRoot;
  await app.register(staticFiles, { root: webRoot, prefix: '/lab/', wildcard: false });
  app.get('/lab', async (request, reply) => reply.redirect('/lab/'));

  // 启动动画与讲义：直接由同一服务提供，避免用户去文件系统里找 MP4。
  const mediaRoot = path.join(ROOT, 'docs/video');
  if (fs.existsSync(mediaRoot)) {
    await app.register(staticFiles, { root: mediaRoot, prefix: '/media/', wildcard: false, decorateReply: false });
  }
  const animationRoot = path.join(ROOT, 'docs/animation');
  if (fs.existsSync(animationRoot)) {
    await app.register(staticFiles, { root: animationRoot, prefix: '/animation/', wildcard: false, decorateReply: false });
  }

  app.addHook('onClose', async () => {
    await registry.closeAll();
  });

  return { app, registry };
}

async function main() {
  const port = Number(process.env.LAB_PORT ?? 13029);
  const host = process.env.LAB_HOST ?? '0.0.0.0';
  const { app } = await buildServer();
  await app.listen({ port, host });
  app.log.info(`linux-observatory 调试服务监听 http://${host}:${port}`);

  // 优雅停止：关闭 Fastify -> onClose -> registry.closeAll() -> 每个会话关闭
  // QEMU/GDB 与 socket。信号处理器负责在服务退出前清理虚拟机子进程。
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`收到 ${signal}，正在关闭会话与子进程…`);
    const timer = setTimeout(() => {
      app.log.error('关闭超时，强制退出');
      process.exit(1);
    }, 15000);
    timer.unref?.();
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      console.error('关闭失败:', error);
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
