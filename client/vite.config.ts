import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';

// ルートまたはサーバーの .env からポート番号を取得
let backendPort = '3000';
const envCandidates = [
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '../server/.env'),
];
for (const envFile of envCandidates) {
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf-8');
    const match = content.match(/^PORT\s*=\s*(\d+)/m);
    if (match) {
      backendPort = match[1];
      break;
    }
  }
}
if (process.env.PORT) {
  backendPort = process.env.PORT;
}

const backendTarget = `http://localhost:${backendPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // 任意のトンネルドメインからのアクセスを許可
    allowedHosts: true,
    // 開発時に Vite(5173) への API / ActivityPub リクエストをバックエンドへ転送
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/.well-known': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/users': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/nodeinfo': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/inbox': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/actor': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/outbox': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/activities': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/uploads': {
        target: backendTarget,
        changeOrigin: true,
      },
    },
  },
});
