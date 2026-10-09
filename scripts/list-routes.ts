/**
 * 登録されている API の経路を一覧する（クライアントが叩く経路との突き合わせ用）
 *   npx tsx scripts/list-routes.ts
 */
import { apiRouter } from '../server/src/routes/api.js';
import { adminRouter } from '../server/src/routes/admin.js';
import { misskeyRouter } from '../server/src/routes/misskey.js';

const mounts: [string, any][] = [
  ['', apiRouter],
  ['/admin', adminRouter],
  ['', misskeyRouter],
];

const out: string[] = [];
for (const [prefix, router] of mounts) {
  for (const layer of (router as any).stack ?? []) {
    if (layer.route) {
      const routePath = layer.route.path;
      const full = `/api${prefix}${routePath === '/' ? '' : routePath}`;
      for (const m of Object.keys(layer.route.methods ?? {})) {
        out.push(`${m.toUpperCase()} ${full}`);
      }
    }
  }
}
console.log(out.sort().join('\n'));
