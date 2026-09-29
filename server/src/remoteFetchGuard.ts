import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from './config.js';

/**
 * リモート取得先 URL の安全性検証（SSRF 対策）。
 *
 * 未認証の Inbox リクエストや WebFinger 解決など、外部入力から URL を組み立てて
 * 外向き fetch する箇所から呼び出す。本番（https 運用）ではプライベートアドレス・
 * 内部ホスト名への取得を拒否し、ホスト名がプライベートアドレスに解決される場合
 * （DNS リバインディング）も拒否する。
 */

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // リンクローカル
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // ベンチマーク用
  if (a >= 224) return true; // マルチキャスト・予約
  return false;
}

function isPrivateIPv6(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (value === '::' || value === '::1') return true;

  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    return isIP(mapped) === 4 ? isPrivateIPv4(mapped) : true;
  }

  const firstGroup = value.split(':')[0];
  const first = firstGroup ? parseInt(firstGroup, 16) : 0;
  if ((first & 0xffc0) === 0xfe80) return true; // リンクローカル fe80::/10
  if ((first & 0xfe00) === 0xfc00) return true; // ユニークローカル fc00::/7
  return false;
}

// 名前解決させたくないホスト名（内部向け・クラウドメタデータ等）
const NON_ROUTABLE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.home\.arpa$/i,
  /^metadata\.google\.internal$/i,
];

export async function assertFetchableRemoteUrl(rawUrl: string): Promise<{ safe: boolean; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: `Not a valid URL: ${rawUrl}` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Unsupported protocol for remote fetch: ${parsed.protocol}` };
  }

  // ローカル開発（http 運用）ではローカル宛の連合テストを許可する
  if (config.allowPrivateRemoteFetch) {
    return { safe: true };
  }

  if (parsed.protocol !== 'https:') {
    return { safe: false, reason: 'Remote fetch requires https in production' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (NON_ROUTABLE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))) {
    return { safe: false, reason: `Refusing to fetch non-routable hostname: ${hostname}` };
  }

  const literalFamily = isIP(hostname);
  if (literalFamily === 4) {
    return isPrivateIPv4(hostname)
      ? { safe: false, reason: `Refusing to fetch private address: ${hostname}` }
      : { safe: true };
  }
  if (literalFamily === 6) {
    return isPrivateIPv6(hostname)
      ? { safe: false, reason: `Refusing to fetch private address: ${hostname}` }
      : { safe: true };
  }

  const resolved = await resolveHost(hostname);
  if (resolved.length === 0) {
    return { safe: false, reason: `Remote hostname did not resolve: ${hostname}` };
  }

  for (const entry of resolved) {
    const isPrivate = entry.family === 6 ? isPrivateIPv6(entry.address) : isPrivateIPv4(entry.address);
    if (isPrivate) {
      return { safe: false, reason: `Hostname ${hostname} resolves to a private address (${entry.address})` };
    }
  }

  return { safe: true };
}

/**
 * 名前解決の結果を少しの間だけ覚える。
 *
 * 配送 1 件ごとに相手のホストを引き直すので、フォロワーが多い投稿では同じホストを
 * 何百回も引くことになる（1 投稿の fan-out が数百の DNS を作る）。TTL は短くして、
 * 公開アドレスだったホストが private に変わる余地を残さない範囲にする。
 *
 * **失敗は覚えない**（一時的な名前解決の失敗で配送が「再試行しない」扱いになるのを避ける）。
 */
const DNS_CACHE_TTL_MS = 60_000;
const DNS_CACHE_MAX = 2000;
/** リゾルバが固まっても、ここで打ち切って先へ進む */
const DNS_TIMEOUT_MS = 5_000;
const dnsCache = new Map<string, { at: number; entries: { address: string; family: number }[] }>();

async function resolveHost(hostname: string): Promise<{ address: string; family: number }[]> {
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.at < DNS_CACHE_TTL_MS) return cached.entries;

  let timer: NodeJS.Timeout | undefined;
  try {
    const entries = (await Promise.race([
      dnsLookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DNS lookup timed out: ${hostname}`)), DNS_TIMEOUT_MS);
        timer.unref?.();
      }),
    ])) as { address: string; family: number }[];
    if (dnsCache.size >= DNS_CACHE_MAX) {
      // 古いものから捨てる（Map は挿入順）
      const oldest = dnsCache.keys().next().value;
      if (oldest) dnsCache.delete(oldest);
    }
    dnsCache.set(hostname, { at: Date.now(), entries });
    return entries;
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** リダイレクトとして扱うステータス */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export interface SafeFetchOptions extends RequestInit {
  /** 打ち切るまでの時間（ミリ秒）。既定は `FEDERATION_TIMEOUT_MS` */
  timeoutMs?: number;
  /**
   * 追うリダイレクトの上限。既定は GET / HEAD なら 3、それ以外は 0
   * （署名した POST はリダイレクト先へ付け替えられないため）
   */
  maxRedirects?: number;
}

/**
 * SSRF ガードとタイムアウト付きの fetch（連合の外向き取得は必ずこれを通す）。
 *
 * - 取得の前に**毎回** `assertFetchableRemoteUrl` を通す。`redirect: 'follow'` にすると
 *   最初の URL しか検証されず、`Location: http://169.254.169.254/` のような 3xx で
 *   ガードを回避できる。ここでは `redirect: 'manual'` にして**1 ホップずつ検証**する
 * - `AbortSignal.timeout` で必ず打ち切る。相手が黒穴（接続はするが応答しない）だと、
 *   タイムアウトが無い限りソケットとリクエストを掴んだまま戻らない
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<Response> {
  const { timeoutMs = config.federationTimeoutMs, maxRedirects, ...init } = options;
  const method = String(init.method || 'GET').toUpperCase();
  const redirectsAllowed = maxRedirects ?? (method === 'GET' || method === 'HEAD' ? 3 : 0);

  let current = rawUrl;
  for (let hop = 0; ; hop++) {
    const safety = await assertFetchableRemoteUrl(current);
    if (!safety.safe) {
      throw new Error(`安全でない取得先のため拒否しました: ${safety.reason || current}`);
    }

    const response = await fetch(current, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    const location = response.headers.get('location');
    if (!REDIRECT_STATUS.has(response.status) || !location) return response;
    if (hop >= redirectsAllowed) {
      // 追わない場合はそのまま返す（POST の 3xx は呼び出し側が「配送失敗」として扱う。
      // 署名は URL を含むので、こちらで勝手に付け替えて投げ直すことはできない）
      if (redirectsAllowed === 0) return response;
      await response.body?.cancel().catch(() => {});
      throw new Error(`リダイレクトが多すぎます: ${rawUrl}`);
    }
    await response.body?.cancel().catch(() => {});
    current = new URL(location, current).toString();
  }
}
