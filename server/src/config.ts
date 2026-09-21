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

// リモートコンテンツの保存・索引ポリシー（既定は Mastodon / Misskey 相当）
//   管理画面（server_settings）で変更された場合はそちらが優先される（searchPolicy.ts）
const FTS_INDEX_SCOPE = (process.env.FTS_INDEX_SCOPE || 'local').trim().toLowerCase();
const REMOTE_ANNOUNCE_POLICY = (process.env.REMOTE_ANNOUNCE_POLICY || 'follows').trim().toLowerCase();

// 動画サムネイル生成に使う ffmpeg / ffprobe（未インストールなら機能だけ無効になる）
const FFMPEG_PATH = (process.env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
const FFPROBE_PATH = (process.env.FFPROBE_PATH || 'ffprobe').trim() || 'ffprobe';

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
  remotePostRetentionDays: REMOTE_POST_RETENTION_DAYS,
  mediaQuotaMb: MEDIA_QUOTA_MB,
  ffmpegPath: FFMPEG_PATH,
  ffprobePath: FFPROBE_PATH,
  ftsIndexScope: FTS_INDEX_SCOPE,
  remoteAnnouncePolicy: REMOTE_ANNOUNCE_POLICY,
};
