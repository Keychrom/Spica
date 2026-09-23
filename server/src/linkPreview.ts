import { db } from './db.js';
import { assertFetchableRemoteUrl } from './remoteFetchGuard.js';

/**
 * リンクプレビュー（OGP / oEmbed）カード
 *
 * 投稿本文中の URL を取得して og:title / og:description / og:image を抽出し、
 * link_previews テーブルにキャッシュする。表示側はキャッシュを参照するだけなので
 * タイムラインの描画をブロックしない。
 *
 * 取得は SSRF ガード（assertFetchableRemoteUrl）を通し、サイズと時間を制限する。
 */

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024; // 512KB まで読む

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  image_url: string | null;
  site_name: string | null;
  status: string;
  fetched_at: string;
}

/** 本文から最初の http(s) URL を取り出す */
export function extractFirstUrl(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }
  const match = text.match(/https?:\/\/[^\s<>"']+/);
  if (!match) {
    return null;
  }
  // 末尾に付きがちな記号を落とす
  return match[0].replace(/[)\]}>.,、。!?！？]+$/, '');
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** <meta> タグと <title> から OGP 情報を抽出する */
export function parseOpenGraph(html: string, baseUrl: string): {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
} {
  const metas = new Map<string, string>();
  const metaRegex = /<meta\s+([^>]+?)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRegex.exec(html)) !== null) {
    const attrs: Record<string, string> = {};
    const attrRegex = /([a-zA-Z:]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(match[1])) !== null) {
      attrs[attrMatch[1].toLowerCase()] = attrMatch[3] ?? attrMatch[4] ?? '';
    }
    const key = (attrs['property'] || attrs['name'] || '').toLowerCase();
    if (key && attrs['content'] !== undefined && !metas.has(key)) {
      metas.set(key, decodeHtmlEntities(attrs['content']).trim());
    }
  }

  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = metas.get('og:title') || metas.get('twitter:title') || (titleTag ? decodeHtmlEntities(titleTag[1]).trim() : '') || null;
  const description = metas.get('og:description') || metas.get('twitter:description') || metas.get('description') || null;
  const rawImage = metas.get('og:image') || metas.get('og:image:url') || metas.get('twitter:image') || null;
  const siteName = metas.get('og:site_name') || null;

  let imageUrl: string | null = null;
  if (rawImage) {
    try {
      imageUrl = new URL(rawImage, baseUrl).toString();
    } catch {
      imageUrl = null;
    }
  }

  return { title, description, imageUrl, siteName };
}

/** キャッシュから取得（TTL 内のみ）。複数 URL をまとめて引くための一括取得にも使う */
export async function getCachedPreviews(urls: string[]): Promise<Map<string, LinkPreview>> {
  const result = new Map<string, LinkPreview>();
  if (urls.length === 0) {
    return result;
  }
  try {
    const placeholders = urls.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT * FROM link_previews WHERE url IN (${placeholders})`).all(...urls) as unknown as LinkPreview[];
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const row of rows) {
      if (row.status === 'ok' && Date.parse(row.fetched_at) > cutoff) {
        result.set(row.url, row);
      }
    }
  } catch {
    // 取得失敗時はプレビューなしで続行する
  }
  return result;
}

async function hasRecentFailure(url: string): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT fetched_at, status FROM link_previews WHERE url = ?').get(url) as
      | { fetched_at: string; status: string }
      | undefined;
    if (!row) {
      return false;
    }
    return Date.parse(row.fetched_at) > Date.now() - CACHE_TTL_MS && row.status !== 'ok';
  } catch {
    return false;
  }
}

async function savePreview(preview: LinkPreview): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO link_previews (url, title, description, image_url, site_name, status, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        image_url = excluded.image_url,
        site_name = excluded.site_name,
        status = excluded.status,
        fetched_at = excluded.fetched_at
    `).run(preview.url, preview.title, preview.description, preview.image_url, preview.site_name, preview.status, preview.fetched_at);
  } catch {
    // 保存失敗は無視（表示側はプレビューなしで動く）
  }
}

/** 上限付きで本文を読み出す */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    return (await res.text()).slice(0, MAX_BYTES);
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let received = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value?.length ?? 0;
    text += decoder.decode(value, { stream: true });
    if (received >= MAX_BYTES) {
      try { await reader.cancel(); } catch {}
      break;
    }
  }
  return text;
}

/**
 * URL のプレビューを取得してキャッシュする（取得済み・失敗キャッシュ済みなら何もしない）
 */
export async function fetchAndCacheLinkPreview(rawUrl: string): Promise<LinkPreview | null> {
  let url: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    url = parsed.toString();
  } catch {
    return null;
  }

  if (await hasRecentFailure(url)) {
    return null;
  }
  const cached = (await getCachedPreviews([url])).get(url);
  if (cached) {
    return cached;
  }

  // SSRF 対策: 内部アドレスや解決できないホストへは取得しない
  const safety = await assertFetchableRemoteUrl(url);
  if (!safety.safe) {
    await savePreview({ url, title: null, description: null, image_url: null, site_name: null, status: 'unsafe', fetched_at: new Date().toISOString() });
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': `Spica/1.0.0 (+LinkPreview)`,
      },
    });

    const contentType = String(res.headers.get('content-type') || '');
    const contentLength = parseInt(String(res.headers.get('content-length') || '0'), 10);
    if (!res.ok || (!contentType.includes('text/html') && !contentType.includes('xhtml')) || contentLength > MAX_BYTES) {
      await savePreview({ url, title: null, description: null, image_url: null, site_name: null, status: 'skipped', fetched_at: new Date().toISOString() });
      return null;
    }

    const html = await readCapped(res);
    const og = parseOpenGraph(html, url);
    const preview: LinkPreview = {
      url,
      title: og.title ? og.title.slice(0, 300) : null,
      description: og.description ? og.description.slice(0, 500) : null,
      image_url: og.imageUrl,
      site_name: og.siteName ? og.siteName.slice(0, 100) : null,
      status: og.title || og.description || og.imageUrl ? 'ok' : 'empty',
      fetched_at: new Date().toISOString(),
    };
    await savePreview(preview);
    if (preview.status === 'ok') {
      console.log(`[LinkPreview] 🔗 ${url} → ${preview.title || '(no title)'}`);
      return preview;
    }
    return null;
  } catch {
    await savePreview({ url, title: null, description: null, image_url: null, site_name: null, status: 'error', fetched_at: new Date().toISOString() });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 投稿本文中の URL のプレビューを非同期で取得する（投稿作成時に呼ぶ） */
export function queueLinkPreviewFetch(content: string | null | undefined): void {
  const url = extractFirstUrl(content);
  if (!url) {
    return;
  }
  fetchAndCacheLinkPreview(url).catch(() => {});
}

/** 本文に含まれる URL のキャッシュ済みプレビューを返す */
export async function attachPreviewForContent(content: string | null | undefined): Promise<LinkPreview | null> {
  const url = extractFirstUrl(content);
  if (!url) {
    return null;
  }
  return (await getCachedPreviews([url])).get(url) ?? null;
}
