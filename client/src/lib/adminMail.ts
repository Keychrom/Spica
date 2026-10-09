/**
 * 管理パネルの通信 その3（メール送信とメディアストレージの設定）。
 * どちらも「サーバー全体の設定」なので、運営だけが読み書きする。
 */
import { api, messageOf } from './api';

/* ---- メール（SMTP） ---- */

export interface MailSettings {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  hasPassword?: boolean;
  from?: string;
  /** 送れる状態かどうか */
  configured?: boolean;
  allowEmailRegistration?: boolean;
  authMode?: string;
  registrationMode?: string;
}

/** 画面で打ち込む値（数字も文字で持つ。空欄は「変えない」の意味） */
export interface MailDraft {
  host: string;
  port: string;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export async function loadMailSettings(): Promise<MailSettings | null> {
  const res = await api.get('/api/admin/mail-settings');
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  return res.data as MailSettings;
}

function mailBody(draft: MailDraft) {
  return {
    host: draft.host.trim(),
    port: draft.port.trim() ? Number(draft.port.trim()) : undefined,
    secure: draft.secure,
    user: draft.user.trim(),
    pass: draft.pass,
    from: draft.from.trim(),
  };
}

export async function saveMailSettings(draft: MailDraft): Promise<string | null> {
  const res = await api.post('/api/admin/mail-settings', mailBody(draft));
  return res.ok ? null : messageOf(res.data, 'メール設定を保存できませんでした。');
}

export async function testMailSettings(draft: MailDraft): Promise<string | null> {
  const res = await api.post('/api/admin/mail-settings/test', mailBody(draft));
  return res.ok ? null : messageOf(res.data, '接続できませんでした。');
}

/* ---- メディアストレージ（S3 互換） ---- */

export interface StorageSettings {
  configured?: boolean;
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  hasSecretAccessKey?: boolean;
  publicUrl?: string;
  region?: string;
}

export interface StorageDraft {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl: string;
  region: string;
}

export async function loadStorage(): Promise<StorageSettings | null> {
  const res = await api.get('/api/admin/storage');
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  return res.data as StorageSettings;
}

function storageBody(draft: StorageDraft) {
  return {
    endpoint: draft.endpoint.trim(),
    bucket: draft.bucket.trim(),
    accessKeyId: draft.accessKeyId.trim(),
    secretAccessKey: draft.secretAccessKey,
    publicUrl: draft.publicUrl.trim(),
    region: draft.region.trim(),
  };
}

export async function saveStorage(draft: StorageDraft): Promise<string | null> {
  const res = await api.post('/api/admin/storage', storageBody(draft));
  return res.ok ? null : messageOf(res.data, 'ストレージ設定を保存できませんでした。');
}

export async function testStorage(draft: StorageDraft): Promise<string | null> {
  const res = await api.post('/api/admin/storage/test', storageBody(draft));
  return res.ok ? null : messageOf(res.data, '接続できませんでした。');
}
