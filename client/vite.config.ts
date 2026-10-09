import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 新しいフロントエンド（案K「雅＋」）の開発サーバー。
 *
 *   npm run dev:next        → http://localhost:5174
 *
 * API は既定で、いま動いている本番相当のインスタンス（localhost:3210）へ転送する。
 * 自分でサーバーを起動して確認したいときは、向き先を変えられる:
 *
 *   SPICA_API=http://localhost:3000 npm run dev:next
 *
 * 転送するのは「サーバーにしか無いもの」だけ。画面のパス（/users/…, /tags/…）は
 * SPA（この開発サーバー）が受けるので、ここには入れない
 * （入れるとサーバーの index.html が返って、画面が空になる）。
 */
const apiTarget = process.env.SPICA_API || 'http://localhost:3210';

const proxyPaths = [
  '/api',
  '/uploads',
  '/proxy',
  '/.well-known',
  '/nodeinfo',
  '/inbox',
  '/actor',
  '/outbox',
  '/activities',
];

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    allowedHosts: true,
    proxy: Object.fromEntries(
      proxyPaths.map((p) => [p, { target: apiTarget, changeOrigin: true }]),
    ),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
