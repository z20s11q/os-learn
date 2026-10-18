import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * 前端构建/开发配置（T04）。
 *
 * base 必须是 /lab/：生产由 lab-server 以 `apps/debugger-web/dist` 为根、
 * 前缀 /lab/ 提供静态资源，资源 URL 若按 /  生成会 404。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/lab/',
  plugins: [react()],
  build: {
    // 相对 root 解析，产物落在 apps/debugger-web/dist
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // React/xterm 单独分块，浏览器可复用稳定的 vendor 缓存。
        manualChunks: {
          react: ['react', 'react-dom'],
          xterm: ['@xterm/xterm', '@xterm/addon-fit'],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4181,
    proxy: {
      // 开发时把 /api 与 WS 代理到本地调试服务（默认端口与 lab-server 一致）
      '/api': { target: 'http://127.0.0.1:13029', ws: true },
    },
  },
});
