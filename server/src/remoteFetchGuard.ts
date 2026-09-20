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

  let resolved: { address: string; family: number }[];
  try {
    resolved = await dnsLookup(hostname, { all: true });
  } catch {
    return { safe: false, reason: `Remote hostname did not resolve: ${hostname}` };
  }
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
