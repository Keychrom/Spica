import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { adb, getServerSetting, setServerSetting } from './db.js';
import { config } from './config.js';
import { getInstanceActorKeyPair } from './instanceActor.js';
import { assertFetchableRemoteUrl } from './remoteFetchGuard.js';

/**
 * 画像プロキシ（リモート画像の直リンク解消）
 *
 * リモートのアイコン・添付画像をそのまま <img src> で読むと、
 *   ・閲覧者の IP と User-Agent が相手サーバーに渡る（プライバシー漏洩）
 *   ・相手サーバーの停止や削除で表示が壊れる
 *   ・TLS 混在やホットリンク制限で読めないことがある
 * といった問題があります。そこで画像をこのノード経由で取得し、ディスクに
 * キャッシュして配信します（Mastodon の /proxy と同じ考え方）。
 *
 * 設計:
 *   ・署名付き URL のみ受け付ける（`/proxy?url=...&s=...`）。署名が無いと
 *     誰でも任意 URL を取得させる踏み台にできてしまうため。
 *   ・署名鍵はインスタンス鍵から導出（外部に漏れない）。
 *   ・取得は SSRF ガード + タイムアウト + サイズ上限 + Content-Type 検査。
 *   ・キャッシュは data/proxy-cache に置き、件数・容量・TTL で整理する。
 *
 * 設定（管理画面 or 環境変数）:
 *   IMAGE_PROXY=true|false        … 有効/無効（既定 true）
 *   IMAGE_PROXY_MAX_MB=512        … キャッシュ上限（MB）
 *   IMAGE_PROXY_TTL_DAYS=30       … キャッシュ保持日数
 */

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB まで
const DEFAULT_MAX_MB = 512;
const DEFAULT_TTL_DAYS = 30;
const MAX_CONCURRENT_FETCHES = 4;

/** キャッシュする Content-Type（画像のみ。動画・音声は容量が大きいので対象外） */
const ALLOWED_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/svg+xml',
  // 一部のサーバーは octet-stream で返すため、拡張子でも判定できるようにする
  'application/octet-stream',
];

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i;

export interface ProxyStats {
  enabled: boolean;
  files: number;
  bytes: number;
  maxBytes: number;
  ttlDays: number;
  cacheDir: string;
}

// ── 設定 ────────────────────────────────────────────────────────────────

export function isImageProxyEnabled(): boolean {
  const stored = getServerSetting('image_proxy');
  if (stored !== undefined) return stored !== 'false';
  return config.imageProxy !== false;
}

export async function setImageProxyEnabled(enabled: boolean): Promise<void> {
  await setServerSetting('image_proxy', enabled ? 'true' : 'false');
}

export function getProxyMaxBytes(): number {
  const stored = Number(getServerSetting('image_proxy_max_mb'));
  const mb = Number.isFinite(stored) && stored > 0 ? stored : config.imageProxyMaxMb || DEFAULT_MAX_MB;
  return Math.max(16, mb) * 1024 * 1024;
}

export function getProxyTtlDays(): number {
  const stored = Number(getServerSetting('image_proxy_ttl_days'));
  return Number.isFinite(stored) && stored > 0 ? stored : config.imageProxyTtlDays || DEFAULT_TTL_DAYS;
}

// ── 署名 ────────────────────────────────────────────────────────────────

let cachedSecret: string | null = null;

/** 署名鍵。インスタンス鍵（DB 内・外部非公開）から導出する */
function getProxySecret(): string {
  if (cachedSecret) return cachedSecret;
  try {
    const { privateKeyPem } = getInstanceActorKeyPair();
    cachedSecret = crypto.createHash('sha256').update(`image-proxy:${privateKeyPem}`).digest('hex');
  } catch {
    cachedSecret = crypto.createHash('sha256').update(`image-proxy:${config.origin}`).digest('hex');
  }
  return cachedSecret;
}

/** URL の署名（短い base64url） */
export function signProxyUrl(url: string): string {
  return crypto.createHmac('sha256', getProxySecret()).update(url).digest('base64url').slice(0, 22);
}

export function verifyProxySignature(url: string, signature: string): boolean {
  if (!signature || typeof signature !== 'string') return false;
  const expected = signProxyUrl(url);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 自分のノードが配信している URL か（プロキシ不要） */
function isOwnUrl(url: string): boolean {
  if (url.startsWith(config.origin)) return true;
  if (url.startsWith('/')) return true; // 相対 URL は同一オリジン
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  return false;
}

/**
 * リモートの画像 URL を署名付きプロキシ URL に変換する。
 * 対象外（自分のメディア・data URL・対応外拡張子・無効時）はそのまま返す。
 */
export function proxyImageUrl(url: unknown): unknown {
  if (typeof url !== 'string' || !url) return url;
  if (!isImageProxyEnabled()) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  if (isOwnUrl(url)) return url;
  if (!IMAGE_EXT_RE.test(url)) return url;
  return `/proxy?url=${encodeURIComponent(url)}&s=${signProxyUrl(url)}`;
}

const MEDIA_HTML_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi;

/** 本文 HTML 内の <img src="http..."> をプロキシ経由にする */
export function proxyHtmlImages(html: string): string {
  if (!isImageProxyEnabled()) return html;
  if (!html.includes('http') || !html.includes('<img')) return html;
  return html.replace(MEDIA_HTML_RE, (_m, prefix: string, quote: string, url: string) => {
    const proxied = proxyImageUrl(url);
    return `${prefix}${quote}${proxied}${quote}`;
  });
}

/**
 * JSON レスポンス全体を走査し、リモート画像 URL をプロキシ経由に置き換える。
 * タイムラインのアイコン・添付・引用・絵文字・本文 HTML をまとめて処理する。
 */
export function rewriteRemoteMediaUrls<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (!isImageProxyEnabled()) return value;

  if (typeof value === 'string') {
    if (value.length < 12) return value;
    if (value.includes('<img')) return proxyHtmlImages(value) as unknown as T;
    return proxyImageUrl(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteRemoteMediaUrls(item, depth + 1)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = rewriteRemoteMediaUrls(item, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/** JSON 応答（GET /api/*、管理 API を除く）にプロキシ変換を挟むミドルウェア */
export function mediaProxyMiddleware() {
  return (req: any, res: any, next: any) => {
    if (req.method !== 'GET' || !isImageProxyEnabled()) return next();
    if (typeof req.path !== 'string' || !req.path.startsWith('/api/')) return next();
    if (req.path.startsWith('/api/admin')) return next();

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => originalJson(rewriteRemoteMediaUrls(body));
    next();
  };
}

// ── キャッシュ ──────────────────────────────────────────────────────────

export function getProxyCacheDir(): string {
  // アップロードやバックアップと同じ data ディレクトリ配下に置く
  // （DB が data/ の中にある構成ならその隣、外にある構成なら data/ を作る）
  const dbDir = path.dirname(path.resolve(config.dbPath));
  const dataDir = path.basename(dbDir) === 'data' ? dbDir : path.resolve(dbDir, 'data');
  return path.resolve(dataDir, 'proxy-cache');
}

function ensureCacheDir(): string {
  const dir = getProxyCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function urlHash(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex');
}

interface CacheRow {
  url_hash: string;
  url: string;
  content_type: string;
  size: number;
  fetched_at: string;
  last_used_at: string;
}

/** キャッシュ済みエントリ（TTL 内のもの）を返す */
async function readCache(url: string): Promise<{ file: string; contentType: string; size: number; fetchedAt: string } | null> {
  try {
    const hash = urlHash(url);
    const row = await adb.prepare('SELECT * FROM proxy_cache WHERE url_hash = ?').get(hash) as unknown as CacheRow | undefined;
    if (!row) return null;

    const ageMs = Date.now() - new Date(row.fetched_at).getTime();
    const ttlMs = getProxyTtlDays() * 24 * 60 * 60 * 1000;
    const file = path.join(getProxyCacheDir(), hash);

    if (!fs.existsSync(file)) {
      await adb.prepare('DELETE FROM proxy_cache WHERE url_hash = ?').run(hash);
      return null;
    }
    if (ageMs > ttlMs) {
      await adb.prepare('DELETE FROM proxy_cache WHERE url_hash = ?').run(hash);
      try { fs.unlinkSync(file); } catch {}
      return null;
    }

    await adb.prepare('UPDATE proxy_cache SET last_used_at = ? WHERE url_hash = ?').run(new Date().toISOString(), hash);
    return { file, contentType: row.content_type, size: row.size, fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

/** 取得中の URL を共有して、同時アクセスで二重取得しないようにする */
const inFlight = new Map<string, Promise<{ body: Buffer; contentType: string }>>();
let activeFetches = 0;

export interface ProxyFetchResult {
  body: Buffer;
  contentType: string;
  fromCache: boolean;
}

/** 画像を取得（キャッシュがあればそれを使う） */
export async function fetchProxiedImage(url: string): Promise<ProxyFetchResult> {
  const cached = await readCache(url);
  if (cached) {
    return { body: fs.readFileSync(cached.file), contentType: cached.contentType, fromCache: true };
  }

  const running = inFlight.get(url);
  if (running) {
    const result = await running;
    return { ...result, fromCache: true };
  }

  if (activeFetches >= MAX_CONCURRENT_FETCHES) {
    throw new Error('混雑しています。少し待ってから再試行してください。');
  }

  const task = (async () => {
    activeFetches++;
    try {
      const safety = await assertFetchableRemoteUrl(url);
      if (!safety.safe) {
        throw new Error(`取得できない URL です（${safety.reason || '安全でないアドレス'}）`);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            // 相手サーバーに余計な情報を渡さない
            'User-Agent': `Spica/${config.instanceName} (+${config.origin})`,
            Accept: 'image/*,*/*;q=0.8',
          },
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        throw new Error(`取得に失敗しました（HTTP ${res.status}）`);
      }

      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const contentLength = Number(res.headers.get('content-length') || '0');
      if (contentLength > MAX_BYTES) {
        throw new Error('画像が大きすぎます。');
      }
      // octet-stream の場合は拡張子で画像と判断する
      const looksLikeImage = contentType.startsWith('image/')
        || (contentType === 'application/octet-stream' && IMAGE_EXT_RE.test(url));
      if (!looksLikeImage || !ALLOWED_CONTENT_TYPES.includes(contentType)) {
        throw new Error(`画像ではないコンテンツです（${contentType || '不明'}）`);
      }

      const chunks: Buffer[] = [];
      let received = 0;
      const reader = res.body?.getReader();
      if (!reader) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BYTES) throw new Error('画像が大きすぎます。');
        chunks.push(buf);
        received = buf.length;
      } else {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value?.length ?? 0;
          if (received > MAX_BYTES) {
            try { await reader.cancel(); } catch {}
            throw new Error('画像が大きすぎます。');
          }
          if (value) chunks.push(Buffer.from(value));
        }
      }

      const body = Buffer.concat(chunks);
      if (body.length === 0) throw new Error('空のレスポンスでした。');

      await writeCache(url, contentType, body);
      return { body, contentType };
    } finally {
      activeFetches--;
    }
  })();

  inFlight.set(url, task as Promise<{ body: Buffer; contentType: string }>);
  try {
    const result = await task;
    return { ...result, fromCache: false };
  } finally {
    inFlight.delete(url);
  }
}

/** キャッシュへ書き込む（容量を超えたら古いものから消す） */
async function writeCache(url: string, contentType: string, body: Buffer): Promise<void> {
  const dir = ensureCacheDir();
  const hash = urlHash(url);
  const file = path.join(dir, hash);
  const now = new Date().toISOString();

  try {
    fs.writeFileSync(file, body);
    await adb.prepare(`
      INSERT INTO proxy_cache (url_hash, url, content_type, size, fetched_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(url_hash) DO UPDATE SET
        content_type = excluded.content_type,
        size = excluded.size,
        fetched_at = excluded.fetched_at,
        last_used_at = excluded.last_used_at
    `).run(hash, url, contentType, body.length, now, now);
  } catch (err) {
    console.warn('[ImageProxy] キャッシュ保存に失敗:', err);
    return;
  }

  await enforceCacheLimit();
}

/** キャッシュ容量を超えていたら、最終使用が古いものから削除する */
export async function enforceCacheLimit(): Promise<{ removed: number; freedBytes: number }> {
  const maxBytes = getProxyMaxBytes();
  let removed = 0;
  let freedBytes = 0;
  try {
    let total = Number((await adb.prepare('SELECT COALESCE(SUM(size), 0) AS t FROM proxy_cache').get() as any).t);
    if (total <= maxBytes) return { removed, freedBytes };

    const rows = await adb.prepare('SELECT url_hash, size FROM proxy_cache ORDER BY last_used_at ASC').all() as unknown as { url_hash: string; size: number }[];
    const dir = getProxyCacheDir();
    for (const row of rows) {
      if (total <= maxBytes * 0.9) break; // 少し余裕を残して止める
      await adb.prepare('DELETE FROM proxy_cache WHERE url_hash = ?').run(row.url_hash);
      try { fs.unlinkSync(path.join(dir, row.url_hash)); } catch {}
      total -= row.size;
      freedBytes += row.size;
      removed++;
    }
  } catch (err) {
    console.warn('[ImageProxy] キャッシュ整理に失敗:', err);
  }
  return { removed, freedBytes };
}

/** TTL を過ぎたキャッシュを削除する */
export async function pruneProxyCache(): Promise<{ removed: number; freedBytes: number }> {
  let removed = 0;
  let freedBytes = 0;
  try {
    const ttlMs = getProxyTtlDays() * 24 * 60 * 60 * 1000;
    const threshold = new Date(Date.now() - ttlMs).toISOString();
    const rows = await adb.prepare('SELECT url_hash, size FROM proxy_cache WHERE last_used_at < ?').all(threshold) as unknown as { url_hash: string; size: number }[];
    const dir = getProxyCacheDir();
    for (const row of rows) {
      await adb.prepare('DELETE FROM proxy_cache WHERE url_hash = ?').run(row.url_hash);
      try { fs.unlinkSync(path.join(dir, row.url_hash)); } catch {}
      freedBytes += row.size;
      removed++;
    }
    const limit = await enforceCacheLimit();
    removed += limit.removed;
    freedBytes += limit.freedBytes;
  } catch (err) {
    console.warn('[ImageProxy] 期限切れの削除に失敗:', err);
  }
  return { removed, freedBytes };
}

/** キャッシュをすべて削除する */
export async function clearProxyCache(): Promise<{ removed: number; freedBytes: number }> {
  let removed = 0;
  let freedBytes = 0;
  try {
    const rows = await adb.prepare('SELECT url_hash, size FROM proxy_cache').all() as unknown as { url_hash: string; size: number }[];
    const dir = getProxyCacheDir();
    for (const row of rows) {
      freedBytes += row.size;
      removed++;
      try { fs.unlinkSync(path.join(dir, row.url_hash)); } catch {}
    }
    await adb.prepare('DELETE FROM proxy_cache').run();
  } catch (err) {
    console.warn('[ImageProxy] キャッシュ削除に失敗:', err);
  }
  return { removed, freedBytes };
}

/**
 * 任意の接続（CLI・メンテナンスツール）でキャッシュを整理する。
 * サーバー本体のシングルトンと別の DB を開いている場合でも安全に使える。
 */
export function pruneProxyCacheOn(
  conn: import('node:sqlite').DatabaseSync,
  dbPath: string,
  ttlDays: number,
  maxBytes: number,
  apply: boolean,
): { removed: number; freedBytes: number; scanned: number; totalBytes: number } {
  const absDb = path.resolve(dbPath);
  const dbDir = path.dirname(absDb);
  const dataDir = path.basename(dbDir) === 'data' ? dbDir : path.resolve(dbDir, 'data');
  const dir = path.resolve(dataDir, 'proxy-cache');
  let removed = 0;
  let freedBytes = 0;
  let scanned = 0;
  let totalBytes = 0;

  try {
    const rows = conn.prepare('SELECT url_hash, size, last_used_at FROM proxy_cache').all() as unknown as {
      url_hash: string; size: number; last_used_at: string;
    }[];
    scanned = rows.length;
    totalBytes = rows.reduce((sum, r) => sum + (r.size || 0), 0);

    const threshold = Date.now() - Math.max(1, ttlDays) * 24 * 60 * 60 * 1000;
    const expired = rows.filter((r) => new Date(r.last_used_at).getTime() < threshold);

    // 期限内でも容量を超えていれば、最終使用が古い順に削除する
    const survivors = rows
      .filter((r) => !expired.includes(r))
      .sort((a, b) => new Date(a.last_used_at).getTime() - new Date(b.last_used_at).getTime());
    let remainingBytes = survivors.reduce((sum, r) => sum + (r.size || 0), 0);
    const overLimit: typeof rows = [];
    for (const row of survivors) {
      if (remainingBytes <= maxBytes * 0.9) break;
      overLimit.push(row);
      remainingBytes -= row.size || 0;
    }

    for (const row of [...expired, ...overLimit]) {
      removed++;
      freedBytes += row.size || 0;
      if (apply) {
        conn.prepare('DELETE FROM proxy_cache WHERE url_hash = ?').run(row.url_hash);
        try { fs.unlinkSync(path.join(dir, row.url_hash)); } catch {}
      }
    }
  } catch {
    // proxy_cache テーブルが無い（未マイグレーション）など
  }

  return { removed, freedBytes, scanned, totalBytes };
}

/** 管理画面用の統計 */
export async function getProxyStats(): Promise<ProxyStats> {
  let files = 0;
  let bytes = 0;
  try {
    const row = await adb.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS t FROM proxy_cache').get() as any;
    files = Number(row?.c || 0);
    bytes = Number(row?.t || 0);
  } catch {
    // テーブル未作成など
  }
  return {
    enabled: isImageProxyEnabled(),
    files,
    bytes,
    maxBytes: getProxyMaxBytes(),
    ttlDays: getProxyTtlDays(),
    cacheDir: getProxyCacheDir(),
  };
}
