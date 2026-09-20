import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getServerSetting, setServerSetting } from './db.js';
import { config } from './config.js';
import { convertImageToWebp } from './imageProcessor.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl: string;
  region: string;
  forcePathStyle: boolean;
}

export interface UploadedMedia {
  url: string;
  key: string;
  mediaType: string;
  size: number;
  name?: string;
}

/**
 * 現在のストレージ設定を取得 (DB優先、フォールバックとして環境変数)
 */
export function getStorageConfig(): StorageConfig {
  return {
    endpoint: getServerSetting('s3_endpoint', process.env.S3_ENDPOINT || '') || '',
    bucket: getServerSetting('s3_bucket', process.env.S3_BUCKET || '') || '',
    accessKeyId: getServerSetting('s3_access_key_id', process.env.S3_ACCESS_KEY_ID || '') || '',
    secretAccessKey: getServerSetting('s3_secret_access_key', process.env.S3_SECRET_ACCESS_KEY || '') || '',
    publicUrl: (getServerSetting('s3_public_url', process.env.S3_PUBLIC_URL || '') || '').replace(/\/+$/, ''),
    region: getServerSetting('s3_region', process.env.S3_REGION || 'auto') || 'auto',
    forcePathStyle: true,
  };
}

/**
 * ストレージ設定を保存 (DB)
 */
export function saveStorageConfig(cfg: Partial<StorageConfig>): void {
  if (cfg.endpoint !== undefined) setServerSetting('s3_endpoint', cfg.endpoint.trim());
  if (cfg.bucket !== undefined) setServerSetting('s3_bucket', cfg.bucket.trim());
  if (cfg.accessKeyId !== undefined) setServerSetting('s3_access_key_id', cfg.accessKeyId.trim());
  if (cfg.secretAccessKey !== undefined) setServerSetting('s3_secret_access_key', cfg.secretAccessKey.trim());
  if (cfg.publicUrl !== undefined) setServerSetting('s3_public_url', cfg.publicUrl.trim().replace(/\/+$/, ''));
  if (cfg.region !== undefined) setServerSetting('s3_region', cfg.region.trim() || 'auto');
}

/**
 * S3 / R2 が有効に設定されているか判定
 */
export function isS3Configured(cfg = getStorageConfig()): boolean {
  return Boolean(
    cfg.endpoint &&
    cfg.bucket &&
    cfg.accessKeyId &&
    cfg.secretAccessKey
  );
}

/**
 * S3Client インスタンスの作成
 */
export function createS3Client(cfg = getStorageConfig()): S3Client {
  return new S3Client({
    region: cfg.region || 'auto',
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: cfg.forcePathStyle ?? true,
  });
}

/**
 * ストレージ接続テスト (Put & Delete)
 */
export async function testStorageConnection(cfg = getStorageConfig()): Promise<{ success: boolean; message?: string; error?: string }> {
  if (!isS3Configured(cfg)) {
    return {
      success: false,
      error: 'S3 / R2 の接続設定（Endpoint, Bucket, Access Key, Secret Key）が不足しています。',
    };
  }

  const client = createS3Client(cfg);
  const testKey = `test-connection-${Date.now()}.txt`;

  try {
    // 1. テストオブジェクトを書き込み
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: testKey,
        Body: Buffer.from('Spica S3 / Cloudflare R2 Connection Test'),
        ContentType: 'text/plain',
      })
    );

    // 2. テストオブジェクトを削除
    await client.send(
      new DeleteObjectCommand({
        Bucket: cfg.bucket,
        Key: testKey,
      })
    );

    return {
      success: true,
      message: `バケット「${cfg.bucket}」への書き込み・削除テストに成功しました！接続は正常です。`,
    };
  } catch (err: any) {
    console.error('[Storage Test Error]:', err);
    return {
      success: false,
      error: `接続テスト失敗: ${err.message || err.toString()}`,
    };
  }
}

/**
 * ファイルの拡張子を取得
 */
function getExtension(mimetype: string, originalname: string): string {
  const extFromName = path.extname(originalname).replace(/^\./, '').toLowerCase();
  if (extFromName) return extFromName;

  const mimeMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    // 動画・音声（変換せずそのまま保存する）
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/ogg': 'ogv',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'weba',
  };
  return mimeMap[mimetype] || 'bin';
}

/**
 * メディアファイルをアップロード (S3/R2 または ローカルフォールバック)
 */
export async function uploadMediaFile(params: {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
  userId: string;
}): Promise<UploadedMedia> {
  const cfg = getStorageConfig();

  // 画像はアップロード時に EXIF（位置情報など）を除去し WebP に変換する。
  // 変換しない形式（GIF/SVG等）や失敗時は元データをそのまま保存する。
  const converted = await convertImageToWebp(params.buffer, params.mimetype);
  const buffer = converted ? converted.buffer : params.buffer;
  const mimetype = converted ? 'image/webp' : params.mimetype;
  const size = converted ? converted.size : params.size;

  const ext = converted ? 'webp' : getExtension(params.mimetype, params.originalname);
  const randomStr = crypto.randomBytes(4).toString('hex');
  const filename = `${Date.now()}_${randomStr}.${ext}`;
  const key = `media/${params.userId}/${filename}`;

  // S3 / R2 が設定されている場合
  if (isS3Configured(cfg)) {
    const client = createS3Client(cfg);

    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
      })
    );

    // 公開URLの決定 (PublicUrl が設定されていればそれを優先、なければ endpoint + bucket)
    let publicUrl = '';
    if (cfg.publicUrl) {
      publicUrl = `${cfg.publicUrl}/${key}`;
    } else {
      const cleanEndpoint = cfg.endpoint.replace(/\/+$/, '');
      publicUrl = `${cleanEndpoint}/${cfg.bucket}/${key}`;
    }

    console.log(`[Storage] ☁️ Uploaded media to S3/R2: ${key} -> ${publicUrl}`);
    return {
      url: publicUrl,
      key,
      mediaType: mimetype,
      size,
      name: params.originalname,
    };
  }

  // S3 未設定時のローカルストレージ・フォールバック
  const uploadDir = path.resolve(process.cwd(), 'data', 'uploads', params.userId);
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const filePath = path.join(uploadDir, filename);
  fs.writeFileSync(filePath, buffer);

  const localUrl = `${config.origin}/uploads/${params.userId}/${filename}`;
  console.log(`[Storage] 💾 Saved media to local storage: ${filePath} -> ${localUrl}`);

  return {
    url: localUrl,
    key,
    mediaType: mimetype,
    size,
    name: params.originalname,
  };
}
