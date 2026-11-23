import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { mockApiPlugin } from './mock/plugin.ts';

// mock 模式（npm run dev:mock）：/api 由内置 mock 后端处理，不需要 Python 后端。
// 默认模式（npm run dev）：/api 代理到真实后端，地址可用环境变量 API_TARGET 覆盖。
export default defineConfig(({ mode }) => {
  const isMock = mode === 'mock';
  const target = process.env.API_TARGET ?? 'http://127.0.0.1:8000';
  return {
    plugins: [react(), tailwindcss(), ...(isMock ? [mockApiPlugin()] : [])],
    server: {
      port: 5173,
      proxy: isMock
        ? undefined
        : {
            '/api': {
              target,
              changeOrigin: true,
              // SSE 不能被代理缓冲
              configure: (proxy) => {
                proxy.on('proxyRes', (res) => {
                  if (String(res.headers['content-type'] ?? '').includes('text/event-stream')) {
                    res.headers['cache-control'] = 'no-cache';
                    res.headers['x-accel-buffering'] = 'no';
                  }
                });
              },
            },
          },
    },
  };
});
