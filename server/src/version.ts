import fs from 'node:fs';

/**
 * サーバーのバージョン。**`server/package.json` から読む**（唯一の出どころ）。
 *
 * ⚠️ ここ以外に版数を書かないこと。ハードコードすると、上げるたびに書き換え忘れて
 *    **NodeInfo（FediDB などのインスタンス一覧が見る）や開発時の応答だけが古いまま**になる。
 *    ビルド後も `dist/version.js` から見て `../package.json` = `server/package.json` を指す。
 */
export function readServerVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_VERSION = readServerVersion();
