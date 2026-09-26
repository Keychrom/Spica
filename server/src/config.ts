import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

// ワークスペースルートまたはサーバーディレクトリの .env を探索して読み込む
const envPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
  path.resolve(process.cwd(), 'server', '.env'),
];
for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

export interface StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl: string;
  region: string;
}

export type InboxSignatureMode = 'strict' | 'log';
export type InboxForwardedPolicy = 'relay' | 'any';

export interface AppConfig {
  port: number;
  bindHost: string;
  domain: string;
  protocol: string;
  origin: string;
  dbPath: string;
  instanceName: string;
  instanceDescription: string;
  storage: StorageConfig;
  /** Inbox の HTTP Signature 検証モード。strict は検証失敗を 401 で拒否する */
  inboxSignatureMode: InboxSignatureMode;
  /** 署名の Date ヘッダー許容幅（秒）。リプレイ防止用 */
  signatureMaxAgeSeconds: number;
  /**
   * 署名鍵の持ち主と Activity の actor が異なる「代理転送」の許可方針。
   * relay: 管理画面で accepted 済みのリレーからの転送のみ許可（既定）
   * any:   誰からの転送でも許可（互換性最大・なりすまし可能になるため非推奨）
   */
  inboxForwardedPolicy: InboxForwardedPolicy;
  /** プライベートアドレスへの remote actor 取得を許可するか（開発時のみ true 推奨） */
  allowPrivateRemoteFetch: boolean;
  /**
   * Authorized Fetch（署名必須モード）。
   * 有効にすると ActivityPub の取得（Actor 文書・コレクション・ノート）に有効な
   * HTTP Signature を必須にし、こちらからの取得にも署名を付ける。
   */
  authorizedFetch: boolean;
  /** レート制限を無効化する（既定 false。テストや特殊な運用時のみ true） */
  rateLimitDisabled: boolean;
  /**
   * Redis の接続先（例: redis://127.0.0.1:6379）。
   * **未設定なら Redis を一切使わない**（今までどおりインメモリ実装＝単一プロセス前提）。
   * 設定すると、レート制限・リアルタイム更新・設定の反映・定期処理の単一実行が Redis 経由になり、
   * 複数プロセスで動かせるようになる（docs/REDIS.md）。
   */
  redisUrl: string;
  /** Redis のキー・チャンネルの接頭辞。同じ Redis を複数のノードで共有するときに分ける */
  redisPrefix: string;
  /** 配送再送ワーカーの同時実行数（既定 5。相手サーバーごとに違うので並べると速い） */
  deliveryConcurrency: number;
  /** タイムラインの読み取りキャッシュの TTL（秒。**既定 0 = 無効**。有効にすると可視性の変化が TTL ぶん遅れる） */
  timelineCacheTtlSec: number;
  /** タグタイムラインが走査する直近の投稿数（既定 20000。0 で無制限） */
  recentScanPosts: number;
  /** メディアの公開 URL（CDN。未設定なら自ホストで配信） */
  mediaPublicBaseUrl: string;
  /** /metrics のトークン（未設定なら /metrics は 404） */
  metricsToken: string;
  /**
   * リモート投稿の保持日数（npm run db:maintenance が使う。既定 30、0 で期間削除なし）
   * リレー経由で流入する投稿で DB が際限なく増えるのを防ぐための設定。
   */
  remotePostRetentionDays: number;
  /** ドライブ（自分のアップロード）の容量上限（MB）。0 は無制限 */
  mediaQuotaMb: number;
  /** ffmpeg の実行ファイルパス（動画サムネイル生成用。既定 'ffmpeg'） */
  ffmpegPath: string;
  /** ffprobe の実行ファイルパス（動画の長さ・解像度取得用。既定 'ffprobe'） */
  ffprobePath: string;
  /**
   * FTS 索引のスコープ（既定 'local' = ローカル投稿のみ。Mastodon / Misskey 相当）
   * 管理画面で変更でき、その場合はそちらが優先される。
   */
  ftsIndexScope: string;
  /** リモートのブースト（announces）の保存方針（既定 'follows' = フォロー中のみ） */
  remoteAnnouncePolicy: string;
  /** 毎日 1 回の自動整理（古いリモート投稿の削除）を行うか。既定 true */
  autoMaintenance: boolean;
  /** 自動整理を実行する時刻（0-23・ローカル時刻）。既定 4 */
  autoMaintenanceHour: number;
  /** 自動整理の前に VACUUM INTO でバックアップを取るか。既定 true */
  autoBackup: boolean;
  /** バックアップの保持世代数。既定 3 */
  backupsKeep: number;
  /** データベースの種類。'sqlite'（既定）または 'postgres'（DB_DRIVER で指定） */
  dbDriver: 'sqlite' | 'postgres';
  /** PostgreSQL の接続文字列（DB_DRIVER=postgres のとき必須。DATABASE_URL） */
  databaseUrl: string;
  /**
   * PostgreSQL の 1 クエリの上限（ミリ秒。0 で無効）。既定 30000。
   * 直列化した 1 接続なので、重いクエリやロック待ちがノード全体を止めないための保険。
   */
  databaseStatementTimeoutMs: number;
  /**
   * アイドル状態のトランザクションを切るまでの時間（ミリ秒。0 で無効）。既定 60000。
   * トランザクションを握ったまま落ちた処理がロックを保持し続けるのを防ぐ。
   */
  databaseIdleTimeoutMs: number;
  /** PostgreSQL の同時接続数（プールの上限）。既定 5 */
  databasePoolMax: number;
  /** 画像プロキシ（リモート画像の直リンクを避け、このノード経由で配信する）既定 true */
  imageProxy: boolean;
  /** 画像プロキシのキャッシュ上限（MB）既定 512 */
  imageProxyMaxMb: number;
  /** 画像プロキシのキャッシュ保持日数 既定 30 */
  imageProxyTtlDays: number;
  /** メール通知（SMTP 設定時のみ。ユーザーごとにオプトイン）既定 true */
  emailNotifications: boolean;
  /** メール通知をまとめて送るまでの待ち時間（秒）既定 60 */
  emailBatchSeconds: number;
  /** 同じユーザーへメールを送る最短間隔（分）既定 5 */
  emailThrottleMinutes: number;
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';

// 公開用ドメイン（環境変数 DOMAIN がなければ localhost:PORT）
const rawDomain = process.env.DOMAIN || (PORT === 80 || PORT === 443 ? 'localhost' : `localhost:${PORT}`);
const DOMAIN = rawDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

// 通信プロトコル（本番公開時は https、localhost の場合のみ http を許容）
const PROTOCOL = process.env.PROTOCOL || (DOMAIN.includes('localhost') || DOMAIN.includes('127.0.0.1') ? 'http' : 'https');
const ORIGIN = `${PROTOCOL}://${DOMAIN}`;

const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'data_astrabit.sqlite');

// データベースの種類。既定は SQLite（追加ミドルウェア不要）。
// 'postgres' を選ぶと DATABASE_URL に接続する（アプリ本体の対応は実験的。docs/POSTGRESQL.md）
const rawDriver = (process.env.DB_DRIVER || 'sqlite').trim().toLowerCase();
const DB_DRIVER: 'sqlite' | 'postgres' =
  rawDriver === 'postgres' || rawDriver === 'postgresql' || rawDriver === 'pg' ? 'postgres' : 'sqlite';
const DATABASE_URL = process.env.DATABASE_URL || '';
// 直列化した 1 接続なので、1 本の重いクエリが全体を止めないよう上限を入れておく（0 で無効）
const DATABASE_STATEMENT_TIMEOUT_MS = Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 30_000);
const DATABASE_IDLE_TIMEOUT_MS = Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 60_000);
const DATABASE_POOL_MAX = Number(process.env.DATABASE_POOL_MAX ?? 5);
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'Spica';
const INSTANCE_DESCRIPTION = process.env.INSTANCE_DESCRIPTION || 'Spica - A decentralized, sovereign social network node built from scratch with ActivityPub.';

// Inbox 署名検証モード。既定は strict（検証失敗を 401 で拒否）。
// 'log' にすると従来挙動（警告ログのみで処理続行）に戻せる。
const rawSignatureMode = (process.env.INBOX_SIGNATURE_MODE || 'strict').trim().toLowerCase();
const INBOX_SIGNATURE_MODE: InboxSignatureMode =
  rawSignatureMode === 'log' || rawSignatureMode === 'permissive' || rawSignatureMode === 'off'
    ? 'log'
    : 'strict';

// 代理転送（リレーが他サーバーの Activity を転送する挙動）の許可方針。
// 既定は relay（= 管理画面で accepted 済みのリレーのみ許可）
const rawForwardedPolicy = (process.env.INBOX_FORWARDED_ACTIVITY_POLICY || 'relay').trim().toLowerCase();
const INBOX_FORWARDED_POLICY: InboxForwardedPolicy =
  rawForwardedPolicy === 'any' || rawForwardedPolicy === 'allow' || rawForwardedPolicy === 'all'
    ? 'any'
    : 'relay';

// 署名の Date ヘッダー許容幅（秒）。既定 12 時間（Mastodon と同値）
const SIGNATURE_MAX_AGE_SECONDS = Math.max(0, parseInt(process.env.SIGNATURE_MAX_AGE_SECONDS || '43200', 10) || 0);

// プライベートアドレス宛の remote actor 取得を許すか。
// 本番（https 公開）では SSRF 対策として既定で拒否し、http 運用のローカル開発時のみ許可する。
const ALLOW_PRIVATE_REMOTE_FETCH = process.env.ALLOW_PRIVATE_REMOTE_FETCH
  ? process.env.ALLOW_PRIVATE_REMOTE_FETCH.trim().toLowerCase() === 'true'
  : PROTOCOL !== 'https';

// レート制限の無効化（既定は有効）
const RATE_LIMIT_DISABLED = (process.env.RATE_LIMIT_DISABLED || 'false').trim().toLowerCase() === 'true';

// Authorized Fetch（署名必須モード）。既定は無効（従来どおり未署名の取得も受け付ける）
const AUTHORIZED_FETCH = (process.env.AUTHORIZED_FETCH || 'false').trim().toLowerCase() === 'true';

// リモート投稿の保持日数（DB メンテナンス用。既定 30 日、0 で期間による削除を行わない）
const REMOTE_POST_RETENTION_DAYS = (() => {
  const raw = process.env.REMOTE_POST_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === '') return 30;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
})();

// ドライブの容量上限（MB）。0 または未設定で無制限
const MEDIA_QUOTA_MB = (() => {
  const parsed = parseInt(process.env.MEDIA_QUOTA_MB || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
})();

// 画像プロキシ（リモート画像をこのノード経由で配信し、直リンクを避ける）。既定は有効
const IMAGE_PROXY = (process.env.IMAGE_PROXY || 'true').trim().toLowerCase() !== 'false';
const IMAGE_PROXY_MAX_MB = (() => {
  const parsed = parseInt(process.env.IMAGE_PROXY_MAX_MB || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 512;
})();
// メール通知（SMTP 設定時のみ有効。ユーザーごとのオプトイン）
const EMAIL_NOTIFICATIONS = (process.env.EMAIL_NOTIFICATIONS || 'true').trim().toLowerCase() !== 'false';
const EMAIL_BATCH_SECONDS = (() => {
  const parsed = parseInt(process.env.EMAIL_BATCH_SECONDS || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60;
})();
const EMAIL_THROTTLE_MINUTES = (() => {
  const parsed = parseInt(process.env.EMAIL_THROTTLE_MINUTES || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
})();

const IMAGE_PROXY_TTL_DAYS = (() => {
  const parsed = parseInt(process.env.IMAGE_PROXY_TTL_DAYS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
})();

// リモートコンテンツの保存・索引ポリシー（既定は Mastodon / Misskey 相当）
//   管理画面（server_settings）で変更された場合はそちらが優先される（searchPolicy.ts）
const FTS_INDEX_SCOPE = (process.env.FTS_INDEX_SCOPE || 'local').trim().toLowerCase();
const REMOTE_ANNOUNCE_POLICY = (process.env.REMOTE_ANNOUNCE_POLICY || 'follows').trim().toLowerCase();

// 運用の自動化（毎日 1 回のリモート投稿整理とバックアップ）
const AUTO_MAINTENANCE = (process.env.AUTO_MAINTENANCE || 'true').trim().toLowerCase() !== 'false';
const AUTO_MAINTENANCE_HOUR = (() => {
  const parsed = parseInt(process.env.AUTO_MAINTENANCE_HOUR || '4', 10);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 23 ? parsed : 4;
})();
const AUTO_BACKUP = (process.env.AUTO_BACKUP || 'true').trim().toLowerCase() !== 'false';
const BACKUPS_KEEP = (() => {
  const parsed = parseInt(process.env.BACKUPS_KEEP || '3', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
})();

// 動画サムネイル生成に使う ffmpeg / ffprobe（未インストールなら機能だけ無効になる）
const FFMPEG_PATH = (process.env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
const FFPROBE_PATH = (process.env.FFPROBE_PATH || 'ffprobe').trim() || 'ffprobe';

// CDN（例: Cloudflare）を前段に置くときのメディアの公開 URL。
// 設定すると API の応答に含まれる自分のメディア（`/uploads/...`）をこの URL に置き換えます
// （DB には相対のまま保存するので、後から CDN を替えられます）
const MEDIA_PUBLIC_BASE_URL = (process.env.MEDIA_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');

// `/metrics`（Prometheus 形式）を出すときのトークン。**未設定なら /metrics は 404**。
// nginx の背後では接続元 IP で守れない（全部 127.0.0.1 になる）ので、トークンで守る。
const METRICS_TOKEN = (process.env.METRICS_TOKEN || '').trim();

// Redis（任意）。未設定ならインメモリ実装のまま＝単一プロセス前提で今までどおり動く
const REDIS_URL = process.env.REDIS_URL?.trim() || '';
const REDIS_PREFIX = process.env.REDIS_PREFIX?.trim() || 'spica';

// 配送再送の同時実行数（ネットワーク待ちが主なので、並べると同じ時間で多く送れる）
const DELIVERY_CONCURRENCY = (() => {
  const parsed = parseInt(process.env.DELIVERY_CONCURRENCY || '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 50) : 5;
})();

// タイムラインの読み取りキャッシュ（秒）。**既定は 0 = 無効**。
// 有効にすると「同じ画面を何度も開いたときの組み立て」を省けるが、ブロック・削除・フォローの
// 反映が TTL ぶん遅れる（権限はキャッシュ時点のもので判定されるので、他人に漏れることはない）
const TIMELINE_CACHE_TTL_SEC = (() => {
  const parsed = parseInt(process.env.TIMELINE_CACHE_TTL_SEC || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
})();

// タグタイムラインと検索の「LIKE 走査」が対象にする直近の投稿数。
// `content LIKE '%語%'` は索引が使えず、全件走査だと 32 万投稿で 250〜300ms 超
// （SQLite は同期 API なのでプロセス全体が止まる）。直近 N 件に限れば DB が育っても
// コストが一定になる（実測: 2 万件で 17ms / 5 万件で 40ms / 10 万件で 139ms）。
// 0 で無制限（従来の挙動）。広げるほど「古い投稿のタグ・語」も見つかるようになる。
const RECENT_SCAN_POSTS = (() => {
  const parsed = parseInt(process.env.RECENT_SCAN_POSTS || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 20000;
})();

export const config: AppConfig = {
  port: PORT,
  bindHost: BIND_HOST,
  domain: DOMAIN,
  protocol: PROTOCOL,
  origin: ORIGIN,
  dbPath: DB_PATH,
  instanceName: INSTANCE_NAME,
  instanceDescription: INSTANCE_DESCRIPTION,
  storage: {
    endpoint: process.env.S3_ENDPOINT || '',
    bucket: process.env.S3_BUCKET || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    publicUrl: (process.env.S3_PUBLIC_URL || '').replace(/\/+$/, ''),
    region: process.env.S3_REGION || 'auto',
  },
  inboxSignatureMode: INBOX_SIGNATURE_MODE,
  signatureMaxAgeSeconds: SIGNATURE_MAX_AGE_SECONDS,
  inboxForwardedPolicy: INBOX_FORWARDED_POLICY,
  allowPrivateRemoteFetch: ALLOW_PRIVATE_REMOTE_FETCH,
  authorizedFetch: AUTHORIZED_FETCH,
  rateLimitDisabled: RATE_LIMIT_DISABLED,
  redisUrl: REDIS_URL,
  redisPrefix: REDIS_PREFIX,
  deliveryConcurrency: DELIVERY_CONCURRENCY,
  timelineCacheTtlSec: TIMELINE_CACHE_TTL_SEC,
  recentScanPosts: RECENT_SCAN_POSTS,
  mediaPublicBaseUrl: MEDIA_PUBLIC_BASE_URL,
  metricsToken: METRICS_TOKEN,
  remotePostRetentionDays: REMOTE_POST_RETENTION_DAYS,
  mediaQuotaMb: MEDIA_QUOTA_MB,
  ffmpegPath: FFMPEG_PATH,
  ffprobePath: FFPROBE_PATH,
  ftsIndexScope: FTS_INDEX_SCOPE,
  remoteAnnouncePolicy: REMOTE_ANNOUNCE_POLICY,
  autoMaintenance: AUTO_MAINTENANCE,
  autoMaintenanceHour: AUTO_MAINTENANCE_HOUR,
  autoBackup: AUTO_BACKUP,
  backupsKeep: BACKUPS_KEEP,
  dbDriver: DB_DRIVER,
  databaseUrl: DATABASE_URL,
  databaseStatementTimeoutMs: Number.isFinite(DATABASE_STATEMENT_TIMEOUT_MS) ? DATABASE_STATEMENT_TIMEOUT_MS : 30_000,
  databaseIdleTimeoutMs: Number.isFinite(DATABASE_IDLE_TIMEOUT_MS) ? DATABASE_IDLE_TIMEOUT_MS : 60_000,
  databasePoolMax: Number.isFinite(DATABASE_POOL_MAX) && DATABASE_POOL_MAX >= 1 ? Math.floor(DATABASE_POOL_MAX) : 5,
  imageProxy: IMAGE_PROXY,
  imageProxyMaxMb: IMAGE_PROXY_MAX_MB,
  imageProxyTtlDays: IMAGE_PROXY_TTL_DAYS,
  emailNotifications: EMAIL_NOTIFICATIONS,
  emailBatchSeconds: EMAIL_BATCH_SECONDS,
  emailThrottleMinutes: EMAIL_THROTTLE_MINUTES,
};
