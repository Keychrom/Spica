/**
 * 添付（画像・動画）のアップロードと、カスタム絵文字の一覧。
 * アップロードは 1 回で複数まとめて送れる（/api/media/upload は any で受ける）。
 */
import { api } from './api';
import { compressImage } from './compress';
import { getPrefs } from './prefs';

/** アップロードの結果（サーバーの ClientMedia。camelCase なのに注意） */
export interface UploadedMedia {
  id: string;
  url: string;
  mediaType?: string;
  size?: number;
  name?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  duration?: number | null;
}

/** 投稿に付ける添付（本文の attachments に渡す形） */
export interface Attachment {
  url: string;
  mediaType: string;
  name: string;
  description?: string;
  thumbnailUrl?: string;
  size?: number;
  width?: number;
  height?: number;
}

export const MAX_ATTACHMENTS = 4;

export function toAttachment(media: UploadedMedia): Attachment {
  return {
    url: media.url,
    mediaType: media.mediaType || 'image/png',
    name: media.name || 'ファイル',
    thumbnailUrl: media.thumbnailUrl,
    size: media.size,
    width: media.width,
    height: media.height,
  };
}

/** まとめて上げる。失敗したらどのファイルが駄目だったかを返す */
export async function uploadMedia(files: File[]): Promise<{ media: UploadedMedia[]; error?: string }> {
  const picked = files.slice(0, MAX_ATTACHMENTS);
  // 設定「画像を自動で軽くする」が入っていれば、上げる前に縮める（既定は入）
  const compress = getPrefs().autoCompressImages !== false;
  const ready: File[] = [];
  for (const file of picked) {
    ready.push(compress ? await compressImage(file) : file);
  }
  const form = new FormData();
  for (const file of ready) form.append('file', file);
  const res = await api.post('/api/media/upload', form);
  if (!res.ok || !res.data) {
    const data = res.data as { error?: string } | null;
    return { media: [], error: data?.error || 'アップロードできませんでした。' };
  }
  const data = res.data as { media?: UploadedMedia[]; attachment?: UploadedMedia };
  return { media: data.media ?? (data.attachment ? [data.attachment] : []) };
}

/** 音声（プレイヤーでその場で再生する） */
export function isAudioAttachment(attachment: Attachment): boolean {
  return attachment.mediaType.startsWith('audio');
}

/** 動画（その場で再生する。静止画と違ってサムネイルが無いことがある） */
export function isVideoAttachment(attachment: Attachment): boolean {
  return attachment.mediaType.startsWith('video');
}

/* ---- カスタム絵文字（リアクションと本文で使う :name:） ---- */

export interface CustomEmoji {
  id: string;
  name: string;
  url: string;
  category?: string;
}

let emojiCache: CustomEmoji[] | null = null;

export async function loadCustomEmojis(): Promise<CustomEmoji[]> {
  if (emojiCache) return emojiCache;
  const res = await api.get('/api/emojis', { auth: false });
  if (!res.ok || !Array.isArray(res.data)) return [];
  emojiCache = res.data as CustomEmoji[];
  return emojiCache;
}
