/**
 * 表示のための整形（純関数だけ）。
 * ・相対時刻 / 桁区切りの数字
 * ・本文の安全な表示（プレーンテキストはリンク化、HTML は無害化）
 */
import DOMPurify from 'dompurify';
import { getPrefs } from './prefs';

export interface PostReaction {
  reaction: string;
  count: number;
  me: boolean;
}

export interface PostMedia {
  url: string;
  type?: string;
  alt?: string;
  thumbnail_url?: string;
}

export interface Post {
  id: string;
  user_id: string;
  author_name: string;
  author_handle: string;
  author_url: string;
  author_icon?: string;
  content: string;
  cw?: string | null;
  is_sensitive?: boolean;
  visibility: 'public' | 'unlisted' | 'followers' | 'direct' | string;
  published_at?: string;
  created_at?: string;
  reactions?: PostReaction[];
  media_attachments?: PostMedia[];
  attachments?: PostMedia[];
  quote?: Post | null;
  renote?: Post | null;
  poll?: {
    choices: { text: string; votes_count?: number; votes?: number; me?: boolean }[];
    expires_at?: string;
    multiple?: boolean;
    /** 自分が投票済みか / 締め切られたか（サーバーが返す） */
    my_voted?: boolean;
    is_expired?: boolean;
    total_votes?: number;
  } | null;
  /** プロフィールにピン留めされているか */
  is_pinned?: boolean;
  reply_count?: number;
  announce_count?: number;
  quote_count?: number;
  bookmarked?: boolean;
  my_announced?: boolean;
}

export interface SessionUser {
  id: string;
  name: string;
  handle: string;
  icon_url?: string;
  role?: string;
  onboarding_completed?: number;
  /** 設定画面で使う（/api/auth/me が返す） */
  email?: string;
  email_verified?: boolean | number;
  hasPassword?: boolean;
  totp_enabled?: boolean | number;
}

export interface ServerInfo {
  name: string;
  description?: string;
  icon_url?: string;
  stats?: { users?: number; totalPosts?: number; federatedPosts?: number };
  server_rules?: string[];
  require_rules_agreement?: boolean;
  registration_mode?: string;
  /** DM が有効かどうかはここで分かる（features.dm） */
  features?: { dm?: boolean };
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface DirectoryUser {
  id: string;
  name: string;
  handle: string;
  summary?: string;
  icon_url?: string;
}

export function formatCount(n: number | undefined | null): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('ja-JP') : '0';
}

const TIME_FMT = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' });
const TIME_FMT_FULL = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });

/** 「2026/10/9 18:30」の形（設定で絶対時刻を選んだとき） */
export function absoluteTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relativeTime(iso: string | undefined): string {
  if (!iso) return '';
  // 設定が「絶対時刻」なら、そのまま日時で出す（既定は絶対。元の UI と同じ）
  if (getPrefs().timeFormat !== 'relative') return absoluteTime(iso);
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const min = 60_000;
  if (diff < min) return 'たった今';
  if (diff < 60 * min) return `${Math.floor(diff / min)}分前`;
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))}時間前`;
  if (diff < 7 * 24 * 60 * min) return `${Math.floor(diff / (24 * 60 * min))}日前`;
  const date = new Date(then);
  return date.getFullYear() === new Date().getFullYear()
    ? TIME_FMT.format(date)
    : TIME_FMT_FULL.format(date);
}

const VISIBILITY_LABEL: Record<string, string> = {
  public: '連合',
  unlisted: 'ひかえめ',
  followers: 'フォロワー',
  direct: 'ダイレクト',
};

export function visibilityLabel(visibility: string): string {
  return VISIBILITY_LABEL[visibility] || '';
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] || c);
}

function looksLikeHtml(raw: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(raw);
}

const ALLOWED_TAGS = [
  'a', 'p', 'br', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre',
  'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'hr', 'small',
];
const ALLOWED_ATTR = ['href', 'class', 'src', 'alt', 'title', 'width', 'height'];

/** プレーンテキストの本文を、URL・@メンション・#タグだけリンクにする */
function linkifyPlainText(raw: string): string {
  return escapeHtml(raw)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/(^|[\s(])(@[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?)/g, '$1<a class="mention" href="#">$2</a>')
    .replace(/(^|[\s(])(#[^\s<#]+)/g, (_m, lead: string, tag: string) =>
      `${lead}<a class="hashtag" href="/tags/${encodeURIComponent(tag.slice(1))}">${tag}</a>`);
}

/** 本文を安全な HTML にする（表示は dangerouslySetInnerHTML で行う） */
export function formatContent(raw: string): string {
  if (!raw) return '';
  const html = looksLikeHtml(raw) ? raw : linkifyPlainText(raw);
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment;

  const host = document.createElement('div');
  host.appendChild(clean);

  // 設定「カスタム絵文字を画像で出す」が切ってあるときは、:name: の文字に戻す
  if (getPrefs().showCustomEmojiImages === false) {
    for (const img of Array.from(host.querySelectorAll('img'))) {
      const alt = img.getAttribute('alt') || '';
      if (!img.classList.contains('emoji') && !alt.startsWith(':')) continue;
      const text = document.createElement('span');
      text.textContent = alt.startsWith(':') ? alt : `:${alt}:`;
      img.replaceWith(text);
    }
  }

  for (const a of Array.from(host.querySelectorAll('a'))) {
    const href = a.getAttribute('href') || '';
    const text = a.textContent || '';
    if (href.includes('/tags/')) {
      const tag = decodeURIComponent(href.split('/tags/').pop() || '').replace(/^#/, '');
      a.setAttribute('href', `/tags/${encodeURIComponent(tag)}`);
      a.classList.add('hashtag');
      a.removeAttribute('target');
    } else if (text.startsWith('@') || href.includes('/users/')) {
      a.classList.add('mention');
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else if (/^https?:/.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('href');
    }
  }
  return host.innerHTML;
}

/** 本文が実質空（メディアだけの投稿など）かどうか */
export function isBlankContent(raw: string): boolean {
  return raw.replace(/<[^>]*>/g, '').replace(/[\s\u3000]/g, '') === '';
}
