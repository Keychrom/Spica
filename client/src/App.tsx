import React, { useState, useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import {
  Globe,
  Radio,
  Send,
  RefreshCw,
  Server,
  Users,
  MessageSquare,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Key,
  KeyRound,
  Mail,
  Lock,
  Copy,
  LogOut,
  LogIn,
  Settings,
  ShieldAlert,
  ArrowLeft,
  Check,
  UserPlus,
  AtSign,
  List as ListIcon,
  UserCheck,
  Edit3,
  Calendar,
  User,
  Sliders,
  Repeat,
  MessageCircle,
  Megaphone,
  Share2,
  SmilePlus,
  GitBranch,
  Home,
  Trash2,
  Bell,
  Heart,
  CheckCheck,
  Image as ImageIcon,
  X,
  Cloud,
  HardDrive,
  FolderOpen,
  FileVideo,
  BellOff,
  Zap,
  LayoutDashboard,
  Search,
  Database,
  Hash,
  Menu,
  Bookmark,
  VolumeX,
  Volume2,
  Ban,
  MoreHorizontal,
  Eye,
  EyeOff,
  Pin,
  BarChart2,
  Quote,
  Upload,
  Sparkles,
  ArrowRight,
  Smile,
  Ticket,
  Plus,
  Tag,
  Download,
  FileText,
  ClipboardCheck,
  ChevronDown,
  ChevronUp,
  FolderArchive,
  Clock,
  Fingerprint,
  Palette,
  Sun,
  Moon,
  Layers,
} from 'lucide-react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { compressImage } from './utils/imageCompressor';

// DOMPurify 設定: 安全な外部リンク処理
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    const href = node.getAttribute('href') || '';
    if (!href.startsWith('#tag-')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
});

// Fediverse (Mastodon / Misskey) の HTML 投稿およびカスタム絵文字・ハッシュタグを安全にサニタイズして美しく表示
function FormattedPostContent({
  content,
  emojis,
  enableEmojis = true,
  onTagClick,
}: {
  content: string;
  emojis?: string;
  enableEmojis?: boolean;
  onTagClick?: (tag: string) => void;
}) {
  let displayContent = content;

  // もし emojis カラムがあり、かつ本文中でまだ <img> に置換されていない場合のみ置換
  const alreadyReplaced = displayContent.includes('custom-emoji');
  if (enableEmojis && emojis && !alreadyReplaced) {
    try {
      const emojiList = JSON.parse(emojis) as { name: string; url: string }[];
      if (Array.isArray(emojiList)) {
        for (const emoji of emojiList) {
          if (emoji.name && emoji.url) {
            const rawShortcode = emoji.name;
            const cleanName = emoji.name.replace(/^:|:$/g, '');
            const escapedName = rawShortcode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // タグの属性値内（="...:shortcode:..."）を誤置換しないよう、タグ外のみにマッチ
            const regex = new RegExp(`${escapedName}(?![^<]*>)`, 'g');
            const imgTag = `<img src="${emoji.url}" alt="${cleanName}" title="${rawShortcode}" class="custom-emoji inline-block h-6 w-auto align-middle" loading="lazy" />`;
            displayContent = displayContent.replace(regex, imgTag);
          }
        }
      }
    } catch {}
  }

  const hasHtmlTags = /<[a-z][\s\S]*>/i.test(displayContent);

  let sanitizedHtml = '';
  if (hasHtmlTags) {
    // HTML内のテキスト中のハッシュタグをリンク化 (タグ外のみ)
    displayContent = displayContent.replace(
      /(^|\s)#([a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)(?![^<]*>)/gu,
      '$1<a href="#tag-$2" data-tag="$2" class="hashtag text-indigo-400 hover:text-indigo-300 font-semibold hover:underline cursor-pointer">#$2</a>'
    );
    sanitizedHtml = DOMPurify.sanitize(displayContent, {
      ALLOWED_TAGS: [
        'p', 'br', 'span', 'a', 'b', 'strong', 'i', 'em', 'code', 'pre',
        'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img'
      ],
      ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'title', 'src', 'alt', 'loading', 'width', 'height', 'data-tag'],
    });
  } else {
    // プレーンテキストの場合はHTMLエスケープの上、URL自動リンク化とハッシュタグ自動リンク化
    const escaped = displayContent
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const withLinks = escaped.replace(
      /(https?:\/\/[^\s]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer" class="text-indigo-400 hover:text-indigo-300 hover:underline break-all">$1</a>'
    );
    const withTags = withLinks.replace(
      /(^|\s)#([a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)/gu,
      '$1<a href="#tag-$2" data-tag="$2" class="hashtag text-indigo-400 hover:text-indigo-300 font-semibold hover:underline cursor-pointer">#$2</a>'
    );
    sanitizedHtml = withTags.replace(/\n/g, '<br />');
  }

  return (
    <div
      className="prose-post text-sm text-slate-200 leading-relaxed break-words pl-13"
      onClick={(e) => {
        const target = (e.target as HTMLElement).closest('a');
        if (target) {
          const tag = target.getAttribute('data-tag');
          if (tag && onTagClick) {
            e.preventDefault();
            e.stopPropagation();
            onTagClick(tag);
            return;
          }
          const href = target.getAttribute('href') || '';
          const match = href.match(/\/tags?\/([a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)/);
          if (match && onTagClick) {
            e.preventDefault();
            e.stopPropagation();
            onTagClick(match[1]);
            return;
          }
        }
      }}
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  );
}

// 投稿に添付された画像グリッド表示 (1〜4枚・センシティブ/NSFWぼかし対応)
function PostMediaGrid({
  attachments,
  onImageClick,
  className = 'mt-3 pl-13',
  isSensitive = false,
}: {
  attachments?: MediaAttachment[];
  onImageClick?: (url: string) => void;
  className?: string;
  isSensitive?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  // サムネイル表示から実際の再生に切り替えたか（動画）
  const [videoPlaying, setVideoPlaying] = useState(false);
  if (!attachments || attachments.length === 0) return null;

  const count = attachments.length;

  const renderContent = () => {
    if (count === 1) {
      const att = attachments[0];
      const mediaType = String(att.mediaType || '');

      // 🎬 動画（サムネイルがあれば画像＋再生ボタンで表示し、タップで再生する）
      if (mediaType.startsWith('video/')) {
        if (att.thumbnailUrl && !videoPlaying) {
          return (
            <div className="relative rounded-2xl overflow-hidden border border-slate-800/80 bg-black max-w-full">
              <img
                src={att.thumbnailUrl}
                alt={att.name || '動画のサムネイル'}
                className="w-full max-h-96 object-contain cursor-pointer"
                loading="lazy"
                onClick={(e) => { e.stopPropagation(); setVideoPlaying(true); }}
              />
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setVideoPlaying(true); }}
                className="absolute inset-0 flex items-center justify-center cursor-pointer group"
                aria-label="動画を再生"
              >
                <span className="w-14 h-14 rounded-full bg-black/60 border border-white/30 backdrop-blur-sm flex items-center justify-center group-hover:bg-black/75 transition">
                  <svg viewBox="0 0 24 24" className="w-6 h-6 text-white translate-x-[1px]" fill="currentColor" aria-hidden="true">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
              </button>
              {att.duration ? (
                <span className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded-md bg-black/70 text-white text-[10px] font-mono">
                  {Math.floor(att.duration / 60)}:{String(Math.floor(att.duration % 60)).padStart(2, '0')}
                </span>
              ) : null}
            </div>
          );
        }
        return (
          <div className="rounded-2xl overflow-hidden border border-slate-800/80 bg-black max-w-full">
            <video
              src={att.url}
              controls
              autoPlay={videoPlaying}
              preload="metadata"
              playsInline
              poster={att.thumbnailUrl || undefined}
              className="w-full max-h-96 bg-black"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        );
      }

      // 🎵 音声
      if (mediaType.startsWith('audio/')) {
        return (
          <div className="rounded-2xl border border-slate-800/80 bg-slate-950 p-3 max-w-md">
            <audio
              src={att.url}
              controls
              preload="metadata"
              className="w-full"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        );
      }

      return (
        <div className="rounded-2xl overflow-hidden border border-slate-800/80 bg-slate-950 max-h-96 w-fit max-w-full">
          <img
            src={att.url}
            alt={att.name || '投稿画像'}
            className="w-auto h-auto max-h-96 object-contain cursor-pointer hover:opacity-95 transition"
            loading="lazy"
            onClick={() => onImageClick?.(att.url)}
          />
        </div>
      );
    }

    if (count === 2) {
      return (
        <div className="grid grid-cols-2 gap-2 rounded-2xl overflow-hidden border border-slate-800/80 aspect-[16/9] bg-slate-950">
          {attachments.slice(0, 2).map((att, idx) => (
            <div key={idx} className="relative overflow-hidden h-full group bg-slate-900">
              <img
                src={att.url}
                alt={att.name || `投稿画像 ${idx + 1}`}
                className="w-full h-full object-cover cursor-pointer group-hover:scale-105 transition duration-200"
                loading="lazy"
                onClick={() => onImageClick?.(att.url)}
              />
            </div>
          ))}
        </div>
      );
    }

    if (count === 3) {
      return (
        <div className="grid grid-cols-2 gap-2 rounded-2xl overflow-hidden border border-slate-800/80 aspect-[16/9] bg-slate-950">
          <div className="relative overflow-hidden h-full group bg-slate-900">
            <img
              src={attachments[0].url}
              alt={attachments[0].name || '投稿画像 1'}
              className="w-full h-full object-cover cursor-pointer group-hover:scale-105 transition duration-200"
              loading="lazy"
              onClick={() => onImageClick?.(attachments[0].url)}
            />
          </div>
          <div className="grid grid-rows-2 gap-2 h-full">
            {attachments.slice(1, 3).map((att, idx) => (
              <div key={idx} className="relative overflow-hidden h-full group bg-slate-900">
                <img
                  src={att.url}
                  alt={att.name || `投稿画像 ${idx + 2}`}
                  className="w-full h-full object-cover cursor-pointer group-hover:scale-105 transition duration-200"
                  loading="lazy"
                  onClick={() => onImageClick?.(att.url)}
                />
              </div>
            ))}
          </div>
        </div>
      );
    }

    // 4枚以上 (2x2 グリッド)
    return (
      <div className="grid grid-cols-2 gap-2 rounded-2xl overflow-hidden border border-slate-800/80 aspect-square sm:aspect-[16/10] bg-slate-950">
        {attachments.slice(0, 4).map((att, idx) => (
          <div key={idx} className="relative overflow-hidden h-full group bg-slate-900">
            <img
              src={att.url}
              alt={att.name || `投稿画像 ${idx + 1}`}
              className="w-full h-full object-cover cursor-pointer group-hover:scale-105 transition duration-200"
              loading="lazy"
              onClick={() => onImageClick?.(att.url)}
            />
          </div>
        ))}
      </div>
    );
  };

  const isHidden = isSensitive && !revealed;

  return (
    <div className={`${className} relative rounded-2xl overflow-hidden`}>
      <div className={isHidden ? 'filter blur-2xl scale-105 select-none pointer-events-none transition duration-300' : 'transition duration-300'}>
        {renderContent()}
      </div>

      {/* センシティブ警告オーバーレイ */}
      {isHidden && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setRevealed(true);
          }}
          className="absolute inset-0 z-10 bg-slate-950/75 backdrop-blur-md flex flex-col items-center justify-center p-4 text-center cursor-pointer group hover:bg-slate-950/65 transition rounded-2xl border border-amber-500/30"
        >
          <div className="w-11 h-11 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center mb-2 group-hover:scale-110 transition shadow-lg">
            <Eye className="w-5 h-5 text-amber-400" />
          </div>
          <span className="text-xs font-bold text-slate-200">閲覧注意 (センシティブなメディア)</span>
          <span className="text-[11px] text-slate-400 mt-0.5">クリックして表示</span>
        </div>
      )}

      {/* 表示中の「隠す」ボタン */}
      {isSensitive && revealed && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setRevealed(false);
          }}
          className="absolute top-2 right-2 z-10 px-2.5 py-1 rounded-xl bg-slate-950/80 hover:bg-slate-900 border border-slate-700/80 text-slate-300 hover:text-white text-[11px] font-semibold flex items-center space-x-1 shadow-md transition cursor-pointer backdrop-blur-sm"
          title="メディアを隠す"
        >
          <EyeOff className="w-3.5 h-3.5" />
          <span>隠す</span>
        </button>
      )}
    </div>
  );
}

// 💬 引用ノート（Quote）カード
function QuoteCard({
  quote,
  onClick,
  showCustomEmojis = true,
}: {
  quote: Post;
  onClick?: () => void;
  showCustomEmojis?: boolean;
}) {
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className="mt-3 rounded-2xl border border-slate-800 hover:border-indigo-500/50 bg-slate-950/80 hover:bg-slate-900/60 p-3.5 transition cursor-pointer group shadow-md"
    >
      {/* 著者情報 */}
      <div className="flex items-center space-x-2 mb-2 min-w-0">
        <div className="w-6 h-6 rounded-lg overflow-hidden bg-indigo-600 flex items-center justify-center font-bold text-xs text-white shrink-0">
          {quote.author_icon ? (
            <img src={quote.author_icon} alt={quote.author_name} className="w-full h-full object-cover" />
          ) : (
            quote.author_name?.slice(0, 1).toUpperCase() || 'U'
          )}
        </div>
        <span className="font-bold text-xs text-slate-200 group-hover:text-indigo-300 transition truncate">
          {quote.author_name}
        </span>
        <span className="text-[11px] text-slate-500 font-mono truncate">{quote.author_handle}</span>
        <span className="text-[10px] text-slate-600 shrink-0 ml-auto">
          {new Date(quote.published_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* CW (閲覧注意) 注記があれば */}
      {quote.cw && (
        <div className="text-[11px] font-semibold text-amber-400 mb-1 flex items-center space-x-1">
          <ShieldAlert className="w-3 h-3 text-amber-400" />
          <span>閲覧注意: {quote.cw}</span>
        </div>
      )}

      {/* 本文 (最大3行で省略) */}
      <div className="text-xs text-slate-300 line-clamp-3">
        <FormattedPostContent
          content={quote.content}
          emojis={quote.emojis}
          enableEmojis={showCustomEmojis}
        />
      </div>

      {/* メディアサムネイル (あれば) */}
      {quote.media_attachments && quote.media_attachments.length > 0 && (
        <div className="mt-2 flex gap-1.5 overflow-hidden rounded-xl max-h-20">
          {quote.media_attachments.slice(0, 4).map((att, idx) => (
            <div key={idx} className="relative h-16 w-20 bg-slate-900 rounded-lg overflow-hidden shrink-0 border border-slate-800">
              <img src={att.url} alt="" className={`w-full h-full object-cover ${quote.is_sensitive ? 'blur-md' : ''}`} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ✨ メンション & ハッシュタグ 入力補完ドロップダウン UI
function AutocompleteDropdown({
  type,
  suggestions,
  selectedIndex,
  onSelect,
}: {
  type: 'user' | 'tag' | null;
  suggestions: any[];
  selectedIndex: number;
  onSelect: (item: any) => void;
}) {
  if (!type || suggestions.length === 0) return null;

  return (
    <div className="absolute left-0 bottom-full mb-2 w-full sm:w-80 bg-slate-900/95 border border-slate-700/80 rounded-2xl shadow-2xl backdrop-blur-xl overflow-hidden z-30 animate-in fade-in zoom-in-95 duration-150">
      <div className="px-3 py-1.5 bg-slate-950/60 border-b border-slate-800 text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center justify-between">
        <span>{type === 'user' ? '👥 ユーザー候補' : '#️⃣ ハッシュタグ候補'}</span>
        <span className="text-[9px] text-slate-500 font-mono">↑↓で選択 / Enterで確定</span>
      </div>
      <div className="max-h-48 overflow-y-auto divide-y divide-slate-800/60">
        {suggestions.map((s, idx) => {
          const isSelected = idx === selectedIndex;
          if (type === 'user') {
            return (
              <button
                key={s.id || s.handle}
                type="button"
                onClick={() => onSelect(s)}
                className={`w-full text-left px-3 py-2 flex items-center space-x-2.5 transition cursor-pointer ${
                  isSelected ? 'bg-indigo-600/30 text-white font-semibold' : 'hover:bg-slate-800 text-slate-300'
                }`}
              >
                <div className="w-6 h-6 rounded-lg overflow-hidden bg-slate-800 shrink-0">
                  {s.icon_url ? (
                    <img src={s.icon_url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center font-bold text-white bg-indigo-600 text-xs">
                      {s.name?.slice(0, 1) || 'U'}
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-slate-100 truncate">{s.name}</p>
                  <p className="text-[10px] text-slate-400 font-mono truncate">{s.handle}</p>
                </div>
                {s.is_following && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/30">
                    フォロー中
                  </span>
                )}
              </button>
            );
          } else {
            return (
              <button
                key={s.tag}
                type="button"
                onClick={() => onSelect(s)}
                className={`w-full text-left px-3 py-2 flex items-center justify-between space-x-2 transition cursor-pointer ${
                  isSelected ? 'bg-indigo-600/30 text-white font-semibold' : 'hover:bg-slate-800 text-slate-300'
                }`}
              >
                <span className="text-xs font-bold text-indigo-300">#{s.tag}</span>
                {s.count !== undefined && (
                  <span className="text-[10px] text-slate-500 font-mono">{s.count}件のノート</span>
                )}
              </button>
            );
          }
        })}
      </div>
    </div>
  );
}

interface AuthUser {
  id: string;
  name: string;
  summary: string;
  icon_url?: string;
  banner_url?: string;
  role: 'admin' | 'user';
  handle: string;
  actorUrl: string;
  createdAt: string;
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
  email?: string;
  email_verified?: number;
  hasPassword?: boolean;
}

export interface PostReaction {
  reaction: string;
  count: number;
  me: boolean;
}

export interface MediaAttachment {
  url: string;
  mediaType: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  /** 動画のサムネイル（ffmpeg がある時のみ） */
  thumbnailUrl?: string;
  /** 動画の再生時間（秒） */
  duration?: number;
  /** ドライブのメディア ID（アップロード時に付与） */
  id?: string;
}

export interface PollChoice {
  choice_index: number;
  text: string;
  votes_count: number;
  me: boolean;
}

export interface PollData {
  id: string;
  multiple: boolean;
  expires_at: string | null;
  is_expired: boolean;
  total_votes: number;
  my_voted: boolean;
  choices: PollChoice[];
}

interface Post {
  id: string;
  feed_id?: string;
  user_id: string;
  author_name: string;
  author_url: string;
  author_handle: string;
  author_icon?: string;
  content: string;
  is_local: number;
  visibility?: 'public' | 'local' | 'followers';
  // 🔗 リンクプレビュー（OGPカード）
  link_preview?: {
    url: string;
    title?: string | null;
    description?: string | null;
    image_url?: string | null;
    site_name?: string | null;
  } | null;
  emojis?: string;
  in_reply_to?: string | null;
  media_attachments?: MediaAttachment[];
  published_at: string;
  timeline_at?: string;
  url?: string;
  renote?: {
    id: string;
    name: string;
    handle: string;
    icon?: string;
    url?: string;
    at: string;
  } | null;
  reactions?: PostReaction[];
  announce_count?: number;
  my_announced?: boolean;
  reply_count?: number;
  bookmarked?: boolean;
  cw?: string | null;
  quote_id?: string | null;
  quote?: Post | null;
  is_sensitive?: boolean;
  is_pinned?: boolean;
  poll?: PollData | null;
  channel_id?: string | null;
  channel?: {
    id: string;
    name: string;
    description?: string;
    banner_url?: string;
    color?: string;
  } | null;
}

export interface Channel {
  id: string;
  user_id: string;
  name: string;
  description: string;
  banner_url: string;
  color: string;
  category: string;
  is_archived: boolean;
  posts_count: number;
  followers_count: number;
  is_following?: boolean;
  created_at: string;
}

export interface WebAuthnCredential {
  id: string;
  device_name: string;
  counter: number;
  created_at: string;
  last_used_at: string | null;
}

export interface AppNotification {
  id: string;
  user_id: string;
  type: 'reply' | 'follow' | 'renote' | 'announce' | 'reaction' | 'antenna' | 'scheduled_published' | 'mention' | 'move';
  actor_id: string;
  actor_name: string;
  actor_handle: string;
  actor_icon: string;
  post_id: string | null;
  post_content: string;
  content: string;
  is_read: number;
  created_at: string;
}

export interface Antenna {
  id: string;
  user_id: string;
  name: string;
  src: 'all' | 'home' | 'users';
  user_list: string;
  keywords: string;
  exclude_keywords: string;
  case_sensitive: boolean;
  with_file: boolean;
  notify: boolean;
  created_at: string;
}

export interface Draft {
  id: string;
  user_id: string;
  content: string;
  cw: string;
  visibility: 'public' | 'local' | 'followers';
  media_attachments: MediaAttachment[];
  poll: any;
  in_reply_to: string;
  quote_id: string;
  updated_at: string;
  created_at: string;
}

export interface ScheduledPost {
  id: string;
  user_id: string;
  content: string;
  cw: string;
  visibility: 'public' | 'local' | 'followers';
  media_attachments: MediaAttachment[];
  poll: any;
  in_reply_to: string;
  quote_id: string;
  scheduled_at: string;
  status: 'pending' | 'published' | 'failed';
  error_message: string;
  created_at: string;
}

interface UserProfile {
  id: string;
  name: string;
  summary: string;
  icon_url: string;
  banner_url: string;
  handle: string;
  actor_url: string;
  domain: string;
  is_local: boolean;
  created_at: string;
  follower_count: number;
  following_count: number;
  post_count: number;
  is_following: boolean;
  is_blocked?: boolean;
  is_muted?: boolean;
  is_blocking_me?: boolean;
  pinned_posts?: Post[];
}

export interface CustomEmoji {
  id: string;
  name: string;
  url: string;
  category: string;
  aliases?: string;
}

export interface InvitationCode {
  code: string;
  created_by: string;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  memo: string;
  created_at: string;
}

interface ServerStats {
  name: string;
  description?: string;
  icon_url?: string;
  banner_url?: string;
  registration_mode?: 'open' | 'invite' | 'closed';
  tos_url?: string;
  privacy_policy_url?: string;
  contact_url?: string;
  repository_url?: string;
  operator_url?: string;
  server_rules?: string[];
  require_rules_agreement?: boolean;
  domain: string;
  origin: string;
  stats: {
    users: number;
    totalPosts: number;
    federatedPosts: number;
  };
}

// 📊 アンケート（Poll）表示コンポーネント (タイムライン & スレッド兼用)
function PollCard({
  poll,
  isVoting,
  onVote,
  isAuthenticated,
  onRequireLogin,
  isAuthor,
}: {
  poll: PollData;
  isVoting: boolean;
  onVote: (selectedIndices: number[]) => void;
  isAuthenticated: boolean;
  onRequireLogin: () => void;
  isAuthor?: boolean;
}) {
  const [selectedChoices, setSelectedChoices] = useState<number[]>([]);
  const [showGuestResults, setShowGuestResults] = useState<boolean>(false);

  const toggleChoice = (index: number) => {
    // 未ログイン時は選択肢クリックで即座にログインを要求
    if (!isAuthenticated) {
      onRequireLogin();
      return;
    }
    if (poll.multiple) {
      setSelectedChoices((prev) =>
        prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
      );
    } else {
      setSelectedChoices([index]);
    }
  };

  const handleVoteSubmit = () => {
    if (!isAuthenticated) {
      onRequireLogin();
      return;
    }
    if (selectedChoices.length === 0) return;
    onVote(selectedChoices);
  };

  const totalVotes = poll.total_votes || 0;
  // 投稿者本人、投票済み、期限切れ、または未ログイン者の結果プレビュー時はプログレスバーを表示
  const showResults = poll.my_voted || poll.is_expired || Boolean(isAuthor) || showGuestResults;

  return (
    <div className="mt-3 p-4 rounded-2xl bg-slate-950/60 border border-slate-800/80 space-y-3">
      {/* 選択肢リスト */}
      <div className="space-y-2">
        {poll.choices.map((choice) => {
          const percent = totalVotes > 0 ? Math.round((choice.votes_count / totalVotes) * 100) : 0;
          const isSelected = selectedChoices.includes(choice.choice_index);

          if (showResults) {
            // 結果表示モード（プログレスバー）
            return (
              <div key={choice.choice_index} className="relative overflow-hidden rounded-xl border border-slate-800/70 bg-slate-900/60 p-2.5">
                {/* 投票率バー */}
                <div
                  className={`absolute top-0 bottom-0 left-0 transition-all duration-500 rounded-r-lg ${
                    choice.me
                      ? 'bg-indigo-600/35 border-r-2 border-indigo-400'
                      : 'bg-slate-700/25'
                  }`}
                  style={{ width: `${percent}%` }}
                />
                <div className="relative flex items-center justify-between z-10 text-xs">
                  <div className="flex items-center space-x-2 font-medium text-slate-200">
                    {choice.me && (
                      <span className="text-emerald-400 font-bold flex items-center" title="あなたの投票">
                        <Check className="w-3.5 h-3.5" />
                      </span>
                    )}
                    <span>{choice.text}</span>
                  </div>
                  <div className="flex items-center space-x-2 font-mono text-[11px] text-slate-400 shrink-0">
                    <span>{choice.votes_count}票</span>
                    <span className="font-bold text-slate-300 w-9 text-right">{percent}%</span>
                  </div>
                </div>
              </div>
            );
          }

          // 投票前モード（ラジオ/チェックボックス選択）
          return (
            <button
              key={choice.choice_index}
              type="button"
              onClick={() => toggleChoice(choice.choice_index)}
              title={!isAuthenticated ? '投票するにはログインが必要です' : undefined}
              className={`w-full text-left p-3 rounded-xl border text-xs font-semibold flex items-center justify-between transition cursor-pointer ${
                isSelected
                  ? 'bg-indigo-600/20 border-indigo-500 text-indigo-200 shadow-sm'
                  : 'bg-slate-900/50 border-slate-800 text-slate-300 hover:bg-slate-800/60 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center space-x-2.5">
                <div
                  className={`w-4 h-4 flex items-center justify-center border transition ${
                    poll.multiple ? 'rounded-md' : 'rounded-full'
                  } ${
                    isSelected
                      ? 'bg-indigo-600 border-indigo-500 text-white'
                      : 'border-slate-600 bg-slate-950'
                  }`}
                >
                  {isSelected && <Check className="w-3 h-3" />}
                </div>
                <span>{choice.text}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* フッター情報 & 投票ボタン */}
      <div className="flex items-center justify-between pt-2 border-t border-slate-800/50 text-[11px] text-slate-400 gap-2">
        <div className="flex items-center space-x-2.5 flex-wrap">
          <span>{totalVotes} 票</span>
          <span>•</span>
          <span>{poll.multiple ? '複数回答可' : '単一回答'}</span>
          {isAuthor && (
            <>
              <span>•</span>
              <span className="text-indigo-400 font-medium">作成者</span>
            </>
          )}
          {poll.expires_at && (
            <>
              <span>•</span>
              <span className={poll.is_expired ? 'text-rose-400' : 'text-slate-400'}>
                {poll.is_expired
                  ? '受付終了'
                  : `終了: ${new Date(poll.expires_at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
              </span>
            </>
          )}
        </div>

        {/* 投票ボタン / ログイン誘導 / 結果表示切り替え */}
        <div className="flex items-center space-x-2 shrink-0">
          {!isAuthenticated ? (
            // 未ログイン時
            <>
              {!isAuthor && !poll.is_expired && (
                <button
                  type="button"
                  onClick={() => setShowGuestResults((prev) => !prev)}
                  className="text-[11px] text-slate-400 hover:text-indigo-300 transition underline underline-offset-2 cursor-pointer"
                >
                  {showGuestResults ? '投票に戻る' : '結果を見る'}
                </button>
              )}
              <button
                type="button"
                onClick={onRequireLogin}
                className="px-3 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 hover:border-indigo-500/60 font-bold text-xs rounded-xl shadow transition cursor-pointer flex items-center space-x-1.5"
                title="投票するにはログインが必要です"
              >
                <Lock className="w-3 h-3" />
                <span>ログインして投票</span>
              </button>
            </>
          ) : (
            // ログイン済み時
            !showResults && (
              <button
                type="button"
                onClick={handleVoteSubmit}
                disabled={selectedChoices.length === 0 || isVoting}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-40 text-white font-bold text-xs rounded-xl shadow transition cursor-pointer flex items-center space-x-1"
              >
                {isVoting ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : (
                  <span>投票する</span>
                )}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// 📊 アンケート作成エディター（投稿フォーム用）
function PollInputEditor({
  choices,
  onChangeChoices,
  multiple,
  onChangeMultiple,
  expiresIn,
  onChangeExpiresIn,
  onClose,
}: {
  choices: string[];
  onChangeChoices: (choices: string[]) => void;
  multiple: boolean;
  onChangeMultiple: (m: boolean) => void;
  expiresIn: number;
  onChangeExpiresIn: (sec: number) => void;
  onClose: () => void;
}) {
  const handleChoiceTextChange = (index: number, text: string) => {
    const updated = [...choices];
    updated[index] = text;
    onChangeChoices(updated);
  };

  const addChoice = () => {
    if (choices.length < 6) {
      onChangeChoices([...choices, '']);
    }
  };

  const removeChoice = (index: number) => {
    if (choices.length > 2) {
      onChangeChoices(choices.filter((_, i) => i !== index));
    }
  };

  return (
    <div className="p-3.5 rounded-2xl bg-slate-950/80 border border-indigo-500/30 space-y-2.5 animate-in fade-in duration-150">
      <div className="flex items-center justify-between pb-1 border-b border-slate-800">
        <span className="text-xs font-bold text-indigo-300 flex items-center space-x-1.5">
          <BarChart2 className="w-3.5 h-3.5 text-indigo-400" />
          <span>📊 アンケート設定</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="p-1 text-slate-500 hover:text-rose-400 rounded-lg transition"
          title="アンケートを取り消す"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 選択肢リスト */}
      <div className="space-y-1.5">
        {choices.map((choice, idx) => (
          <div key={idx} className="flex items-center space-x-2">
            <span className="text-[11px] font-mono text-slate-500 w-4 text-center">{idx + 1}.</span>
            <input
              type="text"
              value={choice}
              onChange={(e) => handleChoiceTextChange(idx, e.target.value)}
              placeholder={`選択肢 ${idx + 1}`}
              maxLength={100}
              className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:ring-1 focus:ring-indigo-500 focus:outline-none transition"
            />
            {choices.length > 2 && (
              <button
                type="button"
                onClick={() => removeChoice(idx)}
                className="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-slate-800 transition"
                title="選択肢を削除"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
      </div>

      {choices.length < 6 && (
        <button
          type="button"
          onClick={addChoice}
          className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold px-2 py-1 rounded-lg hover:bg-indigo-950/30 transition flex items-center space-x-1 cursor-pointer"
        >
          <span>＋ 選択肢を追加 (最大6個)</span>
        </button>
      )}

      {/* オプション設定: 期限・複数選択 */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800 text-xs text-slate-400">
        <label className="flex items-center space-x-2 cursor-pointer">
          <input
            type="checkbox"
            checked={multiple}
            onChange={(e) => onChangeMultiple(e.target.checked)}
            className="rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5"
          />
          <span className="text-slate-300 text-[11px]">複数回答を許可</span>
        </label>

        <div className="flex items-center space-x-1.5 text-[11px]">
          <span className="text-slate-500">投票期限:</span>
          <select
            value={expiresIn}
            onChange={(e) => onChangeExpiresIn(Number(e.target.value))}
            className="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-slate-200 text-[11px] focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value={1800}>30分</option>
            <option value={3600}>1時間</option>
            <option value={21600}>6時間</option>
            <option value={86400}>1日</option>
            <option value={259200}>3日</option>
            <option value={604800}>7日</option>
          </select>
        </div>
      </div>
    </div>
  );
}

// 📡 アンテナ作成・編集モーダル
function AntennaEditModal({
  initialData,
  onSave,
  onClose,
}: {
  initialData: Partial<Antenna> | null;
  onSave: (data: Partial<Antenna>) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState<string>(initialData?.name || '');
  const [src, setSrc] = useState<'all' | 'home' | 'users'>(initialData?.src || 'all');
  const [userList, setUserList] = useState<string>(initialData?.user_list || '');
  const [keywords, setKeywords] = useState<string>(initialData?.keywords || '');
  const [excludeKeywords, setExcludeKeywords] = useState<string>(initialData?.exclude_keywords || '');
  const [caseSensitive, setCaseSensitive] = useState<boolean>(Boolean(initialData?.case_sensitive));
  const [withFile, setWithFile] = useState<boolean>(Boolean(initialData?.with_file));
  const [notify, setNotify] = useState<boolean>(Boolean(initialData?.notify));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      alert('アンテナ名を入力してください。');
      return;
    }
    if (!keywords.trim() && src === 'all') {
      alert('全ノートを対象にする場合は、キーワードを1つ以上入力してください。');
      return;
    }
    onSave({
      id: initialData?.id,
      name: name.trim(),
      src,
      user_list: userList.trim(),
      keywords: keywords.trim(),
      exclude_keywords: excludeKeywords.trim(),
      case_sensitive: caseSensitive,
      with_file: withFile,
      notify,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700/80 rounded-3xl max-w-lg w-full p-5 sm:p-6 shadow-2xl space-y-4 my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center space-x-2 text-emerald-400">
            <Radio className="w-5 h-5" />
            <h3 className="font-bold text-base text-slate-100">
              {initialData?.id ? 'アンテナの編集' : 'アンテナの新規作成'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* アンテナ名 */}
          <div>
            <label className="block font-bold text-slate-300 mb-1">
              アンテナ名 <span className="text-rose-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: イラスト, Spica, 猫画像"
              maxLength={50}
              required
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition"
            />
          </div>

          {/* 受信ソース */}
          <div>
            <label className="block font-bold text-slate-300 mb-1">受信ソース</label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setSrc('all')}
                className={`py-2 px-3 rounded-xl font-bold border transition text-center cursor-pointer ${
                  src === 'all'
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 shadow-sm'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-800'
                }`}
              >
                全ノート (連合含む)
              </button>
              <button
                type="button"
                onClick={() => setSrc('home')}
                className={`py-2 px-3 rounded-xl font-bold border transition text-center cursor-pointer ${
                  src === 'home'
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 shadow-sm'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-800'
                }`}
              >
                ホーム (フォロー中)
              </button>
              <button
                type="button"
                onClick={() => setSrc('users')}
                className={`py-2 px-3 rounded-xl font-bold border transition text-center cursor-pointer ${
                  src === 'users'
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 shadow-sm'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-800'
                }`}
              >
                指定ユーザー
              </button>
            </div>
          </div>

          {/* 指定ユーザーの場合 */}
          {src === 'users' && (
            <div>
              <label className="block font-bold text-slate-300 mb-1">
                指定ユーザー名 (カンマ区切り)
              </label>
              <input
                type="text"
                value={userList}
                onChange={(e) => setUserList(e.target.value)}
                placeholder="例: alice, bob@example.com"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition"
              />
            </div>
          )}

          {/* 含めるキーワード */}
          <div>
            <label className="block font-bold text-slate-300 mb-1">
              含めるキーワード (スペースまたはカンマ区切り)
            </label>
            <input
              type="text"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="例: イラスト 創作 ドット絵"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition"
            />
            <p className="text-[10px] text-slate-500 mt-1">
              いずれかのキーワードを含むノートを自動収集します。空の場合は指定ソースの全ノートが対象になります。
            </p>
          </div>

          {/* 除外するキーワード */}
          <div>
            <label className="block font-bold text-slate-300 mb-1">
              除外するキーワード (スペースまたはカンマ区切り)
            </label>
            <input
              type="text"
              value={excludeKeywords}
              onChange={(e) => setExcludeKeywords(e.target.value)}
              placeholder="例: bot スパム ネタバレ"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition"
            />
          </div>

          {/* オプションチェックボックス */}
          <div className="space-y-2 pt-2 border-t border-slate-800/60">
            <label className="flex items-center space-x-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={withFile}
                onChange={(e) => setWithFile(e.target.checked)}
                className="rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-emerald-500 w-4 h-4"
              />
              <span className="text-slate-300 font-medium">画像・動画などメディア添付があるノートのみ</span>
            </label>

            <label className="flex items-center space-x-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
                className="rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-emerald-500 w-4 h-4"
              />
              <span className="text-slate-300 font-medium">大文字・小文字を厳密に区別する</span>
            </label>

            <label className="flex items-center space-x-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={notify}
                onChange={(e) => setNotify(e.target.checked)}
                className="rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-emerald-500 w-4 h-4"
              />
              <span className="text-slate-300 font-medium">マッチした新着投稿を受信した時に通知する</span>
            </label>
          </div>

          <div className="flex items-center justify-end space-x-3 pt-4 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
            >
              キャンセル
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950 font-bold shadow-lg shadow-emerald-500/20 transition cursor-pointer"
            >
              {initialData?.id ? 'アンテナを更新' : 'アンテナを作成'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// 📡 アンテナ管理・一覧モーダル
function AntennaManageModal({
  antennas,
  activeAntenna,
  onSelectAntenna,
  onOpenCreate,
  onEditAntenna,
  onDeleteAntenna,
  onClose,
}: {
  antennas: Antenna[];
  activeAntenna: Antenna | null;
  onSelectAntenna: (ant: Antenna) => void;
  onOpenCreate: () => void;
  onEditAntenna: (ant: Antenna) => void;
  onDeleteAntenna: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700/80 rounded-3xl max-w-lg w-full p-5 sm:p-6 shadow-2xl space-y-4 my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center space-x-2 text-emerald-400">
            <Radio className="w-5 h-5" />
            <h3 className="font-bold text-base text-slate-100">
              アンテナ管理 ({antennas.length})
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 新規作成ボタン */}
        <button
          type="button"
          onClick={() => {
            onClose();
            onOpenCreate();
          }}
          className="w-full py-2.5 px-4 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 rounded-2xl font-bold text-xs transition flex items-center justify-center space-x-2 cursor-pointer shadow-sm"
        >
          <Plus className="w-4 h-4" />
          <span>新しいアンテナを作成する</span>
        </button>

        <div className="max-h-96 overflow-y-auto space-y-2.5 pr-1">
          {antennas.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-xs space-y-2">
              <Radio className="w-8 h-8 mx-auto opacity-40 text-slate-400" />
              <p>アンテナはまだ作成されていません。</p>
              <p className="text-emerald-400 font-semibold">
                上のボタンからキーワードを設定してアンテナを作成しましょう！
              </p>
            </div>
          ) : (
            antennas.map((ant) => (
              <div
                key={ant.id}
                className={`p-3.5 rounded-2xl border transition space-y-2 group ${
                  activeAntenna?.id === ant.id
                    ? 'bg-emerald-500/10 border-emerald-500/50'
                    : 'bg-slate-950/70 border-slate-800/80 hover:border-emerald-500/30'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <Radio className="w-4 h-4 text-emerald-400" />
                    <span className="font-bold text-sm text-slate-200">{ant.name}</span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300">
                      {ant.src === 'home' ? 'ホームのみ' : ant.src === 'users' ? '指定ユーザー' : '全ノート'}
                    </span>
                    {ant.with_file ? (
                      <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-indigo-500/20 text-indigo-300">
                        メディアあり
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center space-x-1">
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onEditAntenna(ant);
                      }}
                      className="p-1.5 text-slate-400 hover:text-indigo-300 rounded-lg hover:bg-slate-800 transition cursor-pointer"
                      title="アンテナを編集"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteAntenna(ant.id)}
                      className="p-1.5 text-slate-400 hover:text-rose-400 rounded-lg hover:bg-slate-800 transition cursor-pointer"
                      title="アンテナを削除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="text-xs text-slate-400 space-y-1">
                  {ant.keywords && (
                    <p className="flex items-center space-x-1 text-[11px]">
                      <span className="text-slate-500">キーワード:</span>
                      <span className="text-emerald-300 font-mono font-bold">{ant.keywords}</span>
                    </p>
                  )}
                  {ant.exclude_keywords && (
                    <p className="flex items-center space-x-1 text-[11px]">
                      <span className="text-slate-500">除外:</span>
                      <span className="text-rose-400 font-mono">{ant.exclude_keywords}</span>
                    </p>
                  )}
                </div>

                <div className="pt-1 flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectAntenna(ant);
                      onClose();
                    }}
                    className={`px-3 py-1 rounded-xl text-xs font-bold transition flex items-center space-x-1 cursor-pointer ${
                      activeAntenna?.id === ant.id
                        ? 'bg-emerald-500 text-slate-950 shadow-md'
                        : 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40'
                    }`}
                  >
                    <span>{activeAntenna?.id === ant.id ? '表示中' : 'このアンテナを表示'}</span>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// 📝 下書き一覧モーダル
function DraftsModal({
  drafts,
  hasCurrentContent,
  onSaveCurrent,
  onLoadDraft,
  onDeleteDraft,
  onClose,
}: {
  drafts: Draft[];
  hasCurrentContent: boolean;
  onSaveCurrent: () => void;
  onLoadDraft: (draft: Draft) => void;
  onDeleteDraft: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700/80 rounded-3xl max-w-lg w-full p-5 sm:p-6 shadow-2xl space-y-4 my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center space-x-2 text-cyan-400">
            <FileText className="w-5 h-5" />
            <h3 className="font-bold text-base text-slate-100">
              下書き一覧 ({drafts.length})
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 現在の入力内容を下書き保存ボタン */}
        {hasCurrentContent && (
          <button
            type="button"
            onClick={onSaveCurrent}
            className="w-full py-2.5 px-4 bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-300 border border-cyan-500/40 rounded-2xl font-bold text-xs transition flex items-center justify-center space-x-2 cursor-pointer shadow-sm"
          >
            <Plus className="w-4 h-4" />
            <span>現在の入力内容を新しく下書き保存する</span>
          </button>
        )}

        <div className="max-h-96 overflow-y-auto space-y-2.5 pr-1">
          {drafts.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-xs space-y-2">
              <FileText className="w-8 h-8 mx-auto opacity-40 text-slate-400" />
              <p>保存された下書きはありません。</p>
              {hasCurrentContent && (
                <p className="text-cyan-400 font-semibold">
                  上のボタンを押すと現在のノートを下書き保存できます。
                </p>
              )}
            </div>
          ) : (
            drafts.map((draft) => (
              <div
                key={draft.id}
                className="p-3.5 rounded-2xl bg-slate-950/70 border border-slate-800/80 hover:border-cyan-500/40 transition space-y-2 group"
              >
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <div className="flex items-center space-x-2">
                    <span className="font-mono">
                      {new Date(draft.updated_at).toLocaleString('ja-JP')}
                    </span>
                    <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${
                      draft.visibility === 'local'
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : draft.visibility === 'followers'
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-indigo-500/20 text-indigo-300'
                    }`}>
                      {draft.visibility === 'local' ? 'ローカル' : draft.visibility === 'followers' ? '🔒 フォロワー' : '連合'}
                    </span>
                    {draft.media_attachments && draft.media_attachments.length > 0 && (
                      <span className="px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 text-[9px] font-bold">
                        画像 {draft.media_attachments.length}枚
                      </span>
                    )}
                    {draft.poll && (
                      <span className="px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 text-[9px] font-bold">
                        アンケート
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onDeleteDraft(draft.id)}
                    className="p-1 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-slate-800 transition cursor-pointer"
                    title="下書きを削除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {draft.cw && (
                  <div className="text-amber-300 text-xs font-semibold px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 w-fit">
                    CW: {draft.cw}
                  </div>
                )}

                <p className="text-xs text-slate-200 line-clamp-3 whitespace-pre-wrap">
                  {draft.content || <span className="text-slate-500 italic">（本文なし・メディアのみ）</span>}
                </p>

                <div className="pt-1 flex justify-end">
                  <button
                    type="button"
                    onClick={() => onLoadDraft(draft)}
                    className="px-3 py-1 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 rounded-xl text-xs font-bold transition flex items-center space-x-1 cursor-pointer"
                  >
                    <Edit3 className="w-3 h-3" />
                    <span>フォームに読み込む</span>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ⏰ 予約投稿モーダル
function ScheduleModal({
  scheduledPosts,
  scheduledDateTime,
  setScheduledDateTime,
  hasCurrentContent,
  onSubmitSchedule,
  onCancelScheduledPost,
  onClose,
}: {
  scheduledPosts: ScheduledPost[];
  scheduledDateTime: string;
  setScheduledDateTime: (dt: string) => void;
  hasCurrentContent: boolean;
  onSubmitSchedule: () => void;
  onCancelScheduledPost: (id: string) => void;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'new' | 'list'>('new');

  // クイックプリセット日時設定ヘルパー
  const setPresetTime = (minutesFromNow: number) => {
    const target = new Date(Date.now() + minutesFromNow * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const formatted = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}`;
    setScheduledDateTime(formatted);
  };

  const setPresetTomorrow = (hour: number, minute: number) => {
    const target = new Date();
    target.setDate(target.getDate() + 1);
    target.setHours(hour, minute, 0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    const formatted = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}`;
    setScheduledDateTime(formatted);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700/80 rounded-3xl max-w-lg w-full p-5 sm:p-6 shadow-2xl space-y-4 my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center space-x-2 text-amber-400">
            <Clock className="w-5 h-5" />
            <h3 className="font-bold text-base text-slate-100">予約投稿</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* タブ切り替え */}
        <div className="flex space-x-2 bg-slate-950 p-1 rounded-2xl border border-slate-800">
          <button
            type="button"
            onClick={() => setActiveTab('new')}
            className={`flex-1 py-1.5 text-xs font-bold rounded-xl transition flex items-center justify-center space-x-1.5 cursor-pointer ${
              activeTab === 'new'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>日時を指定して予約</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('list')}
            className={`flex-1 py-1.5 text-xs font-bold rounded-xl transition flex items-center justify-center space-x-1.5 cursor-pointer ${
              activeTab === 'list'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FolderArchive className="w-3.5 h-3.5" />
            <span>予約済み一覧 ({scheduledPosts.length})</span>
          </button>
        </div>

        {activeTab === 'new' ? (
          <div className="space-y-4 text-xs">
            {!hasCurrentContent ? (
              <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-2xl text-amber-300 space-y-1">
                <p className="font-bold">⚠️ 予約する投稿が入力されていません</p>
                <p className="text-[11px] text-amber-400/80">
                  予約投稿を行うには、まず背面の投稿フォームに本文や画像を入力してください。
                </p>
              </div>
            ) : (
              <>
                <div>
                  <label className="block font-bold text-slate-300 mb-1.5">
                    公開予定日時 <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={scheduledDateTime}
                    onChange={(e) => setScheduledDateTime(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 transition font-mono"
                  />
                </div>

                {/* クイック日時プリセットボタン */}
                <div>
                  <label className="block text-[11px] font-bold text-slate-400 mb-1.5">
                    クイック指定
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setPresetTime(30)}
                      className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 hover:text-amber-300 hover:border-amber-500/40 transition cursor-pointer text-[11px]"
                    >
                      30分後
                    </button>
                    <button
                      type="button"
                      onClick={() => setPresetTime(60)}
                      className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 hover:text-amber-300 hover:border-amber-500/40 transition cursor-pointer text-[11px]"
                    >
                      1時間後
                    </button>
                    <button
                      type="button"
                      onClick={() => setPresetTime(180)}
                      className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 hover:text-amber-300 hover:border-amber-500/40 transition cursor-pointer text-[11px]"
                    >
                      3時間後
                    </button>
                    <button
                      type="button"
                      onClick={() => setPresetTomorrow(8, 0)}
                      className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 hover:text-amber-300 hover:border-amber-500/40 transition cursor-pointer text-[11px]"
                    >
                      明日の朝 08:00
                    </button>
                    <button
                      type="button"
                      onClick={() => setPresetTomorrow(20, 0)}
                      className="px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 hover:text-amber-300 hover:border-amber-500/40 transition cursor-pointer text-[11px]"
                    >
                      明日の夜 20:00
                    </button>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800/80 text-[11px] text-slate-400 space-y-1">
                  <p className="font-semibold text-slate-300">💡 予約投稿の動作:</p>
                  <p>
                    指定した日時にサーバーのバックグラウンドスケジューラが自動で公開投稿（ActivityPub連合配信を含む）を行います。ブラウザを閉じていても問題ありません。
                  </p>
                </div>

                <div className="flex items-center justify-end space-x-3 pt-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition cursor-pointer"
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    onClick={onSubmitSchedule}
                    className="px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-slate-950 font-bold shadow-lg shadow-amber-500/20 transition flex items-center space-x-1.5 cursor-pointer"
                  >
                    <Clock className="w-3.5 h-3.5" />
                    <span>この日時で予約する</span>
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="max-h-96 overflow-y-auto space-y-2.5 pr-1">
              {scheduledPosts.length === 0 ? (
                <div className="py-12 text-center text-slate-500 text-xs space-y-2">
                  <Clock className="w-8 h-8 mx-auto opacity-40 text-slate-400" />
                  <p>待機中の予約投稿はありません。</p>
                </div>
              ) : (
                scheduledPosts.map((sp) => (
                  <div
                    key={sp.id}
                    className="p-3.5 rounded-2xl bg-slate-950/70 border border-slate-800/80 space-y-2"
                  >
                    <div className="flex items-center justify-between text-[11px]">
                      <div className="flex items-center space-x-2">
                        <span className="px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30 flex items-center space-x-1">
                          <Clock className="w-3 h-3" />
                          <span>{new Date(sp.scheduled_at).toLocaleString('ja-JP')}</span>
                        </span>
                        <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${
                          sp.status === 'pending' ? 'bg-cyan-500/20 text-cyan-300' : 'bg-slate-700 text-slate-300'
                        }`}>
                          {sp.status === 'pending' ? '公開待機中' : sp.status}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => onCancelScheduledPost(sp.id)}
                        className="text-rose-400 hover:text-rose-300 text-xs font-semibold hover:underline flex items-center space-x-1 cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>予約を解除</span>
                      </button>
                    </div>

                    {sp.cw && (
                      <div className="text-amber-300 text-xs font-semibold px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 w-fit">
                        CW: {sp.cw}
                      </div>
                    )}

                    <p className="text-xs text-slate-200 line-clamp-3 whitespace-pre-wrap">
                      {sp.content || <span className="text-slate-500 italic">（本文なし・メディアのみ）</span>}
                    </p>

                    {sp.media_attachments && sp.media_attachments.length > 0 && (
                      <span className="inline-block px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 text-[10px]">
                        添付画像 {sp.media_attachments.length}枚
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  // 現在のページビュー: 'timeline' | 'admin' | 'profile' | 'settings' | 'notifications' | 'search' | 'bookmarks' | 'channels'
  const [currentView, setCurrentView] = useState<'timeline' | 'admin' | 'profile' | 'settings' | 'notifications' | 'search' | 'bookmarks' | 'channels'>('timeline');

  // 🎨 テーマ & アクセントカラー設定 (localStorage 永続化)
  const [themeMode, setThemeMode] = useState<'dark' | 'pure_black' | 'light'>(() => {
    return (localStorage.getItem('spica_theme_mode') as any) || 'dark';
  });
  const [accentColor, setAccentColor] = useState<'indigo' | 'cyan' | 'emerald' | 'purple' | 'rose' | 'amber'>(() => {
    return (localStorage.getItem('spica_accent_color') as any) || 'indigo';
  });

  // DOM 属性への即時テーマ適用
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeMode);
    document.body.setAttribute('data-theme', themeMode);
    localStorage.setItem('spica_theme_mode', themeMode);
  }, [themeMode]);

  useEffect(() => {
    document.documentElement.setAttribute('data-accent', accentColor);
    document.body.setAttribute('data-accent', accentColor);
    localStorage.setItem('spica_accent_color', accentColor);
  }, [accentColor]);

  // 📢 チャンネル機能関連ステート
  const [channels, setChannels] = useState<Channel[]>([]);
  const [isLoadingChannels, setIsLoadingChannels] = useState<boolean>(false);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [channelTimelinePosts, setChannelTimelinePosts] = useState<Post[]>([]);
  const [isLoadingChannelTimeline, setIsLoadingChannelTimeline] = useState<boolean>(false);
  const [channelCategoryFilter, setChannelCategoryFilter] = useState<string>('all');
  const [showCreateChannelModal, setShowCreateChannelModal] = useState<boolean>(false);
  const [newChannelName, setNewChannelName] = useState<string>('');
  const [newChannelDesc, setNewChannelDesc] = useState<string>('');
  const [newChannelColor, setNewChannelColor] = useState<string>('#6366f1');
  const [newChannelCategory, setNewChannelCategory] = useState<string>('general');
  const [isCreatingChannel, setIsCreatingChannel] = useState<boolean>(false);
  const [postTargetChannelId, setPostTargetChannelId] = useState<string | null>(null); // 投稿先チャンネル
  const [showPostExtraMenu, setShowPostExtraMenu] = useState<boolean>(false); // 🍔 投稿オプション・ハンバーガーメニュー開閉
  const postExtraMenuRef = useRef<HTMLDivElement>(null);

  // 外部クリック検知で投稿オプションメニューを閉じる
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (postExtraMenuRef.current && !postExtraMenuRef.current.contains(e.target as Node)) {
        setShowPostExtraMenu(false);
      }
    }
    if (showPostExtraMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showPostExtraMenu]);

  // 🔐 WebAuthn / パスキー生体認証関連ステート
  const [passkeys, setPasskeys] = useState<WebAuthnCredential[]>([]);
  const [isLoadingPasskeys, setIsLoadingPasskeys] = useState<boolean>(false);
  const [isRegisteringPasskey, setIsRegisteringPasskey] = useState<boolean>(false);
  const [isLoggingInWithPasskey, setIsLoggingInWithPasskey] = useState<boolean>(false);
  const [passkeyDeviceName, setPasskeyDeviceName] = useState<string>('');
  const [passkeyActionMessage, setPasskeyActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 📊 アンケート（Poll）作成ステート
  const [showPollInput, setShowPollInput] = useState<boolean>(false);
  const [pollChoices, setPollChoices] = useState<string[]>(['', '']);
  const [pollMultiple, setPollMultiple] = useState<boolean>(false);
  const [pollExpiresIn, setPollExpiresIn] = useState<number>(86400); // 1日
  const [isVotingPoll, setIsVotingPoll] = useState<string | null>(null);

  // 📡 リアルタイム SSE ストリーミング関連ステート
  const [isStreamingConnected, setIsStreamingConnected] = useState<boolean>(false);
  const [newPostsQueue, setNewPostsQueue] = useState<Post[]>([]);
  const [notificationToast, setNotificationToast] = useState<AppNotification | null>(null);

  // 通知ステート
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadNotificationsCount, setUnreadNotificationsCount] = useState<number>(0);
  const [isLoadingNotifications, setIsLoadingNotifications] = useState<boolean>(false);
  const [notificationFilter, setNotificationFilter] = useState<'all' | 'reply' | 'reaction' | 'follow'>('all');

  // ブックマークステート
  const [bookmarks, setBookmarks] = useState<Post[]>([]);
  const [isLoadingBookmarks, setIsLoadingBookmarks] = useState<boolean>(false);

  // ブロック・ミュート管理ステート
  const [blockedUsers, setBlockedUsers] = useState<any[]>([]);
  const [mutedUsers, setMutedUsers] = useState<any[]>([]);
  const [isLoadingBlocksMutes, setIsLoadingBlocksMutes] = useState<boolean>(false);

  // 🔇 ワードフィルター / 🔒 フォローリクエスト
  const [mutedWords, setMutedWords] = useState<any[]>([]);
  const [newMutedWord, setNewMutedWord] = useState<string>('');
  const [mutedWordCaseSensitive, setMutedWordCaseSensitive] = useState<boolean>(false);
  const [mutedWordWholeWord, setMutedWordWholeWord] = useState<boolean>(false);
  const [isSavingMutedWord, setIsSavingMutedWord] = useState<boolean>(false);
  const [followRequests, setFollowRequests] = useState<any[]>([]);
  const [isRespondingRequest, setIsRespondingRequest] = useState<string | null>(null);
  const [profileIsLocked, setProfileIsLocked] = useState<boolean>(false);

  // 投稿ドロップダウンメニュー用ステート
  const [activeMenuPostId, setActiveMenuPostId] = useState<string | null>(null);

  // クライアント環境設定 (localStorage 永続化)
  const [defaultVisibility, setDefaultVisibility] = useState<'public' | 'local' | 'followers'>(() => {
    const val = localStorage.getItem('spica_pref_visibility') || localStorage.getItem('astrabit_pref_visibility');
    return (val === 'local' || val === 'followers') ? val : 'public';
  });
  const [defaultTimeline, setDefaultTimeline] = useState<'local' | 'home' | 'all'>(() => {
    const val = localStorage.getItem('spica_pref_timeline') || localStorage.getItem('astrabit_pref_timeline');
    return (val as 'local' | 'home' | 'all') || 'local';
  });
  const [showCustomEmojis, setShowCustomEmojis] = useState<boolean>(() => {
    const v = localStorage.getItem('spica_pref_emojis') ?? localStorage.getItem('astrabit_pref_emojis');
    return v === null ? true : v === 'true';
  });

  // ユーザー設定画面ステート
  const [settingsTab, setSettingsTab] = useState<'profile' | 'preferences' | 'account' | 'session' | 'mutes_blocks'>('profile');
  const [settingsMessage, setSettingsMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 認証ステート
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(localStorage.getItem('spica_token') || localStorage.getItem('astrabit_token'));

  // 認証ポータル (Misskey風ウェルカム・ログイン・登録画面: 未ログイン時は初期起動で自動表示)
  const [showAuthPortal, setShowAuthPortal] = useState<boolean>(!Boolean(localStorage.getItem('spica_token') || localStorage.getItem('astrabit_token')));
  const [authPortalTab, setAuthPortalTab] = useState<'welcome' | 'rules_agreement' | 'login' | 'register'>('welcome');
  const [showServerMenuPopover, setShowServerMenuPopover] = useState<boolean>(false);

  // 新規登録時の同意ステート
  const [agreeRules, setAgreeRules] = useState<boolean>(false);
  const [agreeTosPrivacy, setAgreeTosPrivacy] = useState<boolean>(false);
  const [agreeBasicNotes, setAgreeBasicNotes] = useState<boolean>(false);
  const [hasAgreedToRules, setHasAgreedToRules] = useState<boolean>(false);
  const [expandedAccordions, setExpandedAccordions] = useState<{ rules: boolean; tos: boolean; basic: boolean }>({
    rules: true,
    tos: true,
    basic: true,
  });

  // データエクスポートステート
  const [isExportingData, setIsExportingData] = useState<boolean>(false);
  const [exportingFormat, setExportingFormat] = useState<'json' | 'zip' | null>(null);
  // 📦 引っ越し（Move）の状態
  const [migrationInfo, setMigrationInfo] = useState<{ actorUrl: string; movedTo: string; alsoKnownAs: string; followers: number }>({
    actorUrl: '',
    movedTo: '',
    alsoKnownAs: '',
    followers: 0,
  });
  const [migrationAliasInput, setMigrationAliasInput] = useState<string>('');
  const [migrationTargetInput, setMigrationTargetInput] = useState<string>('');
  const [migrationMsg, setMigrationMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isMigrating, setIsMigrating] = useState<boolean>(false);

  const setShowLoginModal = (show: boolean) => {
    if (show) {
      setAuthError(null);
      setAuthPortalTab('login');
      setShowAuthPortal(true);
    } else {
      setShowAuthPortal(false);
    }
  };

  const setShowRegisterModal = (show: boolean) => {
    if (show) {
      setAuthError(null);
      setAgreeRules(false);
      setAgreeTosPrivacy(false);
      setAgreeBasicNotes(false);
      const hasRules = (serverStats?.server_rules && serverStats.server_rules.length > 0) || serverStats?.tos_url || serverStats?.privacy_policy_url;
      if (serverStats?.require_rules_agreement && hasRules) {
        setAuthPortalTab('rules_agreement');
      } else {
        setAuthPortalTab('register');
      }
      setShowAuthPortal(true);
    } else {
      setShowAuthPortal(false);
    }
  };

  const openWelcomePortal = () => {
    setAuthError(null);
    setAuthPortalTab('welcome');
    setShowAuthPortal(true);
  };

  const [showMasterKeyModal, setShowMasterKeyModal] = useState<boolean>(false);
  const [issuedMasterKey, setIssuedMasterKey] = useState<string>('');
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [hasConfirmedSaved, setHasConfirmedSaved] = useState<boolean>(false);

  // 登録・ログインフォーム
  const [loginId, setLoginId] = useState<string>('');
  const [loginKey, setLoginKey] = useState<string>('');
  const [loginPassword, setLoginPassword] = useState<string>('');
  // ログイン画面で表示する方式 (auth_mode = password のときはパスワード方式を既定にする)
  const [loginMethod, setLoginMethod] = useState<'master_key' | 'password'>('master_key');
  const [regId, setRegId] = useState<string>('');
  const [regName, setRegName] = useState<string>('');
  const [regBio, setRegBio] = useState<string>('');
  const [regEmail, setRegEmail] = useState<string>('');
  const [regPassword, setRegPassword] = useState<string>('');
  const [regPasswordConfirm, setRegPasswordConfirm] = useState<string>('');
  // 登録前のメール確認コード（SMTP 設定済みのサーバーでのみ使う）
  const [regEmailCode, setRegEmailCode] = useState<string>('');
  const [isSendingRegCode, setIsSendingRegCode] = useState<boolean>(false);
  const [regCodeMsg, setRegCodeMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // タイムライン ('local' = 自ノードのみ, 'home' = 自ノード+フォロー中, 'all' = 連合・リレー含む全件, 'tag' = ハッシュタグ, 'antenna' = アンテナ)
  const [timeline, setTimeline] = useState<Post[]>([]);
  const [timelineMode, setTimelineMode] = useState<'local' | 'home' | 'all' | 'tag' | 'antenna'>(defaultTimeline);
  const [activeHashtag, setActiveHashtag] = useState<string>('');
  // サーバーが返す X-Next-Cursor（続きがある場合のみ）。過去のノート追加読み込みに使う
  const [timelineCursor, setTimelineCursor] = useState<string | null>(null);
  const [isLoadingOlderPosts, setIsLoadingOlderPosts] = useState<boolean>(false);
  const [followingUrls, setFollowingUrls] = useState<Set<string>>(new Set());

  // 📡 アンテナ管理状態
  const [antennas, setAntennas] = useState<Antenna[]>([]);
  const [activeAntenna, setActiveAntenna] = useState<Antenna | null>(null);
  const [showAntennaManageModal, setShowAntennaManageModal] = useState<boolean>(false);
  const [showAntennaModal, setShowAntennaModal] = useState<boolean>(false);
  const [editingAntenna, setEditingAntenna] = useState<Partial<Antenna> | null>(null);
  const activeAntennaRef = useRef(activeAntenna);
  useEffect(() => {
    activeAntennaRef.current = activeAntenna;
  }, [activeAntenna]);

  // 📝 下書き管理状態
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [showDraftsModal, setShowDraftsModal] = useState<boolean>(false);

  // ⏰ 予約投稿管理状態
  const [scheduledPosts, setScheduledPosts] = useState<ScheduledPost[]>([]);
  const [showScheduleModal, setShowScheduleModal] = useState<boolean>(false);
  const [scheduledDateTime, setScheduledDateTime] = useState<string>('');

  // リアルタイム SSE コールバック用の最新状態参照 Ref (クロージャ stale state 回避)
  const timelineModeRef = useRef(timelineMode);
  useEffect(() => {
    timelineModeRef.current = timelineMode;
  }, [timelineMode]);

  const activeHashtagRef = useRef(activeHashtag);
  useEffect(() => {
    activeHashtagRef.current = activeHashtag;
  }, [activeHashtag]);

  const followingUrlsRef = useRef(followingUrls);
  useEffect(() => {
    followingUrlsRef.current = followingUrls;
  }, [followingUrls]);

  const authUserRef = useRef(authUser);
  useEffect(() => {
    authUserRef.current = authUser;
  }, [authUser]);

  // 🎯 投稿が現在のタイムラインモード（ローカル/ホーム/連合/タグ/アンテナ）に合致するか判定する共通ヘルパー
  const isPostMatchingTimeline = (
    post: Post,
    mode: 'local' | 'home' | 'all' | 'tag' | 'antenna',
    tag: string,
    followUrls: Set<string>,
    me: AuthUser | null
  ): boolean => {
    const isLocalPost = post.is_local === 1 || (post as any).is_local === true;

    // 🔒 閲覧権限の確認: フォロワー限定の投稿は「自分自身」または「フォロー中の相手」のみ表示する
    //    （サーバー側でも除外しているが、SSE で届いた投稿などの取りこぼしを防ぐ二重の防御）
    const isFollowersOnly = post.visibility === 'followers';
    if (isFollowersOnly) {
      const myActorUrl = me ? `/users/${me.id}` : null;
      const isMine = Boolean(me && (post.author_url?.endsWith(myActorUrl || '\u0000') || post.user_id === me.id));
      const isFollowed = Boolean(
        post.author_url &&
          (followUrls.has(post.author_url) || followUrls.has(post.author_url.replace(/\/$/, ''))),
      );
      if (!isMine && !isFollowed) return false;
    }

    // 📡 アンテナ: 選択中のアンテナ条件に合致するか
    if (mode === 'antenna') {
      const ant = activeAntennaRef.current;
      if (!ant) return false;
      if (ant.with_file && (!post.media_attachments || post.media_attachments.length === 0)) return false;
      const rawText = `${post.content || ''} ${post.cw || ''}`;
      const searchTarget = ant.case_sensitive ? rawText : rawText.toLowerCase();
      if (ant.exclude_keywords) {
        const exList = ant.exclude_keywords.split(/[,、\n\s]+/).filter(Boolean);
        for (const ex of exList) {
          const t = ant.case_sensitive ? ex : ex.toLowerCase();
          if (searchTarget.includes(t)) return false;
        }
      }
      if (ant.keywords) {
        const kwList = ant.keywords.split(/[,、\n\s]+/).filter(Boolean);
        if (kwList.length > 0) {
          const matched = kwList.some((kw) => {
            const t = ant.case_sensitive ? kw : kw.toLowerCase();
            return searchTarget.includes(t);
          });
          if (!matched) return false;
        }
      }
      return true;
    }

    // 🏠 ローカル: 自ノードの投稿 (is_local === 1) のみ！連合投稿は厳格に除外
    if (mode === 'local') {
      return isLocalPost;
    }

    // 🏠 ホーム: ローカル投稿 (is_local === 1) または 自分がフォローしているアカウント
    if (mode === 'home') {
      if (isLocalPost) return true;
      if (me) {
        const checkUrl = (u?: string | null) => {
          if (!u) return false;
          return followUrls.has(u) || followUrls.has(u.replace(/\/$/, '')) || followUrls.has(`${u}/`);
        };
        if (checkUrl(post.author_url)) return true;
        if (post.author_handle && (followUrls.has(post.author_handle) || followUrls.has(post.author_handle.replace(/^@/, '')))) return true;
        if (checkUrl(post.user_id)) return true;
        if (checkUrl(post.renote?.url)) return true;
        if (post.renote?.handle && (followUrls.has(post.renote.handle) || followUrls.has(post.renote.handle.replace(/^@/, '')))) return true;
      }
      return false;
    }

    // #️⃣ タグ: 選択中のハッシュタグを含むか
    if (mode === 'tag') {
      if (!tag) return false;
      const cleanTag = tag.toLowerCase().replace(/^#/, '');
      const content = (post.content || '').toLowerCase();
      return content.includes(`#${cleanTag}`) || content.includes(`/tags/${cleanTag}`);
    }

    // 🌐 連合 (all): 全件対象
    return true;
  };

  // 新着保留投稿をタイムラインに反映（現在のモードに合致するもののみ厳格にマージ）
  const applyNewPostsQueue = () => {
    if (newPostsQueue.length === 0) return;
    setTimeline((prev) => {
      const existingIds = new Set(prev.map((p) => p.id));
      const fresh = newPostsQueue.filter((p) => {
        if (existingIds.has(p.id)) return false;
        return isPostMatchingTimeline(p, timelineMode, activeHashtag, followingUrls, authUser);
      });
      return [...fresh, ...prev];
    });
    setNewPostsQueue([]);
  };

  // 統合検索 & ハッシュタグステート
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [searchResults, setSearchResults] = useState<{
    remoteUser: any;
    users: any[];
    posts: any[];
  } | null>(null);
  const [popularTags, setPopularTags] = useState<{ tag: string; count: number }[]>([]);
  const [searchTab, setSearchTab] = useState<'all' | 'users' | 'posts'>('all');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);

  const [postContent, setPostContent] = useState<string>('');
  const [postVisibility, setPostVisibility] = useState<'public' | 'local' | 'followers'>(defaultVisibility); // 🌐 グローバル / 🏠 ローカル限定 / 🔒 フォロワー限定
  const [postAttachments, setPostAttachments] = useState<MediaAttachment[]>([]);
  const [isUploadingMedia, setIsUploadingMedia] = useState<boolean>(false);
  const [uploadStatusText, setUploadStatusText] = useState<string>('');
  const [autoCompressImages, setAutoCompressImages] = useState<boolean>(() => {
    const saved = localStorage.getItem('spica_auto_compress');
    return saved !== null ? saved === 'true' : true;
  });
  const [previewMediaUrl, setPreviewMediaUrl] = useState<string | null>(null);
  const [isPosting, setIsPosting] = useState<boolean>(false);
  const [isLoadingTimeline, setIsLoadingTimeline] = useState<boolean>(false);

  const [showMobilePostModal, setShowMobilePostModal] = useState<boolean>(false);

  // 絵文字リアクションステート
  const [activeReactionPostId, setActiveReactionPostId] = useState<string | null>(null);
  const [customReactionInput, setCustomReactionInput] = useState<string>('');
  const quickEmojis = ['👍', '❤️', '🚀', '🎉', '✨', '🔥', '🥺', '😂', '👀', '💯'];

  // 🎨 カスタム絵文字 & リッチピッカーステート
  const [customEmojis, setCustomEmojis] = useState<CustomEmoji[]>([]);
  const [showRichEmojiPicker, setShowRichEmojiPicker] = useState<{ target: 'post' | 'reply' | 'reaction'; postId?: string } | null>(null);
  const [emojiSearchTerm, setEmojiSearchTerm] = useState<string>('');
  const [emojiCategoryTab, setEmojiCategoryTab] = useState<string>('custom');

  // 🎟 招待コード入力ステート
  const [inviteCodeInput, setInviteCodeInput] = useState<string>('');

  // 💬 引用 & ⚠️ センシティブ & 🔁 リノートメニュー
  const [quoteTargetPost, setQuoteTargetPost] = useState<Post | null>(null);
  const [isSensitivePost, setIsSensitivePost] = useState<boolean>(false);
  const [activeRenoteMenuPostId, setActiveRenoteMenuPostId] = useState<string | null>(null);

  // 引用してノート作成を開始
  const handleStartQuote = (post: Post) => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    setActiveRenoteMenuPostId(null);
    setQuoteTargetPost(post);
    if (window.innerWidth < 768) {
      openMobilePostModal();
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      const textarea = document.querySelector<HTMLTextAreaElement>('#main-post-textarea');
      if (textarea) textarea.focus();
    }
  };

  // ✨ メンション & ハッシュタグ オートコンプリート
  const [autocompleteType, setAutocompleteType] = useState<'user' | 'tag' | null>(null);
  const [autocompleteSuggestions, setAutocompleteSuggestions] = useState<any[]>([]);
  const [autocompleteIndex, setAutocompleteIndex] = useState<number>(0);
  const autocompleteTimerRef = useRef<NodeJS.Timeout | null>(null);

  const checkAutocomplete = (text: string, cursorPos: number) => {
    const textBeforeCursor = text.slice(0, cursorPos);
    const match = textBeforeCursor.match(/([@#])([a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]*)$/);

    if (match) {
      const symbol = match[1];
      const query = match[2];
      const type = symbol === '@' ? 'user' : 'tag';
      setAutocompleteType(type);
      setAutocompleteIndex(0);

      if (autocompleteTimerRef.current) clearTimeout(autocompleteTimerRef.current);
      autocompleteTimerRef.current = setTimeout(async () => {
        try {
          const endpoint = type === 'user'
            ? `/api/autocomplete/users?q=${encodeURIComponent(query)}`
            : `/api/autocomplete/tags?q=${encodeURIComponent(query)}`;
          const res = await fetch(endpoint, {
            headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
          });
          if (res.ok) {
            const data = await res.json();
            setAutocompleteSuggestions(data);
          }
        } catch {}
      }, 150);
    } else {
      setAutocompleteType(null);
      setAutocompleteSuggestions([]);
    }
  };

  const applyAutocomplete = (
    suggestion: any,
    currentText: string,
    setText: (t: string) => void,
    textareaEl?: HTMLTextAreaElement | null
  ) => {
    const el = textareaEl;
    const cursorPos = el?.selectionStart ?? currentText.length;
    const textBeforeCursor = currentText.slice(0, cursorPos);
    const textAfterCursor = currentText.slice(cursorPos);

    let replacement = '';
    if (autocompleteType === 'user') {
      replacement = `${suggestion.handle} `;
    } else if (autocompleteType === 'tag') {
      replacement = `#${suggestion.tag || suggestion} `;
    }

    const newBefore = textBeforeCursor.replace(/([@#])[^@#\s]*$/, replacement);
    const newText = newBefore + textAfterCursor;
    setText(newText);
    setAutocompleteType(null);
    setAutocompleteSuggestions([]);

    if (el) {
      setTimeout(() => {
        el.focus();
        el.setSelectionRange(newBefore.length, newBefore.length);
      }, 0);
    }
  };

  const handleAutocompleteKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    currentText: string,
    setText: (t: string) => void
  ) => {
    if (!autocompleteType || autocompleteSuggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAutocompleteIndex((prev) => (prev + 1) % autocompleteSuggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAutocompleteIndex((prev) => (prev - 1 + autocompleteSuggestions.length) % autocompleteSuggestions.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (autocompleteSuggestions[autocompleteIndex]) {
        e.preventDefault();
        applyAutocomplete(autocompleteSuggestions[autocompleteIndex], currentText, setText, e.currentTarget);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setAutocompleteType(null);
      setAutocompleteSuggestions([]);
    }
  };

  // リアクション絵文字の描画ヘルパー（カスタム絵文字なら画像表示、Unicodeなら文字表示）
  const renderReactionBadgeContent = (reaction: string) => {
    if (reaction.startsWith(':') && reaction.endsWith(':')) {
      const clean = reaction.slice(1, -1).toLowerCase();
      const found = customEmojis.find((e) => e.name.toLowerCase() === clean);
      if (found) {
        return (
          <img
            src={found.url}
            alt={reaction}
            title={reaction}
            className="w-4 h-4 object-contain inline-block align-middle"
            loading="lazy"
          />
        );
      }
    }
    return <span>{reaction}</span>;
  };

  // CW (閲覧注意) ステート
  const [showCwInput, setShowCwInput] = useState<boolean>(false);
  const [cwContent, setCwContent] = useState<string>('');
  const [openedCwPostIds, setOpenedCwPostIds] = useState<Set<string>>(new Set());

  const toggleCw = (postId: string) => {
    setOpenedCwPostIds((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) {
        next.delete(postId);
      } else {
        next.add(postId);
      }
      return next;
    });
  };

  // 返信ステート
  const [replyTargetPost, setReplyTargetPost] = useState<Post | null>(null);
  const [replyContent, setReplyContent] = useState<string>('');
  const [showReplyCwInput, setShowReplyCwInput] = useState<boolean>(false);
  const [replyCwContent, setReplyCwContent] = useState<string>('');
  const [isReplying, setIsReplying] = useState<boolean>(false);

  // 会話スレッドモーダルステート
  const [threadModalPost, setThreadModalPost] = useState<Post | null>(null);
  const [threadData, setThreadData] = useState<{ post: Post; parent: Post | null; replies: Post[] } | null>(null);
  const [isLoadingThread, setIsLoadingThread] = useState<boolean>(false);

  // リモートフォロー
  const [followHandle, setFollowHandle] = useState<string>('');
  const [followStatus, setFollowStatus] = useState<{ type: 'success' | 'error' | 'loading'; msg: string } | null>(null);

  // サーバー情報
  const [serverStats, setServerStats] = useState<ServerStats | null>(null);

  // 管理者画面ナビゲーションステート (Misskey風サイドバー)
  const [adminTab, setAdminTab] = useState<'dashboard' | 'users' | 'federation' | 'blocks' | 'storage' | 'settings' | 'emojis' | 'invites' | 'reports' | 'announcements' | 'roles' | 'mail' | 'delivery'>('dashboard');
  const [adminUserSearch, setAdminUserSearch] = useState<string>('');

  // 🎨 カスタム絵文字管理ステート
  const [adminEmojis, setAdminEmojis] = useState<CustomEmoji[]>([]);
  const [newEmojiName, setNewEmojiName] = useState<string>('');
  const [newEmojiCategory, setNewEmojiCategory] = useState<string>('一般');
  const [newEmojiUrl, setNewEmojiUrl] = useState<string>('');
  const [isUploadingEmoji, setIsUploadingEmoji] = useState<boolean>(false);
  const [emojiActionMsg, setEmojiActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 🎟 招待コード管理ステート
  const [adminInvitations, setAdminInvitations] = useState<InvitationCode[]>([]);
  const [newInviteMaxUses, setNewInviteMaxUses] = useState<number>(1);
  const [newInviteExpiresDays, setNewInviteExpiresDays] = useState<string>('7');
  const [newInviteMemo, setNewInviteMemo] = useState<string>('');
  const [isCreatingInvite, setIsCreatingInvite] = useState<boolean>(false);
  const [isUpdatingRegMode, setIsUpdatingRegMode] = useState<boolean>(false);
  const [inviteActionMsg, setInviteActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 🗑 アカウント削除ステート（管理者による削除 ＆ 本人による退会）
  const [adminDeleteTargetUser, setAdminDeleteTargetUser] = useState<any | null>(null);
  const [isAdminDeletingUser, setIsAdminDeletingUser] = useState<boolean>(false);
  const [showSelfDeleteModal, setShowSelfDeleteModal] = useState<boolean>(false);
  const [selfDeleteConfirmId, setSelfDeleteConfirmId] = useState<string>('');
  const [selfDeleteMasterKey, setSelfDeleteMasterKey] = useState<string>('');
  const [isSelfDeleting, setIsSelfDeleting] = useState<boolean>(false);
  const [selfDeleteError, setSelfDeleteError] = useState<string | null>(null);

  // 🔔 Web Push 通知ステート
  const [isPushSubscribed, setIsPushSubscribed] = useState<boolean>(false);
  const [pushPermission, setPushPermission] = useState<NotificationPermission>(() => {
    return typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'default';
  });
  const [isSubscribingPush, setIsSubscribingPush] = useState<boolean>(false);
  const [isSendingTestPush, setIsSendingTestPush] = useState<boolean>(false);

  // サーバー基本設定ステート (名前・説明・アイコン・バナー・ポリシー・ルール)
  const [adminServerName, setAdminServerName] = useState<string>('');
  const [adminServerDesc, setAdminServerDesc] = useState<string>('');
  const [adminServerIcon, setAdminServerIcon] = useState<string>('');
  const [adminServerBanner, setAdminServerBanner] = useState<string>('');
  const [adminTosUrl, setAdminTosUrl] = useState<string>('');
  const [adminPrivacyPolicyUrl, setAdminPrivacyPolicyUrl] = useState<string>('');
  const [adminContactUrl, setAdminContactUrl] = useState<string>('');
  const [adminRepositoryUrl, setAdminRepositoryUrl] = useState<string>('');
  const [adminOperatorUrl, setAdminOperatorUrl] = useState<string>('');
  const [adminServerRulesText, setAdminServerRulesText] = useState<string>('');
  const [adminRequireRulesAgreement, setAdminRequireRulesAgreement] = useState<boolean>(true);
  const [isUploadingServerIcon, setIsUploadingServerIcon] = useState<boolean>(false);
  const [isUploadingServerBanner, setIsUploadingServerBanner] = useState<boolean>(false);
  const [isSavingServerSettings, setIsSavingServerSettings] = useState<boolean>(false);
  const [serverSettingsMessage, setServerSettingsMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 管理者画面データ
  const [adminStats, setAdminStats] = useState<any>(null);
  const [adminUsers, setAdminUsers] = useState<any[]>([]);
  const [adminFederation, setAdminFederation] = useState<any>(null);
  const [adminRelays, setAdminRelays] = useState<any[]>([]);
  const [relayInputUrl, setRelayInputUrl] = useState<string>('');
  const [isConnectingRelay, setIsConnectingRelay] = useState<boolean>(false);
  const [relayMessage, setRelayMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isLoadingAdmin, setIsLoadingAdmin] = useState<boolean>(false);

  // ドメインブロック管理ステート
  const [adminBlockedDomains, setAdminBlockedDomains] = useState<any[]>([]);
  const [blockInputDomain, setBlockInputDomain] = useState<string>('');
  const [blockInputReason, setBlockInputReason] = useState<string>('');
  const [isBlockingDomain, setIsBlockingDomain] = useState<boolean>(false);
  const [blockMessage, setBlockMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 🚩 通報（モデレーション）ステート
  const [adminReports, setAdminReports] = useState<any[]>([]);
  const [adminReportCounts, setAdminReportCounts] = useState<{ open: number; total: number }>({ open: 0, total: 0 });
  const [reportStatusFilter, setReportStatusFilter] = useState<'open' | 'all' | 'resolved' | 'rejected'>('open');
  const [isUpdatingReport, setIsUpdatingReport] = useState<string | null>(null);
  const [reportActionMsg, setReportActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // 通報フォーム（一般ユーザー向け）
  const [reportTarget, setReportTarget] = useState<{ type: 'post' | 'user'; id: string; label: string } | null>(null);
  const [reportCategory, setReportCategory] = useState<string>('spam');
  const [reportComment, setReportComment] = useState<string>('');
  const [isSubmittingReport, setIsSubmittingReport] = useState<boolean>(false);

  // メディアストレージ設定ステート (Cloudflare R2 / S3)
  const [adminStorageConfig, setAdminStorageConfig] = useState<{
    configured: boolean;
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    hasSecretAccessKey: boolean;
    publicUrl: string;
    region: string;
  } | null>(null);
  const [storageForm, setStorageForm] = useState({
    endpoint: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    publicUrl: '',
    region: 'auto',
  });
  const [isTestingStorage, setIsTestingStorage] = useState<boolean>(false);
  const [isSavingStorage, setIsSavingStorage] = useState<boolean>(false);
  const [storageMessage, setStorageMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // プロフィール画面ステート
  const [profileTarget, setProfileTarget] = useState<string | null>(null);
  const [profileData, setProfileData] = useState<UserProfile | null>(null);
  const [profilePosts, setProfilePosts] = useState<Post[]>([]);
  const [isLoadingProfile, setIsLoadingProfile] = useState<boolean>(false);
  const [isTogglingFollow, setIsTogglingFollow] = useState<boolean>(false);

  // プロフィール編集ステート
  const [showEditProfileModal, setShowEditProfileModal] = useState<boolean>(false);
  const [editName, setEditName] = useState<string>('');
  const [editBio, setEditBio] = useState<string>('');
  const [editIconUrl, setEditIconUrl] = useState<string>('');
  const [editBannerUrl, setEditBannerUrl] = useState<string>('');
  const [isSavingProfile, setIsSavingProfile] = useState<boolean>(false);
  const [isUploadingIcon, setIsUploadingIcon] = useState<boolean>(false);
  const [isUploadingBanner, setIsUploadingBanner] = useState<boolean>(false);

  // =========================================================================
  // 🧭 SPA ナビゲーション & ブラウザ戻る/進む・スマホ戻る操作 (History API 連動)
  // =========================================================================
  const authTokenRef = useRef(authToken);
  useEffect(() => { authTokenRef.current = authToken; }, [authToken]);

  const currentViewRef = useRef(currentView);
  useEffect(() => { currentViewRef.current = currentView; }, [currentView]);

  const profileTargetRef = useRef(profileTarget);
  useEffect(() => { profileTargetRef.current = profileTarget; }, [profileTarget]);

  const selectedChannelRef = useRef(selectedChannel);
  useEffect(() => { selectedChannelRef.current = selectedChannel; }, [selectedChannel]);

  const previewMediaUrlRef = useRef(previewMediaUrl);
  useEffect(() => { previewMediaUrlRef.current = previewMediaUrl; }, [previewMediaUrl]);

  const threadModalPostRef = useRef(threadModalPost);
  useEffect(() => { threadModalPostRef.current = threadModalPost; }, [threadModalPost]);

  const showMobilePostModalRef = useRef(showMobilePostModal);
  useEffect(() => { showMobilePostModalRef.current = showMobilePostModal; }, [showMobilePostModal]);

  const showDraftsModalRef = useRef(showDraftsModal);
  useEffect(() => { showDraftsModalRef.current = showDraftsModal; }, [showDraftsModal]);

  const showScheduleModalRef = useRef(showScheduleModal);
  useEffect(() => { showScheduleModalRef.current = showScheduleModal; }, [showScheduleModal]);

  const showCreateChannelModalRef = useRef(showCreateChannelModal);
  useEffect(() => { showCreateChannelModalRef.current = showCreateChannelModal; }, [showCreateChannelModal]);

  const showEditProfileModalRef = useRef(showEditProfileModal);
  useEffect(() => { showEditProfileModalRef.current = showEditProfileModal; }, [showEditProfileModal]);

  const showAuthPortalRef = useRef(showAuthPortal);
  useEffect(() => { showAuthPortalRef.current = showAuthPortal; }, [showAuthPortal]);

  const showMasterKeyModalRef = useRef(showMasterKeyModal);
  useEffect(() => { showMasterKeyModalRef.current = showMasterKeyModal; }, [showMasterKeyModal]);

  const showAntennaManageModalRef = useRef(showAntennaManageModal);
  useEffect(() => { showAntennaManageModalRef.current = showAntennaManageModal; }, [showAntennaManageModal]);

  const showAntennaModalRef = useRef(showAntennaModal);
  useEffect(() => { showAntennaModalRef.current = showAntennaModal; }, [showAntennaModal]);

  const showSelfDeleteModalRef = useRef(showSelfDeleteModal);
  useEffect(() => { showSelfDeleteModalRef.current = showSelfDeleteModal; }, [showSelfDeleteModal]);

  const showPostExtraMenuRef = useRef(showPostExtraMenu);
  useEffect(() => { showPostExtraMenuRef.current = showPostExtraMenu; }, [showPostExtraMenu]);

  const isMobileMenuOpenRef = useRef(isMobileMenuOpen);
  useEffect(() => { isMobileMenuOpenRef.current = isMobileMenuOpen; }, [isMobileMenuOpen]);

  const showRichEmojiPickerRef = useRef(showRichEmojiPicker);
  useEffect(() => { showRichEmojiPickerRef.current = showRichEmojiPicker; }, [showRichEmojiPicker]);

  // 📱 PWA / モバイル ホーム画面での戻るトラップ用
  const lastBackPressTimeRef = useRef<number>(0);
  const [showExitToast, setShowExitToast] = useState<boolean>(false);

  // モーダルオープン時の履歴プッシュ
  const pushModalState = (modalName: string) => {
    try {
      window.history.pushState({ spica_guard: 'modal', modal: modalName }, '', window.location.href);
    } catch {}
  };

  // 全てのモーダル・オーバーレイを閉じる（戻る操作時に最優先で実行）
  const closeAllModals = (): boolean => {
    let closed = false;
    if (previewMediaUrlRef.current) {
      setPreviewMediaUrl(null);
      closed = true;
    }
    if (threadModalPostRef.current) {
      setThreadModalPost(null);
      setThreadData(null);
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('post')) {
          url.searchParams.delete('post');
          const newPath = (url.pathname || '/') + (url.search ? url.search : '');
          window.history.replaceState({ spica_guard: 'active', view: currentViewRef.current }, '', newPath);
        }
      } catch {}
      closed = true;
    }
    if (showMobilePostModalRef.current) {
      setShowMobilePostModal(false);
      closed = true;
    }
    if (showDraftsModalRef.current) {
      setShowDraftsModal(false);
      closed = true;
    }
    if (showScheduleModalRef.current) {
      setShowScheduleModal(false);
      closed = true;
    }
    if (showCreateChannelModalRef.current) {
      setShowCreateChannelModal(false);
      closed = true;
    }
    if (showEditProfileModalRef.current) {
      setShowEditProfileModal(false);
      closed = true;
    }
    if (showMasterKeyModalRef.current) {
      setShowMasterKeyModal(false);
      closed = true;
    }
    if (showAntennaManageModalRef.current) {
      setShowAntennaManageModal(false);
      closed = true;
    }
    if (showAntennaModalRef.current) {
      setShowAntennaModal(false);
      closed = true;
    }
    if (showSelfDeleteModalRef.current) {
      setShowSelfDeleteModal(false);
      closed = true;
    }
    if (showPostExtraMenuRef.current) {
      setShowPostExtraMenu(false);
      closed = true;
    }
    if (isMobileMenuOpenRef.current) {
      setIsMobileMenuOpen(false);
      closed = true;
    }
    if (showRichEmojiPickerRef.current) {
      setShowRichEmojiPicker(null);
      closed = true;
    }
    if (showAuthPortalRef.current && authTokenRef.current) {
      setShowAuthPortal(false);
      closed = true;
    }
    return closed;
  };

  // 画像プレビューオープン（戻る操作連動）
  const openMediaPreview = (url: string) => {
    setPreviewMediaUrl(url);
    pushModalState('media_preview');
  };

  // 会話スレッドモーダルを閉じる（URLの?post=を復元）
  const closeThreadModal = () => {
    setThreadModalPost(null);
    setThreadData(null);
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('post')) {
        url.searchParams.delete('post');
        const newPath = (url.pathname || '/') + (url.search ? url.search : '');
        window.history.replaceState({ spica_guard: 'active', view: currentViewRef.current }, '', newPath);
      }
    } catch {}
  };

  // 画面遷移ヘルパー（URLのプッシュとビュー切り替え）
  const navigateToView = (view: typeof currentView, push: boolean = true) => {
    closeAllModals();
    setCurrentView(view);
    if (view !== 'channels') {
      setSelectedChannel(null);
    }
    if (push) {
      let targetPath = '/';
      if (view === 'channels') targetPath = '/channels';
      else if (view === 'notifications') targetPath = '/notifications';
      else if (view === 'bookmarks') targetPath = '/bookmarks';
      else if (view === 'search') targetPath = '/search';
      else if (view === 'settings') targetPath = '/settings';
      else if (view === 'admin') targetPath = '/admin';
      else if (view === 'timeline') {
        targetPath = timelineMode === 'local' ? '/?mode=local' : timelineMode === 'home' ? '/?mode=home' : '/?mode=all';
      }
      try {
        window.history.pushState({ spica_guard: 'active', view }, '', targetPath);
      } catch {}
    }
  };

  // ユーザープロフィールを開く
  const openUserProfile = async (identifier: string, push: boolean = true) => {
    if (!identifier) return;
    if (push) {
      try {
        window.history.pushState({ view: 'profile', identifier }, '', `/users/${encodeURIComponent(identifier)}`);
      } catch {}
    }
    setProfileTarget(identifier);
    setCurrentView('profile');
    setIsLoadingProfile(true);
    setProfileData(null);
    setProfilePosts([]);
    try {
      const encoded = encodeURIComponent(identifier);
      const headers: Record<string, string> = {};
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      const [userRes, postsRes] = await Promise.all([
        fetch(`/api/users/${encoded}`, { headers }),
        fetch(`/api/users/${encoded}/posts`, { headers }),
      ]);

      if (userRes.ok) {
        const u = await userRes.json();
        setProfileData(u);
      }
      if (postsRes.ok) {
        const p = await postsRes.json();
        setProfilePosts(p);
      }
    } catch (e) {
      console.error('Failed to load profile:', e);
    } finally {
      setIsLoadingProfile(false);
    }
  };

  // 自分のプロフィール編集モーダルを開く
  const openEditProfileModal = () => {
    if (!authUser) return;
    setEditName(authUser.name || '');
    setEditBio(authUser.summary || '');
    setEditIconUrl(authUser.icon_url || '');
    setEditBannerUrl(authUser.banner_url || '');
    setShowEditProfileModal(true);
    pushModalState('edit_profile');
  };

  function openMobilePostModal() {
    setShowMobilePostModal(true);
    pushModalState('mobile_post');
  }

  function openDraftsModal() {
    setShowDraftsModal(true);
    setShowPostExtraMenu(false);
    pushModalState('drafts');
  }

  function openScheduleModal() {
    setShowScheduleModal(true);
    setShowPostExtraMenu(false);
    pushModalState('schedule');
  }

  function openCreateChannelModal() {
    if (!authUser) {
      setShowLoginModal(true);
      return;
    }
    setShowCreateChannelModal(true);
    pushModalState('create_channel');
  }

  function openAntennaManageModal() {
    if (!authUser) {
      setShowLoginModal(true);
      return;
    }
    setShowAntennaManageModal(true);
    pushModalState('antenna_manage');
  }

  function openAntennaModal(ant?: Partial<Antenna> | null) {
    setEditingAntenna(ant || null);
    setShowAntennaModal(true);
    pushModalState('edit_antenna');
  }

  // ユーザー設定画面を開く
  const openSettings = (tab: 'profile' | 'preferences' | 'account' | 'session' = 'profile') => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    if (authUser) {
      setEditName(authUser.name || '');
      setEditBio(authUser.summary || '');
      setEditIconUrl(authUser.icon_url || '');
      setEditBannerUrl(authUser.banner_url || '');
      setProfileIsLocked(Boolean((authUser as any).is_locked));
      setProfileDiscoverable((authUser as any).discoverable !== false);
      try {
        const parsed = JSON.parse((authUser as any).fields || '[]');
        setEditFields(Array.isArray(parsed) ? parsed.map((f: any) => ({ name: String(f.name || ''), value: String(f.value || '') })) : []);
      } catch {
        setEditFields([]);
      }
    }
    setSettingsTab(tab);
    setSettingsMessage(null);
    navigateToView('settings');
  };

  // プロフィール保存
  const handleSaveProfile = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!authToken) return;
    setIsSavingProfile(true);
    setSettingsMessage(null);
    try {
      const res = await fetch('/api/user/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          name: editName,
          summary: editBio,
          icon_url: editIconUrl,
          banner_url: editBannerUrl,
          is_locked: profileIsLocked,
          discoverable: profileDiscoverable,
          fields: editFields.filter((f) => f.name.trim() && f.value.trim()),
        }),
      });

      if (res.ok) {
        const updated = await res.json();
        setAuthUser(updated);
        setShowEditProfileModal(false);
        setSettingsMessage({ type: 'success', text: 'プロフィールを更新しました！' });
        setTimeout(() => setSettingsMessage(null), 4000);
        // プロフィール画面を開いていればそちらも即座に更新
        if (profileData && profileData.is_local && profileData.id === updated.id) {
          setProfileData(prev => prev ? {
            ...prev,
            name: updated.name,
            summary: updated.summary,
            icon_url: updated.icon_url || '',
            banner_url: updated.banner_url || '',
          } : prev);
        }
        // タイムラインもリフレッシュ
        fetchTimeline();
      } else {
        const err = await res.json();
        setSettingsMessage({ type: 'error', text: err.error || 'プロフィールの保存に失敗しました。' });
      }
    } catch (err: any) {
      console.error('Failed to save profile:', err);
      setSettingsMessage({ type: 'error', text: err.message });
    } finally {
      setIsSavingProfile(false);
    }
  };

  // アバター（アイコン）画像の直接アップロード
  const handleUploadAvatar = async (files: FileList | null) => {
    if (!files || files.length === 0 || !authToken) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) {
      alert('画像ファイルを選択してください。');
      return;
    }
    setIsUploadingIcon(true);
    try {
      // アイコンは正方形アバター用に最大 800px にリサイズ＆WebP圧縮
      const compressRes = await compressImage(file, {
        maxDimension: 800,
        quality: 0.88,
        format: 'image/webp',
      });
      const formData = new FormData();
      formData.append('file', compressRes.file);

      const res = await fetch('/api/media/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        const url = data.attachment?.url || data.media?.[0]?.url;
        if (url) {
          setEditIconUrl(url);
        }
      } else {
        const err = await res.json();
        alert(`アイコンのアップロードに失敗しました: ${err.error || '不明なエラー'}`);
      }
    } catch (err: any) {
      alert(`アップロードエラー: ${err.message}`);
    } finally {
      setIsUploadingIcon(false);
    }
  };

  // ヘッダーバナー画像の直接アップロード
  const handleUploadBanner = async (files: FileList | null) => {
    if (!files || files.length === 0 || !authToken) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) {
      alert('画像ファイルを選択してください。');
      return;
    }
    setIsUploadingBanner(true);
    try {
      // バナーは横長ヘッダー用に最大 2048px にリサイズ＆WebP圧縮
      const compressRes = await compressImage(file, {
        maxDimension: 2048,
        quality: 0.85,
        format: 'image/webp',
      });
      const formData = new FormData();
      formData.append('file', compressRes.file);

      const res = await fetch('/api/media/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        const url = data.attachment?.url || data.media?.[0]?.url;
        if (url) {
          setEditBannerUrl(url);
        }
      } else {
        const err = await res.json();
        alert(`バナーのアップロードに失敗しました: ${err.error || '不明なエラー'}`);
      }
    } catch (err: any) {
      alert(`アップロードエラー: ${err.message}`);
    } finally {
      setIsUploadingBanner(false);
    }
  };

  // 環境設定保存
  const handleSavePreferences = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('spica_pref_visibility', defaultVisibility);
    localStorage.setItem('spica_pref_timeline', defaultTimeline);
    localStorage.setItem('spica_pref_emojis', String(showCustomEmojis));
    localStorage.setItem('spica_auto_compress', String(autoCompressImages));
    localStorage.setItem('astrabit_pref_visibility', defaultVisibility);
    localStorage.setItem('astrabit_pref_timeline', defaultTimeline);
    localStorage.setItem('astrabit_pref_emojis', String(showCustomEmojis));
    setPostVisibility(defaultVisibility);
    setSettingsMessage({ type: 'success', text: '環境設定を保存しました！' });
    setTimeout(() => setSettingsMessage(null), 4000);
  };

  // プロフィール画面からのフォロー/アンフォロー切り替え
  const handleToggleProfileFollow = async () => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    if (!profileData || isTogglingFollow) return;
    setIsTogglingFollow(true);
    try {
      const endpoint = profileData.is_following ? '/api/unfollow' : '/api/follow';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          targetHandle: profileData.handle,
          targetActorUrl: profileData.actor_url,
        }),
      });

      if (res.ok) {
        setProfileData(prev => prev ? {
          ...prev,
          is_following: !prev.is_following,
          follower_count: prev.is_following ? Math.max(0, prev.follower_count - 1) : prev.follower_count + 1,
        } : prev);
        fetchMyFollowingUrls();
      }
    } catch (err) {
      console.error('Failed to toggle follow:', err);
    } finally {
      setIsTogglingFollow(false);
    }
  };

  // 自分がフォローしているアカウント一覧（URL, handle, ID）を取得
  const fetchMyFollowingUrls = async (token = authToken) => {
    if (!token) {
      setFollowingUrls(new Set());
      return;
    }
    try {
      const res = await fetch('/api/following', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        const urls = new Set<string>();
        for (const item of data) {
          if (item.following_url) {
            urls.add(item.following_url);
            urls.add(item.following_url.replace(/\/$/, ''));
          }
          if (item.username && item.domain) {
            urls.add(`@${item.username}@${item.domain}`);
            urls.add(`${item.username}@${item.domain}`);
          }
        }
        setFollowingUrls(urls);
      }
    } catch (e) {
      console.error('フォロー一覧取得エラー:', e);
    }
  };

  // トークンによる自動認証
  const checkAuth = async (token: string) => {
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const user = await res.json();
        setAuthUser(user);
        fetchMyFollowingUrls(token);
        setShowAuthPortal(false);
      } else {
        localStorage.removeItem('spica_token');
        localStorage.removeItem('astrabit_token');
        setAuthToken(null);
        setAuthUser(null);
        setFollowingUrls(new Set());
        setShowAuthPortal(true);
        setAuthPortalTab('welcome');
      }
    } catch {
      setAuthUser(null);
      setFollowingUrls(new Set());
      setShowAuthPortal(true);
      setAuthPortalTab('welcome');
    }
  };

  // サーバー情報取得
  const fetchServerStats = async () => {
    try {
      const res = await fetch('/api/server-info');
      if (res.ok) {
        const data = await res.json();
        setServerStats(data);
        if (data.name) {
          document.title = data.name;
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  // 公開カスタム絵文字一覧取得
  const fetchCustomEmojis = async () => {
    try {
      const res = await fetch('/api/emojis');
      if (res.ok) {
        const data = await res.json();
        setCustomEmojis(data);
      }
    } catch (err) {
      console.error('カスタム絵文字取得失敗:', err);
    }
  };

  // タイムライン取得
  const fetchTimeline = async (
    mode: 'local' | 'home' | 'all' | 'tag' | 'antenna' = timelineMode,
    tagParam?: string,
    antennaIdParam?: string
  ) => {
    setIsLoadingTimeline(true);
    try {
      if (mode === 'antenna') {
        const targetAntennaId = antennaIdParam || activeAntenna?.id;
        if (!targetAntennaId) {
          setTimeline([]);
          setTimelineCursor(null);
          return;
        }
        const res = await fetch(`/api/antennas/${targetAntennaId}/timeline`, {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        });
        if (res.ok) {
          const data = await res.json();
          setTimeline(data.posts || []);
          setTimelineCursor(res.headers.get('X-Next-Cursor'));
        }
        return;
      }

      const currentTag = tagParam !== undefined ? tagParam : activeHashtag;
      const url = mode === 'tag' && currentTag
        ? `/api/timeline?mode=tag&tag=${encodeURIComponent(currentTag)}`
        : `/api/timeline?mode=${mode}`;
      const res = await fetch(url, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      if (res.ok) {
        setTimeline(await res.json());
        setTimelineCursor(res.headers.get('X-Next-Cursor'));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoadingTimeline(false);
    }
  };

  // 過去のノート追加読み込み（カーソルページネーション）
  const loadOlderPosts = async () => {
    if (!timelineCursor || isLoadingOlderPosts) return;

    // 取得中にモードが変わっていたら結果を破棄するためのスナップショット
    const requestedMode = timelineMode;
    const requestedTag = activeHashtag;
    const requestedAntennaId = activeAntenna?.id;

    setIsLoadingOlderPosts(true);
    try {
      let url: string;
      if (requestedMode === 'antenna') {
        if (!requestedAntennaId) return;
        url = `/api/antennas/${requestedAntennaId}/timeline?cursor=${encodeURIComponent(timelineCursor)}`;
      } else if (requestedMode === 'tag' && requestedTag) {
        url = `/api/timeline?mode=tag&tag=${encodeURIComponent(requestedTag)}&cursor=${encodeURIComponent(timelineCursor)}`;
      } else {
        url = `/api/timeline?mode=${requestedMode}&cursor=${encodeURIComponent(timelineCursor)}`;
      }

      const res = await fetch(url, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      // 失敗時はカーソルを保持して、再試行できるようにする
      if (!res.ok) return;

      const data = await res.json();
      const older: Post[] = Array.isArray(data) ? data : (data.posts || []);

      // 取得中にタイムラインの表示条件が変わっていたら破棄
      if (timelineModeRef.current !== requestedMode) return;
      if (requestedMode === 'tag' && activeHashtagRef.current !== requestedTag) return;

      setTimeline((prev) => {
        const existing = new Set(prev.map((p) => p.id));
        return [...prev, ...older.filter((p) => !existing.has(p.id))];
      });
      setTimelineCursor(res.headers.get('X-Next-Cursor'));
    } catch (err) {
      console.error('過去のノート読み込みエラー:', err);
    } finally {
      setIsLoadingOlderPosts(false);
    }
  };

  // タイムラインモード切り替え（即時取得）
  const handleSwitchTimelineMode = (
    mode: 'local' | 'home' | 'all' | 'tag' | 'antenna',
    antenna?: Antenna
  ) => {
    setNewPostsQueue([]);
    setTimelineCursor(null);
    setTimelineMode(mode);
    if (mode === 'antenna' && antenna) {
      setActiveAntenna(antenna);
      fetchTimeline('antenna', undefined, antenna.id);
    } else {
      if (mode !== 'antenna') {
        setActiveAntenna(null);
      }
      fetchTimeline(mode);
    }
  };

  // ==========================================
  // 📡 アンテナ CRUD ハンドラー
  // ==========================================
  const fetchAntennas = async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/antennas', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setAntennas(data);
      }
    } catch (err) {
      console.error('アンテナ一覧取得失敗:', err);
    }
  };

  const handleSaveAntenna = async (antennaData: Partial<Antenna>) => {
    if (!authToken) return;
    try {
      const isEdit = Boolean(antennaData.id);
      const method = isEdit ? 'PUT' : 'POST';
      const url = isEdit ? `/api/antennas/${antennaData.id}` : '/api/antennas';
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(antennaData),
      });
      if (res.ok) {
        const saved = await res.json();
        await fetchAntennas();
        setShowAntennaModal(false);
        setEditingAntenna(null);
        setActiveAntenna(saved);
        handleSwitchTimelineMode('antenna', saved);
      } else {
        const err = await res.json();
        alert(err.error || 'アンテナの保存に失敗しました。');
      }
    } catch (err) {
      console.error('アンテナ保存エラー:', err);
    }
  };

  const handleDeleteAntenna = async (id: string) => {
    if (!authToken || !window.confirm('このアンテナを削除してもよろしいですか？')) return;
    try {
      const res = await fetch(`/api/antennas/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        if (activeAntenna?.id === id) {
          setActiveAntenna(null);
          handleSwitchTimelineMode('local');
        }
        await fetchAntennas();
      }
    } catch (err) {
      console.error('アンテナ削除エラー:', err);
    }
  };

  // ==========================================
  // 📝 下書き CRUD ハンドラー
  // ==========================================
  const fetchDrafts = async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/drafts', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setDrafts(data);
      }
    } catch (err) {
      console.error('下書き一覧取得失敗:', err);
    }
  };

  const handleSaveDraft = async () => {
    if (!authToken) return;
    if (!postContent.trim() && postAttachments.length === 0 && !quoteTargetPost) {
      alert('保存する内容がありません。');
      return;
    }
    try {
      const pollData = showPollInput && pollChoices.filter((c) => c.trim()).length >= 2
        ? { choices: pollChoices.filter((c) => c.trim()), multiple: pollMultiple, expiresIn: pollExpiresIn }
        : null;
      const res = await fetch('/api/drafts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          content: postContent,
          cw: showCwInput ? cwContent : '',
          visibility: postVisibility,
          attachments: postAttachments,
          poll: pollData,
          quote_id: quoteTargetPost?.id || null,
        }),
      });
      if (res.ok) {
        await fetchDrafts();
        alert('下書きを保存しました。');
      } else {
        alert('下書きの保存に失敗しました。');
      }
    } catch (err) {
      console.error('下書き保存エラー:', err);
    }
  };

  const handleLoadDraft = (draft: Draft) => {
    if (postContent.trim() || postAttachments.length > 0) {
      if (!window.confirm('入力中の内容が上書きされます。よろしいですか？')) return;
    }
    setPostContent(draft.content || '');
    if (draft.cw) {
      setCwContent(draft.cw);
      setShowCwInput(true);
    } else {
      setCwContent('');
      setShowCwInput(false);
    }
    setPostVisibility(draft.visibility || 'public');
    setPostAttachments(draft.media_attachments || []);
    if (draft.poll && draft.poll.choices) {
      setShowPollInput(true);
      setPollChoices(draft.poll.choices);
      setPollMultiple(Boolean(draft.poll.multiple));
      setPollExpiresIn(draft.poll.expiresIn || 86400);
    } else {
      setShowPollInput(false);
      setPollChoices(['', '']);
    }
    setShowDraftsModal(false);
  };

  const handleDeleteDraft = async (id: string) => {
    if (!authToken || !window.confirm('この下書きを削除してもよろしいですか？')) return;
    try {
      const res = await fetch(`/api/drafts/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        await fetchDrafts();
      }
    } catch (err) {
      console.error('下書き削除エラー:', err);
    }
  };

  // ==========================================
  // ⏰ 予約投稿 CRUD ハンドラー
  // ==========================================
  const fetchScheduledPosts = async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/scheduled-posts', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setScheduledPosts(data);
      }
    } catch (err) {
      console.error('予約投稿一覧取得失敗:', err);
    }
  };

  const handleCreateScheduledPost = async () => {
    if (!authToken) return;
    if (!scheduledDateTime) {
      alert('予約日時を選択してください。');
      return;
    }
    const scheduledDate = new Date(scheduledDateTime);
    if (isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
      alert('予約日時は現在より未来の日時を指定してください。');
      return;
    }
    if (!postContent.trim() && postAttachments.length === 0 && !quoteTargetPost) {
      alert('投稿内容または画像を入力してください。');
      return;
    }
    try {
      const pollData = showPollInput && pollChoices.filter((c) => c.trim()).length >= 2
        ? { choices: pollChoices.filter((c) => c.trim()), multiple: pollMultiple, expiresIn: pollExpiresIn }
        : null;
      const res = await fetch('/api/scheduled-posts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          content: postContent,
          cw: showCwInput ? cwContent : '',
          visibility: postVisibility,
          attachments: postAttachments,
          poll: pollData,
          quote_id: quoteTargetPost?.id || null,
          scheduled_at: scheduledDate.toISOString(),
        }),
      });
      if (res.ok) {
        await fetchScheduledPosts();
        setShowScheduleModal(false);
        setScheduledDateTime('');
        setPostContent('');
        setPostAttachments([]);
        setCwContent('');
        setShowCwInput(false);
        setShowPollInput(false);
        setQuoteTargetPost(null);
        alert('投稿を予約しました！指定時刻に自動公開されます。');
      } else {
        const err = await res.json();
        alert(err.error || '予約投稿の作成に失敗しました。');
      }
    } catch (err) {
      console.error('予約投稿エラー:', err);
    }
  };

  const handleCancelScheduledPost = async (id: string) => {
    if (!authToken || !window.confirm('この予約投稿をキャンセル（削除）してもよろしいですか？')) return;
    try {
      const res = await fetch(`/api/scheduled-posts/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        await fetchScheduledPosts();
      }
    } catch (err) {
      console.error('予約投稿キャンセルエラー:', err);
    }
  };

  // ハッシュタグ選択
  const handleSelectHashtag = (tag: string) => {
    const clean = tag.replace(/^#/, '');
    setNewPostsQueue([]);
    setTimelineCursor(null);
    setActiveHashtag(clean);
    setTimelineMode('tag');
    navigateToView('timeline');
    fetchTimeline('tag', clean);
  };

  // トレンド・人気タグ一覧取得
  const fetchPopularTags = async () => {
    try {
      const res = await fetch('/api/tags/popular');
      if (res.ok) {
        setPopularTags(await res.json());
      }
    } catch (err) {
      console.error('人気タグ取得失敗:', err);
    }
  };

  // 統合検索の実行
  const executeSearch = async (q: string) => {
    const cleanQ = q.trim();
    if (!cleanQ) return;
    setIsSearching(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(cleanQ)}`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      if (res.ok) {
        setSearchResults(await res.json());
      }
    } catch (err) {
      console.error('検索失敗:', err);
    } finally {
      setIsSearching(false);
    }
  };

  // 検索フォーム送信
  const handleSearchSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!searchQuery.trim()) return;
    navigateToView('search');
    executeSearch(searchQuery);
  };

  // 検索結果からのフォロー/アンフォロー切り替え
  const handleToggleSearchUserFollow = async (user: any) => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    const endpoint = user.is_following ? '/api/unfollow' : '/api/follow';
    const handle = user.domain ? `@${user.username}@${user.domain}` : (user.id || user.username);
    const targetActorUrl = user.id?.startsWith('http') ? user.id : `${window.location.origin}/users/${user.id}`;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          targetHandle: handle,
          targetActorUrl,
        }),
      });
      if (res.ok) {
        setSearchResults((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            remoteUser: prev.remoteUser?.id === user.id ? { ...prev.remoteUser, is_following: !user.is_following } : prev.remoteUser,
            users: prev.users.map((u) => (u.id === user.id ? { ...u, is_following: !user.is_following } : u)),
          };
        });
        fetchMyFollowingUrls();
      }
    } catch (err) {
      console.error('フォロー切り替えエラー:', err);
    }
  };

  // 🚩 通報の分類ラベル
  const REPORT_CATEGORY_LABELS: Record<string, string> = {
    spam: 'スパム',
    abuse: '嫌がらせ・誹謗中傷',
    sensitive: '不適切な内容',
    impersonation: 'なりすまし',
    other: 'その他',
  };

  // 🚩 通報一覧の取得（管理者）
  const fetchReports = async (status: 'open' | 'all' | 'resolved' | 'rejected' = reportStatusFilter) => {
    if (!authToken) return;
    try {
      const res = await fetch(`/api/admin/reports?status=${status}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setAdminReports(data.reports || []);
      setAdminReportCounts(data.counts || { open: 0, total: 0 });
    } catch (err) {
      console.error('通報一覧の取得エラー:', err);
    }
  };

  // 🚩 通報への対応（対応済み / 却下 / 再オープン）
  const handleResolveReport = async (reportId: string, action: 'resolve' | 'reject' | 'reopen') => {
    if (!authToken) return;
    setIsUpdatingReport(reportId);
    setReportActionMsg(null);
    try {
      const res = await fetch(`/api/admin/reports/${encodeURIComponent(reportId)}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (res.ok) {
        setReportActionMsg({
          type: 'success',
          text:
            action === 'resolve'
              ? '通報を「対応済み」にしました。'
              : action === 'reject'
                ? '通報を「却下」にしました。'
                : '通報を再オープンしました。',
        });
        await fetchAdminData();
      } else {
        setReportActionMsg({ type: 'error', text: data.error || '通報の更新に失敗しました。' });
      }
    } catch (err: any) {
      setReportActionMsg({ type: 'error', text: err.message });
    } finally {
      setIsUpdatingReport(null);
    }
  };

  // 🚩 通報の送信（一般ユーザー）
  const handleSubmitReport = async () => {
    if (!authToken || !reportTarget) return;
    setIsSubmittingReport(true);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(
          reportTarget.type === 'post'
            ? { targetPostId: reportTarget.id, category: reportCategory, comment: reportComment }
            : { targetUserId: reportTarget.id, category: reportCategory, comment: reportComment },
        ),
      });
      const data = await res.json();
      if (res.ok) {
        setReportTarget(null);
        setReportComment('');
        setReportCategory('spam');
        alert(data.message || '通報を受け付けました。ご協力ありがとうございます。');
      } else {
        alert(data.error || '通報の送信に失敗しました。');
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsSubmittingReport(false);
    }
  };

  // 管理者データの取得
  const fetchAdminData = async () => {
    if (!authToken || authUser?.role !== 'admin') return;
    setIsLoadingAdmin(true);
    try {
      const headers = { Authorization: `Bearer ${authToken}` };
      const [sRes, uRes, fRes, rRes, bRes, stRes, setRes, emRes, invRes, repRes, annRes] = await Promise.all([
        fetch('/api/admin/stats', { headers }),
        fetch('/api/admin/users', { headers }),
        fetch('/api/admin/federation', { headers }),
        fetch('/api/admin/relays', { headers }),
        fetch('/api/admin/blocks', { headers }),
        fetch('/api/admin/storage', { headers }),
        fetch('/api/admin/server-settings', { headers }),
        fetch('/api/admin/emojis', { headers }),
        fetch('/api/admin/invitations', { headers }),
        fetch('/api/admin/reports?status=all', { headers }),
        fetch('/api/admin/announcements', { headers }),
      ]);
      if (sRes.ok) setAdminStats(await sRes.json());
      if (uRes.ok) setAdminUsers(await uRes.json());
      if (fRes.ok) setAdminFederation(await fRes.json());
      if (rRes.ok) setAdminRelays(await rRes.json());
      if (bRes.ok) setAdminBlockedDomains(await bRes.json());
      if (emRes.ok) setAdminEmojis(await emRes.json());
      if (invRes.ok) setAdminInvitations(await invRes.json());
      if (annRes.ok) setAdminAnnouncements(await annRes.json());
      await fetchRoles();
      if (repRes.ok) {
        const repData = await repRes.json();
        setAdminReports(repData.reports || []);
        setAdminReportCounts(repData.counts || { open: 0, total: 0 });
      }
      if (stRes.ok) {
        const sData = await stRes.json();
        setAdminStorageConfig(sData);
        setStorageForm({
          endpoint: sData.endpoint || '',
          bucket: sData.bucket || '',
          accessKeyId: sData.accessKeyId || '',
          secretAccessKey: sData.secretAccessKey || '',
          publicUrl: sData.publicUrl || '',
          region: sData.region || 'auto',
        });
      }
      if (setRes && setRes.ok) {
        const setData = await setRes.json();
        setAdminServerName(setData.name || '');
        setAdminServerDesc(setData.description || '');
        setAdminServerIcon(setData.icon_url || '');
        setAdminServerBanner(setData.banner_url || '');
        setAdminTosUrl(setData.tos_url || '');
        setAdminPrivacyPolicyUrl(setData.privacy_policy_url || '');
        setAdminContactUrl(setData.contact_url || '');
        setAdminRepositoryUrl(setData.repository_url || '');
        setAdminOperatorUrl(setData.operator_url || '');
        const rulesArr = Array.isArray(setData.server_rules) ? setData.server_rules : [];
        setAdminServerRulesText(rulesArr.join('\n'));
        setAdminRequireRulesAgreement(setData.require_rules_agreement !== false);
      }
    } catch (err) {
      console.error('管理者データ取得エラー:', err);
    } finally {
      setIsLoadingAdmin(false);
    }
  };

  // サーバー基本設定の保存
  const handleSaveServerSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken) return;
    if (!adminServerName.trim()) {
      setServerSettingsMessage({ type: 'error', text: 'サーバー名は空にできません。' });
      return;
    }
    setIsSavingServerSettings(true);
    setServerSettingsMessage(null);
    try {
      const res = await fetch('/api/admin/server-settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          name: adminServerName.trim(),
          description: adminServerDesc.trim(),
          icon_url: adminServerIcon.trim(),
          banner_url: adminServerBanner.trim(),
          tos_url: adminTosUrl.trim(),
          privacy_policy_url: adminPrivacyPolicyUrl.trim(),
          contact_url: adminContactUrl.trim(),
          repository_url: adminRepositoryUrl.trim(),
          operator_url: adminOperatorUrl.trim(),
          server_rules: adminServerRulesText.split('\n').map((r) => r.trim()).filter((r) => r.length > 0),
          require_rules_agreement: adminRequireRulesAgreement,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '設定の保存に失敗しました。');

      setServerStats((prev: any) => prev ? {
        ...prev,
        name: data.settings.name,
        description: data.settings.description,
        icon_url: data.settings.icon_url,
        banner_url: data.settings.banner_url,
        tos_url: data.settings.tos_url,
        privacy_policy_url: data.settings.privacy_policy_url,
        contact_url: data.settings.contact_url,
        repository_url: data.settings.repository_url,
        operator_url: data.settings.operator_url,
        server_rules: data.settings.server_rules,
        require_rules_agreement: data.settings.require_rules_agreement,
      } : prev);
      document.title = data.settings.name;
      setServerSettingsMessage({ type: 'success', text: 'サーバー設定を保存しました！' });
    } catch (err: any) {
      setServerSettingsMessage({ type: 'error', text: err.message || '保存に失敗しました。' });
    } finally {
      setIsSavingServerSettings(false);
    }
  };

  // サーバーアイコンのアップロード
  const handleUploadServerIcon = async (file: File) => {
    if (!authToken) return;
    setIsUploadingServerIcon(true);
    setServerSettingsMessage(null);
    try {
      const formData = new FormData();
      formData.append('icon', file);
      const res = await fetch('/api/admin/server-icon', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'アップロードに失敗しました。');
      setAdminServerIcon(data.icon_url);
      setServerStats((prev: any) => prev ? { ...prev, icon_url: data.icon_url } : prev);
      setServerSettingsMessage({ type: 'success', text: 'サーバーアイコンを更新しました！' });
    } catch (err: any) {
      setServerSettingsMessage({ type: 'error', text: err.message || 'アイコンのアップロードに失敗しました。' });
    } finally {
      setIsUploadingServerIcon(false);
    }
  };

  // サーバーバナー画像のアップロード
  const handleUploadServerBanner = async (file: File) => {
    if (!authToken) return;
    setIsUploadingServerBanner(true);
    setServerSettingsMessage(null);
    try {
      const formData = new FormData();
      formData.append('banner', file);
      const res = await fetch('/api/admin/server-banner', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'バナーのアップロードに失敗しました。');
      setAdminServerBanner(data.banner_url);
      setServerStats((prev: any) => prev ? { ...prev, banner_url: data.banner_url } : prev);
      setServerSettingsMessage({ type: 'success', text: 'サーバーバナー画像を更新しました！' });
    } catch (err: any) {
      setServerSettingsMessage({ type: 'error', text: err.message || 'バナーのアップロードに失敗しました。' });
    } finally {
      setIsUploadingServerBanner(false);
    }
  };

  // 🎨 カスタム絵文字の登録 (管理者)
  const handleCreateEmoji = async (file?: File) => {
    if (!authToken) return;
    if (!newEmojiName.trim()) {
      setEmojiActionMsg({ type: 'error', text: '絵文字のショートコード名を入力してください。' });
      return;
    }
    if (!file && !newEmojiUrl.trim()) {
      setEmojiActionMsg({ type: 'error', text: '画像ファイルを選択するか、画像URLを入力してください。' });
      return;
    }
    setIsUploadingEmoji(true);
    setEmojiActionMsg(null);
    try {
      let res: Response;
      if (file) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('name', newEmojiName.trim());
        formData.append('category', newEmojiCategory.trim() || '一般');
        res = await fetch('/api/admin/emojis', {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
          body: formData,
        });
      } else {
        res = await fetch('/api/admin/emojis', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            name: newEmojiName.trim(),
            category: newEmojiCategory.trim() || '一般',
            url: newEmojiUrl.trim(),
          }),
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '絵文字の登録に失敗しました。');
      setNewEmojiName('');
      setNewEmojiUrl('');
      setEmojiActionMsg({ type: 'success', text: data.message || 'カスタム絵文字を登録しました！' });
      fetchCustomEmojis();
      fetchAdminData();
    } catch (err: any) {
      setEmojiActionMsg({ type: 'error', text: err.message || 'エラーが発生しました。' });
    } finally {
      setIsUploadingEmoji(false);
    }
  };

  // 🎨 カスタム絵文字の削除 (管理者)
  const handleDeleteEmoji = async (emojiId: string, emojiName: string) => {
    if (!authToken) return;
    if (!confirm(`:${emojiName}: を削除してもよろしいですか？`)) return;
    try {
      const res = await fetch(`/api/admin/emojis/${encodeURIComponent(emojiId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '削除に失敗しました。');
      setEmojiActionMsg({ type: 'success', text: data.message || '絵文字を削除しました。' });
      fetchCustomEmojis();
      fetchAdminData();
    } catch (err: any) {
      setEmojiActionMsg({ type: 'error', text: err.message || 'エラーが発生しました。' });
    }
  };

  // 🎟 招待コードの発行 (管理者)
  const handleCreateInvitation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken) return;
    setIsCreatingInvite(true);
    setInviteActionMsg(null);
    try {
      const res = await fetch('/api/admin/invitations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          maxUses: newInviteMaxUses,
          expiresInDays: newInviteExpiresDays === 'infinite' ? null : parseInt(newInviteExpiresDays, 10),
          memo: newInviteMemo.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '招待コードの発行に失敗しました。');
      setNewInviteMemo('');
      setInviteActionMsg({ type: 'success', text: `招待コード ${data.invitation.code} を発行しました！` });
      fetchAdminData();
    } catch (err: any) {
      setInviteActionMsg({ type: 'error', text: err.message || 'エラーが発生しました。' });
    } finally {
      setIsCreatingInvite(false);
    }
  };

  // 🎟 招待コードの削除 (管理者)
  const handleDeleteInvitation = async (code: string) => {
    if (!authToken) return;
    if (!confirm(`招待コード ${code} を無効化・削除しますか？`)) return;
    try {
      const res = await fetch(`/api/admin/invitations/${encodeURIComponent(code)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '削除に失敗しました。');
      setInviteActionMsg({ type: 'success', text: data.message || '招待コードを削除しました。' });
      fetchAdminData();
    } catch (err: any) {
      setInviteActionMsg({ type: 'error', text: err.message || 'エラーが発生しました。' });
    }
  };

  // 🔒 登録モードの切り替え (管理者)
  const handleChangeRegistrationMode = async (mode: 'open' | 'invite' | 'closed') => {
    if (!authToken) return;
    setIsUpdatingRegMode(true);
    setInviteActionMsg(null);
    try {
      const res = await fetch('/api/admin/registration-mode', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '登録モードの更新に失敗しました。');
      setServerStats((prev: any) => prev ? { ...prev, registration_mode: mode } : prev);
      setInviteActionMsg({ type: 'success', text: data.message });
      fetchServerStats();
    } catch (err: any) {
      setInviteActionMsg({ type: 'error', text: err.message || 'エラーが発生しました。' });
    } finally {
      setIsUpdatingRegMode(false);
    }
  };

  // 未読通知数の取得
  const fetchUnreadCount = async () => {
    if (!authToken) {
      setUnreadNotificationsCount(0);
      return;
    }
    try {
      const res = await fetch('/api/notifications/unread-count', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setUnreadNotificationsCount(data.unreadCount || 0);
      }
    } catch (err) {
      console.error('未読通知カウント取得エラー:', err);
    }
  };

  // 通知一覧の取得
  const fetchNotifications = async (filter = notificationFilter) => {
    if (!authToken) return;
    setIsLoadingNotifications(true);
    try {
      const query = filter !== 'all' ? `?filter=${filter}` : '';
      const res = await fetch(`/api/notifications${query}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setNotifications(data);
      }
    } catch (err) {
      console.error('通知一覧取得エラー:', err);
    } finally {
      setIsLoadingNotifications(false);
    }
  };

  // 全通知を既読にする
  const handleReadAllNotifications = async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/notifications/read-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        setNotifications((prev) => prev.map((n) => ({ ...n, is_read: 1 })));
        setUnreadNotificationsCount(0);
      }
    } catch (err) {
      console.error('一括既読エラー:', err);
    }
  };

  // 単一通知を既読にする
  const handleMarkNotificationRead = async (id: string) => {
    if (!authToken) return;
    try {
      const res = await fetch(`/api/notifications/${id}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: 1 } : n)));
        setUnreadNotificationsCount((prev) => Math.max(0, prev - 1));
      }
    } catch (err) {
      console.error('既読マークエラー:', err);
    }
  };

  // post_idからスレッドモーダルを開く
  const handleOpenThreadById = async (postId: string, push: boolean = true) => {
    if (push) {
      try {
        window.history.pushState({ modal: 'thread', postId }, '', `/?post=${encodeURIComponent(postId)}`);
      } catch {}
    }
    setIsLoadingThread(true);
    setThreadModalPost({ id: postId } as any);
    try {
      const res = await fetch(`/api/posts/${encodeURIComponent(postId)}/thread`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        setThreadData(data);
        setThreadModalPost(data.post);
      } else {
        alert('該当の投稿が見つかりませんでした。');
        setThreadModalPost(null);
      }
    } catch (err) {
      console.error('会話スレッド読み込みエラー:', err);
      setThreadModalPost(null);
    } finally {
      setIsLoadingThread(false);
    }
  };

  // 通知をクリックした時のインタラクション
  const handleNotificationClick = async (notif: AppNotification) => {
    if (!notif.is_read) {
      handleMarkNotificationRead(notif.id);
    }
    if (notif.type === 'follow') {
      openUserProfile(notif.actor_id);
    } else if (notif.post_id) {
      handleOpenThreadById(notif.post_id);
    }
  };

  // ブックマーク一覧取得
  const fetchBookmarks = async () => {
    if (!authToken) return;
    setIsLoadingBookmarks(true);
    try {
      const res = await fetch('/api/bookmarks', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setBookmarks(data);
      }
    } catch (err) {
      console.error('ブックマーク取得エラー:', err);
    } finally {
      setIsLoadingBookmarks(false);
    }
  };

  // ブックマーク追加・解除トグル
  const handleToggleBookmark = async (postId: string) => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    try {
      const res = await fetch('/api/bookmarks/toggle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ postId }),
      });
      if (res.ok) {
        const data = await res.json();
        const isBookmarked = data.bookmarked;

        const updatePost = (p: Post) => (p.id === postId ? { ...p, bookmarked: isBookmarked } : p);
        setTimeline((prev) => prev.map(updatePost));
        setProfilePosts((prev) => prev.map(updatePost));
        setSearchResults((prev) =>
          prev
            ? {
                ...prev,
                posts: prev.posts.map(updatePost),
              }
            : null
        );

        if (!isBookmarked) {
          setBookmarks((prev) => prev.filter((p) => p.id !== postId));
        } else {
          // 該当投稿が bookmarks になければ追加
          setBookmarks((prev) => {
            if (prev.some((p) => p.id === postId)) return prev;
            const found =
              timeline.find((p) => p.id === postId) ||
              profilePosts.find((p) => p.id === postId) ||
              searchResults?.posts.find((p) => p.id === postId);
            return found ? [{ ...found, bookmarked: true }, ...prev] : prev;
          });
        }
      } else {
        const err = await res.json().catch(() => ({}));
        console.error('Bookmark toggle failed:', err);
      }
    } catch (err) {
      console.error('ブックマークトグルエラー:', err);
    }
  };

  // 📌 投稿のピン留め追加・解除トグル (プロフィール固定)
  const handleTogglePinPost = async (postId: string) => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    try {
      const res = await fetch('/api/posts/pin/toggle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ postId }),
      });
      if (res.ok) {
        const data = await res.json();
        const isPinned = data.pinned;

        const updatePost = (p: Post) => (p.id === postId ? { ...p, is_pinned: isPinned } : p);
        setTimeline((prev) => prev.map(updatePost));
        setProfilePosts((prev) => prev.map(updatePost));
        setSearchResults((prev) =>
          prev
            ? {
                ...prev,
                posts: prev.posts.map(updatePost),
              }
            : null
        );

        // プロフィール表示中なら profileData.pinned_posts も更新
        setProfileData((prev) => {
          if (!prev) return prev;
          let newPinned = [...(prev.pinned_posts || [])];
          if (!isPinned) {
            newPinned = newPinned.filter((p) => p.id !== postId);
          } else {
            if (!newPinned.some((p) => p.id === postId)) {
              const target =
                profilePosts.find((p) => p.id === postId) ||
                timeline.find((p) => p.id === postId) ||
                searchResults?.posts.find((p) => p.id === postId);
              if (target) newPinned = [{ ...target, is_pinned: true }, ...newPinned];
            }
          }
          return { ...prev, pinned_posts: newPinned };
        });

        alert(isPinned ? '📌 プロフィールの先頭にピン留めしました！' : '📌 ピン留めを解除しました。');
      } else {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'ピン留め処理に失敗しました。');
      }
    } catch (err: any) {
      alert(`ピン留めエラー: ${err.message}`);
    }
  };

  // ブロック・ミュート一覧取得
  // 🔇 ワードフィルターの取得 / 追加 / 削除
  const fetchMutedWords = async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/muted-words', { headers: { Authorization: `Bearer ${authToken}` } });
      if (res.ok) setMutedWords(await res.json());
    } catch (err) {
      console.error('ミュートワードの取得エラー:', err);
    }
  };

  const handleAddMutedWord = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authToken || !newMutedWord.trim()) return;
    setIsSavingMutedWord(true);
    try {
      const res = await fetch('/api/muted-words', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          keyword: newMutedWord.trim(),
          caseSensitive: mutedWordCaseSensitive,
          wholeWord: mutedWordWholeWord,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setNewMutedWord('');
        setMutedWordCaseSensitive(false);
        setMutedWordWholeWord(false);
        await fetchMutedWords();
        await fetchTimeline();
      } else {
        alert(data.error || 'キーワードの登録に失敗しました。');
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsSavingMutedWord(false);
    }
  };

  const handleDeleteMutedWord = async (id: string) => {
    if (!authToken) return;
    try {
      const res = await fetch(`/api/muted-words/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        await fetchMutedWords();
        await fetchTimeline();
      }
    } catch (err) {
      console.error('ミュートワードの削除エラー:', err);
    }
  };

  // 🔒 フォローリクエスト（鍵アカウント）の取得 / 承認・拒否
  const fetchFollowRequests = async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/follow-requests', { headers: { Authorization: `Bearer ${authToken}` } });
      if (res.ok) setFollowRequests(await res.json());
    } catch (err) {
      console.error('フォローリクエストの取得エラー:', err);
    }
  };

  const handleRespondFollowRequest = async (actorUrl: string, action: 'accept' | 'reject') => {
    if (!authToken) return;
    setIsRespondingRequest(actorUrl);
    try {
      const res = await fetch('/api/follow-requests/respond', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ actorUrl, action }),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchFollowRequests();
        alert(action === 'accept' ? 'フォローを承認しました。' : 'フォローを拒否しました。');
      } else {
        alert(data.error || '処理に失敗しました。');
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsRespondingRequest(null);
    }
  };

  // 📢 お知らせ
  const [adminAnnouncements, setAdminAnnouncements] = useState<any[]>([]);
  const [newAnnouncementTitle, setNewAnnouncementTitle] = useState<string>('');
  const [newAnnouncementContent, setNewAnnouncementContent] = useState<string>('');
  const [isSavingAnnouncement, setIsSavingAnnouncement] = useState<boolean>(false);
  const [announcementMsg, setAnnouncementMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [publicAnnouncements, setPublicAnnouncements] = useState<any[]>([]);
  const [dismissedAnnouncements, setDismissedAnnouncements] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('spica_dismissed_announcements') || '[]');
    } catch {
      return [];
    }
  });

  // 📋 リスト（ユーザーを束ねた専用タイムライン）
  const [lists, setLists] = useState<any[]>([]);
  const [showListsModal, setShowListsModal] = useState<boolean>(false);
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [listTimelinePosts, setListTimelinePosts] = useState<Post[]>([]);
  const [isLoadingListTimeline, setIsLoadingListTimeline] = useState<boolean>(false);
  const [newListName, setNewListName] = useState<string>('');
  const [newListMember, setNewListMember] = useState<string>('');
  const [listActionMsg, setListActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 🗂️ ドライブ（自分のアップロード管理）
  const [showDriveModal, setShowDriveModal] = useState<boolean>(false);
  const [driveItems, setDriveItems] = useState<any[]>([]);
  const [driveStats, setDriveStats] = useState<{ count: number; bytes: number; quotaBytes: number }>({ count: 0, bytes: 0, quotaBytes: 0 });
  const [isLoadingDrive, setIsLoadingDrive] = useState<boolean>(false);
  const [isUploadingToDrive, setIsUploadingToDrive] = useState<boolean>(false);
  const [driveMsg, setDriveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 🔔 通知の種類別設定
  const [notificationPrefs, setNotificationPrefs] = useState<Record<string, boolean> | null>(null);
  const [notificationTypes, setNotificationTypes] = useState<{ type: string; label: string }[]>([]);
  const [isSavingNotifPrefs, setIsSavingNotifPrefs] = useState<boolean>(false);

  // 🗂️ ドライブ: 一覧と使用量を取得
  const fetchDrive = async () => {
    if (!authToken) return;
    setIsLoadingDrive(true);
    try {
      const res = await fetch('/api/drive', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      if (res.ok) {
        setDriveItems(Array.isArray(data.items) ? data.items : []);
        if (data.stats) setDriveStats(data.stats);
        setDriveMsg(null);
      } else {
        setDriveMsg({ type: 'error', text: data.error || 'ドライブの取得に失敗しました。' });
      }
    } catch (err: any) {
      setDriveMsg({ type: 'error', text: err.message });
    } finally {
      setIsLoadingDrive(false);
    }
  };

  // 🗂️ ドライブ: メディアを削除（投稿で使用中のものはサーバーが拒否する）
  const handleDeleteDriveMedia = async (id: string) => {
    if (!authToken) return;
    if (!confirm('このファイルを削除しますか？（元に戻せません）')) return;
    try {
      const res = await fetch(`/api/drive/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      if (!res.ok) {
        setDriveMsg({ type: 'error', text: data.error || '削除に失敗しました。' });
        return;
      }
      setDriveItems((prev) => prev.filter((item) => item.id !== id));
      if (data.stats) setDriveStats(data.stats);
      setDriveMsg({ type: 'success', text: 'ファイルを削除しました。' });
    } catch (err: any) {
      setDriveMsg({ type: 'error', text: err.message });
    }
  };

  // 🗂️ ドライブ: ファイルを追加アップロード（投稿には添付せずドライブに置く）
  const handleDriveUpload = async (files: FileList | null) => {
    if (!authToken || !files || files.length === 0) return;
    setIsUploadingToDrive(true);
    setDriveMsg(null);
    try {
      const form = new FormData();
      Array.from(files).slice(0, 4).forEach((file) => form.append('file', file));
      const res = await fetch('/api/media/upload', { method: 'POST', headers: { Authorization: `Bearer ${authToken}` }, body: form });
      const data = await res.json();
      if (!res.ok) {
        setDriveMsg({ type: 'error', text: data.error || 'アップロードに失敗しました。' });
        return;
      }
      setDriveMsg({ type: 'success', text: `${data.media?.length ?? 0} 件アップロードしました。` });
      await fetchDrive();
    } catch (err: any) {
      setDriveMsg({ type: 'error', text: err.message });
    } finally {
      setIsUploadingToDrive(false);
    }
  };

  // 🔔 通知の種類別設定を取得
  const fetchNotificationSettings = async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/notifications/settings', { headers: { Authorization: `Bearer ${authToken}` } });
      if (!res.ok) return;
      const data = await res.json();
      setNotificationPrefs(data.prefs || {});
      setNotificationTypes(Array.isArray(data.types) ? data.types : []);
    } catch (err) {
      console.error('通知設定の取得エラー:', err);
    }
  };

  // 🔔 通知の種類別設定を保存（切り替えた種類だけ送る）
  const handleToggleNotificationPref = async (type: string, enabled: boolean) => {
    if (!authToken || !notificationPrefs) return;
    const next = { ...notificationPrefs, [type]: enabled };
    setNotificationPrefs(next);
    setIsSavingNotifPrefs(true);
    try {
      const res = await fetch('/api/notifications/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ prefs: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotificationPrefs(notificationPrefs);
        alert(data.error || '通知設定の保存に失敗しました。');
        return;
      }
      setNotificationPrefs(data.prefs || next);
    } catch (err: any) {
      setNotificationPrefs(notificationPrefs);
      alert(err.message);
    } finally {
      setIsSavingNotifPrefs(false);
    }
  };

  const fetchLists = async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/lists', { headers: { Authorization: `Bearer ${authToken}` } });
      if (res.ok) {
        const data = await res.json();
        setLists(data);
        if (!activeListId && data.length > 0) {
          setActiveListId(data[0].id);
        }
      }
    } catch (err) {
      console.error('リストの取得エラー:', err);
    }
  };

  const handleCreateList = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authToken || !newListName.trim()) return;
    try {
      const res = await fetch('/api/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ name: newListName.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setNewListName('');
        setListActionMsg({ type: 'success', text: `リスト「${data.name}」を作成しました。` });
        await fetchLists();
      } else {
        setListActionMsg({ type: 'error', text: data.error || 'リストの作成に失敗しました。' });
      }
    } catch (err: any) {
      setListActionMsg({ type: 'error', text: err.message });
    }
  };

  const handleDeleteList = async (id: string) => {
    if (!authToken) return;
    if (!confirm('このリストを削除しますか？')) return;
    try {
      const res = await fetch(`/api/lists/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        if (activeListId === id) {
          setActiveListId(null);
          setListTimelinePosts([]);
        }
        setListActionMsg({ type: 'success', text: 'リストを削除しました。' });
        await fetchLists();
      }
    } catch (err) {
      console.error('リストの削除エラー:', err);
    }
  };

  const handleAddListMember = async (listId: string, e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authToken || !newListMember.trim()) return;
    try {
      const res = await fetch(`/api/lists/${encodeURIComponent(listId)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ member: newListMember.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setNewListMember('');
        setListActionMsg({ type: 'success', text: `${data.display_name} を追加しました。` });
        await fetchLists();
      } else {
        setListActionMsg({ type: 'error', text: data.error || 'メンバーの追加に失敗しました。' });
      }
    } catch (err: any) {
      setListActionMsg({ type: 'error', text: err.message });
    }
  };

  const handleRemoveListMember = async (listId: string, memberId: string) => {
    if (!authToken) return;
    try {
      const res = await fetch(`/api/lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(memberId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        await fetchLists();
      }
    } catch (err) {
      console.error('メンバーの削除エラー:', err);
    }
  };

  const openListTimeline = async (listId: string) => {
    if (!authToken) return;
    setActiveListId(listId);
    setIsLoadingListTimeline(true);
    try {
      const res = await fetch(`/api/lists/${encodeURIComponent(listId)}/timeline`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setListTimelinePosts(data.posts || []);
      }
    } catch (err) {
      console.error('リストタイムラインの取得エラー:', err);
    } finally {
      setIsLoadingListTimeline(false);
    }
  };

  // 🎭 ロール（権限）管理
  const [adminRoles, setAdminRoles] = useState<any[]>([]);
  const [availablePermissions, setAvailablePermissions] = useState<{ key: string; label: string }[]>([]);
  const [newRoleName, setNewRoleName] = useState<string>('');
  const [newRoleColor, setNewRoleColor] = useState<string>('#6366f1');
  const [newRolePermissions, setNewRolePermissions] = useState<string[]>([]);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [roleActionMsg, setRoleActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 👥 プロフィール項目 / バッジ / ユーザーディレクトリ
  const [editFields, setEditFields] = useState<{ name: string; value: string }[]>([]);
  const [profileDiscoverable, setProfileDiscoverable] = useState<boolean>(true);
  const [showDirectoryModal, setShowDirectoryModal] = useState<boolean>(false);
  const [directoryUsers, setDirectoryUsers] = useState<any[]>([]);
  const [directorySearch, setDirectorySearch] = useState<string>('');
  const [isLoadingDirectory, setIsLoadingDirectory] = useState<boolean>(false);

  // 📧 メールアドレス登録 / 🔑 マスターキー復元 / 管理者のメール設定
  const [recoveryStatus, setRecoveryStatus] = useState<{ authMode: string; allowEmailRegistration: boolean; mailConfigured: boolean; recoveryAvailable: boolean }>({
    authMode: 'master_key',
    allowEmailRegistration: false,
    mailConfigured: false,
    recoveryAvailable: false,
  });

  // インスタンスの認証方式 (auth_mode = password なら メールアドレス＋パスワード方式で登録・ログインする)
  const isPasswordAuthMode = String(recoveryStatus.authMode || 'master_key').toLowerCase() === 'password';
  // ログイン画面で今どちらの方式を表示しているか (切替リンクで入れ替えられる)
  const showPasswordLoginForm = isPasswordAuthMode && loginMethod === 'password';

  // サーバー側 (routes/api.ts の isValidEmail) と同じ形式チェック
  const isValidEmailFormat = (value: string): boolean =>
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254;

  useEffect(() => {
    setLoginMethod(isPasswordAuthMode ? 'password' : 'master_key');
  }, [isPasswordAuthMode]);

  const [myEmail, setMyEmail] = useState<string>('');
  const [myEmailVerified, setMyEmailVerified] = useState<boolean>(false);
  const [emailInput, setEmailInput] = useState<string>('');
  const [emailCode, setEmailCode] = useState<string>('');
  const [emailMsg, setEmailMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isSendingEmail, setIsSendingEmail] = useState<boolean>(false);
  // 🔑 パスワードの設定・変更（password 方式）
  const [pwCurrent, setPwCurrent] = useState<string>('');
  const [pwMasterKey, setPwMasterKey] = useState<string>('');
  const [pwNew, setPwNew] = useState<string>('');
  const [pwNewConfirm, setPwNewConfirm] = useState<string>('');
  const [isSavingPassword, setIsSavingPassword] = useState<boolean>(false);
  const [passwordMsg, setPasswordMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showRecoveryModal, setShowRecoveryModal] = useState<boolean>(false);
  const [recoveryUserId, setRecoveryUserId] = useState<string>('');
  const [recoveryEmail, setRecoveryEmail] = useState<string>('');
  const [recoveryCode, setRecoveryCode] = useState<string>('');
  const [recoveryStep, setRecoveryStep] = useState<'request' | 'verify' | 'done'>('request');
  const [recoveryMsg, setRecoveryMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isRecovering, setIsRecovering] = useState<boolean>(false);
  const [mailSettings, setMailSettings] = useState<any>({ host: '', port: 587, secure: false, user: '', pass: '', from: '', allowEmailRegistration: false, authMode: 'master_key' });
  const [mailSettingsMsg, setMailSettingsMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isSavingMail, setIsSavingMail] = useState<boolean>(false);
  // 📮 配送再送キューの状態（管理画面）
  const [deliveryQueue, setDeliveryQueue] = useState<any>({
    stats: { pending: 0, delivered: 0, failed: 0, nextAttemptAt: null },
    pending: [],
    recentFailures: [],
    maxAttempts: 9,
    retryDelaysMs: [],
  });
  const [isLoadingDeliveryQueue, setIsLoadingDeliveryQueue] = useState<boolean>(false);
  const [isActingOnDelivery, setIsActingOnDelivery] = useState<boolean>(false);
  const [deliveryQueueMsg, setDeliveryQueueMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchRecoveryStatus = async () => {
    try {
      const res = await fetch('/api/auth/recovery/status');
      if (res.ok) setRecoveryStatus(await res.json());
    } catch (err) {
      console.error('認証設定の取得エラー:', err);
    }
  };

  // 📮 配送再送キュー（ActivityPub 配送の指数バックオフ再送）
  const fetchDeliveryQueue = async () => {
    if (!authToken) return;
    setIsLoadingDeliveryQueue(true);
    try {
      const res = await fetch('/api/admin/delivery-queue', { headers: { Authorization: `Bearer ${authToken}` } });
      if (res.ok) setDeliveryQueue(await res.json());
    } catch (err) {
      console.error('配送キューの取得エラー:', err);
    } finally {
      setIsLoadingDeliveryQueue(false);
    }
  };

  const handleRetryDeliveries = async () => {
    if (!authToken) return;
    setIsActingOnDelivery(true);
    setDeliveryQueueMsg(null);
    try {
      const res = await fetch('/api/admin/delivery-queue/retry', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setDeliveryQueueMsg({ type: 'error', text: data.error || '再送の実行に失敗しました。' });
        return;
      }
      setDeliveryQueueMsg({ type: 'success', text: data.message || '再送を開始しました。' });
      await fetchDeliveryQueue();
    } catch (err: any) {
      setDeliveryQueueMsg({ type: 'error', text: err.message });
    } finally {
      setIsActingOnDelivery(false);
    }
  };

  const handleClearFailedDeliveries = async () => {
    if (!authToken) return;
    if (!window.confirm('失敗が確定した配送の記録を削除しますか？（再送は行われません）')) return;
    setIsActingOnDelivery(true);
    setDeliveryQueueMsg(null);
    try {
      const res = await fetch('/api/admin/delivery-queue/clear-failed', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setDeliveryQueueMsg({ type: 'error', text: data.error || '削除に失敗しました。' });
        return;
      }
      setDeliveryQueueMsg({ type: 'success', text: data.message || '削除しました。' });
      await fetchDeliveryQueue();
    } catch (err: any) {
      setDeliveryQueueMsg({ type: 'error', text: err.message });
    } finally {
      setIsActingOnDelivery(false);
    }
  };

  const fetchMailSettings = async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/admin/mail-settings', { headers: { Authorization: `Bearer ${authToken}` } });
      if (res.ok) setMailSettings(await res.json());
    } catch (err) {
      console.error('メール設定の取得エラー:', err);
    }
  };

  const handleSaveMailSettings = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authToken) return;
    setIsSavingMail(true);
    setMailSettingsMsg(null);
    try {
      const res = await fetch('/api/admin/mail-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          host: mailSettings.host,
          port: mailSettings.port,
          secure: mailSettings.secure,
          user: mailSettings.user,
          pass: mailSettings.pass,
          from: mailSettings.from,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMailSettingsMsg({ type: 'error', text: data.error || '保存に失敗しました。' });
        return;
      }

      // 認証方式・メール登録可否も同時に保存する
      const authRes = await fetch('/api/admin/auth-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          authMode: mailSettings.authMode,
          allowEmailRegistration: mailSettings.allowEmailRegistration,
        }),
      });
      if (!authRes.ok) {
        const authData = await authRes.json();
        setMailSettingsMsg({ type: 'error', text: authData.error || '認証設定の保存に失敗しました。' });
        return;
      }

      setMailSettingsMsg({ type: 'success', text: 'メール・認証設定を保存しました。' });
      setMailSettings((prev: any) => ({ ...prev, pass: '' }));
      await fetchRecoveryStatus();
    } catch (err: any) {
      setMailSettingsMsg({ type: 'error', text: err.message });
    } finally {
      setIsSavingMail(false);
    }
  };

  const handleTestMailSettings = async () => {
    if (!authToken) return;
    setIsSavingMail(true);
    setMailSettingsMsg(null);
    try {
      const res = await fetch('/api/admin/mail-settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ host: mailSettings.host, port: mailSettings.port, user: mailSettings.user, pass: mailSettings.pass, from: mailSettings.from }),
      });
      const data = await res.json();
      setMailSettingsMsg(
        res.ok
          ? { type: 'success', text: data.message || 'SMTP に接続できました。' }
          : { type: 'error', text: data.error || '接続テストに失敗しました。' },
      );
    } catch (err: any) {
      setMailSettingsMsg({ type: 'error', text: err.message });
    } finally {
      setIsSavingMail(false);
    }
  };

  // メールアドレスの登録（確認コード送信 → 検証）
  const handleSendEmailCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authToken || !emailInput.trim()) return;
    setIsSendingEmail(true);
    setEmailMsg(null);
    try {
      const res = await fetch('/api/user/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ email: emailInput.trim() }),
      });
      const data = await res.json();
      setEmailMsg(res.ok
        ? { type: 'success', text: data.message || '確認コードを送信しました。' }
        : { type: 'error', text: data.error || '送信に失敗しました。' });
    } catch (err: any) {
      setEmailMsg({ type: 'error', text: err.message });
    } finally {
      setIsSendingEmail(false);
    }
  };

  const handleVerifyEmail = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authToken || !emailInput.trim() || !emailCode.trim()) return;
    setIsSendingEmail(true);
    setEmailMsg(null);
    try {
      const res = await fetch('/api/user/email/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ email: emailInput.trim(), code: emailCode.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setMyEmail(emailInput.trim().toLowerCase());
        setMyEmailVerified(true);
        setEmailCode('');
        setEmailMsg({ type: 'success', text: data.message || 'メールアドレスを確認しました。' });
      } else {
        setEmailMsg({ type: 'error', text: data.error || '確認に失敗しました。' });
      }
    } catch (err: any) {
      setEmailMsg({ type: 'error', text: err.message });
    } finally {
      setIsSendingEmail(false);
    }
  };

  const handleDeleteEmail = async () => {
    if (!authToken) return;
    if (!confirm('登録したメールアドレスを削除しますか？（マスターキーの復元ができなくなります）')) return;
    try {
      const res = await fetch('/api/user/email', { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } });
      if (res.ok) {
        setMyEmail('');
        setMyEmailVerified(false);
        setEmailInput('');
        setEmailMsg({ type: 'success', text: 'メールアドレスを削除しました。' });
      }
    } catch (err) {
      console.error('メールアドレスの削除エラー:', err);
    }
  };

  // 🔑 パスワードの設定・変更（password 方式のサーバー用）
  //    パスワード未設定ならマスターキー必須、設定済みなら現在のパスワードかマスターキーで認証する
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken) return;
    setPasswordMsg(null);

    const hasPassword = Boolean(authUser?.hasPassword);
    if (pwNew.length < 8) {
      setPasswordMsg({ type: 'error', text: '新しいパスワードは8文字以上で入力してください。' });
      return;
    }
    if (pwNew !== pwNewConfirm) {
      setPasswordMsg({ type: 'error', text: '確認用の新しいパスワードが一致しません。' });
      return;
    }
    if (hasPassword ? (!pwCurrent && !pwMasterKey.trim()) : !pwMasterKey.trim()) {
      setPasswordMsg({
        type: 'error',
        text: hasPassword
          ? '現在のパスワード、またはマスターキーを入力してください。'
          : 'パスワードを新しく設定するにはマスターキーが必要です。',
      });
      return;
    }

    setIsSavingPassword(true);
    try {
      const res = await fetch('/api/user/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          newPassword: pwNew,
          ...(pwCurrent ? { currentPassword: pwCurrent } : {}),
          ...(pwMasterKey.trim() ? { masterKey: pwMasterKey.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPasswordMsg({ type: 'error', text: data.error || 'パスワードの変更に失敗しました。' });
        return;
      }
      setPasswordMsg({ type: 'success', text: data.message || 'パスワードを変更しました。' });
      setPwCurrent('');
      setPwMasterKey('');
      setPwNew('');
      setPwNewConfirm('');
      setAuthUser((prev) => (prev ? { ...prev, hasPassword: true } : prev));
    } catch (err: any) {
      setPasswordMsg({ type: 'error', text: err.message });
    } finally {
      setIsSavingPassword(false);
    }
  };

  // 🔑 マスターキー復元（ID+メール → 確認コード → 新しいキーをメールで受領）
  const handleRecoveryRequest = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!recoveryUserId.trim() || !recoveryEmail.trim()) return;
    setIsRecovering(true);
    setRecoveryMsg(null);
    try {
      const res = await fetch('/api/auth/recovery/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: recoveryUserId.trim(), email: recoveryEmail.trim() }),
      });
      const data = await res.json();
      setRecoveryStep('verify');
      setRecoveryMsg({ type: 'success', text: data.message || '確認コードを送信しました。メールをご確認ください。' });
    } catch (err: any) {
      setRecoveryMsg({ type: 'error', text: err.message });
    } finally {
      setIsRecovering(false);
    }
  };

  const handleRecoveryVerify = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!recoveryCode.trim()) return;
    setIsRecovering(true);
    setRecoveryMsg(null);
    try {
      const res = await fetch('/api/auth/recovery/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: recoveryUserId.trim(), email: recoveryEmail.trim(), code: recoveryCode.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setRecoveryStep('done');
        setRecoveryMsg({ type: 'success', text: data.message || '新しいマスターキーをメールで送信しました。' });
      } else {
        setRecoveryMsg({ type: 'error', text: data.error || '復元に失敗しました。' });
      }
    } catch (err: any) {
      setRecoveryMsg({ type: 'error', text: err.message });
    } finally {
      setIsRecovering(false);
    }
  };

  const fetchDirectory = async (query = '') => {
    setIsLoadingDirectory(true);
    try {
      const res = await fetch(`/api/directory?limit=100${query ? `&q=${encodeURIComponent(query)}` : ''}`);
      if (res.ok) {
        const data = await res.json();
        setDirectoryUsers(data.users || []);
      }
    } catch (err) {
      console.error('ディレクトリの取得エラー:', err);
    } finally {
      setIsLoadingDirectory(false);
    }
  };

  const fetchRoles = async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/admin/roles', { headers: { Authorization: `Bearer ${authToken}` } });
      if (res.ok) {
        const data = await res.json();
        setAdminRoles(data.roles || []);
        setAvailablePermissions(data.availablePermissions || []);
      }
    } catch (err) {
      console.error('ロールの取得エラー:', err);
    }
  };

  const handleSaveRole = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authToken || !newRoleName.trim() || newRolePermissions.length === 0) return;
    const isEdit = Boolean(editingRoleId);
    try {
      const res = await fetch(isEdit ? `/api/admin/roles/${encodeURIComponent(editingRoleId as string)}` : '/api/admin/roles', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ name: newRoleName.trim(), color: newRoleColor, permissions: newRolePermissions }),
      });
      const data = await res.json();
      if (res.ok) {
        setRoleActionMsg({ type: 'success', text: isEdit ? 'ロールを更新しました。' : `ロール「${newRoleName.trim()}」を作成しました。` });
        setNewRoleName('');
        setNewRoleColor('#6366f1');
        setNewRolePermissions([]);
        setEditingRoleId(null);
        await fetchRoles();
        await fetchAdminData();
      } else {
        setRoleActionMsg({ type: 'error', text: data.error || 'ロールの保存に失敗しました。' });
      }
    } catch (err: any) {
      setRoleActionMsg({ type: 'error', text: err.message });
    }
  };

  const handleEditRole = (role: any) => {
    setEditingRoleId(role.id);
    setNewRoleName(role.name);
    setNewRoleColor(role.color || '#6366f1');
    setNewRolePermissions(String(role.permissions || '').split(',').map((p) => p.trim()).filter(Boolean));
    setRoleActionMsg(null);
  };

  const handleDeleteRole = async (id: string) => {
    if (!authToken) return;
    if (!confirm('このロールを削除しますか？（付与済みのユーザーからも外れます）')) return;
    try {
      const res = await fetch(`/api/admin/roles/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        setRoleActionMsg({ type: 'success', text: 'ロールを削除しました。' });
        if (editingRoleId === id) {
          setEditingRoleId(null);
          setNewRoleName('');
          setNewRolePermissions([]);
        }
        await fetchRoles();
        await fetchAdminData();
      }
    } catch (err) {
      console.error('ロールの削除エラー:', err);
    }
  };

  // ユーザーへのロール付与（チップのクリックで付け外し）
  const handleToggleUserRole = async (userId: string, roleId: string) => {
    if (!authToken) return;
    const user = adminUsers.find((u: any) => u.id === userId);
    if (!user) return;

    const currentIds = new Set((user.roles || []).map((r: any) => r.id));
    if (currentIds.has(roleId)) {
      currentIds.delete(roleId);
    } else {
      currentIds.add(roleId);
    }

    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/roles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ roleIds: Array.from(currentIds) }),
      });
      const data = await res.json();
      if (res.ok) {
        setRoleActionMsg({ type: 'success', text: `@${userId} のロールを更新しました。` });
        await fetchAdminData();
        await fetchRoles();
      } else {
        setRoleActionMsg({ type: 'error', text: data.error || 'ロールの更新に失敗しました。' });
      }
    } catch (err: any) {
      setRoleActionMsg({ type: 'error', text: err.message });
    }
  };

  // 📥 アカウント移行インポート
  const [importFile, setImportFile] = useState<File | null>(null);
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [importResult, setImportResult] = useState<{ type: 'success' | 'error'; text: string; detail?: string } | null>(null);

  // 📢 お知らせの取得（全ユーザー向け / 管理者向け）
  const fetchAnnouncements = async () => {
    try {
      const res = await fetch('/api/announcements');
      if (res.ok) setPublicAnnouncements(await res.json());
    } catch (err) {
      console.error('お知らせの取得エラー:', err);
    }
  };

  const fetchAdminAnnouncements = async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/admin/announcements', { headers: { Authorization: `Bearer ${authToken}` } });
      if (res.ok) setAdminAnnouncements(await res.json());
    } catch (err) {
      console.error('お知らせ管理の取得エラー:', err);
    }
  };

  const handleCreateAnnouncement = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authToken || !newAnnouncementTitle.trim() || !newAnnouncementContent.trim()) return;
    setIsSavingAnnouncement(true);
    setAnnouncementMsg(null);
    try {
      const res = await fetch('/api/admin/announcements', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ title: newAnnouncementTitle.trim(), content: newAnnouncementContent.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setNewAnnouncementTitle('');
        setNewAnnouncementContent('');
        setAnnouncementMsg({ type: 'success', text: 'お知らせを投稿しました。' });
        await fetchAdminAnnouncements();
        await fetchAnnouncements();
      } else {
        setAnnouncementMsg({ type: 'error', text: data.error || 'お知らせの投稿に失敗しました。' });
      }
    } catch (err: any) {
      setAnnouncementMsg({ type: 'error', text: err.message });
    } finally {
      setIsSavingAnnouncement(false);
    }
  };

  const handleToggleAnnouncement = async (id: string, isActive: boolean) => {
    if (!authToken) return;
    try {
      const res = await fetch(`/api/admin/announcements/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        await fetchAdminAnnouncements();
        await fetchAnnouncements();
      }
    } catch (err) {
      console.error('お知らせの更新エラー:', err);
    }
  };

  const handleDeleteAnnouncement = async (id: string) => {
    if (!authToken) return;
    if (!confirm('このお知らせを削除しますか？')) return;
    try {
      const res = await fetch(`/api/admin/announcements/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        await fetchAdminAnnouncements();
        await fetchAnnouncements();
      }
    } catch (err) {
      console.error('お知らせの削除エラー:', err);
    }
  };

  const dismissAnnouncement = (id: string) => {
    const next = Array.from(new Set([...dismissedAnnouncements, id]));
    setDismissedAnnouncements(next);
    try {
      localStorage.setItem('spica_dismissed_announcements', JSON.stringify(next));
    } catch {}
  };

  // 起動 / ログイン時にお知らせと認証設定を取得
  useEffect(() => {
    fetchAnnouncements();
    fetchRecoveryStatus();
  }, [authToken]);

  useEffect(() => {
    setMyEmail(String((authUser as any)?.email || ''));
    setMyEmailVerified(Number((authUser as any)?.email_verified) === 1);
  }, [authUser]);

  // 📥 アーカイブ（Mastodon outbox.json / Misskey notes.json）の取り込み
  const handleImportArchive = async () => {
    if (!authToken || !importFile) return;
    setIsImporting(true);
    setImportResult(null);
    try {
      const form = new FormData();
      form.append('archive', importFile);

      const res = await fetch('/api/import/archive', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: form,
      });
      const data = await res.json();

      if (res.ok) {
        setImportResult({
          type: 'success',
          text: data.message || `${data.imported} 件の投稿を取り込みました。`,
          detail: `形式: ${data.format} / 取り込み: ${data.imported} / 重複スキップ: ${data.skipped} / 失敗: ${data.failed}${data.total ? ` / 対象: ${data.total}` : ''}${
            Array.isArray(data.errors) && data.errors.length > 0 ? `\n${data.errors.join('\n')}` : ''
          }`,
        });
        setImportFile(null);
        await fetchTimeline();
      } else {
        setImportResult({ type: 'error', text: data.error || 'インポートに失敗しました。' });
      }
    } catch (err: any) {
      setImportResult({ type: 'error', text: err.message });
    } finally {
      setIsImporting(false);
    }
  };

  const fetchBlocksAndMutes = async () => {
    if (!authToken) return;
    setIsLoadingBlocksMutes(true);
    try {
      const [bRes, mRes] = await Promise.all([
        fetch('/api/user/blocks', { headers: { Authorization: `Bearer ${authToken}` } }),
        fetch('/api/user/mutes', { headers: { Authorization: `Bearer ${authToken}` } }),
      ]);
      if (bRes.ok) setBlockedUsers(await bRes.json());
      if (mRes.ok) setMutedUsers(await mRes.json());
    } catch (err) {
      console.error('ブロック/ミュート取得エラー:', err);
    } finally {
      setIsLoadingBlocksMutes(false);
    }
  };

  // ユーザーブロック実行
  const handleBlockUser = async (targetIdentifier: string) => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    if (!confirm(`@${targetIdentifier} をブロックしますか？\n相手の投稿が非表示になり、相互フォローが解除されます。ActivityPub対応サーバーにもブロック通知が送信されます。`)) {
      return;
    }
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(targetIdentifier)}/block`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        // タイムライン・検索結果から即座に対象の投稿を除外
        const filterOut = (p: Post) => p.user_id !== targetIdentifier && p.author_handle !== targetIdentifier && p.author_url !== targetIdentifier;
        setTimeline((prev) => prev.filter(filterOut));
        setProfilePosts((prev) => prev.filter(filterOut));
        if (searchResults) {
          setSearchResults({
            ...searchResults,
            posts: searchResults.posts.filter(filterOut),
          });
        }
        if (profileData && (profileData.id === targetIdentifier || profileData.handle === targetIdentifier || profileData.actor_url === targetIdentifier)) {
          setProfileData({ ...profileData, is_blocked: true, is_following: false });
        }
        fetchBlocksAndMutes();
        alert(`@${targetIdentifier} をブロックしました。`);
      } else {
        const err = await res.json();
        alert(`ブロックに失敗しました: ${err.error || 'エラー'}`);
      }
    } catch (err) {
      console.error('ブロックエラー:', err);
    }
  };

  // ユーザーブロック解除
  const handleUnblockUser = async (targetIdentifier: string) => {
    if (!authToken) return;
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(targetIdentifier)}/unblock`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        if (profileData && (profileData.id === targetIdentifier || profileData.handle === targetIdentifier || profileData.actor_url === targetIdentifier)) {
          setProfileData({ ...profileData, is_blocked: false });
        }
        setBlockedUsers((prev) => prev.filter((u) => u.target_user_id !== targetIdentifier && u.target_handle !== targetIdentifier));
        fetchBlocksAndMutes();
        fetchTimeline();
        alert(`@${targetIdentifier} のブロックを解除しました。`);
      }
    } catch (err) {
      console.error('ブロック解除エラー:', err);
    }
  };

  // ユーザーミュート実行
  const handleMuteUser = async (targetIdentifier: string) => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    if (!confirm(`@${targetIdentifier} をミュートしますか？\nタイムラインや検索、通知から相手の投稿が非表示になります。`)) {
      return;
    }
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(targetIdentifier)}/mute`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const filterOut = (p: Post) => p.user_id !== targetIdentifier && p.author_handle !== targetIdentifier && p.author_url !== targetIdentifier;
        setTimeline((prev) => prev.filter(filterOut));
        setProfilePosts((prev) => prev.filter(filterOut));
        if (searchResults) {
          setSearchResults({
            ...searchResults,
            posts: searchResults.posts.filter(filterOut),
          });
        }
        if (profileData && (profileData.id === targetIdentifier || profileData.handle === targetIdentifier || profileData.actor_url === targetIdentifier)) {
          setProfileData({ ...profileData, is_muted: true });
        }
        fetchBlocksAndMutes();
        alert(`@${targetIdentifier} をミュートしました。`);
      } else {
        const err = await res.json();
        alert(`ミュートに失敗しました: ${err.error || 'エラー'}`);
      }
    } catch (err) {
      console.error('ミュートエラー:', err);
    }
  };

  // ユーザーミュート解除
  const handleUnmuteUser = async (targetIdentifier: string) => {
    if (!authToken) return;
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(targetIdentifier)}/unmute`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        if (profileData && (profileData.id === targetIdentifier || profileData.handle === targetIdentifier || profileData.actor_url === targetIdentifier)) {
          setProfileData({ ...profileData, is_muted: false });
        }
        setMutedUsers((prev) => prev.filter((u) => u.target_user_id !== targetIdentifier && u.target_handle !== targetIdentifier));
        fetchBlocksAndMutes();
        fetchTimeline();
        alert(`@${targetIdentifier} のミュートを解除しました。`);
      }
    } catch (err) {
      console.error('ミュート解除エラー:', err);
    }
  };

  // 認証チェックと未読通知ポーリング (未認証時はウェルカムポータルを表示)
  useEffect(() => {
    if (authToken) {
      checkAuth(authToken);
      fetchUnreadCount();
      fetchAntennas();
      fetchDrafts();
      fetchScheduledPosts();
      fetchChannels();
      fetchPasskeys();
      const timer = setInterval(fetchUnreadCount, 25000);
      return () => clearInterval(timer);
    } else {
      setShowAuthPortal(true);
      setAuthPortalTab('welcome');
    }
  }, [authToken]);

  // 🧭 URL パースと画面遷移の同期
  const parseUrlAndNavigate = (pathname: string, search: string, isInitial: boolean = false) => {
    try {
      const searchParams = new URLSearchParams(search);
      const postId = searchParams.get('post');

      // 1. ?post=:id がある場合、スレッドモーダルを開く
      if (postId) {
        handleOpenThreadById(postId, false);
      }

      // 2. パスによるルーティング
      if (pathname.startsWith('/users/')) {
        const userId = decodeURIComponent(pathname.replace('/users/', ''));
        if (userId) {
          openUserProfile(userId, false);
          return;
        }
      }

      if (pathname.startsWith('/channels/')) {
        const channelId = decodeURIComponent(pathname.replace('/channels/', ''));
        if (channelId) {
          setCurrentView('channels');
          openChannelDetailById(channelId, false);
          return;
        }
      }

      if (pathname === '/channels') {
        setCurrentView('channels');
        setSelectedChannel(null);
        fetchChannels();
        return;
      }

      if (pathname === '/notifications') {
        setCurrentView('notifications');
        return;
      }

      if (pathname === '/bookmarks') {
        setCurrentView('bookmarks');
        fetchBookmarks();
        return;
      }

      if (pathname === '/search') {
        setCurrentView('search');
        return;
      }

      if (pathname === '/settings') {
        setCurrentView('settings');
        return;
      }

      if (pathname === '/admin') {
        setCurrentView('admin');
        return;
      }

      // デフォルト: タイムライン
      if (!isInitial || currentViewRef.current !== 'profile') {
        setCurrentView('timeline');
        setSelectedChannel(null);
        const mode = searchParams.get('mode');
        if (mode && ['local', 'home', 'all'].includes(mode)) {
          handleSwitchTimelineMode(mode as any);
        }
      }
    } catch (e) {
      console.error('URL parse error:', e);
    }
  };

  // サーバー基本情報・人気タグ・カスタム絵文字の初期取得 & 招待リンク検知 & Web Push 状態確認 & History API 連動
  useEffect(() => {
    fetchServerStats();
    fetchPopularTags();
    fetchCustomEmojis();
    fetchChannels();
    checkPushSubscriptionStatus();

    // URL パラメータから招待コードを自動取得 (例: ?invite=spica-inv-xxx)
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const inviteCode = urlParams.get('invite');
      if (inviteCode) {
        setInviteCodeInput(inviteCode.trim());
        setShowAuthPortal(true);
        setAuthPortalTab('register');
      }
    } catch {}

    // PWA/SPA での戻る操作で真っ白なページに飛ぶのを防止するための履歴ガード
    try {
      if (!window.history.state || !window.history.state.spica_guard) {
        window.history.replaceState({ spica_guard: 'root', view: currentViewRef.current }, '', window.location.href);
        window.history.pushState({ spica_guard: 'active', view: currentViewRef.current }, '', window.location.href);
      }
    } catch {}

    // 初期URL解析 & ブラウザ戻る/進む・スマホ戻るイベントリスナー登録
    parseUrlAndNavigate(window.location.pathname, window.location.search, true);

    const handlePopState = () => {
      // 1. モーダルが開いていればモーダルのみ閉じる（アプリから離脱しない）
      if (closeAllModals()) {
        try {
          window.history.pushState({ spica_guard: 'active', view: currentViewRef.current }, '', window.location.href);
        } catch {}
        return;
      }

      // 2. チャンネル詳細画面にいて、URLがチャンネル詳細でないならチャンネル一覧に戻す
      if (selectedChannelRef.current && !window.location.pathname.startsWith('/channels/')) {
        setSelectedChannel(null);
        try {
          window.history.pushState({ spica_guard: 'active', view: 'channels' }, '', '/channels');
        } catch {}
        return;
      }

      // 3. サブ画面（設定、通知、検索、ブックマーク、管理者、個別プロフィール等）にいる場合はホーム（タイムライン）に戻す
      if (currentViewRef.current !== 'timeline') {
        navigateToView('timeline', false);
        try {
          window.history.pushState({ spica_guard: 'active', view: 'timeline' }, '', '/');
        } catch {}
        return;
      }

      // 4. すでにホーム画面（タイムライン）にいる場合:
      // スマホPWAで真っ白なページ（about:blank等）に飛ぶのを完全に防止する無限ガード
      try {
        window.history.pushState({ spica_guard: 'active', view: 'timeline' }, '', window.location.href);
      } catch {}

      // ホーム画面通知トーストを表示（連打防止: 1.5秒間隔）
      const now = Date.now();
      if (now - lastBackPressTimeRef.current > 1500) {
        lastBackPressTimeRef.current = now;
        setShowExitToast(true);
        setTimeout(() => {
          setShowExitToast(false);
        }, 2200);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  // タイムラインモード変更時または認証状態変化時のタイムライン自動取得
  useEffect(() => {
    fetchTimeline(timelineMode);
  }, [timelineMode, authToken]);

  useEffect(() => {
    if (currentView === 'admin') {
      fetchAdminData();
    } else if (currentView === 'notifications') {
      fetchNotifications(notificationFilter);
    } else if (currentView === 'search') {
      fetchPopularTags();
    } else if (currentView === 'bookmarks') {
      fetchBookmarks();
    } else if (currentView === 'settings' && settingsTab === 'mutes_blocks') {
      fetchBlocksAndMutes();
      fetchMutedWords();
      fetchFollowRequests();
    } else if (currentView === 'settings' && settingsTab === 'account') {
      fetchMigrationInfo();
    } else if (currentView === 'settings' && settingsTab === 'preferences') {
      fetchNotificationSettings();
    }
  }, [currentView, notificationFilter, settingsTab]);

  // 📡 リアルタイム SSE (Server-Sent Events) ストリーミング接続
  useEffect(() => {
    const sseUrl = authToken
      ? `/api/streaming?token=${encodeURIComponent(authToken)}`
      : '/api/streaming';

    let eventSource: EventSource | null = null;
    let reconnectTimeout: any = null;

    const connectSSE = () => {
      try {
        eventSource = new EventSource(sseUrl);

        eventSource.onopen = () => {
          setIsStreamingConnected(true);
        };

        eventSource.onerror = () => {
          setIsStreamingConnected(false);
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          // 5秒後に再接続を試行
          reconnectTimeout = setTimeout(connectSSE, 5000);
        };

        // 1. 新着投稿イベント
        eventSource.addEventListener('note', (e: MessageEvent) => {
          try {
            const newPost: Post = JSON.parse(e.data);
            if (!newPost || !newPost.id) return;

            // 現在開いているタイムラインモード（ローカル/ホーム/連合/タグ）に合致するか判定
            const matches = isPostMatchingTimeline(
              newPost,
              timelineModeRef.current,
              activeHashtagRef.current,
              followingUrlsRef.current,
              authUserRef.current
            );
            if (!matches) return;

            const currentMe = authUserRef.current;
            const isMe = currentMe && (newPost.user_id === currentMe.id || newPost.author_handle?.includes(`@${currentMe.id}@`));
            if (isMe) {
              setTimeline((prev) => {
                if (prev.some((p) => p.id === newPost.id)) return prev;
                return [newPost, ...prev];
              });
            } else {
              setNewPostsQueue((prev) => {
                if (prev.some((p) => p.id === newPost.id)) return prev;
                return [newPost, ...prev];
              });
            }
          } catch (err) {
            console.error('[SSE] Error parsing note:', err);
          }
        });

        // 2. リアクション更新イベント
        eventSource.addEventListener('reaction', (e: MessageEvent) => {
          try {
            const data: { postId: string; reaction: string; count: number; user_id?: string; action: 'add' | 'remove' } = JSON.parse(e.data);
            if (!data || !data.postId) return;

            const updateReaction = (p: Post): Post => {
              if (p.id !== data.postId) return p;
              const currentReactions = p.reactions ? [...p.reactions] : [];
              const targetIdx = currentReactions.findIndex((r) => r.reaction === data.reaction);
              const isMyAction = authUser && (data.user_id === authUser.id);

              if (data.count <= 0) {
                if (targetIdx !== -1) currentReactions.splice(targetIdx, 1);
              } else if (targetIdx !== -1) {
                currentReactions[targetIdx] = {
                  ...currentReactions[targetIdx],
                  count: data.count,
                  me: isMyAction ? (data.action === 'add') : currentReactions[targetIdx].me,
                };
              } else {
                currentReactions.push({
                  reaction: data.reaction,
                  count: data.count,
                  me: Boolean(isMyAction && data.action === 'add'),
                });
              }
              return { ...p, reactions: currentReactions };
            };

            setTimeline((prev) => prev.map(updateReaction));
            setProfilePosts((prev) => prev.map(updateReaction));
            setBookmarks((prev) => prev.map(updateReaction));
            setNewPostsQueue((prev) => prev.map(updateReaction));
          } catch (err) {
            console.error('[SSE] Error parsing reaction:', err);
          }
        });

        // 3. リノート更新イベント
        eventSource.addEventListener('renote', (e: MessageEvent) => {
          try {
            const data: { postId: string; count: number; renote?: any } = JSON.parse(e.data);
            if (!data || !data.postId) return;

            const updateAnnounce = (p: Post): Post => {
              if (p.id !== data.postId) return p;
              return { ...p, announce_count: data.count };
            };

            setTimeline((prev) => prev.map(updateAnnounce));
            setProfilePosts((prev) => prev.map(updateAnnounce));
            setBookmarks((prev) => prev.map(updateAnnounce));
            setNewPostsQueue((prev) => prev.map(updateAnnounce));
          } catch (err) {
            console.error('[SSE] Error parsing renote:', err);
          }
        });

        // 4. アンケート更新イベント
        eventSource.addEventListener('poll_updated', (e: MessageEvent) => {
          try {
            const data: { postId: string; poll: PollData } = JSON.parse(e.data);
            if (!data || !data.postId || !data.poll) return;

            const updatePoll = (p: Post): Post => {
              if (p.id !== data.postId) return p;
              const myCurrentVoted = p.poll?.my_voted || false;
              const mergedChoices = data.poll.choices.map((c) => {
                const existing = p.poll?.choices.find((ec) => ec.choice_index === c.choice_index);
                return {
                  ...c,
                  me: existing?.me || c.me,
                };
              });
              return {
                ...p,
                poll: {
                  ...data.poll,
                  my_voted: myCurrentVoted || data.poll.my_voted,
                  choices: mergedChoices,
                },
              };
            };

            setTimeline((prev) => prev.map(updatePoll));
            setProfilePosts((prev) => prev.map(updatePoll));
            setBookmarks((prev) => prev.map(updatePoll));
            setNewPostsQueue((prev) => prev.map(updatePoll));
          } catch (err) {
            console.error('[SSE] Error parsing poll_updated:', err);
          }
        });

        // 5. 投稿削除イベント
        eventSource.addEventListener('delete_post', (e: MessageEvent) => {
          try {
            const data: { postId: string } = JSON.parse(e.data);
            if (!data || !data.postId) return;

            setTimeline((prev) => prev.filter((p) => p.id !== data.postId));
            setProfilePosts((prev) => prev.filter((p) => p.id !== data.postId));
            setBookmarks((prev) => prev.filter((p) => p.id !== data.postId));
            setNewPostsQueue((prev) => prev.filter((p) => p.id !== data.postId));
          } catch (err) {
            console.error('[SSE] Error parsing delete_post:', err);
          }
        });

        // 6. 新着通知イベント
        eventSource.addEventListener('notification', (e: MessageEvent) => {
          try {
            const notif: AppNotification = JSON.parse(e.data);
            if (!notif) return;

            setUnreadNotificationsCount((prev) => prev + 1);
            setNotifications((prev) => [notif, ...prev]);
            setNotificationToast(notif);
          } catch (err) {
            console.error('[SSE] Error parsing notification:', err);
          }
        });
      } catch (err) {
        console.error('[SSE] Connection error:', err);
      }
    };

    connectSSE();

    return () => {
      if (eventSource) eventSource.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    };
  }, [authToken, authUser?.id]);

  // 新着通知トーストの自動非表示タイマー (4.5秒)
  useEffect(() => {
    if (!notificationToast) return;
    const timer = setTimeout(() => {
      setNotificationToast(null);
    }, 4500);
    return () => clearTimeout(timer);
  }, [notificationToast]);

  // 登録前のメール確認コードを送ってもらう（SMTP 未設定のサーバーではこの UI 自体を出さない）
  const handleSendRegisterCode = async () => {
    const email = regEmail.trim();
    if (!isValidEmailFormat(email)) {
      setRegCodeMsg({ type: 'error', text: 'メールアドレスの形式をご確認ください。' });
      return;
    }
    setIsSendingRegCode(true);
    setRegCodeMsg(null);
    try {
      const res = await fetch('/api/auth/register/email-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      setRegCodeMsg(res.ok
        ? { type: 'success', text: data.message || '確認コードを送信しました（10分有効）。' }
        : { type: 'error', text: data.error || '送信に失敗しました。' });
    } catch (err: any) {
      setRegCodeMsg({ type: 'error', text: err.message });
    } finally {
      setIsSendingRegCode(false);
    }
  };

  // 新規登録ハンドラ
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    // メールアドレス＋パスワード方式: 送信前にフォーム側でも検証する (サーバーも 400 を返す)
    if (isPasswordAuthMode) {
      const email = regEmail.trim();
      if (!isValidEmailFormat(email)) {
        setAuthError('メールアドレスの形式をご確認ください。');
        return;
      }
      if (regPassword.length < 8) {
        setAuthError('パスワードは8文字以上で入力してください。');
        return;
      }
      if (regPassword !== regPasswordConfirm) {
        setAuthError('確認用パスワードが一致しません。');
        return;
      }
      // SMTP が設定されているサーバーでは、なりすまし登録を防ぐため確認コードを必須にする
      if (recoveryStatus.mailConfigured && !regEmailCode.trim()) {
        setAuthError('メールアドレスの確認コードを入力してください（「確認コードを送信」から取得できます）。');
        return;
      }
    }

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: regId.trim(),
          name: regName.trim(),
          summary: regBio.trim(),
          inviteCode: inviteCodeInput.trim() || undefined,
          agreedToRules: hasAgreedToRules || true,
          ...(isPasswordAuthMode ? { email: regEmail.trim(), password: regPassword, emailCode: regEmailCode.trim() || undefined } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'アカウント作成に失敗しました。');
        return;
      }

      // マスターキー表示用モーダルを起動
      setIssuedMasterKey(data.masterKey);
      setAuthToken(data.sessionToken);
      localStorage.setItem('spica_token', data.sessionToken);
      localStorage.setItem('astrabit_token', data.sessionToken);
      setAuthUser(data.user);
      fetchMyFollowingUrls(data.sessionToken);
      setShowRegisterModal(false);
      setShowMasterKeyModal(true);
      setHasConfirmedSaved(false);
      setIsCopied(false);
      setRegPassword('');
      setRegPasswordConfirm('');
      setRegEmailCode('');
      setRegCodeMsg(null);
      fetchServerStats();
    } catch (err: any) {
      setAuthError(err.message);
    }
  };

  // ==========================================
  // 📦 引っ越し（Move / alsoKnownAs）
  // ==========================================
  const fetchMigrationInfo = async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/user/migration', { headers: { Authorization: `Bearer ${authToken}` } });
      if (res.ok) {
        const data = await res.json();
        setMigrationInfo(data);
        setMigrationAliasInput(data.alsoKnownAs || '');
      }
    } catch (err) {
      console.error('引っ越し情報の取得エラー:', err);
    }
  };

  const handleSaveMigrationAlias = async () => {
    if (!authToken) return;
    setIsMigrating(true);
    setMigrationMsg(null);
    try {
      const res = await fetch('/api/user/migration/alias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ alias: migrationAliasInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMigrationMsg({ type: 'error', text: data.error || '保存に失敗しました。' });
        return;
      }
      setMigrationMsg({ type: 'success', text: data.message || '保存しました。' });
      await fetchMigrationInfo();
    } catch (err: any) {
      setMigrationMsg({ type: 'error', text: err.message });
    } finally {
      setIsMigrating(false);
    }
  };

  const handleExecuteMove = async () => {
    if (!authToken) return;
    const target = migrationTargetInput.trim();
    if (!target) {
      setMigrationMsg({ type: 'error', text: '引っ越し先アカウント（@ユーザー名@サーバー）を入力してください。' });
      return;
    }
    if (!window.confirm(`このアカウントから ${target} へ引っ越しますか？\nフォロワー全員に通知され、元には戻せません。`)) {
      return;
    }
    setIsMigrating(true);
    setMigrationMsg(null);
    try {
      const res = await fetch('/api/user/migration/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ target }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMigrationMsg({ type: 'error', text: data.error || '引っ越しに失敗しました。' });
        return;
      }
      setMigrationMsg({ type: 'success', text: data.message || '引っ越しを実行しました。' });
      await fetchMigrationInfo();
      fetchTimeline();
    } catch (err: any) {
      setMigrationMsg({ type: 'error', text: err.message });
    } finally {
      setIsMigrating(false);
    }
  };

  const handleCancelMove = async () => {
    if (!authToken) return;
    if (!window.confirm('引っ越し先の記録を解除しますか？（連合先へ配送済みの通知は取り消せません）')) return;
    setIsMigrating(true);
    setMigrationMsg(null);
    try {
      const res = await fetch('/api/user/migration/cancel', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await res.json();
      setMigrationMsg(
        res.ok ? { type: 'success', text: data.message || '解除しました。' } : { type: 'error', text: data.error || '解除に失敗しました。' },
      );
      await fetchMigrationInfo();
    } catch (err: any) {
      setMigrationMsg({ type: 'error', text: err.message });
    } finally {
      setIsMigrating(false);
    }
  };

  // 📦 データエクスポートハンドラ (JSON / ZIP)
  const handleExportData = async (format: 'json' | 'zip') => {
    if (!authToken) return;
    setIsExportingData(true);
    setExportingFormat(format);
    try {
      const res = await fetch(`/api/user/export?format=${format}`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'データのエクスポートに失敗しました。');
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const dateStr = new Date().toISOString().split('T')[0];
      a.download = format === 'zip'
        ? `spica-backup-${authUser?.id || 'me'}-${dateStr}.zip`
        : `spica-backup-${authUser?.id || 'me'}-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      setSettingsMessage({ type: 'success', text: `データを${format.toUpperCase()}形式でダウンロードしました！` });
      setTimeout(() => setSettingsMessage(null), 4000);
    } catch (err: any) {
      alert(`エクスポートエラー: ${err.message}`);
    } finally {
      setIsExportingData(false);
      setExportingFormat(null);
    }
  };

  // ==========================================
  // 📢 チャンネル機能 ハンドラ
  // ==========================================
  const fetchChannels = async () => {
    setIsLoadingChannels(true);
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      const url = channelCategoryFilter && channelCategoryFilter !== 'all'
        ? `/api/channels?category=${encodeURIComponent(channelCategoryFilter)}`
        : '/api/channels';
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data = await res.json();
        setChannels(data);
      }
    } catch (e) {
      console.error('Failed to fetch channels:', e);
    } finally {
      setIsLoadingChannels(false);
    }
  };

  const openChannelDetail = async (channel: Channel, push: boolean = true) => {
    closeAllModals();
    setCurrentView('channels');
    if (push) {
      try {
        window.history.pushState({ view: 'channels', channelId: channel.id }, '', `/channels/${encodeURIComponent(channel.id)}`);
      } catch {}
    }
    setSelectedChannel(channel);
    setIsLoadingChannelTimeline(true);
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      const res = await fetch(`/api/channels/${channel.id}/timeline`, { headers });
      if (res.ok) {
        const data = await res.json();
        setChannelTimelinePosts(data.posts || []);
        if (data.channel) {
          setSelectedChannel(data.channel);
        }
      }
    } catch (e) {
      console.error('Failed to fetch channel timeline:', e);
    } finally {
      setIsLoadingChannelTimeline(false);
    }
  };

  const openChannelDetailById = async (channelId: string, push: boolean = true) => {
    closeAllModals();
    setCurrentView('channels');
    if (push) {
      try {
        window.history.pushState({ view: 'channels', channelId }, '', `/channels/${encodeURIComponent(channelId)}`);
      } catch {}
    }
    setIsLoadingChannelTimeline(true);
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      const res = await fetch(`/api/channels/${channelId}/timeline`, { headers });
      if (res.ok) {
        const data = await res.json();
        setChannelTimelinePosts(data.posts || []);
        if (data.channel) {
          setSelectedChannel(data.channel);
        }
      }
    } catch (e) {
      console.error('Failed to fetch channel timeline:', e);
    } finally {
      setIsLoadingChannelTimeline(false);
    }
  };

  const handleToggleChannelFollow = async (channelId: string) => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    try {
      const res = await fetch(`/api/channels/${channelId}/follow`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setChannels((prev) =>
          prev.map((c) =>
            c.id === channelId
              ? {
                  ...c,
                  is_following: data.following,
                  followers_count: data.following ? c.followers_count + 1 : Math.max(0, c.followers_count - 1),
                }
              : c
          )
        );
        if (selectedChannel && selectedChannel.id === channelId) {
          setSelectedChannel((prev) =>
            prev
              ? {
                  ...prev,
                  is_following: data.following,
                  followers_count: data.following ? prev.followers_count + 1 : Math.max(0, prev.followers_count - 1),
                }
              : null
          );
        }
      }
    } catch (e) {
      console.error('Failed to toggle channel follow:', e);
    }
  };

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !newChannelName.trim()) return;
    setIsCreatingChannel(true);
    try {
      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          name: newChannelName.trim(),
          description: newChannelDesc.trim(),
          color: newChannelColor,
          category: newChannelCategory,
        }),
      });
      if (res.ok) {
        const created = await res.json();
        setChannels((prev) => [created, ...prev]);
        setShowCreateChannelModal(false);
        setNewChannelName('');
        setNewChannelDesc('');
        openChannelDetail(created);
      } else {
        const err = await res.json();
        alert(err.error || 'チャンネルの作成に失敗しました。');
      }
    } catch (e: any) {
      alert(`エラー: ${e.message}`);
    } finally {
      setIsCreatingChannel(false);
    }
  };

  // ==========================================
  // 🔐 WebAuthn / パスキー生体認証 ハンドラ
  // ==========================================
  const fetchPasskeys = async () => {
    if (!authToken) return;
    setIsLoadingPasskeys(true);
    try {
      const res = await fetch('/api/webauthn/credentials', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setPasskeys(data);
      }
    } catch (e) {
      console.error('Failed to fetch passkeys:', e);
    } finally {
      setIsLoadingPasskeys(false);
    }
  };

  const handleRegisterPasskey = async () => {
    if (!authToken) return;
    setIsRegisteringPasskey(true);
    setPasskeyActionMessage(null);
    try {
      const optRes = await fetch('/api/webauthn/register/options', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!optRes.ok) {
        const err = await optRes.json();
        throw new Error(err.error || 'オプション取得に失敗しました。');
      }
      const options = await optRes.json();

      // SimpleWebAuthn ブラウザ側 API 実行
      const regResponse = await startRegistration({ optionsJSON: options });

      const verifyRes = await fetch('/api/webauthn/register/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          response: regResponse,
          credential: regResponse,
          device_name: passkeyDeviceName.trim() || undefined,
        }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json();
        throw new Error(err.error || '登録検証に失敗しました。');
      }

      setPasskeyDeviceName('');
      setPasskeyActionMessage({ type: 'success', text: 'パスキーを正常に登録しました！次回から生体認証でワンタップログインできます。' });
      fetchPasskeys();
      setTimeout(() => setPasskeyActionMessage(null), 5000);
    } catch (e: any) {
      console.error('Passkey registration error:', e);
      if (e.name !== 'NotAllowedError') {
        setPasskeyActionMessage({ type: 'error', text: e.message || 'パスキー登録に失敗しました。' });
      }
    } finally {
      setIsRegisteringPasskey(false);
    }
  };

  const handleDeletePasskey = async (credId: string) => {
    if (!authToken || !confirm('このパスキーを削除しますか？')) return;
    try {
      const res = await fetch(`/api/webauthn/credentials/${credId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        setPasskeys((prev) => prev.filter((p) => p.id !== credId));
        setPasskeyActionMessage({ type: 'success', text: 'パスキーを削除しました。' });
        setTimeout(() => setPasskeyActionMessage(null), 4000);
      } else {
        const err = await res.json();
        alert(err.error || 'パスキーの削除に失敗しました。');
      }
    } catch (e: any) {
      alert(`エラー: ${e.message}`);
    }
  };

  const handleLoginWithPasskey = async () => {
    setIsLoggingInWithPasskey(true);
    setAuthError(null);
    try {
      const optRes = await fetch('/api/webauthn/authenticate/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: loginId.trim() || undefined }),
      });
      if (!optRes.ok) {
        const err = await optRes.json();
        throw new Error(err.error || '認証オプションの取得に失敗しました。');
      }
      const options = await optRes.json();

      // SimpleWebAuthn ブラウザ側 生体認証 / パスキープロンプト起動
      const authResponse = await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch('/api/webauthn/authenticate/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credential: authResponse,
          expectedChallenge: options.challenge,
        }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json();
        throw new Error(err.error || 'パスキー認証に失敗しました。');
      }

      const data = await verifyRes.json();
      setAuthToken(data.token);
      localStorage.setItem('spica_token', data.token);
      localStorage.setItem('astrabit_token', data.token);
      setAuthUser(data.user);
      fetchMyFollowingUrls(data.token);
      setShowLoginModal(false);
      fetchTimeline();
    } catch (e: any) {
      console.error('Passkey login error:', e);
      if (e.name !== 'NotAllowedError') {
        setAuthError(e.message || 'パスキー認証に失敗しました。');
      }
    } finally {
      setIsLoggingInWithPasskey(false);
    }
  };

  // ログインハンドラ (マスターキー方式 / メールアドレス＋パスワード方式)
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    const identifier = loginId.trim();
    const usePassword = isPasswordAuthMode && loginMethod === 'password';
    if (usePassword) {
      if (!identifier) {
        setAuthError('ユーザーIDまたはメールアドレスを入力してください。');
        return;
      }
      if (!loginPassword) {
        setAuthError('パスワードを入力してください。');
        return;
      }
    }

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          usePassword
            // 入力がメールアドレス形式なら email、それ以外はユーザーIDとして送信する
            ? { password: loginPassword, ...(isValidEmailFormat(identifier) ? { email: identifier } : { id: identifier }) }
            : { id: identifier, masterKey: loginKey.trim() },
        ),
      });

      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'ログインに失敗しました。');
        return;
      }

      setAuthToken(data.sessionToken);
      localStorage.setItem('spica_token', data.sessionToken);
      localStorage.setItem('astrabit_token', data.sessionToken);
      setAuthUser(data.user);
      fetchMyFollowingUrls(data.sessionToken);
      setShowLoginModal(false);
      setLoginKey('');
      setLoginPassword('');
      setLoginId('');
      fetchTimeline();
    } catch (err: any) {
      setAuthError(err.message);
    }
  };

  // ログアウト
  const handleLogout = async () => {
    if (authToken) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
        });
      } catch {}
    }
    localStorage.removeItem('spica_token');
    localStorage.removeItem('astrabit_token');
    setAuthToken(null);
    setAuthUser(null);
    setFollowingUrls(new Set());
    setCurrentView('timeline');
    setShowAuthPortal(true);
    setAuthPortalTab('welcome');
  };

  // メディア（画像・動画・音声）選択・アップロード処理
  const handleSelectMedia = async (files: FileList | null) => {
    if (!files || files.length === 0 || !authToken) return;
    const currentCount = postAttachments.length;
    if (currentCount >= 4) {
      alert('一度に添付できるファイルは最大4件までです。');
      return;
    }
    const remainingSlots = 4 - currentCount;
    const filesToUpload = Array.from(files).slice(0, remainingSlots);

    setIsUploadingMedia(true);
    try {
      for (let i = 0; i < filesToUpload.length; i++) {
        const rawFile = filesToUpload[i];
        const isImage = rawFile.type.startsWith('image/');
        const isAv = rawFile.type.startsWith('video/') || rawFile.type.startsWith('audio/');

        if (!isImage && !isAv) {
          alert(`「${rawFile.name}」は対応していない形式です（画像・動画・音声のみ）。`);
          continue;
        }

        // 動画・音声は1件まで（サイズが大きいため）
        const alreadyHasAv = postAttachments.some(
          (a: any) => String(a.mediaType || '').startsWith('video/') || String(a.mediaType || '').startsWith('audio/'),
        );
        if (isAv && (alreadyHasAv || filesToUpload.filter((f) => f.type.startsWith('video/') || f.type.startsWith('audio/')).length > 1)) {
          alert('動画・音声は1件まで添付できます。');
          continue;
        }

        // ⚡ Misskey風 クライアント自動圧縮 (ONの場合 / 画像のみ)
        let fileToUpload = rawFile;
        if (autoCompressImages && isImage) {
          setUploadStatusText(`画像を最適化中... (${i + 1}/${filesToUpload.length})`);
          const compressRes = await compressImage(rawFile, {
            maxDimension: 2048,
            quality: 0.85,
            format: 'image/webp',
          });
          fileToUpload = compressRes.file;
        }

        const maxSize = isImage ? 15 * 1024 * 1024 : 50 * 1024 * 1024;
        if (fileToUpload.size > maxSize) {
          alert(`「${fileToUpload.name}」のサイズが${isImage ? '15MB' : '50MB'}を超えています。`);
          continue;
        }

        setUploadStatusText(`アップロード中... (${i + 1}/${filesToUpload.length})`);
        const formData = new FormData();
        formData.append('file', fileToUpload);

        const res = await fetch('/api/media/upload', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
          body: formData,
        });

        if (res.ok) {
          const data = await res.json();
          if (data.media && Array.isArray(data.media)) {
            setPostAttachments((prev) => [...prev, ...data.media]);
          } else if (data.attachment) {
            setPostAttachments((prev) => [...prev, data.attachment]);
          }
        } else {
          const err = await res.json();
          alert(`画像アップロード失敗: ${err.error || '不明なエラー'}`);
        }
      }
    } catch (err: any) {
      alert(`アップロードエラー: ${err.message}`);
    } finally {
      setIsUploadingMedia(false);
      setUploadStatusText('');
    }
  };

  // メディア添付の削除
  const handleRemoveAttachment = (index: number) => {
    setPostAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  // メディアストレージ設定の保存
  const handleSaveStorage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken) return;
    setIsSavingStorage(true);
    setStorageMessage(null);
    try {
      const res = await fetch('/api/admin/storage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(storageForm),
      });
      const data = await res.json();
      if (res.ok) {
        setStorageMessage({ type: 'success', text: data.message || '保存しました。' });
        // 再取得してステート反映
        const stRes = await fetch('/api/admin/storage', {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (stRes.ok) {
          const sData = await stRes.json();
          setAdminStorageConfig(sData);
        }
      } else {
        setStorageMessage({ type: 'error', text: data.error || '保存に失敗しました。' });
      }
    } catch (err: any) {
      setStorageMessage({ type: 'error', text: err.message });
    } finally {
      setIsSavingStorage(false);
    }
  };

  // メディアストレージ疎通テスト
  const handleTestStorage = async () => {
    if (!authToken) return;
    setIsTestingStorage(true);
    setStorageMessage(null);
    try {
      const res = await fetch('/api/admin/storage/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(storageForm),
      });
      const data = await res.json();
      if (res.ok) {
        setStorageMessage({ type: 'success', text: data.message || '接続テストに成功しました！' });
      } else {
        setStorageMessage({ type: 'error', text: data.error || '接続テストに失敗しました。' });
      }
    } catch (err: any) {
      setStorageMessage({ type: 'error', text: err.message });
    } finally {
      setIsTestingStorage(false);
    }
  };

  // 📊 アンケート投票処理
  const handleVotePoll = async (postId: string, selectedChoiceIndices: number[]) => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    if (selectedChoiceIndices.length === 0) return;
    setIsVotingPoll(postId);
    try {
      const res = await fetch(`/api/posts/${encodeURIComponent(postId)}/poll/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ choices: selectedChoiceIndices }),
      });
      if (res.ok) {
        const data = await res.json();
        const updatePoll = (p: Post) => (p.id === postId ? { ...p, poll: data.poll } : p);
        setTimeline((prev) => prev.map(updatePoll));
        setProfilePosts((prev) => prev.map(updatePoll));
        setBookmarks((prev) => prev.map(updatePoll));
        setNewPostsQueue((prev) => prev.map(updatePoll));
        if (threadData) {
          setThreadData((td) => {
            if (!td) return null;
            return {
              ...td,
              post: td.post.id === postId ? { ...td.post, poll: data.poll } : td.post,
              parent: td.parent && td.parent.id === postId ? { ...td.parent, poll: data.poll } : td.parent,
              replies: td.replies.map(updatePoll),
            };
          });
        }
      } else {
        const err = await res.json();
        alert(`投票に失敗しました: ${err.error || 'エラー'}`);
      }
    } catch (err: any) {
      alert(`投票エラー: ${err.message}`);
    } finally {
      setIsVotingPoll(null);
    }
  };

  // 投稿作成
  const handleCreatePost = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = postContent.trim();
    const validChoices = pollChoices.map((c) => c.trim()).filter(Boolean);
    const hasPoll = showPollInput && validChoices.length >= 2;

    if (!authToken || (!trimmed && postAttachments.length === 0 && !hasPoll && !quoteTargetPost) || isPosting || isUploadingMedia) return;

    setIsPosting(true);
    try {
      const res = await fetch('/api/posts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          content: trimmed,
          visibility: postVisibility,
          attachments: postAttachments,
          quote_id: quoteTargetPost ? quoteTargetPost.id : undefined,
          is_sensitive: isSensitivePost,
          cw: showCwInput && cwContent.trim() ? cwContent.trim() : undefined,
          channel_id: postTargetChannelId || undefined,
          poll: hasPoll
            ? {
                choices: validChoices,
                multiple: pollMultiple,
                expires_in: pollExpiresIn,
              }
            : undefined,
        }),
      });

      if (res.ok) {
        setPostContent('');
        setPostAttachments([]);
        setQuoteTargetPost(null);
        setIsSensitivePost(false);
        setShowCwInput(false);
        setCwContent('');
        setShowPollInput(false);
        setPollChoices(['', '']);
        setPollMultiple(false);
        setPollExpiresIn(86400);
        setShowMobilePostModal(false);
        setPostTargetChannelId(null);
        await fetchTimeline();
        await fetchServerStats();
        if (selectedChannel) {
          openChannelDetail(selectedChannel);
        }
        if (authUser) {
          checkAuth(authToken);
        }
      } else {
        const err = await res.json();
        alert(`投稿エラー: ${err.error}`);
      }
    } catch (err: any) {
      alert(`エラー: ${err.message}`);
    } finally {
      setIsPosting(false);
    }
  };

  // 投稿削除
  const handleDeletePost = async (postId: string) => {
    if (!authToken) return;
    if (!confirm('この投稿を削除してもよろしいですか？\n（自ノードおよび連合ノードへ削除リクエストが配信されます）')) {
      return;
    }
    try {
      const res = await fetch(`/api/posts/${encodeURIComponent(postId)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      if (res.ok) {
        setTimeline((prev) => prev.filter((p) => p.id !== postId));
        setProfilePosts((prev) => prev.filter((p) => p.id !== postId));
        if (threadModalPost?.id === postId) {
          setThreadModalPost(null);
        }
        await fetchServerStats();
      } else {
        const err = await res.json();
        alert(err.error || '投稿の削除に失敗しました。');
      }
    } catch {
      alert('削除リクエストの送信に失敗しました。');
    }
  };

  // 絵文字リアクションの付与 / 解除
  const handleToggleReaction = async (postId: string, reaction: string) => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    setActiveReactionPostId(null);
    try {
      const res = await fetch(`/api/posts/${encodeURIComponent(postId)}/react`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ reaction }),
      });
      if (res.ok) {
        const data = await res.json();
        setTimeline((prev) =>
          prev.map((p) => (p.id === postId ? { ...p, reactions: data.reactions } : p))
        );
        if (threadData) {
          setThreadData((td) => {
            if (!td) return null;
            return {
              ...td,
              post: td.post.id === postId ? { ...td.post, reactions: data.reactions } : td.post,
              parent: td.parent && td.parent.id === postId ? { ...td.parent, reactions: data.reactions } : td.parent,
              replies: td.replies.map((r) => (r.id === postId ? { ...r, reactions: data.reactions } : r)),
            };
          });
        }
      }
    } catch (err: any) {
      console.error(err);
    }
  };

  // RT (ブースト / Announce) の付与 / 解除
  const handleToggleAnnounce = async (postId: string) => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    try {
      const res = await fetch(`/api/posts/${encodeURIComponent(postId)}/announce`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
      });
      if (res.ok) {
        const data = await res.json();
        setTimeline((prev) =>
          prev.map((p) =>
            p.id === postId
              ? { ...p, announce_count: data.announce_count, my_announced: data.announced }
              : p
          )
        );
        if (threadData) {
          setThreadData((td) => {
            if (!td) return null;
            const updatePost = (p: Post) =>
              p.id === postId
                ? { ...p, announce_count: data.announce_count, my_announced: data.announced }
                : p;
            return {
              ...td,
              post: updatePost(td.post),
              parent: td.parent ? updatePost(td.parent) : null,
              replies: td.replies.map(updatePost),
            };
          });
        }
        fetchTimeline();
      }
    } catch (err: any) {
      console.error(err);
    }
  };

  // 返信モーダル起動
  const handleOpenReply = (post: Post) => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    setReplyTargetPost(post);
    setReplyContent('');
  };

  // 返信送信
  const handleSubmitReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !replyTargetPost || !replyContent.trim() || isReplying) return;
    setIsReplying(true);
    try {
      const res = await fetch('/api/posts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          content: replyContent.trim(),
          visibility: postVisibility,
          in_reply_to: replyTargetPost.id,
          cw: showReplyCwInput && replyCwContent.trim() ? replyCwContent.trim() : undefined,
        }),
      });
      if (res.ok) {
        setReplyContent('');
        setShowReplyCwInput(false);
        setReplyCwContent('');
        setReplyTargetPost(null);
        await fetchTimeline();
        if (threadModalPost) {
          handleOpenThread(threadModalPost);
        }
      } else {
        const err = await res.json();
        alert(`返信エラー: ${err.error}`);
      }
    } catch (err: any) {
      alert(`エラー: ${err.message}`);
    } finally {
      setIsReplying(false);
    }
  };

  // 会話スレッドを開く
  const handleOpenThread = async (post: Post, push: boolean = true) => {
    if (push) {
      try {
        window.history.pushState({ modal: 'thread', postId: post.id }, '', `/?post=${encodeURIComponent(post.id)}`);
      } catch {}
    }
    setThreadModalPost(post);
    setIsLoadingThread(true);
    try {
      const res = await fetch(`/api/posts/${encodeURIComponent(post.id)}/thread`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      if (res.ok) {
        setThreadData(await res.json());
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoadingThread(false);
    }
  };

  // リモートフォロー
  const handleFollow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !followHandle.trim()) return;

    setFollowStatus({ type: 'loading', msg: 'WebFinger解決 ＆ Follow Activity送信中...' });
    try {
      const res = await fetch('/api/follow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ targetHandle: followHandle.trim() }),
      });

      const data = await res.json();
      if (res.ok) {
        setFollowStatus({
          type: 'success',
          msg: `${data.target.name} (@${data.target.username}@${data.target.domain}) をフォローしました！`,
        });
        setFollowHandle('');
        checkAuth(authToken);
      } else {
        setFollowStatus({ type: 'error', msg: data.error || 'フォローに失敗しました。' });
      }
    } catch (err: any) {
      setFollowStatus({ type: 'error', msg: err.message });
    }
  };

  // 管理者操作: ロール変更
  const handleAdminChangeRole = async (userId: string, currentRole: string) => {
    if (!authToken) return;
    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    if (!confirm(`ユーザー @${userId} のロールを ${newRole} に変更しますか？`)) return;

    try {
      const res = await fetch(`/api/admin/users/${userId}/role`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ role: newRole }),
      });
      if (res.ok) {
        fetchAdminData();
      } else {
        const err = await res.json();
        alert(err.error);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  // 管理者操作: 凍結
  const handleAdminToggleFreeze = async (userId: string, isFrozen: boolean) => {
    if (!authToken) return;
    const action = isFrozen ? '凍結解除' : '凍結';
    if (!confirm(`ユーザー @${userId} を${action}しますか？`)) return;

    try {
      const res = await fetch(`/api/admin/users/${userId}/freeze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ isFrozen: !isFrozen }),
      });
      if (res.ok) {
        fetchAdminData();
      } else {
        const err = await res.json();
        alert(err.error);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  // 管理者操作: アカウント完全削除
  const handleAdminDeleteUser = async () => {
    if (!authToken || !adminDeleteTargetUser) return;
    setIsAdminDeletingUser(true);
    try {
      const res = await fetch(`/api/admin/users/${adminDeleteTargetUser.id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const data = await res.json();
      if (res.ok) {
        const deletedId = adminDeleteTargetUser.id;
        setAdminDeleteTargetUser(null);
        fetchAdminData();
        alert(`ユーザー @${deletedId} を完全に削除しました。`);
      } else {
        alert(data.error || 'アカウントの削除に失敗しました。');
      }
    } catch (err: any) {
      alert(err.message || '通信エラーが発生しました。');
    } finally {
      setIsAdminDeletingUser(false);
    }
  };

  // ユーザー自身によるアカウント削除（退会）
  const handleSelfDeleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !authUser) return;
    if (selfDeleteConfirmId.trim().toLowerCase() !== authUser.id.toLowerCase()) {
      setSelfDeleteError(`確認用ユーザーIDが一致しません。「${authUser.id}」と正確に入力してください。`);
      return;
    }

    setIsSelfDeleting(true);
    setSelfDeleteError(null);
    try {
      const res = await fetch('/api/user/delete-me', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          confirmUserId: selfDeleteConfirmId.trim(),
          masterKey: selfDeleteMasterKey.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setSelfDeleteError(data.error || '退会処理に失敗しました。');
        setIsSelfDeleting(false);
        return;
      }

      // 退会完了: セッションストレージクリアしてウェルカムポータルへ
      localStorage.removeItem('spica_token');
      localStorage.removeItem('astrabit_token');
      setAuthToken(null);
      setAuthUser(null);
      setShowSelfDeleteModal(false);
      setSelfDeleteConfirmId('');
      setSelfDeleteMasterKey('');
      setIsSelfDeleting(false);
      setCurrentView('timeline');
      setShowAuthPortal(true);
      setAuthPortalTab('welcome');
      alert('アカウントと関連データを完全に削除しました。ご利用ありがとうございました。');
    } catch (err: any) {
      setSelfDeleteError(err.message || '通信エラーが発生しました。');
      setIsSelfDeleting(false);
    }
  };

  // VAPID公開鍵の base64URL を Uint8Array に変換するヘルパー
  const urlBase64ToUint8Array = (base64String: string) => {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  };

  // プッシュ購読状況の確認
  const checkPushSubscriptionStatus = async () => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setIsPushSubscribed(Boolean(sub));
      if ('Notification' in window) {
        setPushPermission(Notification.permission);
      }
    } catch {}
  };

  // プッシュ通知の有効化
  const handleSubscribePush = async () => {
    if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) {
      alert('お使いのブラウザまたは環境は Web Push 通知に対応していません。');
      return;
    }

    setIsSubscribingPush(true);
    try {
      // 1. 通知パーミッションの要求
      const perm = await Notification.requestPermission();
      setPushPermission(perm);
      if (perm !== 'granted') {
        alert('プッシュ通知の許可が拒否されました。ブラウザの設定から通知を許可してください。');
        setIsSubscribingPush(false);
        return;
      }

      // 2. サーバーから VAPID 公開鍵を取得
      const keyRes = await fetch('/api/push/vapid-public-key');
      const { publicKey } = await keyRes.json();
      if (!publicKey) throw new Error('VAPID 公開鍵を取得できませんでした。');

      // 3. Service Worker で PushManager.subscribe
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      // 4. サーバーへ登録
      const subRes = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });

      if (subRes.ok) {
        setIsPushSubscribed(true);
        alert('Web Push 通知が有効になりました！通知をテストしたい場合は「テスト通知を送信」をお試しください。');
      } else {
        const err = await subRes.json();
        alert(err.error || 'プッシュ通知の登録に失敗しました。');
      }
    } catch (err: any) {
      alert(err.message || 'プッシュ通知の登録中にエラーが発生しました。');
    } finally {
      setIsSubscribingPush(false);
    }
  };

  // プッシュ通知の解除
  const handleUnsubscribePush = async () => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    setIsSubscribingPush(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setIsPushSubscribed(false);
      alert('プッシュ通知の登録を解除しました。');
    } catch (err: any) {
      alert(err.message || '解除中にエラーが発生しました。');
    } finally {
      setIsSubscribingPush(false);
    }
  };

  // テスト通知の送信
  const handleSendTestPush = async () => {
    if (!authToken) return;
    setIsSendingTestPush(true);
    try {
      const res = await fetch('/api/push/test', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const data = await res.json();
      if (res.ok) {
        alert('テスト通知を送信しました！スマホまたはデスクトップの通知欄をご確認ください。');
      } else {
        alert(data.error || 'テスト通知の送信に失敗しました。');
      }
    } catch (err: any) {
      alert(err.message || '通信エラーが発生しました。');
    } finally {
      setIsSendingTestPush(false);
    }
  };

  // リレー接続
  const handleConnectRelay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !relayInputUrl.trim() || isConnectingRelay) return;

    setIsConnectingRelay(true);
    setRelayMessage(null);
    try {
      const res = await fetch('/api/admin/relays', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ url: relayInputUrl.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setRelayMessage({ type: 'success', text: data.message });
        setRelayInputUrl('');
        fetchAdminData();
      } else {
        setRelayMessage({ type: 'error', text: data.error || '接続に失敗しました。' });
      }
    } catch (err: any) {
      setRelayMessage({ type: 'error', text: err.message });
    } finally {
      setIsConnectingRelay(false);
    }
  };

  // リレー購読解除
  const handleDisconnectRelay = async (inboxUrl: string) => {
    if (!authToken) return;
    if (!confirm(`リレー (${inboxUrl}) の購読を解除しますか？`)) return;

    try {
      const res = await fetch('/api/admin/relays', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ inboxUrl }),
      });
      if (res.ok) {
        fetchAdminData();
      } else {
        const data = await res.json();
        alert(data.error);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  // 管理者操作: リモートキャッシュ全消去
  const handleAdminClearCache = async () => {
    if (!authToken) return;
    if (!confirm('提携先FediverseドメインのActor情報、および外部から受信した投稿キャッシュをすべて消去しますか？\n（※自ノードの投稿やアカウントは保持されます）')) return;

    try {
      const res = await fetch('/api/admin/cache/clear', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ clearPosts: true }),
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.message);
        await fetchAdminData();
        await fetchTimeline();
        await fetchServerStats();
      } else {
        alert(`エラー: ${data.error}`);
      }
    } catch (err: any) {
      alert(`エラー: ${err.message}`);
    }
  };

  // 管理者操作: リレーステータス手動切替
  const handleAdminToggleRelayStatus = async (inboxUrl: string, currentStatus: string) => {
    if (!authToken) return;
    const newStatus = currentStatus === 'accepted' ? 'pending' : 'accepted';
    try {
      const res = await fetch('/api/admin/relays/toggle-status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ inboxUrl, status: newStatus }),
      });
      if (res.ok) {
        fetchAdminData();
      } else {
        const data = await res.json();
        alert(data.error);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  // 管理者操作: リレー Follow 再送 (個別または一括)
  const handleAdminResendRelay = async (inboxUrl?: string) => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/admin/relays/resend', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(inboxUrl ? { inboxUrl } : {}),
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.message || 'Follow Activity を再送しました。');
        fetchAdminData();
      } else {
        alert(data.error);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  // ドメインブロック実行ハンドラ
  const executeBlockDomain = async (domain: string, reason = '') => {
    if (!authToken) return;
    setIsBlockingDomain(true);
    setBlockMessage(null);
    try {
      const res = await fetch('/api/admin/blocks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ domain, reason, purgeData: true }),
      });
      const data = await res.json();
      if (res.ok) {
        setBlockMessage({
          type: 'success',
          text: `ドメイン "${data.domain}" をブロックしました。（投稿 ${data.purgeStats?.posts ?? 0}件, Actor ${data.purgeStats?.actors ?? 0}件をパージ）`,
        });
        setBlockInputDomain('');
        setBlockInputReason('');
        await fetchAdminData();
        await fetchTimeline();
      } else {
        setBlockMessage({ type: 'error', text: data.error || 'ブロック登録に失敗しました。' });
      }
    } catch (err: any) {
      setBlockMessage({ type: 'error', text: err.message });
    } finally {
      setIsBlockingDomain(false);
    }
  };

  // 連携先ドメイン一覧からのワンクリックブロック
  const handleQuickBlockDomain = async (domain: string) => {
    if (!confirm(`ドメイン "${domain}" をブロックしますか？\n\n・このサーバーからの通信（Inbox）を遮断します\n・蓄積されたキャッシュや投稿を即時削除します`)) {
      return;
    }
    await executeBlockDomain(domain, '連携先一覧からのクイックブロック');
  };

  // 手動ブロックフォーム送信
  const handleManualBlockDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!blockInputDomain.trim()) return;
    await executeBlockDomain(blockInputDomain.trim(), blockInputReason.trim());
  };

  // ブロック解除ハンドラ
  const handleUnblockDomain = async (domain: string) => {
    if (!authToken) return;
    if (!confirm(`ドメイン "${domain}" のブロックを解除しますか？`)) return;

    try {
      const res = await fetch(`/api/admin/blocks/${encodeURIComponent(domain)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const data = await res.json();
      if (res.ok) {
        setBlockMessage({ type: 'success', text: data.message || `ドメイン "${domain}" のブロックを解除しました。` });
        await fetchAdminData();
      } else {
        alert(data.error);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  // 投稿カードレンダリング共通関数 (タイムライン・検索・プロフィール共通)
  const renderPostCard = (post: Post) => {
    const isCwOpen = openedCwPostIds.has(post.id);

    return (
      <div
        key={post.feed_id || post.id}
        className="bg-slate-900/90 border border-slate-800 hover:border-slate-700/80 rounded-2xl p-4 sm:p-5 shadow-lg transition overflow-hidden"
      >
        {/* 📌 ピン留めバッジ */}
        {post.is_pinned && (
          <div className="flex items-center space-x-1.5 text-xs text-amber-400 font-bold mb-3 pb-2 border-b border-amber-500/20">
            <Pin className="w-3.5 h-3.5 text-amber-400 fill-amber-400 shrink-0" />
            <span>ピン留めされたノート</span>
          </div>
        )}

        {/* リノート（RT）ヘッダー帯 (Misskey風) */}
        {post.renote && (
          <div className="flex items-center space-x-2 text-xs text-emerald-400 font-semibold mb-3 pb-2 border-b border-slate-800/60 min-w-0">
            <Repeat className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <button
              onClick={() => openUserProfile(post.renote!.url || post.renote!.handle)}
              className="hover:underline hover:text-emerald-300 transition truncate font-bold min-w-0 flex-1 text-left"
            >
              {post.renote.name}
            </button>
            <span className="text-slate-400 font-normal shrink-0">さんがリノート</span>
            <span className="text-[10px] text-slate-500 font-mono font-normal ml-auto shrink-0">
              {new Date(post.renote.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        )}

        <div className="flex items-start justify-between gap-2 mb-3 min-w-0">
          <div className="flex items-start sm:items-center space-x-2.5 sm:space-x-3 min-w-0 flex-1">
            <button
              onClick={() => openUserProfile(post.author_url || post.user_id || post.author_handle)}
              className="relative group focus:outline-none shrink-0"
              title={`${post.author_name}のプロフィールを見る`}
            >
              {post.author_icon ? (
                <img
                  src={post.author_icon}
                  alt={post.author_name}
                  className="w-10 h-10 rounded-xl object-cover shadow-md border border-slate-700/60 group-hover:ring-2 group-hover:ring-indigo-500 group-hover:scale-105 transition duration-200"
                  onError={(e) => {
                    (e.target as HTMLElement).style.display = 'none';
                    const fallback = (e.target as HTMLElement).nextElementSibling as HTMLElement;
                    if (fallback) fallback.style.display = 'flex';
                  }}
                />
              ) : null}
              <div
                className={`w-10 h-10 rounded-xl items-center justify-center font-bold text-white shadow-md group-hover:ring-2 group-hover:ring-indigo-500 group-hover:scale-105 transition duration-200 ${
                  post.author_icon ? 'hidden' : 'flex'
                } ${
                  post.is_local
                    ? 'bg-gradient-to-tr from-indigo-500 to-purple-600'
                    : 'bg-gradient-to-tr from-emerald-500 to-teal-600'
                }`}
              >
                {post.author_name.slice(0, 1).toUpperCase()}
              </div>
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-col sm:flex-row sm:items-baseline sm:space-x-2 min-w-0">
                <button
                  onClick={() => openUserProfile(post.author_url || post.user_id || post.author_handle)}
                  className="font-bold text-sm text-slate-100 hover:text-indigo-300 hover:underline transition truncate text-left max-w-full"
                >
                  {post.author_name}
                </button>
                <span className="text-xs text-slate-400 font-mono truncate max-w-full">
                  {post.author_handle}
                </span>
              </div>
              <div className="flex items-center space-x-2 text-[11px] text-slate-500 mt-0.5 truncate flex-wrap gap-y-1">
                <span className="shrink-0">{new Date(post.published_at).toLocaleString('ja-JP')}</span>
                {post.channel && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openChannelDetail(post.channel as any);
                      setCurrentView('channels');
                    }}
                    className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-[10px] font-bold text-indigo-300 bg-indigo-500/15 border border-indigo-500/30 hover:bg-indigo-500/25 transition cursor-pointer shrink-0"
                    title={`チャンネル「${post.channel.name}」を開く`}
                  >
                    <Hash className="w-2.5 h-2.5 text-indigo-400" />
                    <span className="truncate max-w-[140px]">{post.channel.name}</span>
                  </button>
                )}
                {post.visibility === 'local' && (
                  <span className="text-[10px] text-emerald-400/90 font-medium shrink-0">🏠 ローカル限定</span>
                )}
                {post.visibility === 'followers' && (
                  <span className="text-[10px] text-amber-400/90 font-medium shrink-0">🔒 フォロワー限定</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0 ml-1">
            {post.is_local ? (
              post.visibility === 'public' ? (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-medium flex items-center space-x-1">
                  <Globe className="w-2.5 h-2.5 mr-0.5" />
                  <span>連合配信</span>
                </span>
              ) : post.visibility === 'followers' ? (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium flex items-center space-x-1">
                  <span>🔒 フォロワー限定</span>
                </span>
              ) : (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium flex items-center space-x-1">
                  <Server className="w-2.5 h-2.5 mr-0.5" />
                  <span>ローカル限定</span>
                </span>
              )
            ) : (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-medium flex items-center space-x-1">
                <Radio className="w-2.5 h-2.5 mr-0.5" />
                <span>🌐 連合受信</span>
              </span>
            )}

            {/* 投稿オプションメニュー (三点リーダー) */}
            <div className="relative">
              <button
                onClick={() => setActiveMenuPostId(activeMenuPostId === (post.feed_id || post.id) ? null : (post.feed_id || post.id))}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/80 transition"
                title="その他の操作"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>

              {activeMenuPostId === (post.feed_id || post.id) && (
                <div
                  className="absolute right-0 top-full mt-1 z-30 w-48 bg-slate-900 border border-slate-750 rounded-2xl shadow-2xl p-1.5 space-y-0.5 text-xs animate-in fade-in zoom-in-95 duration-100"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => {
                      const shareUrl = post.url || `${window.location.origin}/posts/${post.id}`;
                      navigator.clipboard.writeText(shareUrl);
                      setActiveMenuPostId(null);
                      alert('投稿URLをクリップボードにコピーしました！');
                    }}
                    className="w-full flex items-center space-x-2 px-2.5 py-2 rounded-xl text-slate-300 hover:bg-slate-800 hover:text-white transition text-left"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span>投稿URLをコピー</span>
                  </button>

                  {/* 📌 自分の投稿の場合のピン留め・解除メニュー */}
                  {authUser && post.is_local === 1 && post.user_id === authUser.id && (
                    <>
                      <div className="h-[1px] bg-slate-800 my-1" />
                      <button
                        onClick={() => {
                          setActiveMenuPostId(null);
                          handleTogglePinPost(post.id);
                        }}
                        className={`w-full flex items-center space-x-2 px-2.5 py-2 rounded-xl transition text-left ${
                          post.is_pinned
                            ? 'text-amber-400 hover:bg-amber-500/10'
                            : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                        }`}
                      >
                        <Pin className={`w-3.5 h-3.5 ${post.is_pinned ? 'fill-amber-400' : ''}`} />
                        <span>{post.is_pinned ? 'ピン留めを解除' : 'プロフィールにピン留め'}</span>
                      </button>
                    </>
                  )}

                  {/* ログイン中 かつ 他人の投稿の場合にミュート・ブロックメニューを表示 */}
                  {authUser && !(post.is_local === 1 && post.user_id === authUser.id) && (
                    <>
                      <div className="h-[1px] bg-slate-800 my-1" />
                      <button
                        onClick={() => {
                          setActiveMenuPostId(null);
                          handleMuteUser(post.author_handle || post.user_id);
                        }}
                        className="w-full flex items-center space-x-2 px-2.5 py-2 rounded-xl text-amber-400 hover:bg-amber-500/10 transition text-left"
                      >
                        <VolumeX className="w-3.5 h-3.5" />
                        <span>{post.author_name} をミュート</span>
                      </button>
                      <button
                        onClick={() => {
                          setActiveMenuPostId(null);
                          handleBlockUser(post.author_handle || post.user_id);
                        }}
                        className="w-full flex items-center space-x-2 px-2.5 py-2 rounded-xl text-rose-400 hover:bg-rose-500/10 transition text-left"
                      >
                        <Ban className="w-3.5 h-3.5" />
                        <span>{post.author_name} をブロック</span>
                      </button>
                      <button
                        onClick={() => {
                          setActiveMenuPostId(null);
                          setReportCategory('spam');
                          setReportComment('');
                          setReportTarget({ type: 'post', id: post.id, label: `${post.author_name} のノート` });
                        }}
                        className="w-full flex items-center space-x-2 px-2.5 py-2 rounded-xl text-rose-400 hover:bg-rose-500/10 transition text-left"
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                        <span>この投稿を通報</span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 返信先インジケーター */}
        {post.in_reply_to && (
          <div className="mb-2 flex items-center space-x-1.5 text-xs text-indigo-400/90 bg-indigo-950/40 border border-indigo-900/40 px-2.5 py-1 rounded-lg w-fit">
            <MessageCircle className="w-3 h-3 text-indigo-400" />
            <span className="truncate max-w-[260px] sm:max-w-md">返信先: {post.in_reply_to}</span>
          </div>
        )}

        {/* 🤫 CW (閲覧注意) 注記バー */}
        {post.cw && (
          <div className="mb-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-center justify-between gap-2">
            <div className="flex items-center space-x-2 text-xs font-semibold text-amber-300 min-w-0">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
              <span className="truncate">閲覧注意: {post.cw}</span>
            </div>
            <button
              type="button"
              onClick={() => toggleCw(post.id)}
              className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-xs font-bold transition shrink-0 flex items-center space-x-1.5 cursor-pointer"
            >
              {isCwOpen ? (
                <>
                  <EyeOff className="w-3.5 h-3.5" />
                  <span>隠す</span>
                </>
              ) : (
                <>
                  <Eye className="w-3.5 h-3.5" />
                  <span>もっと見る</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* 投稿本文 & 画像 (CW設定時は展開時のみ表示) */}
        {(!post.cw || isCwOpen) && (
          <>
            {/* 投稿本文 (ハッシュタグクリック対応) */}
            <FormattedPostContent
              content={post.content}
              emojis={post.emojis}
              enableEmojis={showCustomEmojis}
              onTagClick={handleSelectHashtag}
            />

            {/* 添付画像グリッド */}
            <PostMediaGrid
              attachments={post.media_attachments}
              onImageClick={openMediaPreview}
              className="mt-3"
              isSensitive={post.is_sensitive}
            />

            {/* 🔗 リンクプレビュー（OGPカード） */}
            {post.link_preview && (post.link_preview.title || post.link_preview.image_url) && (
              <a
                href={post.link_preview.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="mt-3 block rounded-2xl border border-slate-800 bg-slate-950/60 overflow-hidden hover:border-indigo-500/40 transition group"
              >
                {post.link_preview.image_url && (
                  <img
                    src={post.link_preview.image_url}
                    alt=""
                    loading="lazy"
                    className="w-full max-h-64 object-cover border-b border-slate-800"
                  />
                )}
                <div className="p-3 space-y-1">
                  <span className="text-[10px] text-slate-500 font-mono block truncate">
                    {post.link_preview.site_name || new URL(post.link_preview.url).hostname}
                  </span>
                  {post.link_preview.title && (
                    <span className="text-xs font-bold text-slate-100 block group-hover:text-indigo-300 transition">
                      {post.link_preview.title}
                    </span>
                  )}
                  {post.link_preview.description && (
                    <span className="text-[11px] text-slate-400 block leading-relaxed line-clamp-2">
                      {post.link_preview.description}
                    </span>
                  )}
                </div>
              </a>
            )}

            {/* 💬 引用ノート（Quote）カード */}
            {post.quote && (
              <QuoteCard
                quote={post.quote}
                onClick={() => handleOpenThread(post.quote!)}
                showCustomEmojis={showCustomEmojis}
              />
            )}

            {/* 📊 アンケート（Poll） */}
            {post.poll && (
              <PollCard
                poll={post.poll}
                isVoting={isVotingPoll === post.id}
                onVote={(indices) => handleVotePoll(post.id, indices)}
                isAuthenticated={Boolean(authToken)}
                onRequireLogin={() => setShowLoginModal(true)}
                isAuthor={Boolean(authUser && ((post.is_local === 1 && post.user_id === authUser.id) || post.author_handle?.includes(`@${authUser.id}@`)))}
              />
            )}
          </>
        )}

      {/* リアクションピルバッジ一覧 */}
      {post.reactions && post.reactions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3 pt-2 border-t border-slate-800/50">
          {post.reactions.map((r) => (
            <button
              key={r.reaction}
              onClick={() => {
                if (!authToken) {
                  setShowLoginModal(true);
                  return;
                }
                handleToggleReaction(post.id, r.reaction);
              }}
              className={`px-2.5 py-1 rounded-xl text-xs font-semibold flex items-center space-x-1.5 transition border ${
                r.me
                  ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300 shadow-sm'
                  : 'bg-slate-800/60 border-slate-700/50 text-slate-300 hover:bg-slate-800 hover:border-slate-600'
              }`}
              title={
                !authToken
                  ? 'ログインしてリアクションをつける'
                  : r.me
                  ? `${r.reaction} リアクションを解除`
                  : `${r.reaction} リアクションをつける`
              }
            >
              {renderReactionBadgeContent(r.reaction)}
              <span className="text-[11px] font-mono opacity-80">{r.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* アクションバー (返信, RT, リアクション, スレッド, 共有) */}
      <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-800/60 text-slate-400 text-xs">
        {/* 返信ボタン */}
        <button
          onClick={() => handleOpenReply(post)}
          className="flex items-center space-x-1.5 hover:text-indigo-400 py-1 px-2 rounded-lg hover:bg-slate-800/50 transition"
          title={authToken ? '返信' : 'ログインして返信'}
        >
          <MessageSquare className="w-4 h-4" />
          <span>{(post.reply_count ?? 0) > 0 ? post.reply_count : ''}</span>
        </button>

        {/* リノート (RT) & 引用 ボタン */}
        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!authToken) {
                setShowLoginModal(true);
                return;
              }
              setActiveRenoteMenuPostId(activeRenoteMenuPostId === post.id ? null : post.id);
            }}
            className={`flex items-center space-x-1.5 py-1 px-2 rounded-lg transition ${
              post.my_announced
                ? 'text-emerald-400 font-bold bg-emerald-500/10'
                : 'hover:text-emerald-400 hover:bg-slate-800/50'
            }`}
            title={!authToken ? 'ログインしてリノート' : post.my_announced ? 'リノートを取り消す' : 'リノート / 引用'}
          >
            <Repeat className="w-4 h-4" />
            <span>{(post.announce_count ?? 0) > 0 ? post.announce_count : ''}</span>
          </button>

          {/* リノート & 引用 ポップオーバー */}
          {activeRenoteMenuPostId === post.id && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-full left-0 mb-2 z-20 w-40 bg-slate-900 border border-slate-750 p-1.5 rounded-2xl shadow-2xl space-y-1 animate-in fade-in zoom-in-95 duration-100 text-xs"
            >
              <button
                type="button"
                onClick={() => {
                  setActiveRenoteMenuPostId(null);
                  handleToggleAnnounce(post.id);
                }}
                className={`w-full flex items-center space-x-2 px-2.5 py-2 rounded-xl transition text-left cursor-pointer ${
                  post.my_announced
                    ? 'text-rose-400 hover:bg-rose-500/10'
                    : 'text-slate-200 hover:bg-slate-800 hover:text-emerald-400'
                }`}
              >
                <Repeat className="w-3.5 h-3.5 text-emerald-400" />
                <span>{post.my_announced ? 'リノート解除' : 'リノート'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveRenoteMenuPostId(null);
                  handleStartQuote(post);
                }}
                className="w-full flex items-center space-x-2 px-2.5 py-2 rounded-xl text-slate-200 hover:bg-slate-800 hover:text-indigo-400 transition text-left cursor-pointer"
              >
                <Quote className="w-3.5 h-3.5 text-indigo-400" />
                <span>引用してノート</span>
              </button>
            </div>
          )}
        </div>

        {/* リアクション追加ボタン */}
        <div className="relative">
          <button
            onClick={() => {
              if (!authToken) {
                setShowLoginModal(true);
                return;
              }
              setActiveReactionPostId(activeReactionPostId === post.id ? null : post.id);
            }}
            className="flex items-center space-x-1 hover:text-amber-400 py-1 px-2 rounded-lg hover:bg-slate-800/50 transition"
            title={authToken ? 'リアクションをつける' : 'ログインしてリアクションをつける'}
          >
            <SmilePlus className="w-4 h-4" />
          </button>

          {/* クイック絵文字ポップオーバー */}
          {activeReactionPostId === post.id && (
            <div className="absolute bottom-full left-0 mb-2 z-20 bg-slate-900 border border-slate-750 p-2 rounded-2xl shadow-2xl flex items-center space-x-1 animate-in fade-in zoom-in-95 duration-150 max-w-[90vw] overflow-x-auto">
              {quickEmojis.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => handleToggleReaction(post.id, emoji)}
                  className="w-8 h-8 rounded-xl hover:bg-slate-800 flex items-center justify-center text-base hover:scale-125 transition shrink-0"
                >
                  {emoji}
                </button>
              ))}
              {customEmojis.length > 0 && (
                <>
                  <div className="h-5 w-[1px] bg-slate-700 mx-1 shrink-0" />
                  {customEmojis.slice(0, 4).map((ce) => (
                    <button
                      key={ce.id}
                      onClick={() => handleToggleReaction(post.id, `:${ce.name}:`)}
                      className="w-8 h-8 rounded-xl hover:bg-slate-800 flex items-center justify-center hover:scale-125 transition shrink-0 p-1"
                      title={`:${ce.name}:`}
                    >
                      <img src={ce.url} alt={ce.name} className="w-5 h-5 object-contain" />
                    </button>
                  ))}
                </>
              )}
              <div className="h-5 w-[1px] bg-slate-700 mx-1 shrink-0" />
              <button
                type="button"
                onClick={() => {
                  setActiveReactionPostId(null);
                  setShowRichEmojiPicker({ target: 'reaction', postId: post.id });
                }}
                className="w-8 h-8 rounded-xl bg-slate-800 hover:bg-indigo-600 text-slate-300 hover:text-white flex items-center justify-center transition shrink-0"
                title="全絵文字・カスタム絵文字ピッカーを開く"
              >
                <Smile className="w-4 h-4" />
              </button>
              <input
                type="text"
                placeholder="絵文字"
                value={customReactionInput}
                onChange={(e) => setCustomReactionInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customReactionInput.trim()) {
                    handleToggleReaction(post.id, customReactionInput.trim());
                    setCustomReactionInput('');
                  }
                }}
                className="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-xs text-center text-white focus:outline-none focus:border-indigo-500 shrink-0"
              />
            </div>
          )}
        </div>

        <button
          onClick={() => handleOpenThread(post)}
          className="flex items-center space-x-1.5 hover:text-cyan-400 py-1 px-2 rounded-lg hover:bg-slate-800/50 transition"
          title="スレッド会話を表示"
        >
          <GitBranch className="w-4 h-4" />
          <span className="hidden sm:inline">スレッド</span>
        </button>

        <button
          onClick={() => {
            const shareUrl = post.url || `${window.location.origin}/posts/${post.id}`;
            navigator.clipboard.writeText(shareUrl);
            alert('投稿URLをクリップボードにコピーしました！');
          }}
          className="flex items-center space-x-1 hover:text-slate-200 py-1 px-2 rounded-lg hover:bg-slate-800/50 transition"
          title="投稿URLをコピー"
        >
          <Share2 className="w-4 h-4" />
        </button>

        {/* ブックマーク（お気に入り保存）ボタン */}
        <button
          onClick={() => handleToggleBookmark(post.id)}
          className={`flex items-center space-x-1.5 py-1 px-2 rounded-lg transition ${
            post.bookmarked
              ? 'text-amber-400 font-bold bg-amber-500/15'
              : 'hover:text-amber-400 hover:bg-slate-800/50'
          }`}
          title={post.bookmarked ? 'ブックマークを解除' : 'ブックマークに保存'}
        >
          <Bookmark className={`w-4 h-4 ${post.bookmarked ? 'fill-amber-400 text-amber-400' : ''}`} />
          <span className="hidden sm:inline text-[11px]">{post.bookmarked ? '保存済' : ''}</span>
        </button>

        {/* 削除ボタン (自ノードの作成者本人のみ表示) */}
        {authUser && post.is_local === 1 && post.user_id === authUser.id && (
          <button
            onClick={() => handleDeletePost(post.id)}
            className="flex items-center space-x-1 hover:text-rose-400 hover:bg-rose-500/10 py-1 px-2 rounded-lg transition text-slate-500"
            title="投稿を削除"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
};

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-indigo-500 selection:text-white">
      {/* 🖥️ デスクトップ トップヘッダー (統合検索バー配置) */}
      <header className="hidden md:block border-b border-slate-800/80 bg-slate-900/80 backdrop-blur sticky top-0 z-30 px-6 py-2.5">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between gap-4">
          {/* 左: ロゴ & タイトル */}
          <button
            onClick={() => {
              if (!authUser) {
                openWelcomePortal();
              } else {
                navigateToView('timeline');
                handleSwitchTimelineMode('local');
              }
            }}
            className="flex items-center space-x-3 text-left group shrink-0 cursor-pointer"
          >
            <div className="w-9 h-9 rounded-2xl bg-gradient-to-tr from-cyan-500 via-indigo-600 to-purple-600 flex items-center justify-center text-white shadow-md group-hover:scale-105 transition overflow-hidden border border-indigo-500/30">
              <img
                src={serverStats?.icon_url || "/logo.jpg"}
                alt={serverStats?.name || "Spica"}
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLElement).style.display = 'none';
                }}
              />
            </div>
            <div>
              <div className="flex items-center space-x-1.5">
                <span className="font-black text-lg tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-slate-100 to-indigo-300">
                  {serverStats?.name || 'Spica'}
                </span>
                <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-cyan-500/10 text-cyan-400 font-semibold border border-cyan-500/20">
                  Fediverse
                </span>
              </div>
            </div>
          </button>

          {/* 中央: 🔍 統合検索バー (ヘッダー常駐) */}
          <form
            onSubmit={handleSearchSubmit}
            className="flex-1 max-w-lg relative flex items-center"
          >
            <Search className="absolute left-3 w-4 h-4 text-slate-500 pointer-events-none" />
            <input
              type="text"
              placeholder="キーワード、@user@misskey.io、#タグ、from:user / has:media / before:2026-09-01..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950/90 border border-slate-800 hover:border-slate-700 rounded-2xl pl-9 pr-8 py-2 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-slate-950 transition"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSearchResults(null);
                }}
                className="absolute right-2.5 p-1 text-slate-500 hover:text-slate-300 rounded-lg transition"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </form>

          {/* 右: クイックアクション */}
          <div className="flex items-center space-x-2 shrink-0">
            {authUser ? (
              <div className="flex items-center space-x-2">
                {authUser.role === 'admin' && (
                  <button
                    onClick={() => navigateToView(currentView === 'admin' ? 'timeline' : 'admin')}
                    className={`px-3 py-1.5 text-xs font-bold rounded-xl transition flex items-center space-x-1.5 ${
                      currentView === 'admin'
                        ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/30'
                        : 'bg-slate-800/80 text-purple-300 border border-purple-500/30 hover:bg-purple-900/30'
                    }`}
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>{currentView === 'admin' ? 'タイムラインへ' : '管理パネル'}</span>
                  </button>
                )}

                <button
                  onClick={() => navigateToView('notifications')}
                  className={`relative p-2 rounded-xl transition ${
                    currentView === 'notifications'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30'
                      : 'bg-slate-800/80 text-slate-300 hover:bg-slate-800 hover:text-white border border-slate-700/60'
                  }`}
                  title="通知センター"
                >
                  <Bell className="w-4 h-4" />
                  {unreadNotificationsCount > 0 && (
                    <span className="absolute -top-1 -right-1 inline-flex items-center justify-center px-1.5 py-0.2 text-[9px] font-black rounded-full bg-rose-500 text-white shadow min-w-[16px]">
                      {unreadNotificationsCount > 99 ? '99+' : unreadNotificationsCount}
                    </span>
                  )}
                </button>

                <button
                  onClick={() => openUserProfile(authUser.id)}
                  className="flex items-center space-x-2 bg-slate-800/60 hover:bg-slate-800 px-2.5 py-1.5 rounded-xl border border-slate-700/50 transition cursor-pointer group"
                >
                  <div className="w-6 h-6 rounded-lg overflow-hidden bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center text-xs font-bold text-white shadow shrink-0">
                    {authUser.icon_url ? (
                      <img src={authUser.icon_url} alt={authUser.name} className="w-full h-full object-cover" />
                    ) : (
                      authUser.name.slice(0, 1).toUpperCase()
                    )}
                  </div>
                  <span className="text-xs font-bold text-slate-200 group-hover:text-indigo-300 transition max-w-[100px] truncate">{authUser.name}</span>
                </button>
              </div>
            ) : (
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setShowLoginModal(true)}
                  className="px-3 py-1.5 text-xs font-bold text-slate-200 hover:text-white bg-slate-800/80 hover:bg-slate-800 rounded-xl border border-slate-700 transition flex items-center space-x-1"
                >
                  <LogIn className="w-3.5 h-3.5 text-indigo-400" />
                  <span>ログイン</span>
                </button>
                <button
                  onClick={() => setShowRegisterModal(true)}
                  className="px-3.5 py-1.5 text-xs font-bold text-white bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 rounded-xl shadow-md transition flex items-center space-x-1"
                >
                  <Key className="w-3.5 h-3.5" />
                  <span>新規登録</span>
                </button>
              </div>
            )}

            {/* 🎨 テーマ切替ボタン (ダーク / 漆黒OLED / ライト) */}
            <button
              type="button"
              onClick={() => {
                setThemeMode((prev) => (prev === 'dark' ? 'pure_black' : prev === 'pure_black' ? 'light' : 'dark'));
              }}
              className="p-2 rounded-xl bg-slate-800/80 text-slate-300 hover:bg-slate-800 hover:text-white border border-slate-700/60 transition cursor-pointer"
              title={`外観テーマ切替 (現在: ${themeMode === 'pure_black' ? 'OLED漆黒モード' : themeMode === 'light' ? 'ソーラーライトモード' : 'コズミックダークモード'})`}
            >
              {themeMode === 'pure_black' ? (
                <Moon className="w-4 h-4 text-purple-400" />
              ) : themeMode === 'light' ? (
                <Sun className="w-4 h-4 text-amber-400" />
              ) : (
                <Palette className="w-4 h-4 text-cyan-400" />
              )}
            </button>
          </div>
        </div>
      </header>

      {/* 📱 モバイル用トップヘッダー (Misskey風) */}
      <header className="md:hidden border-b border-slate-800/80 bg-slate-900/80 backdrop-blur sticky top-0 z-30 px-3 py-2 flex items-center justify-between">
        <button
          onClick={() => {
            if (authUser) openUserProfile(authUser.id);
            else setShowLoginModal(true);
          }}
          className="w-8 h-8 rounded-full overflow-hidden bg-gradient-to-tr from-cyan-500 via-indigo-600 to-purple-600 flex items-center justify-center font-bold text-xs text-white shrink-0 shadow"
        >
          {authUser?.icon_url ? (
            <img src={authUser.icon_url} alt={authUser.name} className="w-full h-full object-cover" />
          ) : (
            authUser ? authUser.name.slice(0, 1).toUpperCase() : <LogIn className="w-4 h-4" />
          )}
        </button>

        {/* タイムラインタブ切り替え */}
        <div className="flex items-center space-x-1 overflow-x-auto">
          <button
            onClick={() => {
              navigateToView('timeline');
              handleSwitchTimelineMode('home');
            }}
            className={`px-2.5 py-1 text-xs font-bold rounded-lg transition ${
              currentView === 'timeline' && timelineMode === 'home'
                ? 'text-emerald-400 border-b-2 border-emerald-400 font-black'
                : 'text-slate-400'
            }`}
          >
            ホーム
          </button>
          <button
            onClick={() => {
              navigateToView('timeline');
              handleSwitchTimelineMode('local');
            }}
            className={`px-2.5 py-1 text-xs font-bold rounded-lg transition ${
              currentView === 'timeline' && timelineMode === 'local'
                ? 'text-emerald-400 border-b-2 border-emerald-400 font-black'
                : 'text-slate-400'
            }`}
          >
            ローカル
          </button>
          <button
            onClick={() => {
              navigateToView('timeline');
              handleSwitchTimelineMode('all');
            }}
            className={`px-2.5 py-1 text-xs font-bold rounded-lg transition ${
              currentView === 'timeline' && timelineMode === 'all'
                ? 'text-emerald-400 border-b-2 border-emerald-400 font-black'
                : 'text-slate-400'
            }`}
          >
            連合
          </button>
          {timelineMode === 'tag' && activeHashtag && (
            <span className="px-2 py-0.5 text-[11px] bg-indigo-600/30 text-indigo-300 rounded font-bold">
              #{activeHashtag}
            </span>
          )}
        </div>

        <div className="flex items-center space-x-1">
          <button
            type="button"
            onClick={() => {
              setThemeMode((prev) => (prev === 'dark' ? 'pure_black' : prev === 'pure_black' ? 'light' : 'dark'));
            }}
            className="p-1.5 text-slate-400 hover:text-slate-200 rounded-xl"
            title="外観テーマ切替"
          >
            {themeMode === 'pure_black' ? (
              <Moon className="w-4 h-4 text-purple-400" />
            ) : themeMode === 'light' ? (
              <Sun className="w-4 h-4 text-amber-400" />
            ) : (
              <Palette className="w-4 h-4 text-cyan-400" />
            )}
          </button>
          <button
            onClick={() => fetchTimeline(timelineMode)}
            disabled={isLoadingTimeline}
            className="p-1.5 text-slate-400 hover:text-slate-200 rounded-xl"
          >
            <RefreshCw className={`w-4 h-4 ${isLoadingTimeline ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* メインビュー */}
      {currentView === 'admin' ? (
        /* 🛡️ 管理者コントロールパネル (Misskey風 2カラムレイアウト) */
        <main className="max-w-7xl mx-auto px-4 py-6 flex-1 w-full">
          {/* 上部ヘッダー（全画面共通） */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-5 border-b border-slate-800/80 mb-6">
            <div className="flex items-center space-x-3">
              <button
                onClick={() => navigateToView('timeline')}
                className="p-2.5 rounded-2xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 transition"
                title="タイムラインへ戻る"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div>
                <h2 className="text-xl font-black text-slate-100 flex items-center space-x-2">
                  <Settings className="w-5 h-5 text-indigo-400" />
                  <span>コントロールパネル</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  ノードの統計、ユーザー管理、Fediverse 連合、メディアストレージ設定
                </p>
              </div>
            </div>

            <div className="flex items-center space-x-2 self-end sm:self-auto">
              <button
                onClick={fetchAdminData}
                disabled={isLoadingAdmin}
                className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 text-xs font-bold rounded-xl flex items-center space-x-1.5 transition shadow-sm"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoadingAdmin ? 'animate-spin text-indigo-400' : ''}`} />
                <span>データ再取得</span>
              </button>
            </div>
          </div>

          <div className="flex flex-col md:flex-row gap-6 items-start">
            {/* 📋 左サイドバー (Misskey 風メニュー) */}
            <aside className="w-full md:w-64 shrink-0 bg-slate-900/90 border border-slate-800 rounded-3xl p-3 shadow-xl space-y-4">
              {/* クイック検索バー */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="ユーザー検索..."
                  value={adminUserSearch}
                  onChange={(e) => {
                    setAdminUserSearch(e.target.value);
                    if (adminTab !== 'users') setAdminTab('users');
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition font-sans"
                />
              </div>

              {/* メニューリスト */}
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-slate-500 px-3 uppercase tracking-wider block mb-1">
                  管理
                </span>

                {/* ダッシュボード */}
                <button
                  type="button"
                  onClick={() => setAdminTab('dashboard')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'dashboard'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <LayoutDashboard className="w-4 h-4" />
                    <span>ダッシュボード</span>
                  </div>
                </button>

                {/* ユーザー */}
                <button
                  type="button"
                  onClick={() => setAdminTab('users')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'users'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Users className="w-4 h-4" />
                    <span>ユーザー</span>
                  </div>
                  {adminUsers.length > 0 && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                      adminTab === 'users' ? 'bg-indigo-700 text-white' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {adminUsers.length}
                    </span>
                  )}
                </button>

                {/* 連合・リレー */}
                <button
                  type="button"
                  onClick={() => setAdminTab('federation')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'federation'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Radio className="w-4 h-4" />
                    <span>連合 (リレー)</span>
                  </div>
                  {adminRelays.length > 0 && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                      adminTab === 'federation' ? 'bg-indigo-700 text-white' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {adminRelays.length}
                    </span>
                  )}
                </button>

                {/* サーバーブロック */}
                <button
                  type="button"
                  onClick={() => setAdminTab('blocks')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'blocks'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <ShieldAlert className="w-4 h-4" />
                    <span>サーバーブロック</span>
                  </div>
                  {adminBlockedDomains.length > 0 && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                      adminTab === 'blocks' ? 'bg-indigo-700 text-white' : 'bg-slate-800 text-rose-400'
                    }`}>
                      {adminBlockedDomains.length}
                    </span>
                  )}
                </button>

                {/* メディアストレージ */}
                <button
                  type="button"
                  onClick={() => setAdminTab('storage')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'storage'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Cloud className="w-4 h-4" />
                    <span>ファイル / ストレージ</span>
                  </div>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                    adminStorageConfig?.configured ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'
                  }`}>
                    {adminStorageConfig?.configured ? 'R2' : 'Local'}
                  </span>
                </button>

                {/* ⚙️ サーバー設定 */}
                <button
                  type="button"
                  onClick={() => setAdminTab('settings')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'settings'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Settings className="w-4 h-4" />
                    <span>サーバー設定</span>
                  </div>
                </button>

                {/* 🎨 カスタム絵文字 */}
                <button
                  type="button"
                  onClick={() => setAdminTab('emojis')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'emojis'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Smile className="w-4 h-4 text-yellow-400" />
                    <span>絵文字管理</span>
                  </div>
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-slate-850 text-slate-400">
                    {adminEmojis.length}
                  </span>
                </button>

                {/* 🎟 招待コード */}
                <button
                  type="button"
                  onClick={() => setAdminTab('invites')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'invites'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Ticket className="w-4 h-4 text-cyan-400" />
                    <span>招待コード</span>
                  </div>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                    serverStats?.registration_mode === 'invite' ? 'bg-amber-500/20 text-amber-300' : serverStats?.registration_mode === 'closed' ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-400'
                  }`}>
                    {serverStats?.registration_mode === 'invite' ? '招待制' : serverStats?.registration_mode === 'closed' ? '停止中' : '公開'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => { setAdminTab('reports'); fetchReports(reportStatusFilter); }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'reports'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <ShieldAlert className="w-4 h-4 text-rose-400" />
                    <span>通報</span>
                  </div>
                  {adminReportCounts.open > 0 && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                      adminTab === 'reports' ? 'bg-rose-600 text-white' : 'bg-rose-500/20 text-rose-300'
                    }`}>
                      {adminReportCounts.open}
                    </span>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => { setAdminTab('announcements'); fetchAdminAnnouncements(); }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'announcements'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Megaphone className="w-4 h-4 text-amber-400" />
                    <span>お知らせ</span>
                  </div>
                  {adminAnnouncements.filter((a) => a.is_active === 1).length > 0 && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                      adminTab === 'announcements' ? 'bg-indigo-700 text-white' : 'bg-slate-800 text-amber-400'
                    }`}>
                      {adminAnnouncements.filter((a) => a.is_active === 1).length}
                    </span>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => { setAdminTab('roles'); fetchRoles(); }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'roles'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <UserPlus className="w-4 h-4 text-violet-400" />
                    <span>ロール</span>
                  </div>
                  {adminRoles.length > 0 && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                      adminTab === 'roles' ? 'bg-indigo-700 text-white' : 'bg-slate-800 text-violet-300'
                    }`}>
                      {adminRoles.length}
                    </span>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => { setAdminTab('mail'); fetchMailSettings(); }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'mail'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Mail className="w-4 h-4 text-sky-400" />
                    <span>メール・認証</span>
                  </div>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                    mailSettings.configured ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'
                  }`}>
                    {mailSettings.configured ? '設定済' : '未設定'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => { setAdminTab('delivery'); setDeliveryQueueMsg(null); fetchDeliveryQueue(); }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'delivery'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Send className="w-4 h-4 text-emerald-400" />
                    <span>配送キュー</span>
                  </div>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                    (deliveryQueue.stats?.pending || 0) > 0
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'bg-slate-800 text-slate-400'
                  }`}>
                    {deliveryQueue.stats?.pending || 0}
                  </span>
                </button>
              </div>

              {/* クイック操作 */}
              <div className="pt-3 border-t border-slate-800/80 space-y-1">
                <span className="text-[10px] font-bold text-slate-500 px-3 uppercase tracking-wider block mb-1">
                  システム
                </span>
                <button
                  type="button"
                  onClick={handleAdminClearCache}
                  className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition cursor-pointer"
                  title="外部アクター情報や受信投稿のキャッシュを消去します"
                >
                  <Database className="w-4 h-4 text-slate-400" />
                  <span>キャッシュ消去</span>
                </button>
                <button
                  type="button"
                  onClick={() => navigateToView('timeline')}
                  className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4 text-slate-400" />
                  <span>タイムラインへ戻る</span>
                </button>
              </div>
            </aside>

            {/* 💻 右メインコンテンツエリア */}
            <div className="flex-1 w-full min-w-0 space-y-6">
              {/* 📊 1. ダッシュボードタブ */}
              {adminTab === 'dashboard' && (
                <div className="space-y-6 animate-in fade-in duration-150">
                  {/* 統計カード群 (Misskey Stats互換) */}
                  {adminStats && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-lg">
                        <span className="text-xs text-slate-400 block mb-1 font-medium">登録ユーザー数</span>
                        <span className="text-3xl font-black text-slate-100">{adminStats.stats.users}</span>
                        <span className="text-[11px] text-indigo-400 block mt-1 font-mono">
                          管理者: {adminStats.stats.admins} 名
                        </span>
                      </div>
                      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-lg">
                        <span className="text-xs text-slate-400 block mb-1 font-medium">ローカル投稿数</span>
                        <span className="text-3xl font-black text-indigo-400">{adminStats.stats.localPosts}</span>
                        <span className="text-[11px] text-slate-500 block mt-1">自サーバーのノート</span>
                      </div>
                      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-lg">
                        <span className="text-xs text-slate-400 block mb-1 font-medium">連合受信投稿数</span>
                        <span className="text-3xl font-black text-emerald-400">{adminStats.stats.federatedPosts}</span>
                        <span className="text-[11px] text-slate-500 block mt-1">Fediverse からのノート</span>
                      </div>
                      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-lg">
                        <span className="text-xs text-slate-400 block mb-1 font-medium">連携外部ドメイン</span>
                        <span className="text-3xl font-black text-cyan-400">{adminStats.stats.federatedDomains}</span>
                        <span className="text-[11px] text-slate-500 block mt-1">Mastodon / Misskey等</span>
                      </div>
                    </div>
                  )}

                  {/* サーバー概要 & モデレーター一覧 */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* サーバー基本情報 */}
                    <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-lg space-y-3">
                      <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                        <Server className="w-4 h-4 text-indigo-400" />
                        <span>サーバー基本情報</span>
                      </h3>
                      <div className="divide-y divide-slate-800/60 text-xs">
                        <div className="py-2.5 flex justify-between items-center">
                          <span className="text-slate-400">ノードドメイン</span>
                          <span className="font-mono font-bold text-slate-200">{serverStats?.domain || window.location.host}</span>
                        </div>
                        <div className="py-2.5 flex justify-between items-center">
                          <span className="text-slate-400">ソフトウェア</span>
                          <span className="font-bold text-indigo-300">Spica SNS (ActivityPub Engine)</span>
                        </div>
                        <div className="py-2.5 flex justify-between items-center">
                          <span className="text-slate-400">メディアストレージ</span>
                          <span className={`font-bold px-2 py-0.5 rounded-full text-[10px] ${
                            adminStorageConfig?.configured
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-slate-800 text-slate-400'
                          }`}>
                            {adminStorageConfig?.configured ? 'Cloudflare R2 (S3互換)' : 'サーバーローカル (/uploads)'}
                          </span>
                        </div>
                        <div className="py-2.5 flex justify-between items-center">
                          <span className="text-slate-400">接続中リレー</span>
                          <span className="font-mono font-bold text-purple-300">{adminRelays.length} サーバー</span>
                        </div>
                      </div>
                    </div>

                    {/* モデレーター (管理者一覧) */}
                    <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-lg space-y-3">
                      <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                        <ShieldCheck className="w-4 h-4 text-emerald-400" />
                        <span>モデレーター / 管理者 ({adminUsers.filter((u) => u.role === 'admin').length})</span>
                      </h3>
                      <div className="space-y-2">
                        {adminUsers
                          .filter((u) => u.role === 'admin')
                          .map((u) => (
                            <div
                              key={u.id}
                              className="flex items-center justify-between p-2.5 rounded-2xl bg-slate-950/60 border border-slate-800/80"
                            >
                              <div className="flex items-center space-x-3">
                                <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center font-bold text-xs text-white shrink-0">
                                  {u.name ? u.name.slice(0, 1).toUpperCase() : 'A'}
                                </div>
                                <div>
                                  <span className="font-bold text-xs text-slate-100 block">{u.name}</span>
                                  <span className="font-mono text-[11px] text-indigo-400">@{u.id}</span>
                                </div>
                              </div>
                              <span className="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 font-bold text-[10px] border border-purple-500/30">
                                ADMIN
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 👥 2. ユーザー管理タブ */}
              {adminTab === 'users' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-4 animate-in fade-in duration-150">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                        <Users className="w-4 h-4 text-indigo-400" />
                        <span>ユーザー管理 ({adminUsers.length})</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        アカウントの権限変更、凍結・解除、活動状況の確認
                      </p>
                    </div>

                    <div className="w-full sm:w-64">
                      <input
                        type="text"
                        placeholder="ユーザー名やIDで絞り込み..."
                        value={adminUserSearch}
                        onChange={(e) => setAdminUserSearch(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 transition"
                      />
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400">
                          <th className="pb-3 font-semibold">ユーザー</th>
                          <th className="pb-3 font-semibold">ロール</th>
                          <th className="pb-3 font-semibold">投稿数</th>
                          <th className="pb-3 font-semibold">フォロワー</th>
                          <th className="pb-3 font-semibold">登録日時</th>
                          <th className="pb-3 font-semibold text-right">アクション</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {adminUsers
                          .filter((u) => {
                            if (!adminUserSearch.trim()) return true;
                            const q = adminUserSearch.toLowerCase();
                            return (
                              (u.name && u.name.toLowerCase().includes(q)) ||
                              (u.id && u.id.toLowerCase().includes(q))
                            );
                          })
                          .map((u) => (
                            <tr key={u.id} className="hover:bg-slate-800/30 transition">
                              <td className="py-3">
                                <div className="font-bold text-slate-200">{u.name}</div>
                                <div className="font-mono text-[11px] text-indigo-400">@{u.id}</div>
                              </td>
                              <td className="py-3">
                                {u.role === 'admin' ? (
                                  <span className="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 font-bold text-[10px] border border-purple-500/30">
                                    ADMIN
                                  </span>
                                ) : (
                                  <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-medium text-[10px]">
                                    USER
                                  </span>
                                )}
                              </td>
                              <td className="py-3 font-mono text-slate-300">{u.postCount ?? 0}</td>
                              <td className="py-3 font-mono text-slate-300">{u.followerCount ?? 0}</td>
                              <td className="py-3 text-slate-400 whitespace-nowrap">
                                {new Date(u.created_at).toLocaleDateString('ja-JP')}
                              </td>
                              <td className="py-3 text-right space-x-1.5 whitespace-nowrap">
                                {u.id !== authUser?.id && (
                                  <>
                                    <button
                                      onClick={() =>
                                        handleAdminChangeRole(u.id, u.role)
                                      }
                                      className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs transition"
                                      title={u.role === 'admin' ? '一般ユーザーに降格' : '管理者に昇格'}
                                    >
                                      {u.role === 'admin' ? '一般へ降格' : '管理者へ'}
                                    </button>
                                    <button
                                      onClick={() => handleAdminToggleFreeze(u.id, Boolean(u.is_frozen))}
                                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition ${
                                        u.is_frozen
                                          ? 'bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 border border-emerald-500/30'
                                          : 'bg-rose-600/20 text-rose-300 hover:bg-rose-600/30 border border-rose-500/30'
                                      }`}
                                    >
                                      {u.is_frozen ? '凍結解除' : '凍結'}
                                    </button>
                                    <button
                                      onClick={() => setAdminDeleteTargetUser(u)}
                                      className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-rose-950/60 hover:bg-rose-900/80 text-rose-300 border border-rose-800/60 transition cursor-pointer inline-flex items-center space-x-1"
                                      title="アカウントを完全に削除"
                                    >
                                      <Trash2 className="w-3 h-3 text-rose-400" />
                                      <span>削除</span>
                                    </button>
                                  </>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 🌐 3. 連合・リレータブ */}
              {adminTab === 'federation' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div>
                    <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                      <Radio className="w-4 h-4 text-purple-400" />
                      <span>ActivityPub リレーサーバー管理 (PubSub Relay)</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                      Misskey や Mastodon のリレーサーバーに接続すると、連合タイムラインに世界中のパブリック投稿がリアルタイムに流れるようになります。また、自サーバーの投稿もリレーを通じて世界中へ拡散されます。
                    </p>
                  </div>

                  {/* リレー追加フォーム */}
                  <form onSubmit={handleConnectRelay} className="space-y-3 bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80">
                    <label className="block text-xs font-semibold text-slate-300">
                      リレーサーバー URL (Actor または Inbox URL)
                    </label>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="url"
                        required
                        placeholder="https://relay.example.com/actor または /inbox"
                        value={relayInputUrl}
                        onChange={(e) => setRelayInputUrl(e.target.value)}
                        className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-purple-500 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={!relayInputUrl.trim() || isConnectingRelay}
                        className="px-5 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition whitespace-nowrap flex items-center justify-center space-x-1"
                      >
                        <Radio className="w-3.5 h-3.5" />
                        <span>{isConnectingRelay ? '接続中...' : 'リレーに接続 (Follow)'}</span>
                      </button>
                    </div>

                    {relayMessage && (
                      <div
                        className={`p-2.5 rounded-xl text-xs flex items-center space-x-2 ${
                          relayMessage.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}
                      >
                        {relayMessage.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                        <span>{relayMessage.text}</span>
                      </div>
                    )}
                  </form>

                  {/* 接続中リレー一覧 */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-slate-400">登録済みリレー ({adminRelays.length})</h4>
                      {adminRelays.length > 0 && (
                        <button
                          type="button"
                          onClick={() => handleAdminResendRelay()}
                          className="px-2.5 py-1 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-[11px] font-bold transition flex items-center space-x-1"
                          title="登録されているすべてのリレーに購読(Follow)リクエストを一括再送します"
                        >
                          <span>🔄 全リレー一括再送</span>
                        </button>
                      )}
                    </div>
                    {adminRelays.length === 0 ? (
                      <div className="text-center py-6 bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                        登録されているリレーサーバーはありません。
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {adminRelays.map((r) => (
                          <div
                            key={r.inbox_url}
                            className="bg-slate-950/80 border border-slate-800 p-3.5 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-slate-200 font-bold truncate">{r.inbox_url}</span>
                                {r.status === 'accepted' ? (
                                  <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-bold text-[10px] border border-emerald-500/30 flex items-center space-x-1">
                                    <Check className="w-3 h-3" />
                                    <span>接続中 (ACCEPTED)</span>
                                  </span>
                                ) : (
                                  <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-bold text-[10px] border border-amber-500/30">
                                    承認待ち (PENDING)
                                  </span>
                                )}
                              </div>
                              <span className="text-[11px] text-slate-500 block mt-0.5">登録: {new Date(r.created_at).toLocaleString('ja-JP')}</span>
                            </div>
                            <div className="flex items-center space-x-2 shrink-0">
                              <button
                                onClick={() => handleAdminResendRelay(r.inbox_url)}
                                className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                                title="このリレーに Follow Activity を再送します"
                              >
                                再送
                              </button>
                              <button
                                onClick={() => handleAdminToggleRelayStatus(r.inbox_url, r.status)}
                                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition ${
                                  r.status === 'accepted'
                                    ? 'bg-amber-500/15 border-amber-500/30 text-amber-300 hover:bg-amber-500/30'
                                    : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/30'
                                }`}
                                title="承認ステータスを手動で切り替えます"
                              >
                                {r.status === 'accepted' ? '承認待ちに戻す' : '承認済みにする'}
                              </button>
                              <button
                                onClick={() => handleDisconnectRelay(r.inbox_url)}
                                className="px-3 py-1.5 rounded-lg bg-rose-600/20 text-rose-300 hover:bg-rose-600/40 text-[11px] font-medium transition"
                              >
                                購読解除
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 連携先リモートサーバー一覧 */}
                  <div className="space-y-3 pt-4 border-t border-slate-800">
                    <div>
                      <h4 className="text-xs font-semibold text-slate-300 flex items-center space-x-2">
                        <Globe className="w-3.5 h-3.5 text-cyan-400" />
                        <span>連携先リモートサーバー ({adminFederation?.domainStats?.length || 0})</span>
                      </h4>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        これまでに投稿を受信またはフォローを行った外部インスタンスです。ワンクリックで通信遮断（ブロック）が可能です。
                      </p>
                    </div>

                    {(!adminFederation?.domainStats || adminFederation.domainStats.length === 0) ? (
                      <div className="text-center py-6 bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                        連携中の外部サーバー情報はまだありません。
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {adminFederation.domainStats.map((stat: any) => (
                          <div
                            key={stat.domain}
                            className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-2xl flex items-center justify-between text-xs hover:border-slate-700 transition"
                          >
                            <div className="min-w-0 pr-2">
                              <span className="font-mono font-bold text-slate-200 truncate block">
                                {stat.domain}
                              </span>
                              <span className="text-[10px] text-slate-500">
                                登録アカウント: {stat.actor_count} 件
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleQuickBlockDomain(stat.domain)}
                              className="px-2.5 py-1 bg-rose-600/10 hover:bg-rose-600/20 text-rose-300 border border-rose-500/20 rounded-lg text-[11px] font-semibold transition shrink-0 flex items-center space-x-1"
                              title="このサーバーをブロックして通信を遮断・キャッシュを削除します"
                            >
                              <ShieldAlert className="w-3 h-3" />
                              <span>ブロック</span>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 🚫 4. サーバーブロックタブ */}
              {adminTab === 'blocks' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div>
                    <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                      <ShieldAlert className="w-4 h-4 text-rose-400" />
                      <span>サーバー（ドメイン）ブロック管理 ({adminBlockedDomains.length})</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                      指定した外部 Fediverse サーバーからの通信（Inbox）を 403 で遮断し、配送（Delivery）や WebFinger 検索も停止します。ブロック実行時、該当サーバーの過去のキャッシュ投稿・アクター情報も自動消去されます。
                    </p>
                  </div>

                  {/* 手動ブロック追加フォーム */}
                  <form onSubmit={handleManualBlockDomain} className="space-y-3 bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-1">
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          ブロックするドメイン名 <span className="text-rose-400">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          placeholder="spam.example.com"
                          value={blockInputDomain}
                          onChange={(e) => setBlockInputDomain(e.target.value)}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-rose-500 focus:outline-none"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          ブロック理由（管理者メモ・任意）
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            placeholder="スパム送信サーバーのため、荒らし対策など"
                            value={blockInputReason}
                            onChange={(e) => setBlockInputReason(e.target.value)}
                            className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-rose-500 focus:outline-none"
                          />
                          <button
                            type="submit"
                            disabled={!blockInputDomain.trim() || isBlockingDomain}
                            className="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition whitespace-nowrap flex items-center space-x-1 shrink-0"
                          >
                            <ShieldAlert className="w-3.5 h-3.5" />
                            <span>{isBlockingDomain ? '処理中...' : 'ブロック実行'}</span>
                          </button>
                        </div>
                      </div>
                    </div>

                    {blockMessage && (
                      <div
                        className={`p-2.5 rounded-xl text-xs flex items-center space-x-2 ${
                          blockMessage.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}
                      >
                        {blockMessage.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                        <span>{blockMessage.text}</span>
                      </div>
                    )}
                  </form>

                  {/* ブロック中ドメイン一覧 */}
                  {adminBlockedDomains.length === 0 ? (
                    <div className="text-center py-6 bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                      現在ブロックされているサーバーはありません。
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-400">
                            <th className="pb-3 font-semibold">ブロック中ドメイン</th>
                            <th className="pb-3 font-semibold">理由</th>
                            <th className="pb-3 font-semibold">登録日</th>
                            <th className="pb-3 font-semibold">登録者</th>
                            <th className="pb-3 font-semibold text-right">操作</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60">
                          {adminBlockedDomains.map((b) => (
                            <tr key={b.domain} className="hover:bg-slate-800/20 transition">
                              <td className="py-3 font-mono font-bold text-rose-300">
                                🚫 {b.domain}
                              </td>
                              <td className="py-3 text-slate-300 max-w-xs truncate">
                                {b.reason || <span className="text-slate-500 italic">(理由記載なし)</span>}
                              </td>
                              <td className="py-3 text-slate-400 whitespace-nowrap">
                                {new Date(b.created_at).toLocaleString('ja-JP')}
                              </td>
                              <td className="py-3 text-slate-400 font-mono">
                                @{b.created_by}
                              </td>
                              <td className="py-3 text-right whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => handleUnblockDomain(b.domain)}
                                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold transition"
                                >
                                  ブロック解除
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* ☁️ 5. メディアストレージタブ */}
              {adminTab === 'storage' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                      <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                        <Cloud className="w-4 h-4 text-cyan-400" />
                        <span>メディアストレージ設定 (Cloudflare R2 / S3互換)</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                        Cloudflare R2 などの S3 互換オブジェクトストレージを接続すると、投稿画像を大容量・高速に配信できます。
                        未設定の場合はサーバーローカル（<code className="text-indigo-300 font-mono">data/uploads</code>）へ自動保存されます。
                      </p>
                    </div>
                    <div className="shrink-0">
                      {adminStorageConfig?.configured ? (
                        <span className="px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold flex items-center space-x-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          <span>S3 / R2 有効</span>
                        </span>
                      ) : (
                        <span className="px-3 py-1 rounded-full bg-slate-800 text-slate-400 border border-slate-700 text-xs font-bold flex items-center space-x-1.5">
                          <Server className="w-3.5 h-3.5 text-slate-400" />
                          <span>ローカル保存中</span>
                        </span>
                      )}
                    </div>
                  </div>

                  <form onSubmit={handleSaveStorage} className="space-y-4 bg-slate-950/60 p-5 rounded-2xl border border-slate-800/80">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          エンドポイント URL (Endpoint)
                        </label>
                        <input
                          type="url"
                          placeholder="https://<account-id>.r2.cloudflarestorage.com"
                          value={storageForm.endpoint}
                          onChange={(e) => setStorageForm((prev) => ({ ...prev, endpoint: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                        />
                        <span className="text-[10px] text-slate-500 mt-0.5 block">
                          Cloudflare R2 の「S3 API エンドポイント」を入力
                        </span>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          バケット名 (Bucket)
                        </label>
                        <input
                          type="text"
                          placeholder="spica-media"
                          value={storageForm.bucket}
                          onChange={(e) => setStorageForm((prev) => ({ ...prev, bucket: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                        />
                        <span className="text-[10px] text-slate-500 mt-0.5 block">
                          作成した R2 または S3 バケットの名称
                        </span>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          公開 URL (Public Access URL)
                        </label>
                        <input
                          type="url"
                          placeholder="https://pub-xxxx.r2.dev または https://media.example.com"
                          value={storageForm.publicUrl}
                          onChange={(e) => setStorageForm((prev) => ({ ...prev, publicUrl: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                        />
                        <span className="text-[10px] text-slate-500 mt-0.5 block">
                          R2 のパブリックアクセス URL またはバインドしたカスタムドメイン
                        </span>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          リージョン (Region)
                        </label>
                        <input
                          type="text"
                          placeholder="auto"
                          value={storageForm.region}
                          onChange={(e) => setStorageForm((prev) => ({ ...prev, region: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                        />
                        <span className="text-[10px] text-slate-500 mt-0.5 block">
                          Cloudflare R2 の場合は通常 <code className="text-slate-400">auto</code>
                        </span>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          Access Key ID
                        </label>
                        <input
                          type="text"
                          placeholder="API トークンの Access Key ID"
                          value={storageForm.accessKeyId}
                          onChange={(e) => setStorageForm((prev) => ({ ...prev, accessKeyId: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          Secret Access Key
                        </label>
                        <input
                          type="password"
                          placeholder={adminStorageConfig?.hasSecretAccessKey ? '******** (変更する場合のみ入力)' : 'API トークンの Secret Access Key'}
                          value={storageForm.secretAccessKey}
                          onChange={(e) => setStorageForm((prev) => ({ ...prev, secretAccessKey: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                        />
                      </div>
                    </div>

                    {storageMessage && (
                      <div
                        className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                          storageMessage.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}
                      >
                        {storageMessage.type === 'success' ? (
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 shrink-0" />
                        )}
                        <span>{storageMessage.text}</span>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-slate-800/80">
                      <button
                        type="button"
                        onClick={handleTestStorage}
                        disabled={isTestingStorage || isSavingStorage}
                        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 text-xs font-bold rounded-xl transition flex items-center space-x-1.5 cursor-pointer"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isTestingStorage ? 'animate-spin' : ''}`} />
                        <span>{isTestingStorage ? 'テスト接続中...' : '接続テスト'}</span>
                      </button>
                      <button
                        type="submit"
                        disabled={isSavingStorage || isTestingStorage}
                        className="px-5 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition flex items-center space-x-1.5 cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>{isSavingStorage ? '保存中...' : 'ストレージ設定を保存'}</span>
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {/* ⚙️ サーバー基本設定タブ */}
              {adminTab === 'settings' && (
                <div className="space-y-6">
                  {/* ヘッダーカード */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-2">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-2xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                        <Settings className="w-5 h-5" />
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-slate-100">サーバー基本設定</h2>
                        <p className="text-xs text-slate-400">
                          サーバーの正式名称や紹介文、ヘッダーに表示されるアイコン・ロゴ画像を自由にカスタマイズできます。
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* フォームカード */}
                  <form onSubmit={handleSaveServerSettings} className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-6">
                    {/* アイコン設定 */}
                    <div>
                      <label className="block text-xs font-bold text-slate-300 mb-2">
                        サーバーアイコン / ロゴ
                      </label>
                      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                        <div className="w-20 h-20 rounded-3xl bg-slate-950 border-2 border-slate-700/80 flex items-center justify-center overflow-hidden shadow-lg shrink-0">
                          <img
                            src={adminServerIcon || serverStats?.icon_url || '/logo.jpg'}
                            alt="Preview"
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              (e.currentTarget as HTMLElement).style.display = 'none';
                            }}
                          />
                        </div>
                        <div className="flex-1 space-y-2">
                          <div className="flex flex-wrap gap-2">
                            <label className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition flex items-center space-x-1.5 cursor-pointer shadow-md">
                              {isUploadingServerIcon ? (
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Upload className="w-3.5 h-3.5" />
                              )}
                              <span>{isUploadingServerIcon ? 'アップロード中...' : '画像を選択してアップロード'}</span>
                              <input
                                type="file"
                                accept="image/*"
                                disabled={isUploadingServerIcon}
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) handleUploadServerIcon(file);
                                  e.target.value = '';
                                }}
                                className="hidden"
                              />
                            </label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <span className="text-[11px] text-slate-500 shrink-0">または直接URLを指定:</span>
                            <input
                              type="text"
                              placeholder="https://example.com/logo.png"
                              value={adminServerIcon}
                              onChange={(e) => setAdminServerIcon(e.target.value)}
                              className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                            />
                          </div>
                          <p className="text-[11px] text-slate-500">
                            ※ 正方形の画像（PNG, JPEG, WebP）を推奨します。最大10MB。
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* サーバーバナー設定 */}
                    <div className="pt-4 border-t border-slate-800/80">
                      <label className="block text-xs font-bold text-slate-300 mb-2">
                        サーバーバナー画像 (Instance Banner)
                      </label>
                      <div className="space-y-3">
                        <div className="w-full h-36 sm:h-44 rounded-2xl bg-slate-950 border-2 border-slate-700/80 overflow-hidden relative shadow-lg flex items-center justify-center">
                          {adminServerBanner || serverStats?.banner_url ? (
                            <img
                              src={adminServerBanner || serverStats?.banner_url}
                              alt="Banner Preview"
                              className="w-full h-full object-cover"
                              onError={(e) => {
                                (e.currentTarget as HTMLElement).style.display = 'none';
                              }}
                            />
                          ) : (
                            <div className="flex flex-col items-center justify-center text-slate-500 space-y-1 p-4 text-center">
                              <ImageIcon className="w-8 h-8 opacity-40" />
                              <span className="text-xs">バナー画像が未設定です（デフォルトのグラデーション背景が使用されます）</span>
                            </div>
                          )}
                        </div>

                        <div className="space-y-2">
                          <div className="flex flex-wrap gap-2">
                            <label className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition flex items-center space-x-1.5 cursor-pointer shadow-md">
                              {isUploadingServerBanner ? (
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Upload className="w-3.5 h-3.5" />
                              )}
                              <span>{isUploadingServerBanner ? 'アップロード中...' : 'バナー画像を選択してアップロード'}</span>
                              <input
                                type="file"
                                accept="image/*"
                                disabled={isUploadingServerBanner}
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) handleUploadServerBanner(file);
                                  e.target.value = '';
                                }}
                                className="hidden"
                              />
                            </label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <span className="text-[11px] text-slate-500 shrink-0">または直接URLを指定:</span>
                            <input
                              type="text"
                              placeholder="https://example.com/banner.png"
                              value={adminServerBanner}
                              onChange={(e) => setAdminServerBanner(e.target.value)}
                              className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                            />
                          </div>
                          <p className="text-[11px] text-slate-500">
                            ※ 横長画像（アスペクト比 16:9 や 3:1、1200×630px 以上推奨）を推奨します。最大15MB。ログイン・新規登録画面の背景や連合紹介に表示されます。
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* サーバー名 */}
                    <div className="space-y-1.5 pt-4 border-t border-slate-800/80">
                      <label className="block text-xs font-bold text-slate-300">
                        サーバー名 (Instance Name) <span className="text-rose-400">*</span>
                      </label>
                      <input
                        type="text"
                        placeholder="例: Spica, 星屑ソーシャル, My Mastodon Node"
                        value={adminServerName}
                        onChange={(e) => setAdminServerName(e.target.value)}
                        required
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 font-medium focus:ring-2 focus:ring-indigo-500 focus:outline-none transition"
                      />
                      <p className="text-[11px] text-slate-500">
                        ヘッダー、ブラウザのタイトルタブ、および連合（NodeInfo / ActivityPub）に公開される正式名称です。
                      </p>
                    </div>

                    {/* サーバー説明文 */}
                    <div className="space-y-1.5 pt-4 border-t border-slate-800/80">
                      <label className="block text-xs font-bold text-slate-300">
                        サーバー説明文 (Description)
                      </label>
                      <textarea
                        rows={3}
                        placeholder="このサーバーの特徴やルール、コミュニティの紹介文を入力してください..."
                        value={adminServerDesc}
                        onChange={(e) => setAdminServerDesc(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none transition resize-none leading-relaxed"
                      />
                      <p className="text-[11px] text-slate-500">
                        NodeInfo や外部の Fediverse サーバーからインスタンス詳細を取得した際に表示されます。
                      </p>
                    </div>

                    {/* 📜 サーバールール設定 */}
                    <div className="space-y-3 pt-4 border-t border-slate-800/80">
                      <div className="flex items-center justify-between">
                        <label className="block text-xs font-bold text-slate-300">
                          サーバールール (Server Rules)
                        </label>
                        <span className="text-[11px] text-slate-500">1行に1ルール入力</span>
                      </div>
                      <textarea
                        rows={4}
                        placeholder={"お互いを尊重してください\n他鯖とのもめごとなどをおこさないでください\n個人情報を極力書かないこと\n利用規約をちゃんと守ること"}
                        value={adminServerRulesText}
                        onChange={(e) => setAdminServerRulesText(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none transition resize-none leading-relaxed font-mono"
                      />
                      {adminServerRulesText.split('\n').filter((r) => r.trim()).length > 0 && (
                        <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1.5">
                          <span className="text-[10px] font-bold text-slate-400 block mb-1">新規登録画面でのプレビュー</span>
                          {adminServerRulesText.split('\n').filter((r) => r.trim()).map((rule, idx) => (
                            <div key={idx} className="flex items-start space-x-2 text-xs text-slate-300">
                              <span className="w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-[10px] flex items-center justify-center shrink-0 mt-0.5">
                                {idx + 1}
                              </span>
                              <span>{rule.trim()}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 規約同意の必須化スイッチ */}
                    <div className="pt-4 border-t border-slate-800/80">
                      <label className="flex items-start space-x-3 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={adminRequireRulesAgreement}
                          onChange={(e) => setAdminRequireRulesAgreement(e.target.checked)}
                          className="mt-0.5 w-4 h-4 rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-indigo-500"
                        />
                        <div className="space-y-0.5">
                          <span className="text-xs font-bold text-slate-200 block">
                            新規登録時にサーバールール・利用規約への同意を必須にする
                          </span>
                          <span className="text-[11px] text-slate-400 block leading-relaxed">
                            有効にすると、ユーザーがアカウントを作成する前にMisskeyスタイルのルール・規約同意モーダルが表示され、全項目への同意を要求します。
                          </span>
                        </div>
                      </label>
                    </div>

                    {/* 利用規約・ポリシー・外部リンク設定 (Misskeyスタイル) */}
                    <div className="space-y-4 pt-4 border-t border-slate-800/80">
                      <div className="flex items-center space-x-2 pb-1">
                        <Globe className="w-4 h-4 text-indigo-400" />
                        <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                          ポリシー・外部リンク設定 (Misskey互換)
                        </h3>
                      </div>

                      {/* 利用規約URL */}
                      <div className="space-y-1">
                        <label className="block text-[11px] font-semibold text-slate-300">
                          利用規約URL
                        </label>
                        <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                          <ExternalLink className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
                          <input
                            type="text"
                            placeholder="https://example.com/terms.html"
                            value={adminTosUrl}
                            onChange={(e) => setAdminTosUrl(e.target.value)}
                            className="bg-transparent text-slate-200 placeholder-slate-600 focus:outline-none flex-1 font-mono text-xs"
                          />
                        </div>
                      </div>

                      {/* プライバシーポリシーURL */}
                      <div className="space-y-1">
                        <label className="block text-[11px] font-semibold text-slate-300">
                          プライバシーポリシーURL
                        </label>
                        <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                          <ExternalLink className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
                          <input
                            type="text"
                            placeholder="https://example.com/privacy.html"
                            value={adminPrivacyPolicyUrl}
                            onChange={(e) => setAdminPrivacyPolicyUrl(e.target.value)}
                            className="bg-transparent text-slate-200 placeholder-slate-600 focus:outline-none flex-1 font-mono text-xs"
                          />
                        </div>
                      </div>

                      {/* 問い合わせ先URL */}
                      <div className="space-y-1">
                        <label className="block text-[11px] font-semibold text-slate-300">
                          問い合わせ先URL
                        </label>
                        <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                          <ExternalLink className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
                          <input
                            type="text"
                            placeholder="https://example.com/contact.html"
                            value={adminContactUrl}
                            onChange={(e) => setAdminContactUrl(e.target.value)}
                            className="bg-transparent text-slate-200 placeholder-slate-600 focus:outline-none flex-1 font-mono text-xs"
                          />
                        </div>
                        <p className="text-[10px] text-slate-500">
                          サーバー運営者へのお問い合わせフォームのURLや、運営者の連絡先等が記載されたWebページのURLを指定します。
                        </p>
                      </div>

                      {/* リポジトリURL */}
                      <div className="space-y-1">
                        <label className="block text-[11px] font-semibold text-slate-300">
                          リポジトリURL
                        </label>
                        <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                          <ExternalLink className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
                          <input
                            type="text"
                            placeholder="https://github.com/Keychrom/Spica"
                            value={adminRepositoryUrl}
                            onChange={(e) => setAdminRepositoryUrl(e.target.value)}
                            className="bg-transparent text-slate-200 placeholder-slate-600 focus:outline-none flex-1 font-mono text-xs"
                          />
                        </div>
                        <p className="text-[10px] text-slate-500">
                          ソースコードが公開されているリポジトリがある場合、そのURLを記入します。
                        </p>
                      </div>

                      {/* 運営者情報URL */}
                      <div className="space-y-1">
                        <label className="block text-[11px] font-semibold text-slate-300">
                          運営者情報URL
                        </label>
                        <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                          <ExternalLink className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
                          <input
                            type="text"
                            placeholder="https://example.com/profile.html"
                            value={adminOperatorUrl}
                            onChange={(e) => setAdminOperatorUrl(e.target.value)}
                            className="bg-transparent text-slate-200 placeholder-slate-600 focus:outline-none flex-1 font-mono text-xs"
                          />
                        </div>
                        <p className="text-[10px] text-slate-500">
                          ドイツなどの一部の国と地域では表示が義務付けられています (Impressum)。
                        </p>
                      </div>
                    </div>

                    {/* メッセージ表示 */}
                    {serverSettingsMessage && (
                      <div
                        className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                          serverSettingsMessage.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}
                      >
                        {serverSettingsMessage.type === 'success' ? (
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 shrink-0" />
                        )}
                        <span>{serverSettingsMessage.text}</span>
                      </div>
                    )}

                    {/* 送信ボタン */}
                    <div className="flex justify-end pt-4 border-t border-slate-800/80">
                      <button
                        type="submit"
                        disabled={isSavingServerSettings}
                        className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/30 transition flex items-center space-x-2 cursor-pointer"
                      >
                        {isSavingServerSettings ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Check className="w-3.5 h-3.5" />
                        )}
                        <span>{isSavingServerSettings ? '保存中...' : 'サーバー設定を保存'}</span>
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {/* 🎨 カスタム絵文字管理タブ */}
              {adminTab === 'emojis' && (
                <div className="space-y-6">
                  {/* ヘッダーカード */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-2">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-2xl bg-yellow-500/20 border border-yellow-500/30 flex items-center justify-center text-yellow-400">
                        <Smile className="w-5 h-5" />
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-slate-100">カスタム絵文字管理</h2>
                        <p className="text-xs text-slate-400">
                          サーバーオリジナルのカスタム絵文字を追加・管理できます。登録した絵文字は投稿本文やリアクションピッカーで使用でき、連合先（Mastodon / Misskey）にも画像タグ付きで配信されます。
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* 新規絵文字追加カード */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
                    <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-2">
                      <Plus className="w-4 h-4 text-emerald-400" />
                      <span>新規カスタム絵文字を登録</span>
                    </h3>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-bold text-slate-300 mb-1">
                          ショートコード名 <span className="text-rose-400">*</span>
                        </label>
                        <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                          <span className="text-slate-500 font-mono mr-1">:</span>
                          <input
                            type="text"
                            placeholder="例: blobcat, party_parrot, spica"
                            value={newEmojiName}
                            onChange={(e) => setNewEmojiName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                            className="bg-transparent text-slate-200 focus:outline-none flex-1 font-mono text-xs"
                          />
                          <span className="text-slate-500 font-mono ml-1">:</span>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-1">※ 2〜30文字の小文字英数字・アンダースコア</p>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-300 mb-1">
                          カテゴリ
                        </label>
                        <input
                          type="text"
                          placeholder="例: 一般, キャラクター, ネタ, 挨拶"
                          value={newEmojiCategory}
                          onChange={(e) => setNewEmojiCategory(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        />
                        <p className="text-[10px] text-slate-500 mt-1">※ ピッカー内でタブ分け表示されます</p>
                      </div>
                    </div>

                    {/* 画像選択エリア */}
                    <div className="pt-2 border-t border-slate-800/80">
                      <label className="block text-xs font-bold text-slate-300 mb-2">
                        絵文字画像ファイル / 画像URL <span className="text-rose-400">*</span>
                      </label>
                      <div className="flex flex-col sm:flex-row gap-3">
                        <label className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition flex items-center justify-center space-x-1.5 cursor-pointer shadow-md shrink-0">
                          {isUploadingEmoji ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <Upload className="w-4 h-4" />
                          )}
                          <span>{isUploadingEmoji ? 'アップロード中...' : 'ファイルを選択して登録'}</span>
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                            disabled={isUploadingEmoji}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) handleCreateEmoji(file);
                              e.target.value = '';
                            }}
                            className="hidden"
                          />
                        </label>

                        <div className="flex-1 flex items-center space-x-2">
                          <span className="text-[11px] text-slate-500 shrink-0">またはURL:</span>
                          <input
                            type="text"
                            placeholder="https://example.com/emoji.png"
                            value={newEmojiUrl}
                            onChange={(e) => setNewEmojiUrl(e.target.value)}
                            className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => handleCreateEmoji()}
                            disabled={isUploadingEmoji || !newEmojiName.trim() || !newEmojiUrl.trim()}
                            className="px-4 py-2 bg-slate-800 hover:bg-indigo-600 text-slate-200 hover:text-white rounded-xl text-xs font-bold transition disabled:opacity-40 cursor-pointer shrink-0"
                          >
                            URLで登録
                          </button>
                        </div>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-2">
                        ※ PNG, WebP, GIF, SVG に対応。正方形の透過画像（128×128px 前後）を推奨します。
                      </p>
                    </div>

                    {/* 通知メッセージ */}
                    {emojiActionMsg && (
                      <div
                        className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                          emojiActionMsg.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}
                      >
                        {emojiActionMsg.type === 'success' ? (
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 shrink-0" />
                        )}
                        <span>{emojiActionMsg.text}</span>
                      </div>
                    )}
                  </div>

                  {/* 登録済み絵文字一覧カード */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-2">
                        <Tag className="w-4 h-4 text-indigo-400" />
                        <span>登録済みカスタム絵文字 ({adminEmojis.length}件)</span>
                      </h3>
                      <button
                        type="button"
                        onClick={fetchAdminData}
                        className="p-1.5 text-slate-400 hover:text-slate-200 rounded-xl hover:bg-slate-800 transition text-xs flex items-center space-x-1"
                        title="一覧を更新"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>更新</span>
                      </button>
                    </div>

                    {adminEmojis.length === 0 ? (
                      <div className="p-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800/60">
                        <Smile className="w-10 h-10 mx-auto text-slate-600 mb-2" />
                        <p className="text-xs text-slate-400 font-bold">まだカスタム絵文字が登録されていません</p>
                        <p className="text-[11px] text-slate-500 mt-1">
                          上のフォームから画像を選択して、コミュニティオリジナルの絵文字を追加してみましょう！
                        </p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                        {adminEmojis.map((emoji) => (
                          <div
                            key={emoji.id}
                            className="bg-slate-950/70 border border-slate-800/80 hover:border-slate-750 rounded-2xl p-3 flex flex-col items-center justify-between text-center group transition shadow-sm"
                          >
                            <div className="w-12 h-12 flex items-center justify-center my-1">
                              <img
                                src={emoji.url}
                                alt={emoji.name}
                                className="w-10 h-10 object-contain drop-shadow"
                                loading="lazy"
                              />
                            </div>
                            <div className="w-full mt-2">
                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard.writeText(`:${emoji.name}:`);
                                  alert(`:${emoji.name}: をコピーしました！`);
                                }}
                                className="font-mono text-xs font-bold text-slate-200 hover:text-indigo-400 truncate block w-full transition cursor-pointer"
                                title="クリックでショートコードをコピー"
                              >
                                :{emoji.name}:
                              </button>
                              <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-800/60 text-[10px]">
                                <span className="px-1.5 py-0.5 rounded bg-slate-850 text-slate-400 font-semibold truncate max-w-[70px]">
                                  {emoji.category || '一般'}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteEmoji(emoji.id, emoji.name)}
                                  className="p-1 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
                                  title="削除"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 🎟 招待コード & 登録モード管理タブ */}
              {adminTab === 'mail' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div>
                    <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                      <Mail className="w-4 h-4 text-sky-400" />
                      <span>メール送信（SMTP）と認証方式</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                      マスターキー復元やメール確認に使う SMTP を設定します。未設定のあいだ、メール関連の機能は自動的に無効になります。
                    </p>
                  </div>

                  <form onSubmit={handleSaveMailSettings} className="space-y-3 bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2">
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">SMTP ホスト</label>
                        <input
                          type="text"
                          value={mailSettings.host}
                          onChange={(e) => setMailSettings((p: any) => ({ ...p, host: e.target.value }))}
                          placeholder="smtp.example.com"
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">ポート</label>
                        <input
                          type="number"
                          value={mailSettings.port}
                          onChange={(e) => setMailSettings((p: any) => ({ ...p, port: parseInt(e.target.value, 10) || 587 }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">ユーザー名（任意）</label>
                        <input
                          type="text"
                          value={mailSettings.user}
                          onChange={(e) => setMailSettings((p: any) => ({ ...p, user: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          パスワード {mailSettings.hasPassword ? '（設定済み・空欄で維持）' : '（任意）'}
                        </label>
                        <input
                          type="password"
                          value={mailSettings.pass}
                          onChange={(e) => setMailSettings((p: any) => ({ ...p, pass: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">差出人アドレス <span className="text-rose-400">*</span></label>
                        <input
                          type="text"
                          value={mailSettings.from}
                          onChange={(e) => setMailSettings((p: any) => ({ ...p, from: e.target.value }))}
                          placeholder="no-reply@example.com"
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                      </div>
                    </div>

                    <label className="flex items-center space-x-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(mailSettings.secure)}
                        onChange={(e) => setMailSettings((p: any) => ({ ...p, secure: e.target.checked }))}
                        className="w-3.5 h-3.5 accent-sky-500 cursor-pointer"
                      />
                      <span>SSL/TLS で接続する（ポート465など。587の場合はOFFのままでSTARTTLSを使います）</span>
                    </label>

                    <div className="pt-2 border-t border-slate-800 space-y-3">
                      <h4 className="font-bold text-xs text-slate-200">認証方式とメール登録</h4>
                      <div className="space-y-2">
                        <label className="flex items-start space-x-2 text-xs text-slate-300 cursor-pointer">
                          <input
                            type="radio"
                            name="authMode"
                            checked={mailSettings.authMode === 'master_key'}
                            onChange={() => setMailSettings((p: any) => ({ ...p, authMode: 'master_key' }))}
                            className="mt-0.5 accent-sky-500 cursor-pointer"
                          />
                          <span>マスターキー方式（パスワードレス・推奨）</span>
                        </label>
                        <label className="flex items-start space-x-2 text-xs text-slate-300 cursor-pointer">
                          <input
                            type="radio"
                            name="authMode"
                            checked={mailSettings.authMode === 'password'}
                            onChange={() => setMailSettings((p: any) => ({ ...p, authMode: 'password' }))}
                            className="mt-0.5 accent-sky-500 cursor-pointer"
                          />
                          <span>
                            メールアドレス＋パスワード方式
                            <span className="block text-[10px] text-slate-500">
                              ※ 新規登録とログインがメールアドレス＋パスワード方式に切り替わります（招待コードや利用規約の同意はそのまま有効です。メール送信が未設定でも登録できます）
                            </span>
                          </span>
                        </label>
                      </div>
                      <label className="flex items-start space-x-2 text-xs text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(mailSettings.allowEmailRegistration)}
                          onChange={(e) => setMailSettings((p: any) => ({ ...p, allowEmailRegistration: e.target.checked }))}
                          className="mt-0.5 w-3.5 h-3.5 accent-sky-500 cursor-pointer"
                        />
                        <span>
                          ユーザーがメールアドレスを登録できるようにする
                          <span className="block text-[10px] text-slate-500">オンにすると、ユーザー設定にメール登録欄が出て、マスターキー復元が使えるようになります</span>
                        </span>
                      </label>
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                      <button
                        type="button"
                        onClick={handleTestMailSettings}
                        disabled={isSavingMail || !mailSettings.host}
                        className="px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-bold rounded-xl border border-slate-700 transition cursor-pointer"
                      >
                        接続テスト
                      </button>
                      <button
                        type="submit"
                        disabled={isSavingMail}
                        className="px-4 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition flex items-center space-x-1.5 cursor-pointer"
                      >
                        {isSavingMail ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                        <span>設定を保存</span>
                      </button>
                    </div>

                    {mailSettingsMsg && (
                      <div className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                        mailSettingsMsg.type === 'success'
                          ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                          : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                      }`}>
                        {mailSettingsMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                        <span>{mailSettingsMsg.text}</span>
                      </div>
                    )}
                  </form>
                </div>
              )}

              {/* 📮 配送再送キュー（ActivityPub 配送の指数バックオフ再送） */}
              {adminTab === 'delivery' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                        <Send className="w-4 h-4 text-emerald-400" />
                        <span>配送キュー（再送待ち / 失敗）</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                        相手サーバーの一時的な障害（ネットワークエラー・5xx・429 など）で失敗した配送を指数バックオフで自動再送します。
                        401/403/404 などの恒久的な失敗は再送しません。最大 {deliveryQueue.maxAttempts ?? 9} 回試行します。
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={fetchDeliveryQueue}
                      disabled={isLoadingDeliveryQueue}
                      className="shrink-0 px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-bold rounded-xl border border-slate-700 transition cursor-pointer flex items-center space-x-1.5"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isLoadingDeliveryQueue ? 'animate-spin text-emerald-400' : ''}`} />
                      <span>更新</span>
                    </button>
                  </div>

                  {/* 統計 */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-3">
                      <p className="text-[11px] text-slate-400">再送待ち</p>
                      <p className="text-xl font-black text-amber-300 mt-0.5">{deliveryQueue.stats?.pending ?? 0}</p>
                    </div>
                    <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-3">
                      <p className="text-[11px] text-slate-400">再送に成功</p>
                      <p className="text-xl font-black text-emerald-300 mt-0.5">{deliveryQueue.stats?.delivered ?? 0}</p>
                    </div>
                    <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-3">
                      <p className="text-[11px] text-slate-400">失敗（確定）</p>
                      <p className="text-xl font-black text-rose-300 mt-0.5">{deliveryQueue.stats?.failed ?? 0}</p>
                    </div>
                  </div>

                  {deliveryQueue.stats?.nextAttemptAt && (
                    <p className="text-[11px] text-slate-400">
                      次回の再送予定:{' '}
                      <span className="font-mono text-slate-200">
                        {new Date(deliveryQueue.stats.nextAttemptAt).toLocaleString('ja-JP')}
                      </span>
                    </p>
                  )}

                  {/* 操作 */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleRetryDeliveries}
                      disabled={isActingOnDelivery || (deliveryQueue.stats?.pending ?? 0) === 0}
                      className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold rounded-xl shadow-md transition cursor-pointer flex items-center space-x-1.5"
                    >
                      {isActingOnDelivery ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      <span>今すぐ再送</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleClearFailedDeliveries}
                      disabled={isActingOnDelivery || (deliveryQueue.stats?.failed ?? 0) === 0}
                      className="px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-bold rounded-xl border border-slate-700 transition cursor-pointer flex items-center space-x-1.5"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>失敗した記録を削除</span>
                    </button>
                  </div>

                  {deliveryQueueMsg && (
                    <div className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                      deliveryQueueMsg.type === 'success'
                        ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                        : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                    }`}>
                      {deliveryQueueMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                      <span>{deliveryQueueMsg.text}</span>
                    </div>
                  )}

                  {/* 再送待ちの一覧 */}
                  <div className="space-y-2">
                    <h4 className="font-bold text-xs text-slate-300">
                      再送待ちの配送 ({deliveryQueue.pending?.length ?? 0})
                    </h4>
                    {(deliveryQueue.pending?.length ?? 0) === 0 ? (
                      <p className="text-xs text-slate-500 bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                        再送待ちの配送はありません。
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {deliveryQueue.pending.map((item: any) => (
                          <div key={item.id} className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3 text-xs space-y-1">
                            <div className="flex items-start justify-between gap-2">
                              <span className="font-bold text-slate-200 break-all">
                                {item.activity_type || 'Activity'} → <span className="font-mono text-slate-300">{item.inbox_url}</span>
                              </span>
                              <span className="shrink-0 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-mono text-[10px]">
                                {item.attempts}回失敗
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-500">
                              次回: {new Date(item.next_attempt_at).toLocaleString('ja-JP')}
                              {item.last_status ? ` / 直近の応答: HTTP ${item.last_status}` : ''}
                            </p>
                            {item.last_error && <p className="text-[11px] text-rose-300/80 break-all">{item.last_error}</p>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 失敗が確定した配送 */}
                  <div className="space-y-2">
                    <h4 className="font-bold text-xs text-slate-300">
                      失敗が確定した配送 ({deliveryQueue.recentFailures?.length ?? 0})
                    </h4>
                    {(deliveryQueue.recentFailures?.length ?? 0) === 0 ? (
                      <p className="text-xs text-slate-500 bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                        失敗が確定した配送はありません。
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {deliveryQueue.recentFailures.map((item: any) => (
                          <div key={item.id} className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3 text-xs space-y-1">
                            <div className="flex items-start justify-between gap-2">
                              <span className="font-bold text-slate-200 break-all">
                                {item.activity_type || 'Activity'} → <span className="font-mono text-slate-300">{item.inbox_url}</span>
                              </span>
                              <span className="shrink-0 px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 font-mono text-[10px]">
                                {item.attempts}回失敗
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-500">
                              最終試行: {new Date(item.updated_at).toLocaleString('ja-JP')}
                              {item.last_status ? ` / 応答: HTTP ${item.last_status}` : ''}
                            </p>
                            {item.last_error && <p className="text-[11px] text-rose-300/80 break-all">{item.last_error}</p>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {adminTab === 'roles' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div>
                    <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                      <UserPlus className="w-4 h-4 text-violet-400" />
                      <span>ロール（権限）管理 ({adminRoles.length})</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                      ロールを作成し、ユーザーごとに付け外しできます。付与された権限は再ログイン不要で即時反映されます。
                      「管理者」権限は管理画面のすべての操作、「モデレーター」は通報対応・凍結・ドメインブロックが対象です。
                    </p>
                  </div>

                  <form onSubmit={handleSaveRole} className="space-y-3 bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2">
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          ロール名 <span className="text-rose-400">*</span>
                        </label>
                        <input
                          type="text"
                          value={newRoleName}
                          onChange={(e) => setNewRoleName(e.target.value)}
                          maxLength={40}
                          placeholder="例: モデレーター"
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-violet-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">表示色</label>
                        <input
                          type="color"
                          value={newRoleColor}
                          onChange={(e) => setNewRoleColor(e.target.value)}
                          className="w-full h-9 bg-slate-900 border border-slate-800 rounded-xl cursor-pointer"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                        権限 <span className="text-rose-400">*</span>
                      </label>
                      <div className="space-y-1.5">
                        {availablePermissions.map((perm) => (
                          <label key={perm.key} className="flex items-start space-x-2 cursor-pointer text-xs text-slate-300">
                            <input
                              type="checkbox"
                              checked={newRolePermissions.includes(perm.key)}
                              onChange={(e) => {
                                setNewRolePermissions((prev) =>
                                  e.target.checked ? [...prev, perm.key] : prev.filter((p) => p !== perm.key),
                                );
                              }}
                              className="mt-0.5 w-3.5 h-3.5 accent-violet-500 cursor-pointer"
                            />
                            <span>{perm.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center justify-end space-x-2">
                      {editingRoleId && (
                        <button
                          type="button"
                          onClick={() => { setEditingRoleId(null); setNewRoleName(''); setNewRolePermissions([]); }}
                          className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-xl transition cursor-pointer"
                        >
                          新規作成に切り替え
                        </button>
                      )}
                      <button
                        type="submit"
                        disabled={!newRoleName.trim() || newRolePermissions.length === 0}
                        className="px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition flex items-center space-x-1.5 cursor-pointer"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>{editingRoleId ? 'ロールを更新' : 'ロールを作成'}</span>
                      </button>
                    </div>
                  </form>

                  {roleActionMsg && (
                    <div
                      className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                        roleActionMsg.type === 'success'
                          ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                          : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                      }`}
                    >
                      {roleActionMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                      <span>{roleActionMsg.text}</span>
                    </div>
                  )}

                  {/* ロール一覧 */}
                  {adminRoles.length === 0 ? (
                    <div className="p-6 text-center bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                      まだロールがありません。上のフォームから作成してください。
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {adminRoles.map((role) => (
                        <div key={role.id} className="flex flex-wrap items-center justify-between gap-2 bg-slate-950/50 border border-slate-800 rounded-2xl px-3.5 py-2.5">
                          <div className="flex items-center space-x-2 min-w-0">
                            <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: role.color || '#6366f1' }} />
                            <span className="font-bold text-xs text-slate-100 truncate">{role.name}</span>
                            <span className="text-[10px] text-slate-500 font-mono">{role.member_count} 人</span>
                            <span className="text-[10px] text-slate-400 truncate">
                              {String(role.permissions || '')
                                .split(',')
                                .filter(Boolean)
                                .map((p: string) => availablePermissions.find((ap) => ap.key === p)?.label || p)
                                .join(' / ')}
                            </span>
                          </div>
                          <div className="flex items-center space-x-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleEditRole(role)}
                              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold transition cursor-pointer"
                            >
                              編集
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteRole(role.id)}
                              className="px-3 py-1.5 bg-rose-600/80 hover:bg-rose-600 text-white rounded-lg text-xs font-bold transition cursor-pointer"
                            >
                              削除
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ユーザーへのロール付与 */}
                  <div className="space-y-2 pt-2 border-t border-slate-800">
                    <h4 className="font-bold text-sm text-slate-100">ユーザーへの付与</h4>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      チップをクリックするとロールを付け外しできます（即時反映）。
                    </p>
                    {adminUsers.length === 0 ? (
                      <div className="p-4 text-center bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                        ユーザーがいません。
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {adminUsers.map((user: any) => {
                          const userRoleIds: string[] = (user.roles || []).map((r: any) => r.id);
                          return (
                            <div key={user.id} className="bg-slate-950/50 border border-slate-800 rounded-2xl px-3.5 py-3 space-y-2">
                              <div className="flex items-center space-x-2">
                                <span className="font-bold text-xs text-slate-100">@{user.id}</span>
                                {user.role === 'admin' && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 font-bold">
                                    管理者
                                  </span>
                                )}
                                {user.is_frozen === 1 && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-bold">凍結中</span>
                                )}
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {adminRoles.map((role) => {
                                  const active = userRoleIds.includes(role.id);
                                  return (
                                    <button
                                      key={role.id}
                                      type="button"
                                      onClick={() => handleToggleUserRole(user.id, role.id)}
                                      className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition cursor-pointer ${
                                        active
                                          ? 'text-white border-transparent'
                                          : 'bg-slate-900 text-slate-400 border-slate-800 hover:bg-slate-800'
                                      }`}
                                      style={active ? { backgroundColor: role.color || '#6366f1' } : undefined}
                                    >
                                      {role.name}
                                    </button>
                                  );
                                })}
                                {adminRoles.length === 0 && <span className="text-[11px] text-slate-500">ロール未作成</span>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {adminTab === 'announcements' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div>
                    <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                      <Megaphone className="w-4 h-4 text-amber-400" />
                      <span>お知らせ ({adminAnnouncements.length})</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                      サーバーからの一斉告知です。有効なお知らせは全ユーザーのタイムライン上部に表示されます。メンテナンス予定や運営からの連絡にご利用ください。
                    </p>
                  </div>

                  <form onSubmit={handleCreateAnnouncement} className="space-y-3 bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                        タイトル <span className="text-rose-400">*</span>
                      </label>
                      <input
                        type="text"
                        value={newAnnouncementTitle}
                        onChange={(e) => setNewAnnouncementTitle(e.target.value)}
                        maxLength={120}
                        placeholder="例: サーバーメンテナンスのお知らせ"
                        className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-amber-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                        本文 <span className="text-rose-400">*</span>
                      </label>
                      <textarea
                        value={newAnnouncementContent}
                        onChange={(e) => setNewAnnouncementContent(e.target.value)}
                        rows={3}
                        maxLength={5000}
                        placeholder="例: 9/25 3:00〜5:00 の間、メンテナンスのため停止します。"
                        className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-amber-500 focus:outline-none resize-none"
                      />
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="submit"
                        disabled={isSavingAnnouncement || !newAnnouncementTitle.trim() || !newAnnouncementContent.trim()}
                        className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition flex items-center space-x-1.5 cursor-pointer"
                      >
                        {isSavingAnnouncement ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Megaphone className="w-3.5 h-3.5" />}
                        <span>お知らせを投稿</span>
                      </button>
                    </div>
                  </form>

                  {announcementMsg && (
                    <div
                      className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                        announcementMsg.type === 'success'
                          ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                          : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                      }`}
                    >
                      {announcementMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                      <span>{announcementMsg.text}</span>
                    </div>
                  )}

                  {adminAnnouncements.length === 0 ? (
                    <div className="p-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800/60">
                      <Megaphone className="w-10 h-10 mx-auto text-slate-600 mb-2" />
                      <p className="text-xs text-slate-400 font-bold">まだお知らせがありません</p>
                      <p className="text-[11px] text-slate-500 mt-1">上のフォームから投稿できます。</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {adminAnnouncements.map((a) => (
                        <div key={a.id} className="bg-slate-950/50 border border-slate-800 rounded-2xl p-4 space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center space-x-2 min-w-0">
                              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                                a.is_active === 1 ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'bg-slate-800 text-slate-400 border border-slate-700'
                              }`}>
                                {a.is_active === 1 ? '公開中' : '非公開'}
                              </span>
                              <span className="font-bold text-xs text-slate-100 truncate">{a.title}</span>
                            </div>
                            <span className="text-[10px] text-slate-500 font-mono shrink-0">
                              {new Date(a.created_at).toLocaleString('ja-JP')}
                            </span>
                          </div>
                          <p className="text-xs text-slate-300 whitespace-pre-wrap break-words bg-slate-900/60 rounded-xl p-3 border border-slate-800">
                            {a.content}
                          </p>
                          <div className="flex items-center justify-end space-x-2">
                            <button
                              type="button"
                              onClick={() => handleToggleAnnouncement(a.id, a.is_active !== 1)}
                              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold transition cursor-pointer"
                            >
                              {a.is_active === 1 ? '非公開にする' : '公開する'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteAnnouncement(a.id)}
                              className="px-3 py-1.5 bg-rose-600/80 hover:bg-rose-600 text-white rounded-lg text-xs font-bold transition cursor-pointer flex items-center space-x-1"
                            >
                              <Trash2 className="w-3 h-3" />
                              <span>削除</span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {adminTab === 'reports' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                        <ShieldAlert className="w-4 h-4 text-rose-400" />
                        <span>通報の対応（未対応 {adminReportCounts.open} 件 / 全 {adminReportCounts.total} 件）</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                        ユーザーおよび他サーバーから届いた通報の一覧です。内容を確認し、必要に応じて対象アカウントの凍結やドメインブロックを行ってください。
                        他サーバーのユーザーを通報した場合は、相手サーバーへ Flag として転送されます。
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => fetchReports(reportStatusFilter)}
                      className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-xl border border-slate-700 transition flex items-center space-x-1.5 cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>更新</span>
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {([['open', '未対応'], ['all', 'すべて'], ['resolved', '対応済み'], ['rejected', '却下']] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => { setReportStatusFilter(value); fetchReports(value); }}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition cursor-pointer ${
                          reportStatusFilter === value
                            ? 'bg-indigo-600 border-indigo-500 text-white'
                            : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800/60'
                        }`}
                      >
                        {label}
                        {value === 'open' && adminReportCounts.open > 0 ? ` (${adminReportCounts.open})` : ''}
                      </button>
                    ))}
                  </div>

                  {reportActionMsg && (
                    <div
                      className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                        reportActionMsg.type === 'success'
                          ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                          : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                      }`}
                    >
                      {reportActionMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                      <span>{reportActionMsg.text}</span>
                    </div>
                  )}

                  {(() => {
                    const shown = reportStatusFilter === 'all'
                      ? adminReports
                      : adminReports.filter((r) => r.status === reportStatusFilter);

                    if (shown.length === 0) {
                      return (
                        <div className="p-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800/60">
                          <ShieldAlert className="w-10 h-10 mx-auto text-slate-600 mb-2" />
                          <p className="text-xs text-slate-400 font-bold">該当する通報はありません</p>
                          <p className="text-[11px] text-slate-500 mt-1">新しい通報が届くとここに表示されます。</p>
                        </div>
                      );
                    }

                    return shown.map((r) => {
                      const statusStyle =
                        r.status === 'open'
                          ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                          : r.status === 'resolved'
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            : 'bg-slate-800 text-slate-400 border border-slate-700';
                      const statusLabel = r.status === 'open' ? '未対応' : r.status === 'resolved' ? '対応済み' : '却下';

                      return (
                        <div key={r.id} className="bg-slate-950/50 border border-slate-800 rounded-2xl p-4 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${statusStyle}`}>{statusLabel}</span>
                              <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-slate-800 text-slate-300">
                                {REPORT_CATEGORY_LABELS[r.category] || r.category}
                              </span>
                              {r.is_remote === 1 && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">他サーバーから</span>
                              )}
                              {r.forwarded === 1 && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-slate-800 text-slate-400">Flag転送済</span>
                              )}
                            </div>
                            <span className="text-[10px] text-slate-500 font-mono">
                              {new Date(r.created_at).toLocaleString('ja-JP')}
                            </span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                            <div className="bg-slate-900/60 rounded-xl p-3 border border-slate-800">
                              <span className="text-[10px] text-slate-500 font-bold block mb-1">通報者</span>
                              <span className="text-slate-200 break-all">{r.reporter_handle || r.reporter_actor_url}</span>
                            </div>
                            <div className="bg-slate-900/60 rounded-xl p-3 border border-slate-800">
                              <span className="text-[10px] text-slate-500 font-bold block mb-1">対象</span>
                              <span className="text-slate-200 break-all">
                                {r.target_handle || r.target_actor_url}
                                {r.target_post_id ? ' の投稿' : ''}
                              </span>
                            </div>
                          </div>

                          {r.comment && (
                            <p className="text-xs text-slate-300 bg-slate-900/60 rounded-xl p-3 border border-slate-800 whitespace-pre-wrap break-words">
                              {r.comment}
                            </p>
                          )}
                          {r.target_post_content && (
                            <p className="text-[11px] text-slate-400 bg-slate-900/40 rounded-xl p-3 border border-slate-800/60 whitespace-pre-wrap break-words">
                              対象投稿: {r.target_post_content}
                            </p>
                          )}
                          {r.resolution_note && (
                            <p className="text-[11px] text-emerald-300/80 bg-emerald-500/5 rounded-xl p-3 border border-emerald-500/20 whitespace-pre-wrap break-words">
                              対応メモ: {r.resolution_note}
                            </p>
                          )}

                          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                            {r.target_user_id && (
                              <button
                                type="button"
                                onClick={() => { setAdminUserSearch(r.target_user_id); setAdminTab('users'); }}
                                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold transition cursor-pointer"
                              >
                                対象ユーザーを管理
                              </button>
                            )}
                            {r.status !== 'open' && (
                              <button
                                type="button"
                                disabled={isUpdatingReport === r.id}
                                onClick={() => handleResolveReport(r.id, 'reopen')}
                                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg text-xs font-semibold transition disabled:opacity-50 cursor-pointer"
                              >
                                再オープン
                              </button>
                            )}
                            {r.status === 'open' && (
                              <>
                                <button
                                  type="button"
                                  disabled={isUpdatingReport === r.id}
                                  onClick={() => handleResolveReport(r.id, 'reject')}
                                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg text-xs font-semibold transition disabled:opacity-50 cursor-pointer"
                                >
                                  却下
                                </button>
                                <button
                                  type="button"
                                  disabled={isUpdatingReport === r.id}
                                  onClick={() => handleResolveReport(r.id, 'resolve')}
                                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold shadow-md transition disabled:opacity-50 cursor-pointer flex items-center space-x-1"
                                >
                                  {isUpdatingReport === r.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                                  <span>対応済みにする</span>
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}

              {adminTab === 'invites' && (
                <div className="space-y-6">
                  {/* ヘッダーカード */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-2">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-2xl bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                        <Ticket className="w-5 h-5" />
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-slate-100">招待コード ＆ 登録モード管理</h2>
                        <p className="text-xs text-slate-400">
                          サーバーの登録モードを切り替えたり、招待リンク・コードを発行してクローズドなコミュニティを運営できます。
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* 登録モード切り替えカード */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-2">
                        <Lock className="w-4 h-4 text-indigo-400" />
                        <span>サーバー新規登録ポリシー</span>
                      </h3>
                      {isUpdatingRegMode && (
                        <div className="flex items-center space-x-1 text-xs text-indigo-400">
                          <RefreshCw className="w-3 h-3 animate-spin" />
                          <span>更新中...</span>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {/* オープン */}
                      <button
                        type="button"
                        onClick={() => handleChangeRegistrationMode('open')}
                        disabled={isUpdatingRegMode}
                        className={`p-4 rounded-2xl border text-left transition cursor-pointer ${
                          serverStats?.registration_mode === 'open'
                            ? 'bg-emerald-500/15 border-emerald-500/60 shadow-lg shadow-emerald-500/10'
                            : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center space-x-2 mb-1.5">
                          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                          <span className="text-xs font-black text-slate-100">🟢 自由登録 (オープン)</span>
                        </div>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          誰でも自由にアカウントを作成できます。一般的なパブリックサーバー向けの設定です。
                        </p>
                      </button>

                      {/* 招待制 */}
                      <button
                        type="button"
                        onClick={() => handleChangeRegistrationMode('invite')}
                        disabled={isUpdatingRegMode}
                        className={`p-4 rounded-2xl border text-left transition cursor-pointer ${
                          serverStats?.registration_mode === 'invite'
                            ? 'bg-amber-500/15 border-amber-500/60 shadow-lg shadow-amber-500/10'
                            : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center space-x-2 mb-1.5">
                          <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                          <span className="text-xs font-black text-slate-100">🟡 招待制 (コード必須)</span>
                        </div>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          有効な招待コードを持つ人のみ登録できます。身内やコミュニティ限定運用、スパム対策に最適です。
                        </p>
                      </button>

                      {/* 受付停止 */}
                      <button
                        type="button"
                        onClick={() => handleChangeRegistrationMode('closed')}
                        disabled={isUpdatingRegMode}
                        className={`p-4 rounded-2xl border text-left transition cursor-pointer ${
                          serverStats?.registration_mode === 'closed'
                            ? 'bg-rose-500/15 border-rose-500/60 shadow-lg shadow-rose-500/10'
                            : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center space-x-2 mb-1.5">
                          <span className="w-2.5 h-2.5 rounded-full bg-rose-400" />
                          <span className="text-xs font-black text-slate-100">🔴 新規登録一時停止</span>
                        </div>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          招待コードを含め、すべての新規アカウント登録を拒否します。メンテナンス時や閉鎖運用時に使用します。
                        </p>
                      </button>
                    </div>
                  </div>

                  {/* 招待コード新規発行カード */}
                  <form onSubmit={handleCreateInvitation} className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
                    <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-2">
                      <Ticket className="w-4 h-4 text-cyan-400" />
                      <span>新規招待コードを発行</span>
                    </h3>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-xs font-bold text-slate-300 mb-1">
                          最大使用可能回数
                        </label>
                        <select
                          value={newInviteMaxUses}
                          onChange={(e) => setNewInviteMaxUses(parseInt(e.target.value, 10))}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        >
                          <option value={1}>1回のみ (個人用・使い捨て)</option>
                          <option value={5}>5回まで</option>
                          <option value={10}>10回まで</option>
                          <option value={50}>50回まで</option>
                          <option value={1000000}>無制限 (何人でも登録可)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-300 mb-1">
                          有効期限
                        </label>
                        <select
                          value={newInviteExpiresDays}
                          onChange={(e) => setNewInviteExpiresDays(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        >
                          <option value="1">1日間 (24時間)</option>
                          <option value="3">3日間</option>
                          <option value="7">7日間 (1週間)</option>
                          <option value="30">30日間 (約1ヶ月)</option>
                          <option value="infinite">無期限 (期限なし)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-300 mb-1">
                          管理用メモ (任意)
                        </label>
                        <input
                          type="text"
                          placeholder="例: 友人Alice用, Discord配布用"
                          value={newInviteMemo}
                          onChange={(e) => setNewInviteMemo(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-slate-800/80">
                      <p className="text-[11px] text-slate-500">
                        ※ 発行されたコードは招待リンクとしてワンクリックでコピーできます。
                      </p>
                      <button
                        type="submit"
                        disabled={isCreatingInvite}
                        className="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-lg shadow-cyan-600/30 transition flex items-center space-x-1.5 cursor-pointer shrink-0"
                      >
                        {isCreatingInvite ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Plus className="w-3.5 h-3.5" />
                        )}
                        <span>{isCreatingInvite ? '発行中...' : '招待コードを発行'}</span>
                      </button>
                    </div>

                    {/* 通知メッセージ */}
                    {inviteActionMsg && (
                      <div
                        className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                          inviteActionMsg.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}
                      >
                        {inviteActionMsg.type === 'success' ? (
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 shrink-0" />
                        )}
                        <span>{inviteActionMsg.text}</span>
                      </div>
                    )}
                  </form>

                  {/* 発行済み招待コード一覧 */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-2">
                        <Ticket className="w-4 h-4 text-indigo-400" />
                        <span>発行済み招待コード ({adminInvitations.length}件)</span>
                      </h3>
                      <button
                        type="button"
                        onClick={fetchAdminData}
                        className="p-1.5 text-slate-400 hover:text-slate-200 rounded-xl hover:bg-slate-800 transition text-xs flex items-center space-x-1"
                        title="一覧を更新"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>更新</span>
                      </button>
                    </div>

                    {adminInvitations.length === 0 ? (
                      <div className="p-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800/60">
                        <Ticket className="w-10 h-10 mx-auto text-slate-600 mb-2" />
                        <p className="text-xs text-slate-400 font-bold">まだ招待コードが発行されていません</p>
                        <p className="text-[11px] text-slate-500 mt-1">
                          上のフォームから招待コードを発行して、新メンバーを招待してみましょう。
                        </p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs border-collapse">
                          <thead>
                            <tr className="border-b border-slate-800 text-slate-400 text-[11px]">
                              <th className="py-2.5 px-3 font-semibold">招待コード / 招待URL</th>
                              <th className="py-2.5 px-3 font-semibold">使用状況</th>
                              <th className="py-2.5 px-3 font-semibold">有効期限</th>
                              <th className="py-2.5 px-3 font-semibold">用途メモ</th>
                              <th className="py-2.5 px-3 font-semibold">発行日</th>
                              <th className="py-2.5 px-3 font-semibold text-right">操作</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/60">
                            {adminInvitations.map((inv) => {
                              const isExpired = inv.expires_at && new Date(inv.expires_at) < new Date();
                              const isUsedUp = inv.max_uses > 0 && inv.used_count >= inv.max_uses;
                              const inviteUrl = `${window.location.origin}/?invite=${encodeURIComponent(inv.code)}`;

                              return (
                                <tr key={inv.code} className="hover:bg-slate-800/30 transition">
                                  <td className="py-3 px-3">
                                    <div className="flex items-center space-x-2">
                                      <span className="font-mono font-bold text-cyan-300 bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800">
                                        {inv.code}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          navigator.clipboard.writeText(inviteUrl);
                                          alert(`招待リンクをコピーしました！\n${inviteUrl}`);
                                        }}
                                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                                        title="招待リンクをコピー"
                                      >
                                        <Copy className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  </td>
                                  <td className="py-3 px-3">
                                    <div className="flex items-center space-x-1.5">
                                      <span className={`font-mono font-bold ${isUsedUp ? 'text-rose-400' : 'text-slate-200'}`}>
                                        {inv.used_count}
                                      </span>
                                      <span className="text-slate-500 font-mono">/</span>
                                      <span className="text-slate-400 font-mono">
                                        {inv.max_uses > 100000 ? '無制限' : inv.max_uses}
                                      </span>
                                      {isUsedUp && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 ml-1">
                                          上限到達
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="py-3 px-3">
                                    {inv.expires_at ? (
                                      <span className={`text-[11px] ${isExpired ? 'text-rose-400 line-through' : 'text-slate-300'}`}>
                                        {new Date(inv.expires_at).toLocaleString('ja-JP', {
                                          month: 'numeric',
                                          day: 'numeric',
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })}
                                      </span>
                                    ) : (
                                      <span className="text-[11px] text-emerald-400">無期限</span>
                                    )}
                                  </td>
                                  <td className="py-3 px-3 text-slate-300 max-w-xs truncate">
                                    {inv.memo || <span className="text-slate-500 italic">-</span>}
                                  </td>
                                  <td className="py-3 px-3 text-[11px] text-slate-500 font-mono">
                                    {new Date(inv.created_at).toLocaleDateString('ja-JP')}
                                  </td>
                                  <td className="py-3 px-3 text-right">
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteInvitation(inv.code)}
                                      className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
                                      title="招待コードを削除 / 無効化"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
      ) : currentView === 'settings' ? (
        /* ユーザー向け設定画面 (Settings View) */
        <main className="max-w-5xl mx-auto px-4 py-6 w-full flex-1 space-y-6">
          {/* 戻るボタン & タイトルヘッダー */}
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div className="flex items-center space-x-3">
              <button
                onClick={() => navigateToView('timeline')}
                className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 transition"
                title="タイムラインに戻る"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div>
                <h2 className="text-xl font-black text-slate-100 flex items-center space-x-2">
                  <Settings className="w-5 h-5 text-indigo-400" />
                  <span>ユーザー設定</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  アカウント情報、プロフィール、投稿公開範囲、環境設定
                </p>
              </div>
            </div>
          </div>

          {/* メッセージトースト */}
          {settingsMessage && (
            <div
              className={`p-3.5 rounded-2xl text-xs font-semibold flex items-center space-x-2 shadow-lg ${
                settingsMessage.type === 'success'
                  ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                  : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
              }`}
            >
              {settingsMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
              )}
              <span>{settingsMessage.text}</span>
            </div>
          )}

          {/* 設定タブナビゲーション & コンテンツ */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {/* 左側: タブ一覧 */}
            <div className="md:col-span-1 space-y-1.5 bg-slate-900/70 p-2.5 rounded-2xl border border-slate-800/80 h-fit">
              <button
                onClick={() => { setSettingsTab('profile'); setSettingsMessage(null); }}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold transition flex items-center space-x-2.5 ${
                  settingsTab === 'profile'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <User className="w-4 h-4" />
                <span>プロフィール</span>
              </button>

              <button
                onClick={() => { setSettingsTab('preferences'); setSettingsMessage(null); }}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold transition flex items-center space-x-2.5 ${
                  settingsTab === 'preferences'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Sliders className="w-4 h-4" />
                <span>投稿・表示設定</span>
              </button>

              <button
                onClick={() => { setSettingsTab('account'); setSettingsMessage(null); }}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold transition flex items-center space-x-2.5 ${
                  settingsTab === 'account'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Globe className="w-4 h-4" />
                <span>アカウント・連合</span>
              </button>

              <button
                onClick={() => {
                  setSettingsTab('mutes_blocks');
                  setSettingsMessage(null);
                  fetchBlocksAndMutes();
                }}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold transition flex items-center space-x-2.5 cursor-pointer ${
                  settingsTab === 'mutes_blocks'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Ban className="w-4 h-4" />
                <span>ミュートとブロック</span>
              </button>

              <button
                onClick={() => { setSettingsTab('session'); setSettingsMessage(null); }}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold transition flex items-center space-x-2.5 ${
                  settingsTab === 'session'
                    ? 'bg-rose-600 text-white shadow-md shadow-rose-600/25'
                    : 'text-rose-400/80 hover:text-rose-300 hover:bg-rose-950/20'
                }`}
              >
                <LogOut className="w-4 h-4" />
                <span>セッション・ログアウト</span>
              </button>
            </div>

            {/* 右側: タブコンテンツ */}
            <div className="md:col-span-3 bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl">
              {settingsTab === 'profile' ? (
                /* 👤 プロフィール設定 */
                <form onSubmit={handleSaveProfile} className="space-y-5">
                  <div className="border-b border-slate-800 pb-3">
                    <h3 className="text-base font-bold text-slate-100 flex items-center space-x-2">
                      <User className="w-4 h-4 text-indigo-400" />
                      <span>プロフィール設定</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      タイムラインや連合相手（Mastodon / Misskey）に表示されるあなたの名前やアイコンを変更します。
                    </p>
                  </div>

                  {/* プレビュー表示 */}
                  <div className="rounded-2xl border border-slate-800 overflow-hidden bg-slate-900/90 shadow-xl">
                    <div className="h-32 sm:h-36 relative bg-gradient-to-r from-indigo-950 via-slate-900 to-purple-950 overflow-hidden">
                      {editBannerUrl ? (
                        <img
                          src={editBannerUrl}
                          alt="Banner Preview"
                          className="w-full h-full object-cover"
                          onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
                        />
                      ) : (
                        <div className="w-full h-full opacity-30 bg-[radial-gradient(#4f46e5_1px,transparent_1px)] [background-size:16px_16px]" />
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 to-transparent" />
                    </div>
                    <div className="px-5 pb-5 pt-1 relative bg-slate-900/95">
                      <div className="flex items-end space-x-3.5 -mt-10 relative z-10">
                        <div className="w-16 h-16 rounded-2xl p-1 bg-slate-900 border-2 border-slate-700/80 shadow-2xl shrink-0 overflow-hidden">
                          {editIconUrl ? (
                            <img
                              src={editIconUrl}
                              alt="Avatar Preview"
                              className="w-full h-full rounded-xl object-cover"
                              onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
                            />
                          ) : (
                            <div className="w-full h-full rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-xl text-white">
                              {(editName || authUser?.name || 'A').slice(0, 1).toUpperCase()}
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 pb-1 flex-1">
                          <span className="font-bold text-sm text-slate-100 block truncate">
                            {editName || authUser?.name || '表示名'}
                          </span>
                          <span className="text-xs font-mono text-indigo-400 block truncate">
                            {authUser?.handle}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 表示名 */}
                  <div>
                    <label className="block text-xs font-bold text-slate-300 mb-1.5">
                      表示名 <span className="text-rose-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      required
                      placeholder="例: Alice In Borderland"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                    />
                  </div>

                  {/* アイコン画像 (アバター) */}
                  <div>
                    <label className="block text-xs font-bold text-slate-300 mb-1.5">
                      アイコン画像 (アバター)
                    </label>
                    <div className="flex flex-col sm:flex-row gap-2.5 items-start sm:items-center">
                      <label
                        className={`cursor-pointer px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 text-xs font-bold flex items-center space-x-1.5 transition shrink-0 ${
                          isUploadingIcon ? 'opacity-50 pointer-events-none' : ''
                        }`}
                      >
                        {isUploadingIcon ? (
                          <RefreshCw className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                        ) : (
                          <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
                        )}
                        <span>{isUploadingIcon ? '最適化・保存中...' : '画像をアップロード'}</span>
                        <input
                          type="file"
                          accept="image/*"
                          disabled={isUploadingIcon}
                          onChange={(e) => {
                            handleUploadAvatar(e.target.files);
                            e.target.value = '';
                          }}
                          className="hidden"
                        />
                      </label>
                      <input
                        type="url"
                        value={editIconUrl}
                        onChange={(e) => setEditIconUrl(e.target.value)}
                        placeholder="または画像URLを直接入力 (https://...)"
                        className="w-full sm:flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition font-mono"
                      />
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      端末から画像を直接アップロードするか、外部画像URLを指定できます（長辺800pxに自動最適化されます）。
                    </p>
                  </div>

                  {/* ヘッダー画像 URL */}
                  <div>
                    <label className="block text-xs font-bold text-slate-300 mb-1.5">
                      ヘッダーバナー画像
                    </label>
                    <div className="flex flex-col sm:flex-row gap-2.5 items-start sm:items-center">
                      <label
                        className={`cursor-pointer px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 text-xs font-bold flex items-center space-x-1.5 transition shrink-0 ${
                          isUploadingBanner ? 'opacity-50 pointer-events-none' : ''
                        }`}
                      >
                        {isUploadingBanner ? (
                          <RefreshCw className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                        ) : (
                          <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
                        )}
                        <span>{isUploadingBanner ? '最適化・保存中...' : '画像をアップロード'}</span>
                        <input
                          type="file"
                          accept="image/*"
                          disabled={isUploadingBanner}
                          onChange={(e) => {
                            handleUploadBanner(e.target.files);
                            e.target.value = '';
                          }}
                          className="hidden"
                        />
                      </label>
                      <input
                        type="url"
                        value={editBannerUrl}
                        onChange={(e) => setEditBannerUrl(e.target.value)}
                        placeholder="または画像URLを直接入力 (https://...)"
                        className="w-full sm:flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition font-mono"
                      />
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      プロフィールのヘッダー背景画像です（横長・推奨比率 3:1）。
                    </p>
                  </div>

                  {/* 自己紹介 (Bio) */}
                  <div>
                    <label className="block text-xs font-bold text-slate-300 mb-1.5">
                      自己紹介 (Bio)
                    </label>
                    <textarea
                      value={editBio}
                      onChange={(e) => setEditBio(e.target.value)}
                      rows={3}
                      placeholder="自己紹介を入力してください..."
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition resize-none leading-relaxed"
                    />
                  </div>

                  {/* 🔗 プロフィール項目（リンク集など） */}
                  <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-xs text-slate-100">🔗 プロフィール項目（最大4件）</span>
                      {editFields.length < 4 && (
                        <button
                          type="button"
                          onClick={() => setEditFields((prev) => [...prev, { name: '', value: '' }])}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-[11px] font-semibold transition cursor-pointer"
                        >
                          ＋ 追加
                        </button>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      リンク集や肩書きなど。連合先（Mastodon / Misskey）のプロフィールにも項目として表示されます。
                    </p>
                    {editFields.length === 0 && (
                      <p className="text-[11px] text-slate-500">項目がありません。「＋ 追加」から登録できます。</p>
                    )}
                    {editFields.map((field, index) => (
                      <div key={index} className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          value={field.name}
                          maxLength={40}
                          placeholder="項目名（例: Webサイト）"
                          onChange={(e) => setEditFields((prev) => prev.map((f, i) => (i === index ? { ...f, name: e.target.value } : f)))}
                          className="sm:w-40 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        />
                        <input
                          type="text"
                          value={field.value}
                          maxLength={200}
                          placeholder="内容（例: https://example.com）"
                          onChange={(e) => setEditFields((prev) => prev.map((f, i) => (i === index ? { ...f, value: e.target.value } : f)))}
                          className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => setEditFields((prev) => prev.filter((_, i) => i !== index))}
                          className="px-3 py-2 bg-slate-800 hover:bg-rose-600/80 text-slate-300 hover:text-white rounded-xl text-xs font-bold transition cursor-pointer"
                        >
                          削除
                        </button>
                      </div>
                    ))}
                    <label className="flex items-start space-x-3 cursor-pointer pt-1">
                      <input
                        type="checkbox"
                        checked={profileDiscoverable}
                        onChange={(e) => setProfileDiscoverable(e.target.checked)}
                        className="mt-0.5 w-4 h-4 accent-indigo-500 cursor-pointer"
                      />
                      <div>
                        <span className="font-bold text-xs text-slate-100 block">👥 ユーザーディレクトリに掲載する</span>
                        <span className="text-[11px] text-slate-400 leading-relaxed block mt-0.5">
                          オフにすると、このサーバーのユーザー一覧（ディレクトリ）に表示されなくなります。
                        </span>
                      </div>
                    </label>
                  </div>

                  {/* 🔒 鍵アカウント設定 */}
                  <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4 space-y-2">
                    <label className="flex items-start space-x-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={profileIsLocked}
                        onChange={(e) => setProfileIsLocked(e.target.checked)}
                        className="mt-0.5 w-4 h-4 accent-amber-500 cursor-pointer"
                      />
                      <div>
                        <span className="font-bold text-xs text-slate-100 block">🔒 鍵アカウント（フォロー承認制）</span>
                        <span className="text-[11px] text-slate-400 leading-relaxed block mt-0.5">
                          オンにすると、新しいフォローは自動承認されず「フォローリクエスト」として届きます。
                          承認した相手だけがフォロワーになり、フォロワー限定の投稿が届きます（連合先にも承認制として伝わります）。
                        </span>
                      </div>
                    </label>
                  </div>

                  {/* 保存ボタン */}
                  <div className="pt-2 flex justify-end">
                    <button
                      type="submit"
                      disabled={isSavingProfile}
                      className="px-5 py-2.5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white shadow-lg shadow-indigo-600/30 transition flex items-center space-x-1.5"
                    >
                      {isSavingProfile ? (
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5" />
                      )}
                      <span>{isSavingProfile ? '保存中...' : 'プロフィールを保存'}</span>
                    </button>
                  </div>
                </form>
              ) : settingsTab === 'preferences' ? (
                /* ⚙️ 投稿・表示設定 */
                <form onSubmit={handleSavePreferences} className="space-y-6">
                  <div className="border-b border-slate-800 pb-3">
                    <h3 className="text-base font-bold text-slate-100 flex items-center space-x-2">
                      <Sliders className="w-4 h-4 text-indigo-400" />
                      <span>投稿・表示の環境設定</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      投稿作成時のデフォルト公開範囲や、タイムラインの初期表示を設定します（この端末に保存されます）。
                    </p>
                  </div>

                  {/* 🎨 外観テーマ & アクセントカラー設定 */}
                  <div className="space-y-4 p-4 rounded-2xl bg-slate-950/60 border border-slate-800">
                    <div>
                      <label className="block text-xs font-bold text-slate-200 mb-1 flex items-center space-x-2">
                        <Palette className="w-4 h-4 text-indigo-400" />
                        <span>外観テーマ & カラーテーマ</span>
                      </label>
                      <p className="text-[11px] text-slate-400">
                        お好みの画面モードとアクセントカラーにカスタマイズできます（即時反映されます）。
                      </p>
                    </div>

                    {/* テーマモード (ダーク / 漆黒OLED / ライト) */}
                    <div>
                      <span className="text-[11px] font-bold text-slate-300 block mb-2">画面モード</span>
                      <div className="grid grid-cols-3 gap-2.5">
                        {[
                          { id: 'dark', label: 'コズミック・ダーク', icon: Moon, desc: '標準ダーク' },
                          { id: 'pure_black', label: 'OLED 漆黒モード', icon: Zap, desc: '完全ブラック省電力' },
                          { id: 'light', label: 'ソーラー・ライト', icon: Sun, desc: '明るい白基調' },
                        ].map((m) => {
                          const IconComp = m.icon;
                          const isSelected = themeMode === m.id;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => setThemeMode(m.id as any)}
                              className={`p-3 rounded-xl border text-center transition cursor-pointer flex flex-col items-center justify-center space-y-1 ${
                                isSelected
                                  ? 'bg-indigo-600/20 border-indigo-500 text-white font-bold ring-2 ring-indigo-500/30'
                                  : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                              }`}
                            >
                              <IconComp className={`w-4 h-4 ${isSelected ? 'text-indigo-400' : 'text-slate-400'}`} />
                              <span className="text-xs">{m.label}</span>
                              <span className="text-[10px] text-slate-500">{m.desc}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* アクセントカラー (6色) */}
                    <div>
                      <span className="text-[11px] font-bold text-slate-300 block mb-2">アクセントカラー</span>
                      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                        {[
                          { id: 'indigo', label: 'インディゴ', hex: '#6366f1' },
                          { id: 'cyan', label: 'シアン', hex: '#06b6d4' },
                          { id: 'emerald', label: 'エメラルド', hex: '#10b981' },
                          { id: 'purple', label: 'パープル', hex: '#a855f7' },
                          { id: 'rose', label: 'ローズ', hex: '#f43f5e' },
                          { id: 'amber', label: 'アンバー', hex: '#f59e0b' },
                        ].map((c) => {
                          const isSelected = accentColor === c.id;
                          return (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => setAccentColor(c.id as any)}
                              className={`p-2.5 rounded-xl border flex flex-col items-center space-y-1.5 transition cursor-pointer ${
                                isSelected
                                  ? 'border-white bg-slate-900 ring-2 ring-white/30'
                                  : 'border-slate-800 bg-slate-900/60 hover:bg-slate-800/80'
                              }`}
                            >
                              <div
                                className="w-5 h-5 rounded-full shadow"
                                style={{ backgroundColor: c.hex }}
                              />
                              <span className="text-[10px] font-bold text-slate-300">{c.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* デフォルト投稿公開範囲 */}
                  <div className="space-y-2.5">
                    <label className="block text-xs font-bold text-slate-300">
                      デフォルトの投稿公開範囲
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setDefaultVisibility('public')}
                        className={`p-3.5 rounded-2xl border text-left transition flex items-start space-x-3 ${
                          defaultVisibility === 'public'
                            ? 'bg-indigo-600/15 border-indigo-500/60 ring-2 ring-indigo-500/30 text-white'
                            : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800/40'
                        }`}
                      >
                        <Globe className={`w-4 h-4 mt-0.5 shrink-0 ${defaultVisibility === 'public' ? 'text-indigo-400' : 'text-slate-400'}`} />
                        <div>
                          <span className="font-bold text-xs block">🌐 グローバル (連合配信)</span>
                          <span className="text-[11px] text-slate-400 mt-0.5 block leading-relaxed">
                            世界中のActivityPubサーバーや接続リレーへ配信されます。
                          </span>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setDefaultVisibility('local')}
                        className={`p-3.5 rounded-2xl border text-left transition flex items-start space-x-3 ${
                          defaultVisibility === 'local'
                            ? 'bg-emerald-600/15 border-emerald-500/60 ring-2 ring-emerald-500/30 text-white'
                            : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800/40'
                        }`}
                      >
                        <Server className={`w-4 h-4 mt-0.5 shrink-0 ${defaultVisibility === 'local' ? 'text-emerald-400' : 'text-slate-400'}`} />
                        <div>
                          <span className="font-bold text-xs block">🏠 ローカル限定</span>
                          <span className="text-[11px] text-slate-400 mt-0.5 block leading-relaxed">
                            このノード内のみに留め、外部サーバーには配信しません。
                          </span>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setDefaultVisibility('followers')}
                        className={`p-3.5 rounded-2xl border text-left transition flex items-start space-x-3 ${
                          defaultVisibility === 'followers'
                            ? 'bg-amber-600/15 border-amber-500/60 ring-2 ring-amber-500/30 text-white'
                            : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800/40'
                        }`}
                      >
                        <Users className={`w-4 h-4 mt-0.5 shrink-0 ${defaultVisibility === 'followers' ? 'text-amber-400' : 'text-slate-400'}`} />
                        <div>
                          <span className="font-bold text-xs block">🔒 フォロワー限定</span>
                          <span className="text-[11px] text-slate-400 mt-0.5 block leading-relaxed">
                            あなたのフォロワーだけが閲覧できます（連合先のフォロワーにも届きます）。
                          </span>
                        </div>
                      </button>
                    </div>
                  </div>

                  {/* デフォルトタイムライン */}
                  <div className="space-y-2.5">
                    <label className="block text-xs font-bold text-slate-300">
                      タイムラインの初期表示タブ
                    </label>
                    <div className="grid grid-cols-3 gap-2.5">
                      {[
                        { id: 'local', label: '🏠 ローカル', desc: '自サーバーのみ' },
                        { id: 'home', label: '👥 ホーム', desc: 'フォロー中のみ' },
                        { id: 'all', label: '🌐 連合', desc: 'リレー含む全件' },
                      ].map((tl) => (
                        <button
                          key={tl.id}
                          type="button"
                          onClick={() => setDefaultTimeline(tl.id as any)}
                          className={`p-3 rounded-xl border text-center transition ${
                            defaultTimeline === tl.id
                              ? 'bg-indigo-600/20 border-indigo-500 text-white font-bold'
                              : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-800/40'
                          }`}
                        >
                          <span className="text-xs block">{tl.label}</span>
                          <span className="text-[10px] text-slate-500 block mt-0.5">{tl.desc}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* カスタム絵文字表示 */}
                  <div className="space-y-2.5 pt-2 border-t border-slate-800">
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="block text-xs font-bold text-slate-300">
                          カスタム絵文字の画像置換表示
                        </label>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          Misskey / Mastodon から送られてくるカスタム絵文字（例: :ohayo:）を画像として表示します。
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowCustomEmojis(!showCustomEmojis)}
                        className={`w-12 h-6 rounded-full transition p-1 flex items-center shrink-0 cursor-pointer ${
                          showCustomEmojis ? 'bg-indigo-600 justify-end' : 'bg-slate-800 justify-start'
                        }`}
                      >
                        <div className="w-4 h-4 rounded-full bg-white shadow-md" />
                      </button>
                    </div>
                  </div>

                  {/* ⚡ 画像の自動圧縮 (Misskey互換) */}
                  <div className="space-y-2.5 pt-2 border-t border-slate-800">
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="block text-xs font-bold text-slate-300 flex items-center space-x-1.5">
                          <Zap className="w-3.5 h-3.5 text-amber-400" />
                          <span>画像を自動圧縮してアップロード (推奨)</span>
                        </label>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          投稿前にブラウザ上で長辺最大 2048px にリサイズ＆WebP圧縮し、アップロード時間と通信量を大幅に削減します（アニメGIFは保護されます）。
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const next = !autoCompressImages;
                          setAutoCompressImages(next);
                          localStorage.setItem('spica_auto_compress', String(next));
                        }}
                        className={`w-12 h-6 rounded-full transition p-1 flex items-center shrink-0 cursor-pointer ${
                          autoCompressImages ? 'bg-indigo-600 justify-end' : 'bg-slate-800 justify-start'
                        }`}
                      >
                        <div className="w-4 h-4 rounded-full bg-white shadow-md" />
                      </button>
                    </div>
                  </div>

                  {/* 🔔 Web Push 通知 (PWA / スマホ通知) */}
                  <div className="space-y-3 pt-4 border-t border-slate-800">
                    <div className="flex items-start justify-between">
                      <div>
                        <label className="block text-xs font-bold text-slate-200 flex items-center space-x-1.5">
                          <Bell className="w-4 h-4 text-cyan-400" />
                          <span>Web Push 通知 (PWA / スマホ連携)</span>
                        </label>
                        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                          ブラウザやスマホアプリを閉じている時でも、自分宛ての返信・メンション・リアクション・フォローを端末の通知欄へリアルタイムにお届けします。
                        </p>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0 ml-2 ${
                        isPushSubscribed
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                          : pushPermission === 'denied'
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                          : 'bg-slate-800 text-slate-400 border border-slate-700'
                      }`}>
                        {isPushSubscribed ? '🟢 有効' : pushPermission === 'denied' ? '🔴 ブロック中' : '⚪ 未設定'}
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-2 pt-1">
                      {isPushSubscribed ? (
                        <>
                          <button
                            type="button"
                            onClick={handleSendTestPush}
                            disabled={isSendingTestPush}
                            className="px-3.5 py-2 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 rounded-xl text-xs font-semibold transition flex items-center space-x-1.5 cursor-pointer disabled:opacity-50"
                          >
                            <Bell className="w-3.5 h-3.5" />
                            <span>{isSendingTestPush ? '送信中...' : 'テスト通知を送信'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleUnsubscribePush}
                            disabled={isSubscribingPush}
                            className="px-3.5 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 border border-slate-700 rounded-xl text-xs font-semibold transition flex items-center space-x-1.5 cursor-pointer"
                          >
                            <span>通知を解除</span>
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={handleSubscribePush}
                          disabled={isSubscribingPush}
                          className="px-4 py-2 bg-gradient-to-r from-cyan-500 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 text-white rounded-xl text-xs font-bold shadow-md shadow-indigo-600/20 transition flex items-center space-x-1.5 cursor-pointer disabled:opacity-50"
                        >
                          <Bell className="w-3.5 h-3.5" />
                          <span>{isSubscribingPush ? '設定中...' : 'この端末でプッシュ通知を有効にする'}</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 🔔 通知の種類別設定 */}
                  <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4 space-y-3">
                    <div>
                      <h4 className="font-bold text-sm text-slate-100 flex items-center space-x-2">
                        <Bell className="w-4 h-4 text-amber-400" />
                        <span>通知の種類</span>
                        {isSavingNotifPrefs && <span className="text-[10px] text-slate-500 font-normal">保存中...</span>}
                      </h4>
                      <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                        受け取る通知の種類を選べます。ここで切った種類は、アプリ内の通知・プッシュ通知のどちらも届かなくなります（切っている間に起きた通知は作成されません）。
                      </p>
                    </div>
                    {notificationPrefs === null ? (
                      <p className="text-[11px] text-slate-500">読み込み中...</p>
                    ) : (
                      <div className="space-y-1.5">
                        {(notificationTypes.length > 0
                          ? notificationTypes
                          : [
                              { type: 'follow', label: 'フォロー' },
                              { type: 'reply', label: '返信' },
                              { type: 'mention', label: 'メンション' },
                              { type: 'reaction', label: 'リアクション' },
                              { type: 'renote', label: 'リノート / ブースト' },
                              { type: 'antenna', label: 'アンテナ' },
                              { type: 'move', label: '引っ越し（Move）' },
                            ]
                        ).map((item) => {
                          const enabled = notificationPrefs[item.type] !== false;
                          return (
                            <label
                              key={item.type}
                              className="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-800 cursor-pointer hover:border-slate-700 transition"
                            >
                              <span className="flex items-center space-x-2 text-xs text-slate-200">
                                {enabled ? <Bell className="w-3.5 h-3.5 text-amber-400" /> : <BellOff className="w-3.5 h-3.5 text-slate-500" />}
                                <span className={enabled ? '' : 'text-slate-500'}>{item.label}</span>
                              </span>
                              <span className="flex items-center space-x-2">
                                <span className={`text-[10px] font-bold ${enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
                                  {enabled ? 'ON' : 'OFF'}
                                </span>
                                <input
                                  type="checkbox"
                                  checked={enabled}
                                  onChange={(e) => handleToggleNotificationPref(item.type, e.target.checked)}
                                  className="w-4 h-4 accent-emerald-500 cursor-pointer"
                                />
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    <p className="text-[10px] text-slate-500">
                      ※ 予約投稿の公開通知は自分の操作の控えのため、常に届きます。
                    </p>
                  </div>

                  {/* 保存ボタン */}
                  <div className="pt-3 flex justify-end">
                    <button
                      type="submit"
                      className="px-5 py-2.5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition flex items-center space-x-1.5"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>環境設定を保存</span>
                    </button>
                  </div>
                </form>
              ) : settingsTab === 'account' ? (
                /* 🌐 アカウント・連合情報 */
                <div className="space-y-6">
                  <div className="border-b border-slate-800 pb-3">
                    <h3 className="text-base font-bold text-slate-100 flex items-center space-x-2">
                      <Globe className="w-4 h-4 text-cyan-400" />
                      <span>アカウント・Fediverse 連合情報</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      他の Fediverse サーバー（Misskey / Mastodon）からあなたを発見・フォローするためのアドレス情報です。
                    </p>
                  </div>

                  {/* 📧 メールアドレス（復元手段 / password 方式ではログインID） */}
                  {recoveryStatus.mailConfigured && (recoveryStatus.allowEmailRegistration || Boolean(myEmail)) && (
                    <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4 space-y-3">
                      <div>
                        <h4 className="font-bold text-sm text-slate-100 flex items-center space-x-2">
                          <Mail className="w-4 h-4 text-sky-400" />
                          <span>メールアドレス{isPasswordAuthMode ? '' : '（復元用・任意）'}</span>
                          {myEmail && (
                            myEmailVerified ? (
                              <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[10px] font-bold">確認済み</span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-bold">未確認</span>
                            )
                          )}
                        </h4>
                        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                          {isPasswordAuthMode
                            ? <>ログインと、<strong>マスターキーを忘れたときの復元</strong>に使います。下の「確認コードを送信」→「確認する」で確認済みにできます（現在: {myEmail ? `登録済み ${myEmail}` : '未登録'}）。</>
                            : <>登録しておくと、<strong>マスターキーを忘れたときにメール経由で復元</strong>できます。ログインには使われません（現在: {myEmail ? `登録済み ${myEmail}` : '未登録'}）。</>}
                        </p>
                      </div>

                      {emailMsg && (
                        <div className={`p-2.5 rounded-xl text-xs flex items-center space-x-2 ${
                          emailMsg.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}>
                          {emailMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                          <span>{emailMsg.text}</span>
                        </div>
                      )}

                      <form onSubmit={handleSendEmailCode} className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="email"
                          value={emailInput}
                          onChange={(e) => setEmailInput(e.target.value)}
                          placeholder="you@example.com"
                          className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                        <button
                          type="submit"
                          disabled={isSendingEmail || !emailInput.trim()}
                          className="px-4 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition whitespace-nowrap cursor-pointer"
                        >
                          {isSendingEmail ? '送信中...' : '確認コードを送信'}
                        </button>
                      </form>

                      <form onSubmit={handleVerifyEmail} className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          value={emailCode}
                          onChange={(e) => setEmailCode(e.target.value)}
                          maxLength={6}
                          placeholder="6桁の確認コード"
                          className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                        <button
                          type="submit"
                          disabled={isSendingEmail || !emailCode.trim()}
                          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 text-xs font-bold rounded-xl transition whitespace-nowrap cursor-pointer"
                        >
                          確認する
                        </button>
                      </form>

                      {myEmail && (
                        <button
                          type="button"
                          onClick={handleDeleteEmail}
                          className="px-3 py-1.5 bg-slate-800 hover:bg-rose-600/80 text-slate-300 hover:text-white rounded-lg text-[11px] font-semibold transition cursor-pointer"
                        >
                          メールアドレスを削除
                        </button>
                      )}
                    </div>
                  )}

                  {/* 🔑 パスワードの設定・変更（password 方式のみ） */}
                  {isPasswordAuthMode && (
                    <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4 space-y-3">
                      <div>
                        <h4 className="font-bold text-sm text-slate-100 flex items-center space-x-2">
                          <KeyRound className="w-4 h-4 text-amber-400" />
                          <span>{authUser?.hasPassword ? 'パスワードの変更' : 'パスワードの設定'}</span>
                        </h4>
                        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                          {authUser?.hasPassword
                            ? '現在のパスワード（またはマスターキー）を入力して、新しいパスワードに変更します。'
                            : 'このアカウントにはまだパスワードが設定されていません。パスワードを設定すると、メールアドレスでログインできるようになります（マスターキーが必要です）。'}
                        </p>
                      </div>

                      {passwordMsg && (
                        <div className={`p-2.5 rounded-xl text-xs flex items-center space-x-2 ${
                          passwordMsg.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}>
                          {passwordMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                          <span>{passwordMsg.text}</span>
                        </div>
                      )}

                      <form onSubmit={handleChangePassword} className="space-y-3">
                        {authUser?.hasPassword ? (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[11px] font-semibold text-slate-300 mb-1">現在のパスワード</label>
                              <input
                                type="password"
                                autoComplete="current-password"
                                value={pwCurrent}
                                onChange={(e) => setPwCurrent(e.target.value)}
                                placeholder="現在のパスワード"
                                className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-semibold text-slate-300 mb-1">マスターキー（上記の代わり）</label>
                              <input
                                type="password"
                                autoComplete="off"
                                value={pwMasterKey}
                                onChange={(e) => setPwMasterKey(e.target.value)}
                                placeholder="SPICA-XXXX-XXXX-XXXX"
                                className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                              />
                            </div>
                          </div>
                        ) : (
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                              マスターキー <span className="text-rose-400 font-bold">*必須</span>
                            </label>
                            <input
                              type="password"
                              autoComplete="off"
                              value={pwMasterKey}
                              onChange={(e) => setPwMasterKey(e.target.value)}
                              placeholder="SPICA-XXXX-XXXX-XXXX"
                              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                            />
                            <p className="text-[10px] text-slate-500 mt-1">
                              初回登録時に発行されたマスターキー（SPICA-…）を入力してください。分からない場合は、メールアドレスでマスターキーを復元できます。
                            </p>
                          </div>
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                              新しいパスワード <span className="text-slate-500 font-normal">(8文字以上)</span>
                            </label>
                            <input
                              type="password"
                              autoComplete="new-password"
                              value={pwNew}
                              onChange={(e) => setPwNew(e.target.value)}
                              placeholder="8文字以上"
                              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-300 mb-1">新しいパスワード (確認)</label>
                            <input
                              type="password"
                              autoComplete="new-password"
                              value={pwNewConfirm}
                              onChange={(e) => setPwNewConfirm(e.target.value)}
                              placeholder="同じパスワードをもう一度入力"
                              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                            />
                          </div>
                        </div>

                        <div className="flex justify-end">
                          <button
                            type="submit"
                            disabled={isSavingPassword || !pwNew || !pwNewConfirm}
                            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition flex items-center space-x-1.5 cursor-pointer"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>{isSavingPassword ? '保存中...' : authUser?.hasPassword ? 'パスワードを変更' : 'パスワードを設定'}</span>
                          </button>
                        </div>
                      </form>
                    </div>
                  )}

                  {/* 📥 アカウント移行インポート */}
                  <div className="space-y-3 bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
                    <div>
                      <h4 className="font-bold text-sm text-slate-100 flex items-center space-x-2">
                        <Upload className="w-4 h-4 text-emerald-400" />
                        <span>他のサーバーからの移行（インポート）</span>
                      </h4>
                      <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                        Mastodon の <code className="text-slate-300">outbox.json</code>、または Misskey の{' '}
                        <code className="text-slate-300">notes.json</code> を取り込むと、過去の投稿（本文・CW・公開範囲・投稿日時）を復元できます。
                        元の投稿日時が保持されるため、時系列が崩れません。同じファイルを再度取り込んでも重複しません。
                        <br />※ メディア（画像・動画）とフォロー/ブックマークの取り込みは現在未対応です。
                      </p>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="file"
                        accept=".json,application/json"
                        onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                        className="flex-1 text-xs text-slate-300 file:mr-3 file:py-2 file:px-3 file:rounded-xl file:border-0 file:bg-slate-800 file:text-slate-200 file:text-xs file:font-bold hover:file:bg-slate-700 cursor-pointer"
                      />
                      <button
                        type="button"
                        disabled={!importFile || isImporting}
                        onClick={handleImportArchive}
                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition whitespace-nowrap flex items-center justify-center space-x-1.5 cursor-pointer"
                      >
                        {isImporting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                        <span>{isImporting ? '取り込み中...' : '取り込む'}</span>
                      </button>
                    </div>
                    {importResult && (
                      <div
                        className={`p-3 rounded-xl text-xs flex items-start space-x-2 ${
                          importResult.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}
                      >
                        {importResult.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
                        <div className="space-y-0.5">
                          <span className="block whitespace-pre-wrap">{importResult.text}</span>
                          {importResult.detail && (
                            <span className="block text-[10px] opacity-80 whitespace-pre-wrap">{importResult.detail}</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-3">
                    {/* 連合ハンドル */}
                    <div className="bg-slate-950/70 p-4 rounded-2xl border border-slate-800 space-y-1.5">
                      <span className="text-[11px] text-slate-400 font-semibold block">あなたの ActivityPub ハンドル</span>
                      <div className="flex items-center justify-between bg-slate-900 px-3 py-2 rounded-xl border border-slate-800">
                        <span className="font-mono text-xs text-indigo-300 font-bold select-all truncate mr-2">
                          {authUser?.handle}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            if (authUser?.handle) {
                              navigator.clipboard.writeText(authUser.handle);
                              setSettingsMessage({ type: 'success', text: 'ハンドルをクリップボードにコピーしました！' });
                              setTimeout(() => setSettingsMessage(null), 3000);
                            }
                          }}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-bold transition flex items-center space-x-1 shrink-0"
                          title="コピー"
                        >
                          <Copy className="w-3 h-3" />
                          <span>コピー</span>
                        </button>
                      </div>
                      <p className="text-[11px] text-slate-500">
                        Misskey や Mastodon の検索バーにこのハンドルを入力すると、外部からあなたのアカウントを発見できます。
                      </p>
                    </div>

                    {/* 公開アクターURL */}
                    <div className="bg-slate-950/70 p-4 rounded-2xl border border-slate-800 space-y-1.5">
                      <span className="text-[11px] text-slate-400 font-semibold block">公開 Actor URL</span>
                      <div className="flex items-center justify-between bg-slate-900 px-3 py-2 rounded-xl border border-slate-800">
                        <a
                          href={authUser?.actorUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs text-slate-300 hover:text-indigo-400 underline select-all truncate mr-2 flex items-center space-x-1"
                        >
                          <span>{authUser?.actorUrl}</span>
                          <ExternalLink className="w-3 h-3 shrink-0" />
                        </a>
                        <button
                          type="button"
                          onClick={() => {
                            if (authUser?.actorUrl) {
                              navigator.clipboard.writeText(authUser.actorUrl);
                              setSettingsMessage({ type: 'success', text: 'Actor URL をコピーしました！' });
                              setTimeout(() => setSettingsMessage(null), 3000);
                            }
                          }}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-bold transition flex items-center space-x-1 shrink-0"
                        >
                          <Copy className="w-3 h-3" />
                          <span>コピー</span>
                        </button>
                      </div>
                    </div>

                    {/* 基本ステータス */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2">
                      <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800">
                        <span className="text-[11px] text-slate-500 block">ユーザーID</span>
                        <span className="font-mono font-bold text-xs text-slate-200">@{authUser?.id}</span>
                      </div>
                      <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800">
                        <span className="text-[11px] text-slate-500 block">ロール</span>
                        <span className={`text-xs font-bold ${authUser?.role === 'admin' ? 'text-purple-300' : 'text-slate-200'}`}>
                          {authUser?.role === 'admin' ? '👑 管理者 (ADMIN)' : '一般ユーザー (USER)'}
                        </span>
                      </div>
                      <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800 col-span-2 sm:col-span-1">
                        <span className="text-[11px] text-slate-500 block">参加サーバー</span>
                        <span className="font-mono text-xs text-slate-200">{serverStats?.domain || window.location.host}</span>
                      </div>
                    </div>

                    {/* マスターキー管理についての安全ガイダンス */}
                    <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 p-4 rounded-2xl text-xs space-y-2 mt-4">
                      <div className="flex items-center space-x-2 font-bold text-amber-400">
                        <Key className="w-4 h-4" />
                        <span>{isPasswordAuthMode ? 'ログインとマスターキーに関する重要事項' : 'マスターキー認証に関する重要事項'}</span>
                      </div>
                      <p className="leading-relaxed text-amber-300/90 text-[11px]">
                        {isPasswordAuthMode ? (
                          <>
                            このサーバーはメールアドレス＋パスワード方式です。通常はメールアドレスとパスワードでログインできます。
                            アカウント登録時に発行された <strong>マスターキー (spica_sk_... または astrabit_sk_...)</strong> は、パスワードを忘れたときの最終手段として使えます。
                            紛失すると復旧できなくなる場合がありますので、必ずパスワード管理ツールや安全な保管場所にバックアップしてください。
                          </>
                        ) : (
                          <>
                            Spica では個人情報を収集しないため、メールアドレスやパスワードによるリセット機能はありません。
                            アカウント登録時に発行された <strong>マスターキー (spica_sk_... または astrabit_sk_...)</strong> があなたのアカウントの唯一の鍵です。
                            万が一紛失した場合は再ログインができなくなりますので、必ずパスワード管理ツールや安全な保管場所にバックアップしてください。
                          </>
                        )}
                      </p>
                    </div>

                    {/* 🔐 WebAuthn / パスキー生体認証管理 */}
                    <div className="bg-slate-950/70 border border-slate-800 p-4 sm:p-5 rounded-2xl space-y-4 mt-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2 font-bold text-slate-100">
                          <Fingerprint className="w-5 h-5 text-indigo-400 shrink-0" />
                          <span className="text-sm">パスキー / 生体認証 (WebAuthn)</span>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold">
                          FIDO2 / W3C標準
                        </span>
                      </div>

                      <p className="leading-relaxed text-slate-300 text-xs">
                        Windows Hello、Touch ID、Face ID、物理セキュリティキーを連携すると、長いマスターキーを入力することなく、指紋や顔認証だけでワンタップサインインが可能になります。
                      </p>

                      {/* アクションメッセージ */}
                      {passkeyActionMessage && (
                        <div
                          className={`p-3 rounded-xl text-xs flex items-center space-x-2 animate-in fade-in ${
                            passkeyActionMessage.type === 'success'
                              ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-300'
                              : 'bg-rose-500/20 border border-rose-500/30 text-rose-300'
                          }`}
                        >
                          {passkeyActionMessage.type === 'success' ? (
                            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                          ) : (
                            <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
                          )}
                          <span>{passkeyActionMessage.text}</span>
                        </div>
                      )}

                      {/* パスキー新規登録フォーム */}
                      <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
                        <input
                          type="text"
                          placeholder="デバイス名 (例: 自宅PC, 会社のMacBook, スマホ)"
                          value={passkeyDeviceName}
                          onChange={(e) => setPasskeyDeviceName(e.target.value)}
                          className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                        <button
                          type="button"
                          onClick={handleRegisterPasskey}
                          disabled={isRegisteringPasskey}
                          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition flex items-center justify-center space-x-1.5 shadow-md cursor-pointer shrink-0"
                        >
                          {isRegisteringPasskey ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Fingerprint className="w-3.5 h-3.5" />
                          )}
                          <span>{isRegisteringPasskey ? '端末認証中...' : 'パスキーを登録'}</span>
                        </button>
                      </div>

                      {/* 登録済みパスキー一覧 */}
                      <div className="space-y-2 pt-2 border-t border-slate-800/80">
                        <span className="text-[11px] font-bold text-slate-400 block">
                          登録済みパスキー ({passkeys.length}件)
                        </span>

                        {isLoadingPasskeys ? (
                          <div className="py-4 text-center text-xs text-slate-400">
                            <RefreshCw className="w-4 h-4 animate-spin mx-auto text-indigo-400 mb-1" />
                            読み込み中...
                          </div>
                        ) : passkeys.length === 0 ? (
                          <div className="py-4 text-center text-xs text-slate-500 bg-slate-900/50 rounded-xl border border-dashed border-slate-800">
                            登録されたパスキーはありません
                          </div>
                        ) : (
                          passkeys.map((p) => (
                            <div
                              key={p.id}
                              className="flex items-center justify-between p-3 rounded-xl bg-slate-900 border border-slate-800 text-xs"
                            >
                              <div className="flex items-center space-x-2.5 min-w-0">
                                <Fingerprint className="w-4 h-4 text-emerald-400 shrink-0" />
                                <div className="min-w-0">
                                  <div className="font-bold text-slate-200 truncate">
                                    {p.device_name || '生体認証デバイス'}
                                  </div>
                                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                                    登録日: {new Date(p.created_at).toLocaleDateString('ja-JP')}
                                    {p.last_used_at && (
                                      <span> ・ 最終利用: {new Date(p.last_used_at).toLocaleDateString('ja-JP')}</span>
                                    )}
                                  </div>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleDeletePasskey(p.id)}
                                className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition cursor-pointer"
                                title="このパスキーを削除"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* 📦 データエクスポート (バックアップ・データ主権) */}
                    <div className="bg-slate-950/70 border border-slate-800 p-4 sm:p-5 rounded-2xl space-y-3 mt-4">
                      <div className="flex items-center space-x-2 font-bold text-slate-200">
                        <FolderArchive className="w-4 h-4 text-indigo-400 shrink-0" />
                        <span>データのエクスポート（バックアップ）</span>
                      </div>
                      <p className="leading-relaxed text-slate-300 text-xs">
                        分散型ソーシャルネットワーク（Fediverse）の「自分のデータは自分のもの（データ主権）」という理念に基づき、
                        あなたの過去の全投稿、フォロー・フォロワー一覧、ブックマーク、リアクション履歴をいつでも一括ダウンロードできます。
                      </p>
                      <div className="flex flex-wrap gap-2.5 pt-1">
                        <button
                          type="button"
                          disabled={isExportingData}
                          onClick={() => handleExportData('json')}
                          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition flex items-center space-x-2 shadow-md cursor-pointer"
                        >
                          {isExportingData && exportingFormat === 'json' ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <FileText className="w-3.5 h-3.5" />
                          )}
                          <span>{isExportingData && exportingFormat === 'json' ? '出力中...' : '📄 JSON形式でダウンロード'}</span>
                        </button>
                        <button
                          type="button"
                          disabled={isExportingData}
                          onClick={() => handleExportData('zip')}
                          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 rounded-xl text-xs font-bold transition flex items-center space-x-2 shadow-md cursor-pointer"
                        >
                          {isExportingData && exportingFormat === 'zip' ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Download className="w-3.5 h-3.5 text-cyan-400" />
                          )}
                          <span>{isExportingData && exportingFormat === 'zip' ? 'ZIP生成中...' : '🗜️ ZIP形式でダウンロード'}</span>
                        </button>
                      </div>
                      <p className="text-[11px] text-slate-500">
                        ※ ZIPアーカイブには各カテゴリ別のJSONファイルと解説用READMEが格納されます。
                      </p>
                    </div>

                    {/* 📦 アカウントの引っ越し（Move / alsoKnownAs） */}
                    <div className="bg-slate-950/70 border border-slate-800 p-4 sm:p-5 rounded-2xl space-y-4 mt-4">
                      <div className="flex items-center space-x-2 font-bold text-slate-100">
                        <Send className="w-5 h-5 text-indigo-400 shrink-0" />
                        <span className="text-sm">アカウントの引っ越し（Move）</span>
                      </div>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        別のサーバーへ引っ越すときは、引っ越し先アカウントで旧アカウント（このアカウント）を
                        <span className="font-mono text-slate-300"> alsoKnownAs </span>
                        として設定してから、ここで引っ越しを実行します。フォロワーには
                        <span className="font-mono text-slate-300"> Move </span>
                        が配送され、引っ越し先のフォローに引き継がれます。
                      </p>

                      {migrationInfo.movedTo && (
                        <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 p-3 rounded-xl text-xs space-y-1.5">
                          <div className="flex items-center space-x-2 font-bold">
                            <AlertCircle className="w-4 h-4 shrink-0" />
                            <span>このアカウントは引っ越し済みです</span>
                          </div>
                          <p className="font-mono text-[11px] break-all text-amber-200/90">{migrationInfo.movedTo}</p>
                          <button
                            type="button"
                            onClick={handleCancelMove}
                            disabled={isMigrating}
                            className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-50 text-amber-200 border border-amber-500/40 rounded-xl text-[11px] font-bold transition cursor-pointer"
                          >
                            引っ越し先の記録を解除
                          </button>
                        </div>
                      )}

                      {/* 引っ越し元（他のサーバーからここへ引っ越してきた場合） */}
                      <div className="space-y-2">
                        <label className="block text-xs font-bold text-slate-300">
                          引っ越し元アカウント（他のサーバーからここへ引っ越した場合）
                        </label>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="text"
                            value={migrationAliasInput}
                            onChange={(e) => setMigrationAliasInput(e.target.value)}
                            placeholder="@old@example.com または https://example.com/users/old"
                            className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={handleSaveMigrationAlias}
                            disabled={isMigrating}
                            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-bold rounded-xl border border-slate-700 transition cursor-pointer shrink-0"
                          >
                            保存
                          </button>
                        </div>
                        <p className="text-[11px] text-slate-500">
                          設定すると Actor 文書の <span className="font-mono">alsoKnownAs</span> として公開され、他のサーバーがあなたの引っ越しを検証できるようになります（空欄で保存すると解除）。
                        </p>
                      </div>

                      {/* 引っ越し先（このサーバーから出ていく場合） */}
                      <div className="space-y-2 pt-3 border-t border-slate-800">
                        <label className="block text-xs font-bold text-slate-300">
                          引っ越し先アカウント（このサーバーから引っ越す場合）
                        </label>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="text"
                            value={migrationTargetInput}
                            onChange={(e) => setMigrationTargetInput(e.target.value)}
                            placeholder="@new@example.com"
                            className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={handleExecuteMove}
                            disabled={isMigrating}
                            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition flex items-center justify-center space-x-1.5 cursor-pointer shrink-0"
                          >
                            {isMigrating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                            <span>引っ越しを実行</span>
                          </button>
                        </div>
                        <p className="text-[11px] text-slate-500">
                          フォロワー（{migrationInfo.followers} 件）へ Move を配送します。先に引っ越し先アカウント側で、このアカウントを
                          <span className="font-mono"> alsoKnownAs </span>に設定しておく必要があります。
                        </p>
                      </div>

                      {migrationMsg && (
                        <div className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                          migrationMsg.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}>
                          {migrationMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                          <span>{migrationMsg.text}</span>
                        </div>
                      )}
                    </div>

                    {/* ⚠️ 危険なエリア: アカウントの削除（退会） */}
                    <div className="bg-rose-950/20 border border-rose-500/30 p-4 sm:p-5 rounded-2xl space-y-3 mt-4">
                      <div className="flex items-center space-x-2 font-bold text-rose-400">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <span>危険な操作: アカウントの削除（退会）</span>
                      </div>
                      <p className="leading-relaxed text-rose-200/90 text-xs">
                        アカウントを削除すると、あなたのプロフィール、過去の全投稿、画像ファイル、リアクション、フォロー・フォロワー関係、通知などのすべてのデータがサーバーおよび連合先（Fediverse）から完全に消去されます。
                        <br />
                        <span className="text-rose-400 font-semibold">※この操作は取り消すことができず、データを復元することはできません。</span>
                      </p>
                      <div className="pt-1">
                        <button
                          type="button"
                          onClick={() => {
                            setSelfDeleteConfirmId('');
                            setSelfDeleteMasterKey('');
                            setSelfDeleteError(null);
                            setShowSelfDeleteModal(true);
                          }}
                          className="px-4 py-2 bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/40 rounded-xl text-xs font-bold transition flex items-center space-x-1.5 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                          <span>アカウントを完全に削除する...</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : settingsTab === 'mutes_blocks' ? (
                /* 🚫 ミュートとブロック管理 */
                <div className="space-y-6">
                  <div className="border-b border-slate-800 pb-3 flex items-center justify-between">
                    <div>
                      <h3 className="text-base font-bold text-slate-100 flex items-center space-x-2">
                        <Ban className="w-4 h-4 text-rose-400" />
                        <span>ミュートとブロックの管理</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-1">
                        あなたがミュートまたはブロックしているユーザーの一覧です。いつでも解除できます。
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={fetchBlocksAndMutes}
                      disabled={isLoadingBlocksMutes}
                      className="p-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-300 transition cursor-pointer"
                      title="一覧を更新"
                    >
                      <RefreshCw className={`w-4 h-4 ${isLoadingBlocksMutes ? 'animate-spin text-indigo-400' : ''}`} />
                    </button>
                  </div>

                  {isLoadingBlocksMutes ? (
                    <div className="text-center py-12">
                      <RefreshCw className="w-6 h-6 animate-spin mx-auto text-indigo-400 mb-2" />
                      <p className="text-xs text-slate-400">リストを読み込み中...</p>
                    </div>
                  ) : (
                    <div className="space-y-8">
                      {/* 🔒 フォローリクエスト（鍵アカウント） */}
                      {followRequests.length > 0 && (
                        <div className="space-y-3">
                          <div className="flex items-center space-x-2">
                            <User className="w-4 h-4 text-emerald-400" />
                            <h4 className="font-bold text-sm text-slate-100">
                              フォローリクエスト ({followRequests.length})
                            </h4>
                          </div>
                          <p className="text-[11px] text-slate-400 leading-relaxed">
                            鍵アカウントのため承認待ちになっているフォローです。承認すると相手にフォロワーとして通知（Accept）が送られます。
                          </p>
                          <div className="space-y-2">
                            {followRequests.map((req) => (
                              <div
                                key={req.id}
                                className="flex items-center justify-between space-x-3 bg-slate-950/60 border border-slate-800 rounded-2xl px-3.5 py-3"
                              >
                                <div className="flex items-center space-x-3 min-w-0">
                                  {req.icon_url ? (
                                    <img src={req.icon_url} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
                                  ) : (
                                    <div className="w-9 h-9 rounded-full bg-slate-800 shrink-0" />
                                  )}
                                  <div className="min-w-0">
                                    <span className="font-bold text-xs text-slate-100 block truncate">{req.name}</span>
                                    <span className="text-[11px] text-slate-400 block truncate">{req.handle}</span>
                                  </div>
                                </div>
                                <div className="flex items-center space-x-2 shrink-0">
                                  <button
                                    type="button"
                                    disabled={isRespondingRequest === req.actor_url}
                                    onClick={() => handleRespondFollowRequest(req.actor_url, 'reject')}
                                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg text-xs font-semibold transition cursor-pointer disabled:opacity-50"
                                  >
                                    拒否
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isRespondingRequest === req.actor_url}
                                    onClick={() => handleRespondFollowRequest(req.actor_url, 'accept')}
                                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold shadow-md transition cursor-pointer disabled:opacity-50"
                                  >
                                    承認
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 🔇 ミュートワード（ワードフィルター） */}
                      <div className="space-y-3">
                        <div className="flex items-center space-x-2">
                          <ShieldAlert className="w-4 h-4 text-amber-400" />
                          <h4 className="font-bold text-sm text-slate-100">
                            ミュートワード ({mutedWords.length})
                          </h4>
                        </div>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          登録したキーワードを含む投稿（本文・CW）は、タイムラインやアンテナなどから自動的に除外されます。
                        </p>

                        <form onSubmit={handleAddMutedWord} className="space-y-2 bg-slate-950/60 border border-slate-800 rounded-2xl p-3.5">
                          <div className="flex flex-col sm:flex-row gap-2">
                            <input
                              type="text"
                              value={newMutedWord}
                              onChange={(e) => setNewMutedWord(e.target.value)}
                              maxLength={100}
                              placeholder="除外したいキーワード（例: ネタバレ）"
                              className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
                            />
                            <button
                              type="submit"
                              disabled={isSavingMutedWord || !newMutedWord.trim()}
                              className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition whitespace-nowrap flex items-center space-x-1 justify-center"
                            >
                              {isSavingMutedWord ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                              <span>追加</span>
                            </button>
                          </div>
                          <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-300">
                            <label className="flex items-center space-x-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={mutedWordCaseSensitive}
                                onChange={(e) => setMutedWordCaseSensitive(e.target.checked)}
                                className="w-3.5 h-3.5 accent-amber-500 cursor-pointer"
                              />
                              <span>大文字小文字を区別</span>
                            </label>
                            <label className="flex items-center space-x-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={mutedWordWholeWord}
                                onChange={(e) => setMutedWordWholeWord(e.target.checked)}
                                className="w-3.5 h-3.5 accent-amber-500 cursor-pointer"
                              />
                              <span>単語単位（英数字のみ）</span>
                            </label>
                          </div>
                        </form>

                        {mutedWords.length === 0 ? (
                          <div className="text-center py-5 bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                            登録されているキーワードはありません。
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {mutedWords.map((w) => (
                              <span
                                key={w.id}
                                className="inline-flex items-center space-x-2 bg-slate-900 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200"
                              >
                                <span className="font-mono">{w.keyword}</span>
                                {w.case_sensitive === 1 && <span className="text-[9px] text-amber-400 font-bold">Aa</span>}
                                {w.whole_word === 1 && <span className="text-[9px] text-amber-400 font-bold">W</span>}
                                <button
                                  type="button"
                                  onClick={() => handleDeleteMutedWord(w.id)}
                                  className="p-0.5 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
                                  title="削除"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* ミュート中ユーザーセクション */}
                      <div className="space-y-3">
                        <div className="flex items-center space-x-2">
                          <VolumeX className="w-4 h-4 text-amber-400" />
                          <h4 className="text-sm font-bold text-slate-200">
                            ミュート中のユーザー ({mutedUsers.length})
                          </h4>
                        </div>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          ミュートされたユーザーの投稿やリノートはタイムライン、検索、通知に表示されなくなります（相手には通知されません）。
                        </p>

                        {mutedUsers.length === 0 ? (
                          <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-500">
                            現在ミュートしているユーザーはいません。
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {mutedUsers.map((m: any) => (
                              <div
                                key={m.id || m.target_user_id}
                                className="flex items-center justify-between p-3.5 bg-slate-950/60 border border-slate-800 rounded-2xl hover:border-slate-700/80 transition"
                              >
                                <div className="min-w-0 flex-1 pr-3">
                                  <div className="flex items-center space-x-2">
                                    <span className="font-bold text-xs text-slate-200 truncate">
                                      {m.target_name || m.target_handle}
                                    </span>
                                    <span className="font-mono text-[11px] text-indigo-400 truncate">
                                      @{m.target_handle}
                                    </span>
                                  </div>
                                  <span className="text-[10px] text-slate-500 block mt-0.5">
                                    ミュート日時: {new Date(m.created_at).toLocaleString('ja-JP')}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleUnmuteUser(m.target_handle || m.target_user_id)}
                                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-300 hover:text-amber-200 text-xs font-bold border border-slate-700 transition flex items-center space-x-1 shrink-0 cursor-pointer"
                                >
                                  <Volume2 className="w-3.5 h-3.5" />
                                  <span>解除</span>
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* ブロック中ユーザーセクション */}
                      <div className="space-y-3 pt-4 border-t border-slate-800/80">
                        <div className="flex items-center space-x-2">
                          <Ban className="w-4 h-4 text-rose-400" />
                          <h4 className="text-sm font-bold text-slate-200">
                            ブロック中のユーザー ({blockedUsers.length})
                          </h4>
                        </div>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          ブロックされたユーザーとは相互のフォローが解除され、相手の投稿や通知が完全に遮断されます。
                        </p>

                        {blockedUsers.length === 0 ? (
                          <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-500">
                            現在ブロックしているユーザーはいません。
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {blockedUsers.map((b: any) => (
                              <div
                                key={b.id || b.target_user_id}
                                className="flex items-center justify-between p-3.5 bg-slate-950/60 border border-slate-800 rounded-2xl hover:border-slate-700/80 transition"
                              >
                                <div className="min-w-0 flex-1 pr-3">
                                  <div className="flex items-center space-x-2">
                                    <span className="font-bold text-xs text-slate-200 truncate">
                                      {b.target_name || b.target_handle}
                                    </span>
                                    <span className="font-mono text-[11px] text-rose-400 truncate">
                                      @{b.target_handle}
                                    </span>
                                  </div>
                                  <span className="text-[10px] text-slate-500 block mt-0.5">
                                    ブロック日時: {new Date(b.created_at).toLocaleString('ja-JP')}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleUnblockUser(b.target_handle || b.target_user_id)}
                                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-rose-300 hover:text-rose-200 text-xs font-bold border border-slate-700 transition flex items-center space-x-1 shrink-0 cursor-pointer"
                                >
                                  <Ban className="w-3.5 h-3.5" />
                                  <span>ブロック解除</span>
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                /* 🚪 セッション・ログアウト */
                <div className="space-y-6">
                  <div className="border-b border-slate-800 pb-3">
                    <h3 className="text-base font-bold text-slate-100 flex items-center space-x-2">
                      <LogOut className="w-4 h-4 text-rose-400" />
                      <span>セッションとセキュリティ</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      現在のログイン端末セッションの確認およびサインアウトを行います。
                    </p>
                  </div>

                  <div className="bg-slate-950/60 p-4 rounded-2xl border border-slate-800 space-y-3">
                    <span className="text-xs font-bold text-slate-300 block">現在のセッション情報</span>
                    <div className="space-y-2 text-xs">
                      <div className="flex items-center justify-between text-slate-400 py-1.5 border-b border-slate-800/60">
                        <span>ログインアカウント</span>
                        <span className="font-bold text-slate-200">@{authUser?.id} ({authUser?.name})</span>
                      </div>
                      <div className="flex items-center justify-between text-slate-400 py-1.5 border-b border-slate-800/60">
                        <span>セッショントークン</span>
                        <span className="font-mono text-[11px] text-slate-400">
                          {authToken ? `${authToken.slice(0, 8)}...${authToken.slice(-8)}` : '未ログイン'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-slate-400 py-1.5">
                        <span>ログイン状態</span>
                        <span className="text-[11px] text-emerald-400 flex items-center space-x-1 font-bold">
                          <Check className="w-3 h-3" />
                          <span>アクティブ (認証中)</span>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 危険ゾーン (Danger Zone) */}
                  <div className="bg-rose-950/20 border border-rose-500/30 rounded-2xl p-5 space-y-4">
                    <div>
                      <h4 className="text-sm font-bold text-rose-300 flex items-center space-x-2">
                        <LogOut className="w-4 h-4 text-rose-400" />
                        <span>アカウントからログアウト</span>
                      </h4>
                      <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                        この端末のブラウザからセッショントークンを破棄し、安全にログアウトします。
                        再びログインするには、ユーザーID と マスターキー が必要です。
                      </p>
                    </div>

                    <div className="pt-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm('ログアウトしますか？\n次回ログインには登録時のマスターキーが必要です。')) {
                            handleLogout();
                          }
                        }}
                        className="px-5 py-2.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-rose-600/30 transition flex items-center space-x-2 cursor-pointer"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>この端末からログアウトする</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
      ) : currentView === 'notifications' ? (
        /* 通知センター (Notifications View) */
        <main className="max-w-4xl mx-auto px-4 py-6 w-full flex-1 space-y-6 pb-24 lg:pb-6">
          {/* ヘッダー & アクション */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div className="flex items-center space-x-3">
              <button
                onClick={() => navigateToView('timeline')}
                className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 transition"
                title="タイムラインに戻る"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div>
                <h2 className="text-xl font-black text-slate-100 flex items-center space-x-2">
                  <Bell className="w-5 h-5 text-indigo-400" />
                  <span>通知センター</span>
                  {unreadNotificationsCount > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-bold">
                      {unreadNotificationsCount} 件の未読
                    </span>
                  )}
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  返信、リアクション、リノート、フォローの通知一覧
                </p>
              </div>
            </div>

            <div className="flex items-center space-x-2 shrink-0">
              {unreadNotificationsCount > 0 && (
                <button
                  onClick={handleReadAllNotifications}
                  className="px-3.5 py-1.5 rounded-xl text-xs font-bold bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 transition flex items-center space-x-1.5"
                  title="すべての通知を既読にします"
                >
                  <CheckCheck className="w-4 h-4 text-indigo-400" />
                  <span>すべて既読にする</span>
                </button>
              )}

              <button
                onClick={() => fetchNotifications(notificationFilter)}
                disabled={isLoadingNotifications}
                className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 transition"
                title="更新"
              >
                <RefreshCw className={`w-4 h-4 ${isLoadingNotifications ? 'animate-spin text-indigo-400' : ''}`} />
              </button>
            </div>
          </div>

          {/* フィルタータブ */}
          <div className="flex space-x-2 bg-slate-900/60 p-1.5 rounded-2xl border border-slate-800 overflow-x-auto">
            <button
              onClick={() => setNotificationFilter('all')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center space-x-1.5 shrink-0 ${
                notificationFilter === 'all'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <Bell className="w-3.5 h-3.5" />
              <span>すべて</span>
            </button>
            <button
              onClick={() => setNotificationFilter('reply')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center space-x-1.5 shrink-0 ${
                notificationFilter === 'reply'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <MessageCircle className="w-3.5 h-3.5 text-cyan-400" />
              <span>返信</span>
            </button>
            <button
              onClick={() => setNotificationFilter('reaction')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center space-x-1.5 shrink-0 ${
                notificationFilter === 'reaction'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <Heart className="w-3.5 h-3.5 text-pink-400" />
              <span>リアクション・RT</span>
            </button>
            <button
              onClick={() => setNotificationFilter('follow')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center space-x-1.5 shrink-0 ${
                notificationFilter === 'follow'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <UserCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>フォロー</span>
            </button>
          </div>

          {/* 通知カード一覧 */}
          {isLoadingNotifications ? (
            <div className="text-center py-20 bg-slate-900/60 rounded-3xl border border-slate-800">
              <RefreshCw className="w-8 h-8 animate-spin mx-auto text-indigo-400 mb-3" />
              <p className="text-sm text-slate-400">通知を読み込み中...</p>
            </div>
          ) : notifications.length === 0 ? (
            <div className="text-center py-20 bg-slate-900/60 rounded-3xl border border-slate-800 space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-slate-800/80 flex items-center justify-center mx-auto text-slate-500">
                <Bell className="w-6 h-6" />
              </div>
              <h3 className="text-base font-bold text-slate-200">通知はありません</h3>
              <p className="text-xs text-slate-400 max-w-sm mx-auto">
                あなた宛ての返信、リアクション、リノート、フォローなどの最新アクティビティがここに届きます。
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {notifications.map((notif) => {
                const isUnread = notif.is_read === 0;

                // タイプに応じたアイコン・ラベル・バッジ色
                let typeIcon = <Bell className="w-4 h-4 text-indigo-400" />;
                let typeBadgeBg = 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30';
                let typeLabel = '通知';

                if (notif.type === 'reply') {
                  typeIcon = <MessageCircle className="w-4 h-4 text-cyan-400" />;
                  typeBadgeBg = 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
                  typeLabel = '返信';
                } else if (notif.type === 'mention') {
                  typeIcon = <AtSign className="w-4 h-4 text-violet-400" />;
                  typeBadgeBg = 'bg-violet-500/15 text-violet-300 border-violet-500/30';
                  typeLabel = 'メンション';
                } else if (notif.type === 'reaction') {
                  typeIcon = <Heart className="w-4 h-4 text-pink-400 fill-pink-400/30" />;
                  typeBadgeBg = 'bg-pink-500/15 text-pink-300 border-pink-500/30';
                  typeLabel = 'リアクション';
                } else if (notif.type === 'announce') {
                  typeIcon = <Repeat className="w-4 h-4 text-emerald-400" />;
                  typeBadgeBg = 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
                  typeLabel = 'リノート';
                } else if (notif.type === 'follow') {
                  typeIcon = <UserCheck className="w-4 h-4 text-purple-400" />;
                  typeBadgeBg = 'bg-purple-500/15 text-purple-300 border-purple-500/30';
                  typeLabel = 'フォロー';
                } else if (notif.type === 'antenna') {
                  typeIcon = <Radio className="w-4 h-4 text-emerald-400" />;
                  typeBadgeBg = 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
                  typeLabel = 'アンテナ';
                } else if (notif.type === 'scheduled_published') {
                  typeIcon = <Clock className="w-4 h-4 text-amber-400" />;
                  typeBadgeBg = 'bg-amber-500/15 text-amber-300 border-amber-500/30';
                  typeLabel = '予約公開';
                } else if (notif.type === 'move') {
                  typeIcon = <Send className="w-4 h-4 text-sky-400" />;
                  typeBadgeBg = 'bg-sky-500/15 text-sky-300 border-sky-500/30';
                  typeLabel = '引っ越し';
                }

                return (
                  <div
                    key={notif.id}
                    onClick={() => handleNotificationClick(notif)}
                    className={`p-4 rounded-2xl border transition cursor-pointer relative group ${
                      isUnread
                        ? 'bg-slate-900/95 border-indigo-500/40 shadow-lg shadow-indigo-500/5 hover:border-indigo-500/70'
                        : 'bg-slate-900/60 border-slate-800/80 hover:bg-slate-900/90 hover:border-slate-700/80'
                    }`}
                  >
                    {/* 未読ドットインジケーター */}
                    {isUnread && (
                      <span className="absolute top-4 right-4 w-2.5 h-2.5 rounded-full bg-indigo-500 ring-4 ring-indigo-500/20" />
                    )}

                    <div className="flex items-start space-x-3.5">
                      {/* タイプ別アイコンバッジ */}
                      <div className="relative shrink-0">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openUserProfile(notif.actor_id);
                          }}
                          className="w-11 h-11 rounded-2xl overflow-hidden bg-gradient-to-tr from-cyan-500 to-indigo-600 flex items-center justify-center font-bold text-white shadow-md hover:scale-105 transition"
                          title={`${notif.actor_name} のプロフィールを開く`}
                        >
                          {notif.actor_icon ? (
                            <img
                              src={notif.actor_icon}
                              alt={notif.actor_name}
                              className="w-full h-full object-cover"
                              onError={(e) => {
                                (e.target as HTMLElement).style.display = 'none';
                              }}
                            />
                          ) : (
                            notif.actor_name.slice(0, 1).toUpperCase()
                          )}
                        </button>
                        <div className="absolute -bottom-1 -right-1 p-1 rounded-full bg-slate-900 border border-slate-800 shadow">
                          {typeIcon}
                        </div>
                      </div>

                      {/* 本文エリア */}
                      <div className="flex-1 min-w-0 pr-6">
                        <div className="flex flex-wrap items-center gap-1.5 mb-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openUserProfile(notif.actor_id);
                            }}
                            className="font-bold text-sm text-slate-200 hover:text-indigo-300 hover:underline transition truncate max-w-[200px]"
                          >
                            {notif.actor_name}
                          </button>
                          <span className="text-[11px] text-slate-500 truncate font-mono">
                            {notif.actor_handle}
                          </span>
                          <span className={`text-[10px] font-bold px-2 py-0.2 rounded-md border ${typeBadgeBg}`}>
                            {typeLabel}
                          </span>
                        </div>

                        {/* アクションメッセージ */}
                        <div className="text-xs text-slate-300 mb-1.5">
                          {notif.type === 'reply' && (
                            <span>あなたの投稿に返信しました</span>
                          )}
                          {notif.type === 'reaction' && (
                            <span className="flex items-center space-x-1">
                              <span>リアクションしました:</span>
                              <span className="inline-block px-1.5 py-0.5 rounded-lg bg-slate-800 text-sm font-semibold border border-slate-700">
                                {notif.content}
                              </span>
                            </span>
                          )}
                          {notif.type === 'announce' && (
                            <span>あなたの投稿をリノート (RT) しました</span>
                          )}
                          {notif.type === 'follow' && (
                            <span>あなたをフォローしました</span>
                          )}
                          {notif.type === 'antenna' && (
                            <span className="text-emerald-300">アンテナ「{notif.content}」を受信しました</span>
                          )}
                          {notif.type === 'scheduled_published' && (
                            <span className="text-amber-300">予約投稿が正常に公開されました</span>
                          )}
                        </div>

                        {/* 返信内容の表示 (reply の場合) */}
                        {notif.type === 'reply' && notif.content && (
                          <div className="my-2 p-2.5 rounded-xl bg-slate-950/70 border border-slate-800 text-slate-200 text-xs leading-relaxed">
                            {notif.content}
                          </div>
                        )}

                        {/* 元投稿のプレビュー (post_content がある場合) */}
                        {notif.post_content && (
                          <div className="mt-1.5 px-3 py-1.5 rounded-xl bg-slate-950/40 border-l-2 border-indigo-500/50 text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                            「{notif.post_content}」
                          </div>
                        )}

                        {/* 日時 & 単一既読化ボタン */}
                        <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-slate-800/40 text-[10px] text-slate-500">
                          <span>{new Date(notif.created_at).toLocaleString('ja-JP')}</span>
                          {isUnread && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleMarkNotificationRead(notif.id);
                              }}
                              className="text-indigo-400 hover:text-indigo-300 hover:underline flex items-center space-x-1 transition"
                            >
                              <Check className="w-3 h-3" />
                              <span>既読にする</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>
      ) : currentView === 'profile' ? (
        /* ユーザー詳細プロフィールビュー (Misskey / X 風) */
        <main className="max-w-4xl mx-auto px-4 py-6 w-full flex-1">
          {/* 戻るボタン */}
          <div className="mb-4">
            <button
              onClick={() => navigateToView('timeline')}
              className="inline-flex items-center space-x-2 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800 transition text-xs font-semibold"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>タイムラインに戻る</span>
            </button>
          </div>

          {isLoadingProfile ? (
            <div className="text-center py-24 bg-slate-900/60 rounded-3xl border border-slate-800 shadow-xl">
              <RefreshCw className="w-8 h-8 animate-spin mx-auto text-indigo-400 mb-3" />
              <p className="text-sm text-slate-400">
                ユーザープロフィール {profileTarget ? `(${profileTarget})` : ''} を読み込み中...
              </p>
            </div>
          ) : !profileData ? (
            <div className="text-center py-20 bg-slate-900/60 rounded-3xl border border-slate-800 shadow-xl">
              <AlertCircle className="w-10 h-10 mx-auto text-amber-400 mb-3" />
              <h3 className="text-lg font-bold text-slate-200">ユーザーが見つかりませんでした</h3>
              <p className="text-xs text-slate-400 mt-1">指定されたユーザーが存在しないか、サーバーとの通信に失敗しました。</p>
              <button
                onClick={() => navigateToView('timeline')}
                className="mt-5 px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-500 transition"
              >
                タイムラインに戻る
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              {/* プロフィールカード */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
                {/* ヘッダーバナー */}
                <div className="h-44 sm:h-56 relative bg-gradient-to-r from-indigo-950 via-slate-900 to-purple-950 overflow-hidden">
                  {profileData.banner_url ? (
                    <img
                      src={profileData.banner_url}
                      alt="Banner"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full opacity-30 bg-[radial-gradient(#4f46e5_1px,transparent_1px)] [background-size:16px_16px]" />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-slate-900/90 via-slate-900/30 to-transparent" />
                </div>

                {/* プロフィールメイン情報 */}
                <div className="px-6 pb-6 pt-0 relative">
                  {/* アバター & アクションボタン */}
                  <div className="flex flex-col sm:flex-row sm:items-end justify-between -mt-16 sm:-mt-20 mb-4 gap-4">
                    <div className="relative w-28 h-28 sm:w-32 sm:h-32 rounded-3xl p-1 bg-slate-900 shadow-2xl shrink-0">
                      {profileData.icon_url ? (
                        <img
                          src={profileData.icon_url}
                          alt={profileData.name}
                          className="w-full h-full rounded-2xl object-cover border border-slate-700/60 bg-slate-800 shadow-inner"
                          onError={(e) => {
                            (e.target as HTMLElement).style.display = 'none';
                            const fb = (e.target as HTMLElement).nextElementSibling as HTMLElement;
                            if (fb) fb.style.display = 'flex';
                          }}
                        />
                      ) : null}
                      <div
                        className={`w-full h-full rounded-2xl items-center justify-center font-black text-3xl sm:text-4xl text-white shadow-inner ${
                          profileData.icon_url ? 'hidden' : 'flex'
                        } ${
                          profileData.is_local
                            ? 'bg-gradient-to-tr from-indigo-500 to-purple-600'
                            : 'bg-gradient-to-tr from-emerald-500 to-teal-600'
                        }`}
                      >
                        {profileData.name.slice(0, 1).toUpperCase()}
                      </div>
                    </div>

                    {/* ボタン群 */}
                    <div className="flex items-center space-x-3 pt-2">
                      {authUser && profileData.is_local && authUser.id === profileData.id ? (
                        <div className="flex items-center space-x-2">
                          <button
                            onClick={openEditProfileModal}
                            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-lg shadow-indigo-600/30 flex items-center space-x-1.5 transition"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            <span>プロフィールを編集</span>
                          </button>
                          <button
                            onClick={() => openSettings('preferences')}
                            className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white font-bold text-xs border border-slate-700 transition flex items-center space-x-1.5"
                            title="ユーザー設定を開く"
                          >
                            <Settings className="w-3.5 h-3.5 text-indigo-400" />
                            <span>設定</span>
                          </button>
                        </div>
                      ) : authUser ? (
                        <div className="flex items-center space-x-2">
                          {profileData.is_blocked ? (
                            <button
                              onClick={() => handleUnblockUser(profileData.handle || profileData.id)}
                              className="px-4 py-2 rounded-xl font-bold text-xs bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/30 flex items-center space-x-1.5 transition cursor-pointer"
                            >
                              <Ban className="w-3.5 h-3.5" />
                              <span>ブロック中 (解除)</span>
                            </button>
                          ) : (
                            <>
                              {/* フォローボタン */}
                              <button
                                onClick={handleToggleProfileFollow}
                                disabled={isTogglingFollow}
                                className={`px-4 py-2 rounded-xl font-bold text-xs shadow-lg transition flex items-center space-x-1.5 cursor-pointer ${
                                  profileData.is_following
                                    ? 'bg-slate-800 text-slate-200 border border-slate-700 hover:bg-rose-950/40 hover:text-rose-300 hover:border-rose-500/30'
                                    : 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white hover:from-indigo-500 hover:to-purple-500 shadow-indigo-600/30'
                                }`}
                              >
                                {isTogglingFollow ? (
                                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                ) : profileData.is_following ? (
                                  <>
                                    <UserCheck className="w-3.5 h-3.5 text-emerald-400" />
                                    <span>フォロー中</span>
                                  </>
                                ) : (
                                  <>
                                    <UserPlus className="w-3.5 h-3.5" />
                                    <span>フォローする</span>
                                  </>
                                )}
                              </button>

                              {/* ミュートボタン */}
                              <button
                                onClick={() =>
                                  profileData.is_muted
                                    ? handleUnmuteUser(profileData.handle || profileData.id)
                                    : handleMuteUser(profileData.handle || profileData.id)
                                }
                                className={`p-2 rounded-xl text-xs font-bold border transition flex items-center space-x-1 cursor-pointer ${
                                  profileData.is_muted
                                    ? 'bg-amber-500/20 border-amber-500/40 text-amber-400 hover:bg-amber-500/30'
                                    : 'bg-slate-800/80 border-slate-700 text-slate-400 hover:text-amber-400 hover:bg-slate-800'
                                }`}
                                title={profileData.is_muted ? 'ミュートを解除' : 'このユーザーをミュート'}
                              >
                                {profileData.is_muted ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                              </button>

                              {/* ブロックボタン */}
                              <button
                                onClick={() => handleBlockUser(profileData.handle || profileData.id)}
                                className="p-2 rounded-xl text-xs font-bold border border-slate-700 bg-slate-800/80 text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition flex items-center space-x-1 cursor-pointer"
                                title="このユーザーをブロック"
                              >
                                <Ban className="w-4 h-4" />
                              </button>

                              {/* 通報ボタン */}
                              <button
                                onClick={() => {
                                  setReportCategory('spam');
                                  setReportComment('');
                                  setReportTarget({
                                    type: 'user',
                                    id: profileData.handle || profileData.id,
                                    label: profileData.name || profileData.handle || profileData.id,
                                  });
                                }}
                                className="p-2 rounded-xl text-xs font-bold border border-slate-700 bg-slate-800/80 text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition flex items-center space-x-1 cursor-pointer"
                                title="このユーザーを通報"
                              >
                                <ShieldAlert className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>
                      ) : (
                        <button
                          onClick={() => setShowLoginModal(true)}
                          className="px-4 py-2 rounded-xl font-bold text-xs bg-gradient-to-r from-indigo-600 to-purple-600 text-white hover:from-indigo-500 hover:to-purple-500 shadow-indigo-600/30 transition flex items-center space-x-1.5 cursor-pointer"
                        >
                          <UserPlus className="w-3.5 h-3.5" />
                          <span>フォローする</span>
                        </button>
                      )}

                      {profileData.actor_url && (
                        <a
                          href={profileData.actor_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-2 rounded-xl bg-slate-800/80 border border-slate-700 text-slate-400 hover:text-white hover:bg-slate-700 transition"
                          title="元のActivityPubプロフィールを開く"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      )}
                    </div>
                  </div>

                  {/* ユーザー名 & ハンドル */}
                  <div className="space-y-1 mb-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-xl sm:text-2xl font-black text-white">{profileData.name}</h2>
                      {profileData.is_local ? (
                        <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-bold flex items-center space-x-1">
                          <Server className="w-2.5 h-2.5" />
                          <span>Spica ローカル</span>
                        </span>
                      ) : (
                        <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-bold flex items-center space-x-1">
                          <Globe className="w-2.5 h-2.5" />
                          <span>{profileData.domain}</span>
                        </span>
                      )}
                    </div>
                    <p className="text-xs sm:text-sm text-indigo-400 font-mono select-all">
                      {profileData.handle}
                    </p>
                    {profileData.is_blocking_me && (
                      <div className="mt-2 p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center space-x-2">
                        <Ban className="w-4 h-4 text-rose-400 shrink-0" />
                        <span>あなたはこのユーザーからブロックされています。</span>
                      </div>
                    )}
                  </div>

                  {/* 自己紹介文 (bio) */}
                  {profileData.summary && (
                    <div className="mb-5 p-4 rounded-2xl bg-slate-950/60 border border-slate-800/80 text-sm text-slate-200 leading-relaxed">
                      <FormattedPostContent content={profileData.summary} />
                    </div>
                  )}

                  {/* 統計バー (投稿数, フォロー数, フォロワー数, 登録日) */}
                  <div className="flex flex-wrap items-center gap-4 sm:gap-6 pt-4 border-t border-slate-800/80 text-xs">
                    <div>
                      <span className="font-bold text-white text-sm sm:text-base mr-1.5">{profileData.post_count}</span>
                      <span className="text-slate-400">投稿</span>
                    </div>
                    {profileData.is_local && (
                      <>
                        <div>
                          <span className="font-bold text-white text-sm sm:text-base mr-1.5">{profileData.following_count}</span>
                          <span className="text-slate-400">フォロー中</span>
                        </div>
                        <div>
                          <span className="font-bold text-white text-sm sm:text-base mr-1.5">{profileData.follower_count}</span>
                          <span className="text-slate-400">フォロワー</span>
                        </div>
                      </>
                    )}
                    <div className="text-slate-500 flex items-center space-x-1 sm:ml-auto">
                      <Calendar className="w-3.5 h-3.5" />
                      <span>{profileData.is_local ? '参加日' : '初観測'}: {new Date(profileData.created_at).toLocaleDateString('ja-JP')}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* 📌 ピン留めされたノートセクション (プロフィール固定) */}
              {profileData.pinned_posts && profileData.pinned_posts.length > 0 && !profileData.is_blocked && (
                <div className="space-y-3">
                  <div className="flex items-center space-x-2 px-1 text-xs font-bold text-amber-400 tracking-wider uppercase">
                    <Pin className="w-4 h-4 fill-amber-400 text-amber-400" />
                    <span>ピン留めされたノート ({profileData.pinned_posts.length})</span>
                  </div>
                  <div className="space-y-4">
                    {profileData.pinned_posts.map((post) => renderPostCard({ ...post, is_pinned: true }))}
                  </div>
                </div>
              )}

              {/* 投稿一覧セクション */}
              <div className="space-y-4">
                <div className="flex items-center justify-between px-1">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 flex items-center space-x-2">
                    <MessageSquare className="w-4 h-4 text-indigo-400" />
                    <span>{profileData.name} の投稿 ({profilePosts.length})</span>
                  </h3>
                </div>

                {profileData.is_blocked ? (
                  <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-12 text-center space-y-3 shadow-xl">
                    <div className="w-14 h-14 rounded-3xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center mx-auto text-rose-400">
                      <Ban className="w-7 h-7" />
                    </div>
                    <h3 className="text-base font-bold text-slate-200">このユーザーをブロックしています</h3>
                    <p className="text-xs text-slate-400 max-w-sm mx-auto leading-relaxed">
                      ブロック中のため、このユーザーの投稿は非表示になっています。
                    </p>
                    <button
                      type="button"
                      onClick={() => handleUnblockUser(profileData.handle || profileData.id)}
                      className="mt-3 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-rose-400 border border-slate-700 text-xs font-bold transition cursor-pointer"
                    >
                      ブロックを解除する
                    </button>
                  </div>
                ) : profilePosts.length === 0 ? (
                  <div className="text-center py-16 bg-slate-900/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                    まだ投稿がありません。
                  </div>
                ) : (
                  profilePosts.map((post) => renderPostCard(post))
                )}
              </div>
            </div>
          )}
        </main>
      ) : (
        /* 🌟 Misskey風 3カラム統合レイアウト (PC: 左固定ナビ+中央タイムライン/検索+右ウィジェット / モバイル: 1カラム) */
        <div className="max-w-[1440px] mx-auto px-2 sm:px-4 py-4 flex gap-6 w-full flex-1 pb-24 md:pb-6 min-w-0">
          {/* 📋 左サイドバー (Misskey デスクトップ固定ナビゲーション) */}
          <aside className="hidden md:flex flex-col w-56 lg:w-64 shrink-0 sticky top-16 h-[calc(100vh-5rem)] pb-2 select-none justify-between">
            <div className="space-y-4">
              {/* ナビゲーションメニュー */}
              <nav className="space-y-1">
                {/* タイムライン */}
                <button
                  type="button"
                  onClick={() => {
                    navigateToView('timeline');
                    handleSwitchTimelineMode('home');
                  }}
                  className={`w-full flex items-center space-x-3 px-3.5 py-3 rounded-2xl text-sm font-bold transition cursor-pointer ${
                    currentView === 'timeline'
                      ? 'bg-slate-900 text-emerald-400 border border-emerald-500/30 shadow-md'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-slate-900/60'
                  }`}
                >
                  <Home className="w-5 h-5" />
                  <span>タイムライン</span>
                </button>

                {/* 通知 */}
                <button
                  type="button"
                  onClick={() => {
                    if (authUser) navigateToView('notifications');
                    else setShowLoginModal(true);
                  }}
                  className={`w-full flex items-center justify-between px-3.5 py-3 rounded-2xl text-sm font-bold transition cursor-pointer ${
                    (currentView as string) === 'notifications'
                      ? 'bg-slate-900 text-emerald-400 border border-emerald-500/30 shadow-md'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-slate-900/60'
                  }`}
                >
                  <div className="flex items-center space-x-3">
                    <Bell className="w-5 h-5" />
                    <span>通知</span>
                  </div>
                  {unreadNotificationsCount > 0 && (
                    <span className="px-2 py-0.5 text-xs font-black rounded-full bg-rose-500 text-white shadow">
                      {unreadNotificationsCount > 99 ? '99+' : unreadNotificationsCount}
                    </span>
                  )}
                </button>

                {/* 統合検索・見つける */}
                <button
                  type="button"
                  onClick={() => navigateToView('search')}
                  className={`w-full flex items-center space-x-3 px-3.5 py-3 rounded-2xl text-sm font-bold transition cursor-pointer ${
                    currentView === 'search'
                      ? 'bg-slate-900 text-emerald-400 border border-emerald-500/30 shadow-md'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-slate-900/60'
                  }`}
                >
                  <Search className="w-5 h-5" />
                  <span>見つける・検索</span>
                </button>

                {/* 🔖 ブックマーク */}
                <button
                  type="button"
                  onClick={() => {
                    if (authUser) {
                      navigateToView('bookmarks');
                      fetchBookmarks();
                    } else {
                      setShowLoginModal(true);
                    }
                  }}
                  className={`w-full flex items-center space-x-3 px-3.5 py-3 rounded-2xl text-sm font-bold transition cursor-pointer ${
                    currentView === 'bookmarks'
                      ? 'bg-slate-900 text-emerald-400 border border-emerald-500/30 shadow-md'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-slate-900/60'
                  }`}
                >
                  <Bookmark className="w-5 h-5" />
                  <span>ブックマーク</span>
                </button>

                {/* 📢 チャンネル */}
                <button
                  type="button"
                  onClick={() => {
                    navigateToView('channels');
                    fetchChannels();
                  }}
                  className={`w-full flex items-center justify-between px-3.5 py-3 rounded-2xl text-sm font-bold transition cursor-pointer ${
                    currentView === 'channels'
                      ? 'bg-slate-900 text-emerald-400 border border-emerald-500/30 shadow-md'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-slate-900/60'
                  }`}
                >
                  <div className="flex items-center space-x-3">
                    <Hash className="w-5 h-5 text-indigo-400" />
                    <span>チャンネル</span>
                  </div>
                  {channels.length > 0 && (
                    <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-indigo-500/20 text-indigo-300 font-mono">
                      {channels.length}
                    </span>
                  )}
                </button>

                {/* 👥 ユーザーディレクトリ */}
                <button
                  type="button"
                  onClick={() => { setShowDirectoryModal(true); fetchDirectory(''); }}
                  className="w-full flex items-center justify-between px-3.5 py-3 rounded-2xl text-sm font-bold transition cursor-pointer text-slate-400 hover:text-slate-100 hover:bg-slate-900/60"
                >
                  <div className="flex items-center space-x-3">
                    <Users className="w-5 h-5 text-cyan-400" />
                    <span>ユーザー一覧</span>
                  </div>
                </button>

                {/* 📋 リスト */}
                <button
                  type="button"
                  onClick={() => { setShowListsModal(true); fetchLists(); }}
                  className="w-full flex items-center justify-between px-3.5 py-3 rounded-2xl text-sm font-bold transition cursor-pointer text-slate-400 hover:text-slate-100 hover:bg-slate-900/60"
                >
                  <div className="flex items-center space-x-3">
                    <ListIcon className="w-5 h-5 text-sky-400" />
                    <span>リスト</span>
                  </div>
                  {lists.length > 0 && (
                    <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-sky-500/20 text-sky-300 font-mono">
                      {lists.length}
                    </span>
                  )}
                </button>

                {/* 📡 アンテナ */}
                <button
                  type="button"
                  onClick={openAntennaManageModal}
                  className="w-full flex items-center justify-between px-3.5 py-3 rounded-2xl text-sm font-bold transition cursor-pointer text-slate-400 hover:text-slate-100 hover:bg-slate-900/60"
                >
                  <div className="flex items-center space-x-3">
                    <Radio className="w-5 h-5 text-emerald-400" />
                    <span>アンテナ</span>
                  </div>
                  {antennas.length > 0 && (
                    <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-emerald-500/20 text-emerald-300 font-mono">
                      {antennas.length}
                    </span>
                  )}
                </button>

                {/* 🗂️ ドライブ */}
                <button
                  type="button"
                  onClick={() => {
                    if (authUser) {
                      setShowDriveModal(true);
                      fetchDrive();
                    } else {
                      setShowLoginModal(true);
                    }
                  }}
                  className="w-full flex items-center justify-between px-3.5 py-3 rounded-2xl text-sm font-bold transition cursor-pointer text-slate-400 hover:text-slate-100 hover:bg-slate-900/60"
                >
                  <div className="flex items-center space-x-3">
                    <HardDrive className="w-5 h-5 text-emerald-400" />
                    <span>ドライブ</span>
                  </div>
                </button>

                {/* マイページ */}
                <button
                  type="button"
                  onClick={() => {
                    if (authUser) openUserProfile(authUser.id);
                    else setShowLoginModal(true);
                  }}
                  className={`w-full flex items-center space-x-3 px-3.5 py-3 rounded-2xl text-sm font-bold transition cursor-pointer ${
                    (currentView as string) === 'profile' && profileTarget === authUser?.id
                      ? 'bg-slate-900 text-emerald-400 border border-emerald-500/30 shadow-md'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-slate-900/60'
                  }`}
                >
                  <User className="w-5 h-5" />
                  <span>マイページ</span>
                </button>

                {/* 設定 */}
                <button
                  type="button"
                  onClick={() => openSettings('profile')}
                  className={`w-full flex items-center space-x-3 px-3.5 py-3 rounded-2xl text-sm font-bold transition cursor-pointer ${
                    (currentView as string) === 'settings'
                      ? 'bg-slate-900 text-emerald-400 border border-emerald-500/30 shadow-md'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-slate-900/60'
                  }`}
                >
                  <Settings className="w-5 h-5" />
                  <span>設定</span>
                </button>

                {/* 管理者用コントロールパネル */}
                {authUser?.role === 'admin' && (
                  <button
                    type="button"
                    onClick={() => navigateToView('admin')}
                    className="w-full flex items-center space-x-3 px-3.5 py-3 rounded-2xl text-sm font-bold text-purple-400 hover:bg-purple-950/30 border border-purple-500/20 hover:border-purple-500/40 transition cursor-pointer"
                  >
                    <ShieldCheck className="w-5 h-5 text-purple-400" />
                    <span>コントロールパネル</span>
                  </button>
                )}
              </nav>

              {/* ✏️ 大きな丸みのある「ノート (Note)」投稿ボタン (Misskeyスタイル) */}
              {authUser && (
                <button
                  type="button"
                  onClick={() => {
                    if (currentView !== 'timeline') navigateToView('timeline');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="w-full py-3.5 px-4 bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950 font-black rounded-2xl shadow-lg shadow-emerald-500/25 hover:shadow-emerald-500/40 transition flex items-center justify-center space-x-2 text-base group cursor-pointer"
                >
                  <Edit3 className="w-5 h-5 group-hover:rotate-12 transition-transform" />
                  <span>ノートを作成</span>
                </button>
              )}
            </div>

            {/* 左サイドバー最下部: ユーザーアカウントバー */}
            {authUser ? (
              <div className="pt-3 border-t border-slate-800/80">
                <div className="flex items-center justify-between p-2 rounded-2xl bg-slate-900/70 border border-slate-800">
                  <div
                    onClick={() => openUserProfile(authUser.id)}
                    className="flex items-center space-x-2.5 min-w-0 cursor-pointer group flex-1"
                  >
                    <div className="w-9 h-9 rounded-xl overflow-hidden bg-gradient-to-tr from-cyan-500 via-indigo-600 to-purple-600 flex items-center justify-center font-bold text-xs text-white shrink-0 shadow">
                      {authUser.icon_url ? (
                        <img src={authUser.icon_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        authUser.name.slice(0, 1).toUpperCase()
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-slate-200 group-hover:text-emerald-400 transition truncate">{authUser.name}</p>
                      <p className="text-[11px] text-slate-500 font-mono truncate">{authUser.handle}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-slate-800 transition"
                    title="ログアウト"
                  >
                    <LogOut className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="pt-3 border-t border-slate-800/80 space-y-2">
                <button
                  type="button"
                  onClick={() => setShowLoginModal(true)}
                  className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs transition"
                >
                  ログイン
                </button>
                <button
                  type="button"
                  onClick={() => setShowRegisterModal(true)}
                  className="w-full py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 font-bold rounded-xl text-xs transition"
                >
                  新規登録
                </button>
              </div>
            )}
          </aside>

          {/* 📱 中央メインコンテンツ */}
          <main className="flex-1 min-w-0 max-w-2xl xl:max-w-3xl space-y-4">
            {currentView === 'search' ? (
              /* 🔍 統合検索画面 (Misskey探索 & WebFinger外部アカウント解決) */
              <div className="space-y-4">
                {/* 検索入力カード */}
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-4 sm:p-5 shadow-xl space-y-3">
                  <form onSubmit={handleSearchSubmit} className="flex gap-2">
                    <div className="relative flex-1">
                      <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        placeholder="ノート本文の全文検索、@user@domain、#タグ..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-10 pr-4 py-2.5 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition font-sans"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={isSearching}
                      className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm rounded-2xl shadow-md transition shrink-0 flex items-center space-x-1.5 cursor-pointer"
                    >
                      {isSearching ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                      <span>検索</span>
                    </button>
                  </form>

                  {/* ⚡ SQLite FTS5 (trigram) 高速全文検索ガイダンス */}
                  <div className="flex items-center justify-between text-[11px] text-slate-400 px-1 pt-0.5">
                    <span className="flex items-center space-x-1.5 text-emerald-400/90 font-medium">
                      <Zap className="w-3 h-3 text-emerald-400 shrink-0" />
                      <span>SQLite FTS5 trigram 全文検索対応 (過去のノートを本文キーワードで高速検索)</span>
                    </span>
                    <span className="text-[10px] text-slate-500 hidden sm:inline">スペース区切りでAND検索</span>
                  </div>

                  {/* タブ切り替え */}
                  {searchResults && (
                    <div className="flex items-center space-x-2 pt-2 border-t border-slate-800/60">
                      <button
                        type="button"
                        onClick={() => setSearchTab('all')}
                        className={`px-3 py-1 text-xs font-bold rounded-xl transition cursor-pointer ${
                          searchTab === 'all'
                            ? 'bg-emerald-500 text-slate-950 font-black'
                            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                        }`}
                      >
                        すべて
                      </button>
                      <button
                        type="button"
                        onClick={() => setSearchTab('users')}
                        className={`px-3 py-1 text-xs font-bold rounded-xl transition cursor-pointer ${
                          searchTab === 'users'
                            ? 'bg-emerald-500 text-slate-950 font-black'
                            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                        }`}
                      >
                        ユーザー ({(searchResults.remoteUser ? 1 : 0) + (searchResults.users?.length || 0)})
                      </button>
                      <button
                        type="button"
                        onClick={() => setSearchTab('posts')}
                        className={`px-3 py-1 text-xs font-bold rounded-xl transition cursor-pointer ${
                          searchTab === 'posts'
                            ? 'bg-emerald-500 text-slate-950 font-black'
                            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                        }`}
                      >
                        投稿 ({searchResults.posts?.length || 0})
                      </button>
                    </div>
                  )}
                </div>

                {/* 🌐 Fediverse 外部アクター解決結果カード */}
                {searchResults?.remoteUser && (searchTab === 'all' || searchTab === 'users') && (
                  <div className="bg-gradient-to-r from-purple-950/40 via-indigo-950/40 to-slate-900 border-2 border-indigo-500/40 rounded-3xl p-5 shadow-2xl space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black text-indigo-400 uppercase tracking-wider flex items-center space-x-1.5">
                        <Radio className="w-4 h-4 text-indigo-400" />
                        <span>🌐 Fediverse 外部アカウントを発見</span>
                      </span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 font-mono">
                        WebFinger Verified
                      </span>
                    </div>

                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center space-x-3 min-w-0">
                        <div className="w-12 h-12 rounded-2xl overflow-hidden bg-slate-800 border border-indigo-500/40 shrink-0">
                          {searchResults.remoteUser.icon_url ? (
                            <img src={searchResults.remoteUser.icon_url} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center font-bold text-white bg-indigo-600">
                              {searchResults.remoteUser.name?.slice(0, 1) || 'U'}
                            </div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <h4 className="font-black text-base text-white truncate">{searchResults.remoteUser.name}</h4>
                          <p className="text-xs text-indigo-300 font-mono truncate">{searchResults.remoteUser.handle}</p>
                        </div>
                      </div>

                      <button
                        onClick={() => handleToggleSearchUserFollow(searchResults.remoteUser)}
                        className={`px-4 py-2 rounded-2xl text-xs font-bold transition flex items-center space-x-1.5 shrink-0 shadow-md cursor-pointer ${
                          searchResults.remoteUser.is_following
                            ? 'bg-slate-800 text-slate-300 border border-slate-700 hover:bg-rose-900/30 hover:text-rose-300'
                            : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/30'
                        }`}
                      >
                        {searchResults.remoteUser.is_following ? (
                          <>
                            <UserCheck className="w-4 h-4 text-emerald-400" />
                            <span>フォロー中</span>
                          </>
                        ) : (
                          <>
                            <UserPlus className="w-4 h-4" />
                            <span>フォローする</span>
                          </>
                        )}
                      </button>
                    </div>

                    {searchResults.remoteUser.summary && (
                      <div
                        className="text-xs text-slate-300 line-clamp-3 bg-slate-950/60 p-3 rounded-2xl border border-slate-800/80 leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(searchResults.remoteUser.summary) }}
                      />
                    )}
                  </div>
                )}

                {/* ユーザー一覧 */}
                {searchResults && (searchTab === 'all' || searchTab === 'users') && searchResults.users?.length > 0 && (
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center">
                      <Users className="w-4 h-4 mr-1.5 text-emerald-400" />
                      ユーザー ({searchResults.users.length})
                    </h3>
                    <div className="divide-y divide-slate-800/60">
                      {searchResults.users.map((u: any) => (
                        <div key={u.id} className="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
                          <div
                            onClick={() => openUserProfile(u.id)}
                            className="flex items-center space-x-3 cursor-pointer min-w-0 group"
                          >
                            <div className="w-10 h-10 rounded-xl overflow-hidden bg-slate-800 shrink-0">
                              {u.icon_url ? (
                                <img src={u.icon_url} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center font-bold text-white bg-indigo-600">
                                  {u.name?.slice(0, 1) || 'U'}
                                </div>
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-slate-100 group-hover:text-emerald-400 transition truncate">{u.name}</p>
                              <p className="text-xs text-slate-400 font-mono truncate">{u.domain ? `@${u.username}@${u.domain}` : `@${u.id}`}</p>
                            </div>
                          </div>
                          <button
                            onClick={() => handleToggleSearchUserFollow(u)}
                            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center space-x-1 shrink-0 cursor-pointer ${
                              u.is_following
                                ? 'bg-slate-800 text-slate-300 border border-slate-700 hover:bg-rose-900/30 hover:text-rose-300'
                                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                            }`}
                          >
                            {u.is_following ? <UserCheck className="w-3.5 h-3.5 text-emerald-400" /> : <UserPlus className="w-3.5 h-3.5" />}
                            <span>{u.is_following ? 'フォロー中' : 'フォロー'}</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 投稿一覧 */}
                {searchResults && (searchTab === 'all' || searchTab === 'posts') && searchResults.posts?.length > 0 && (
                  <div className="space-y-4">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center px-1">
                      <MessageSquare className="w-4 h-4 mr-1.5 text-emerald-400" />
                      投稿 ({searchResults.posts.length})
                    </h3>
                    {searchResults.posts.map((post: Post) => renderPostCard(post))}
                  </div>
                )}

                {/* 検索前または該当なし */}
                {(!searchResults || (searchResults.users?.length === 0 && searchResults.posts?.length === 0 && !searchResults.remoteUser)) && !isSearching && (
                  <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-8 text-center space-y-6">
                    <div className="space-y-2">
                      <Hash className="w-12 h-12 text-emerald-400/40 mx-auto" />
                      <h3 className="text-base font-bold text-slate-200">
                        {searchResults ? '一致する検索結果が見つかりませんでした' : '話題のハッシュタグから探す'}
                      </h3>
                      <p className="text-xs text-slate-400 max-w-md mx-auto">
                        キーワード、@ユーザー名@サーバー、または以下のトレンドタグをタップして投稿を探しましょう。
                      </p>
                    </div>

                    {popularTags.length > 0 && (
                      <div className="flex flex-wrap justify-center gap-2 max-w-xl mx-auto">
                        {popularTags.map((item) => (
                          <button
                            key={item.tag}
                            onClick={() => handleSelectHashtag(item.tag)}
                            className="px-3.5 py-2 rounded-2xl bg-slate-950 hover:bg-emerald-600/20 border border-slate-800 hover:border-emerald-500/40 text-xs font-bold text-slate-300 hover:text-emerald-300 transition flex items-center space-x-1.5 cursor-pointer shadow-sm group"
                          >
                            <Hash className="w-3.5 h-3.5 text-emerald-400 group-hover:scale-110 transition-transform" />
                            <span>{item.tag}</span>
                            <span className="text-[10px] px-1.5 py-0.2 bg-slate-800 rounded-full text-slate-400 font-mono">
                              {item.count}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : currentView === 'bookmarks' ? (
              /* 🔖 ブックマーク一覧ビュー (Misskey風) */
              <div className="space-y-4">
                {/* ヘッダーカード */}
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-4 sm:p-5 shadow-xl flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 shadow">
                      <Bookmark className="w-5 h-5 fill-amber-400" />
                    </div>
                    <div>
                      <h2 className="text-base sm:text-lg font-black text-slate-100 flex items-center space-x-2">
                        <span>ブックマーク</span>
                        <span className="text-xs font-normal text-slate-400 font-mono">({bookmarks.length})</span>
                      </h2>
                      <p className="text-xs text-slate-400 mt-0.5">
                        保存したノートのプライベート一覧（あなただけに表示されます）
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={fetchBookmarks}
                    disabled={isLoadingBookmarks}
                    className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-300 hover:text-white transition disabled:opacity-50 cursor-pointer"
                    title="ブックマークを更新"
                  >
                    <RefreshCw className={`w-4 h-4 ${isLoadingBookmarks ? 'animate-spin text-amber-400' : ''}`} />
                  </button>
                </div>

                {/* ブックマークリスト */}
                <div className="space-y-4">
                  {isLoadingBookmarks ? (
                    <div className="text-center py-20 bg-slate-900/60 rounded-3xl border border-slate-800 shadow-xl">
                      <RefreshCw className="w-8 h-8 animate-spin mx-auto text-amber-400 mb-3" />
                      <p className="text-sm text-slate-400">ブックマークを読み込み中...</p>
                    </div>
                  ) : bookmarks.length === 0 ? (
                    <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-12 text-center space-y-3 shadow-xl">
                      <div className="w-14 h-14 rounded-3xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto text-amber-400/80">
                        <Bookmark className="w-7 h-7" />
                      </div>
                      <h3 className="text-base font-bold text-slate-200">ブックマークしたノートはありません</h3>
                      <p className="text-xs text-slate-400 max-w-sm mx-auto leading-relaxed">
                        タイムラインや検索で見つけたノートの 🔖 アイコンを押すと、ここに保存されていつでも見返すことができます。
                      </p>
                    </div>
                  ) : (
                    bookmarks.map((post) => renderPostCard(post))
                  )}
                </div>
              </div>
            ) : currentView === 'channels' ? (
              /* 📢 チャンネル機能ビュー (Misskey風 トピック別掲示板) */
              <div className="space-y-4">
                {selectedChannel ? (
                  /* 📢 選択中チャンネル詳細 & タイムライン */
                  <div className="space-y-4">
                    <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-4 overflow-hidden relative">
                      <div
                        className="h-2 absolute top-0 left-0 right-0"
                        style={{ backgroundColor: selectedChannel.color || '#6366f1' }}
                      />
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => setSelectedChannel(null)}
                          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-300 text-xs font-bold transition cursor-pointer"
                        >
                          <ArrowLeft className="w-3.5 h-3.5" />
                          <span>全チャンネル一覧へ</span>
                        </button>
                        <div className="flex items-center space-x-2">
                          <button
                            type="button"
                            onClick={() => handleToggleChannelFollow(selectedChannel.id)}
                            className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition flex items-center space-x-1.5 cursor-pointer shadow-sm ${
                              selectedChannel.is_following
                                ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/40 hover:bg-rose-500/20 hover:text-rose-300 hover:border-rose-500/40'
                                : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                            }`}
                          >
                            <Users className="w-3.5 h-3.5" />
                            <span>{selectedChannel.is_following ? '参加中' : '参加する'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => openChannelDetail(selectedChannel)}
                            disabled={isLoadingChannelTimeline}
                            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-300 transition cursor-pointer"
                            title="更新"
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingChannelTimeline ? 'animate-spin text-indigo-400' : ''}`} />
                          </button>
                        </div>
                      </div>

                      <div className="flex items-start space-x-3.5">
                        <div
                          className="w-12 h-12 rounded-2xl flex items-center justify-center text-white text-xl font-black shadow-lg shrink-0"
                          style={{ backgroundColor: selectedChannel.color || '#6366f1' }}
                        >
                          <Hash className="w-6 h-6" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <h2 className="text-lg font-black text-slate-100 flex items-center space-x-2 truncate">
                            <span>{selectedChannel.name}</span>
                          </h2>
                          {selectedChannel.description && (
                            <p className="text-xs text-slate-300 mt-1 leading-relaxed whitespace-pre-wrap">
                              {selectedChannel.description}
                            </p>
                          )}
                          <div className="flex items-center space-x-4 text-xs text-slate-400 mt-2 font-semibold">
                            <span>ノート: <strong className="text-slate-200">{selectedChannel.posts_count}</strong></span>
                            <span>参加者: <strong className="text-slate-200">{selectedChannel.followers_count}</strong></span>
                          </div>
                        </div>
                      </div>

                      {/* このチャンネル宛てクイック投稿誘導 */}
                      {authUser && (
                        <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between">
                          <span className="text-xs text-slate-400">
                            {postTargetChannelId === selectedChannel.id ? (
                              <strong className="text-indigo-300">📢 投稿フォームでこのチャンネルが選択されています</strong>
                            ) : (
                              'このチャンネルにノートを投稿しますか？'
                            )}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setPostTargetChannelId(selectedChannel.id);
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                              document.querySelector<HTMLTextAreaElement>('#main-post-textarea')?.focus();
                            }}
                            className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow cursor-pointer"
                          >
                            このチャンネルに投稿する
                          </button>
                        </div>
                      )}
                    </div>

                    {/* チャンネル内タイムライン */}
                    <div className="space-y-4">
                      {isLoadingChannelTimeline ? (
                        <div className="text-center py-20 bg-slate-900/60 rounded-3xl border border-slate-800 shadow-xl">
                          <RefreshCw className="w-8 h-8 animate-spin mx-auto text-indigo-400 mb-3" />
                          <p className="text-sm text-slate-400">ノートを読み込み中...</p>
                        </div>
                      ) : channelTimelinePosts.length === 0 ? (
                        <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-12 text-center space-y-3 shadow-xl">
                          <div className="w-14 h-14 rounded-3xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mx-auto text-indigo-400">
                            <MessageSquare className="w-7 h-7" />
                          </div>
                          <h3 className="text-base font-bold text-slate-200">まだノートがありません</h3>
                          <p className="text-xs text-slate-400 max-w-sm mx-auto leading-relaxed">
                            このチャンネルの最初の投稿者になりましょう！
                          </p>
                          {authUser && (
                            <button
                              type="button"
                              onClick={() => {
                                setPostTargetChannelId(selectedChannel.id);
                                window.scrollTo({ top: 0, behavior: 'smooth' });
                                document.querySelector<HTMLTextAreaElement>('#main-post-textarea')?.focus();
                              }}
                              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow transition cursor-pointer"
                            >
                              このチャンネルにノートを投稿する
                            </button>
                          )}
                        </div>
                      ) : (
                        channelTimelinePosts.map((post) => renderPostCard(post))
                      )}
                    </div>
                  </div>
                ) : (
                  /* 📢 チャンネル一覧 & 探索 */
                  <div className="space-y-4">
                    <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-4 sm:p-5 shadow-xl space-y-4">
                      <div className="flex items-center justify-between flex-wrap gap-3">
                        <div className="flex items-center space-x-3">
                          <div className="w-10 h-10 rounded-2xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400 shadow">
                            <Layers className="w-5 h-5" />
                          </div>
                          <div>
                            <h2 className="text-base sm:text-lg font-black text-slate-100 flex items-center space-x-2">
                              <span>チャンネル</span>
                              <span className="text-xs font-normal text-slate-400 font-mono">({channels.length})</span>
                            </h2>
                            <p className="text-xs text-slate-400 mt-0.5">
                              興味のあるトピックに参加して、仲間と会話を深めましょう
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center space-x-2">
                          <button
                            type="button"
                            onClick={openCreateChannelModal}
                            className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition flex items-center space-x-1.5 shadow-md shadow-indigo-600/30 cursor-pointer"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>チャンネル作成</span>
                          </button>
                          <button
                            type="button"
                            onClick={fetchChannels}
                            disabled={isLoadingChannels}
                            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-300 transition cursor-pointer"
                            title="更新"
                          >
                            <RefreshCw className={`w-4 h-4 ${isLoadingChannels ? 'animate-spin text-indigo-400' : ''}`} />
                          </button>
                        </div>
                      </div>

                      {/* カテゴリフィルタ */}
                      <div className="flex items-center space-x-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
                        {[
                          { id: 'all', label: 'すべて' },
                          { id: 'general', label: '💬 総合・雑談' },
                          { id: 'gaming', label: '🎮 ゲーム' },
                          { id: 'tech', label: '💻 技術・IT' },
                          { id: 'art', label: '🎨 イラスト・創作' },
                        ].map((cat) => (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => {
                              setChannelCategoryFilter(cat.id);
                              fetchChannels();
                            }}
                            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer shrink-0 ${
                              channelCategoryFilter === cat.id
                                ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/40'
                                : 'bg-slate-950/60 border border-slate-800 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {cat.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* チャンネルカードグリッド */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                      {isLoadingChannels ? (
                        <div className="col-span-full text-center py-20 bg-slate-900/60 rounded-3xl border border-slate-800 shadow-xl">
                          <RefreshCw className="w-8 h-8 animate-spin mx-auto text-indigo-400 mb-3" />
                          <p className="text-sm text-slate-400">チャンネルを読み込み中...</p>
                        </div>
                      ) : channels.length === 0 ? (
                        <div className="col-span-full bg-slate-900/60 border border-slate-800 rounded-3xl p-12 text-center space-y-3 shadow-xl">
                          <div className="w-14 h-14 rounded-3xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mx-auto text-indigo-400">
                            <Layers className="w-7 h-7" />
                          </div>
                          <h3 className="text-base font-bold text-slate-200">チャンネルがありません</h3>
                          <p className="text-xs text-slate-400 max-w-sm mx-auto leading-relaxed">
                            最初のチャンネルを作成して、趣味や話題ごとの広場を開設しましょう！
                          </p>
                          {authUser && (
                            <button
                              type="button"
                              onClick={openCreateChannelModal}
                              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow transition cursor-pointer"
                            >
                              チャンネルを作成する
                            </button>
                          )}
                        </div>
                      ) : (
                        channels.map((ch) => (
                          <div
                            key={ch.id}
                            className="bg-slate-900/90 border border-slate-800 hover:border-slate-700 rounded-2xl p-4 shadow-lg flex flex-col justify-between transition relative overflow-hidden group"
                          >
                            <div
                              className="h-1.5 absolute top-0 left-0 right-0"
                              style={{ backgroundColor: ch.color || '#6366f1' }}
                            />
                            <div className="space-y-2">
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex items-center space-x-2.5 min-w-0">
                                  <div
                                    className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold shrink-0 shadow"
                                    style={{ backgroundColor: ch.color || '#6366f1' }}
                                  >
                                    <Hash className="w-4 h-4" />
                                  </div>
                                  <div className="min-w-0">
                                    <h4 className="font-bold text-sm text-slate-100 truncate group-hover:text-indigo-300 transition">
                                      {ch.name}
                                    </h4>
                                    <div className="flex items-center space-x-2 text-[10px] text-slate-400 mt-0.5">
                                      <span>ノート {ch.posts_count}</span>
                                      <span>・</span>
                                      <span>参加 {ch.followers_count}人</span>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {ch.description && (
                                <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">
                                  {ch.description}
                                </p>
                              )}
                            </div>

                            <div className="pt-3 mt-3 border-t border-slate-800/60 flex items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={() => openChannelDetail(ch)}
                                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-750 text-slate-200 rounded-xl text-xs font-bold transition flex items-center space-x-1 cursor-pointer"
                              >
                                <span>開く</span>
                                <ArrowRight className="w-3.5 h-3.5" />
                              </button>

                              {authUser && (
                                <button
                                  type="button"
                                  onClick={() => handleToggleChannelFollow(ch.id)}
                                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                                    ch.is_following
                                      ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/40 hover:bg-rose-500/20 hover:text-rose-300'
                                      : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                                  }`}
                                >
                                  {ch.is_following ? '参加中' : '参加'}
                                </button>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* 🏠 通常タイムラインビュー */
              <div className="space-y-4">
                {/* タイムライン上部タブ (Misskeyスタイル) */}
                <div className="flex items-center justify-between bg-slate-900/90 border border-slate-800 rounded-2xl p-2 px-3 shadow-lg">
                  <div className="flex items-center space-x-1 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                    <button
                      type="button"
                      onClick={() => handleSwitchTimelineMode('home')}
                      className={`px-3 py-1.5 text-xs font-bold rounded-xl transition flex items-center space-x-1.5 shrink-0 cursor-pointer ${
                        timelineMode === 'home'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                      }`}
                    >
                      <Home className="w-3.5 h-3.5" />
                      <span>ホーム</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSwitchTimelineMode('local')}
                      className={`px-3 py-1.5 text-xs font-bold rounded-xl transition flex items-center space-x-1.5 shrink-0 cursor-pointer ${
                        timelineMode === 'local'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                      }`}
                    >
                      <Server className="w-3.5 h-3.5" />
                      <span>ローカル</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSwitchTimelineMode('all')}
                      className={`px-3 py-1.5 text-xs font-bold rounded-xl transition flex items-center space-x-1.5 shrink-0 cursor-pointer ${
                        timelineMode === 'all'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                      }`}
                    >
                      <Globe className="w-3.5 h-3.5" />
                      <span>連合</span>
                    </button>

                    {/* 📡 作成済みアンテナのタブ一覧 */}
                    {antennas.map((ant) => {
                      const isActive = timelineMode === 'antenna' && activeAntenna?.id === ant.id;
                      return (
                        <button
                          key={ant.id}
                          type="button"
                          onClick={() => handleSwitchTimelineMode('antenna', ant)}
                          className={`px-3 py-1.5 text-xs font-bold rounded-xl transition flex items-center space-x-1.5 shrink-0 cursor-pointer ${
                            isActive
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                          }`}
                          title={`アンテナ「${ant.name}」を表示`}
                        >
                          <Radio className="w-3.5 h-3.5 text-emerald-400" />
                          <span>{ant.name}</span>
                        </button>
                      );
                    })}

                    {/* 📡 アンテナ管理・追加ボタン */}
                    <button
                      type="button"
                      onClick={openAntennaManageModal}
                      className="px-2.5 py-1.5 text-xs font-bold rounded-xl transition flex items-center space-x-1 shrink-0 text-slate-400 hover:text-emerald-300 hover:bg-slate-800/60 cursor-pointer border border-dashed border-slate-700/60 hover:border-emerald-500/40"
                      title="アンテナの管理・新規作成"
                    >
                      <Plus className="w-3.5 h-3.5 text-emerald-400" />
                      <span>アンテナ</span>
                      {antennas.length > 0 && (
                        <span className="text-[10px] text-slate-500 font-mono">({antennas.length})</span>
                      )}
                    </button>

                    {timelineMode === 'tag' && activeHashtag && (
                      <div className="flex items-center space-x-1 px-3 py-1.5 text-xs font-bold rounded-xl bg-indigo-600/30 text-indigo-300 border border-indigo-500/50 shadow-sm shrink-0">
                        <Hash className="w-3.5 h-3.5 text-indigo-400" />
                        <span>{activeHashtag}</span>
                        <button
                          type="button"
                          onClick={() => handleSwitchTimelineMode('local')}
                          className="p-0.5 hover:text-white rounded ml-1 transition cursor-pointer"
                          title="タグ絞り込みを解除"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center space-x-2 shrink-0">
                    <div
                      className="flex items-center space-x-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-slate-950 border border-slate-800"
                      title={isStreamingConnected ? 'リアルタイムストリーミング接続中 (SSE)' : 'ストリーミング接続待機中...'}
                    >
                      <span className={`w-2 h-2 rounded-full ${isStreamingConnected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
                      <span className="text-[10px] text-slate-400 font-mono">{isStreamingConnected ? 'Live' : 'Offline'}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => fetchTimeline(timelineMode)}
                      disabled={isLoadingTimeline}
                      className="p-1.5 text-slate-400 hover:text-slate-200 rounded-xl hover:bg-slate-800 transition shrink-0 cursor-pointer"
                      title="再読み込み"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isLoadingTimeline ? 'animate-spin text-emerald-400' : ''}`} />
                    </button>
                  </div>
                </div>

                {/* 投稿フォーム */}
                {authUser ? (
                  <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl space-y-3">
                    <form onSubmit={handleCreatePost} className="space-y-3">
                      <div className="flex items-center justify-between gap-2 pb-1 border-b border-slate-800/60">
                        <span className="text-xs font-bold text-slate-200 flex items-center">
                          <Edit3 className="w-4 h-4 mr-1.5 text-emerald-400" />
                          ノートを作成
                        </span>
                        <div className="flex items-center space-x-1 bg-slate-950 p-1 rounded-xl border border-slate-800">
                          <button
                            type="button"
                            onClick={() => setPostVisibility('public')}
                            className={`px-3 py-1 text-xs font-bold rounded-lg transition flex items-center space-x-1.5 cursor-pointer ${
                              postVisibility === 'public'
                                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            <Globe className="w-3.5 h-3.5 text-indigo-200" />
                            <span>🌐 連合</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setPostVisibility('local')}
                            className={`px-3 py-1 text-xs font-bold rounded-lg transition flex items-center space-x-1.5 cursor-pointer ${
                              postVisibility === 'local'
                                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/30'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            <Server className="w-3.5 h-3.5 text-emerald-200" />
                            <span>🏠 ローカル</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setPostVisibility('followers')}
                            className={`px-3 py-1 text-xs font-bold rounded-lg transition flex items-center space-x-1.5 cursor-pointer ${
                              postVisibility === 'followers'
                                ? 'bg-amber-600 text-white shadow-md shadow-amber-600/30'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            <Users className="w-3.5 h-3.5 text-amber-200" />
                            <span>🔒 フォロワー</span>
                          </button>
                        </div>
                      </div>

                      {/* 💬 引用ターゲットプレビュー */}
                      {quoteTargetPost && (
                        <div className="p-3 rounded-2xl bg-indigo-950/40 border border-indigo-500/40 flex items-start justify-between gap-2 animate-in fade-in duration-150">
                          <div className="flex items-start space-x-2 min-w-0">
                            <Quote className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                            <div className="min-w-0">
                              <div className="flex items-center space-x-1.5 text-xs font-bold text-indigo-300">
                                <span>引用中:</span>
                                <span className="truncate">{quoteTargetPost.author_name}</span>
                                <span className="text-[10px] text-slate-400 font-mono">{quoteTargetPost.author_handle}</span>
                              </div>
                              <p className="text-xs text-slate-300 truncate mt-0.5">{quoteTargetPost.content}</p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setQuoteTargetPost(null)}
                            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition shrink-0 cursor-pointer"
                            title="引用を取り消す"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      )}

                      {/* 📢 チャンネル宛て投稿バッジ */}
                      {postTargetChannelId && (
                        <div className="flex items-center justify-between px-3 py-2 bg-indigo-500/10 border border-indigo-500/30 rounded-xl text-xs text-indigo-300 animate-in fade-in duration-150">
                          <div className="flex items-center space-x-2 min-w-0">
                            <Hash className="w-4 h-4 text-indigo-400 shrink-0" />
                            <span className="font-bold truncate">
                              投稿先: {channels.find((c) => c.id === postTargetChannelId)?.name || 'チャンネル'}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setPostTargetChannelId(null)}
                            className="p-1 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition shrink-0 cursor-pointer"
                            title="タイムライン全体投稿に戻す"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}

                      {/* CW (閲覧注意) 注記入力欄 */}
                      {showCwInput && (
                        <div className="space-y-1 animate-in fade-in duration-150">
                          <input
                            type="text"
                            value={cwContent}
                            onChange={(e) => setCwContent(e.target.value)}
                            placeholder="閲覧注意の理由・注記を入力 (例: ネタバレ、映画の結末、閲覧注意など)"
                            className="w-full bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2 text-xs text-amber-200 placeholder-amber-400/50 focus:ring-2 focus:ring-amber-500 focus:outline-none transition"
                          />
                        </div>
                      )}

                      {/* 本文入力エリア & オートコンプリート */}
                      <div className="relative">
                        <textarea
                          id="main-post-textarea"
                          rows={3}
                          value={postContent}
                          onChange={(e) => {
                            setPostContent(e.target.value);
                            checkAutocomplete(e.target.value, e.target.selectionStart);
                          }}
                          onKeyUp={(e) => checkAutocomplete(postContent, e.currentTarget.selectionStart)}
                          onKeyDown={(e) => handleAutocompleteKeyDown(e, postContent, setPostContent)}
                          placeholder={`${authUser.name} としてノートを作成... いまどうしてる？ (@ユーザー, #タグ候補も自動補完)`}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-200 placeholder-slate-500 focus:ring-2 focus:ring-emerald-500 focus:outline-none resize-none transition"
                        />
                        <AutocompleteDropdown
                          type={autocompleteType}
                          suggestions={autocompleteSuggestions}
                          selectedIndex={autocompleteIndex}
                          onSelect={(item) => applyAutocomplete(item, postContent, setPostContent, document.querySelector<HTMLTextAreaElement>('#main-post-textarea'))}
                        />
                      </div>

                      {/* 📊 アンケート作成エディター */}
                      {showPollInput && (
                        <PollInputEditor
                          choices={pollChoices}
                          onChangeChoices={setPollChoices}
                          multiple={pollMultiple}
                          onChangeMultiple={setPollMultiple}
                          expiresIn={pollExpiresIn}
                          onChangeExpiresIn={setPollExpiresIn}
                          onClose={() => {
                            setShowPollInput(false);
                            setPollChoices(['', '']);
                          }}
                        />
                      )}

                      {/* 添付画像プレビュー */}
                      {postAttachments.length > 0 && (
                        <div className="flex flex-wrap gap-2 pt-1">
                          {postAttachments.map((att, idx) => (
                            <div key={idx} className="relative group w-20 h-20 rounded-xl overflow-hidden border border-slate-700 bg-slate-950 shadow-md">
                              <img src={att.url} alt={`添付画像 ${idx + 1}`} className="w-full h-full object-cover" />
                              <button
                                type="button"
                                onClick={() => handleRemoveAttachment(idx)}
                                className="absolute top-1 right-1 p-1 bg-black/70 hover:bg-rose-600 rounded-full text-white transition shadow"
                                title="削除"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/40">
                        <div className="flex items-center space-x-2">
                          <label
                            className={`cursor-pointer px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-800 text-slate-300 hover:text-emerald-300 text-xs font-semibold flex items-center space-x-1.5 transition border border-slate-700/60 ${
                              postAttachments.length >= 4 || isUploadingMedia ? 'opacity-50 pointer-events-none' : ''
                            }`}
                            title="画像を追加 (最大4枚)"
                          >
                            {isUploadingMedia ? (
                              <RefreshCw className="w-3.5 h-3.5 text-emerald-400 animate-spin" />
                            ) : (
                              <ImageIcon className="w-3.5 h-3.5 text-emerald-400" />
                            )}
                            <span>
                              {isUploadingMedia
                                ? uploadStatusText || 'アップロード中...'
                                : `画像 (${postAttachments.length}/4)`}
                            </span>
                            <input
                              type="file"
                              accept="image/*,video/*,audio/*"
                              multiple
                              disabled={isUploadingMedia || postAttachments.length >= 4}
                              onChange={(e) => {
                                handleSelectMedia(e.target.files);
                                e.target.value = '';
                              }}
                              className="hidden"
                            />
                          </label>

                          {/* ⚠️ センシティブ (NSFW) 指定トグル */}
                          {postAttachments.length > 0 && (
                            <button
                              type="button"
                              onClick={() => setIsSensitivePost(!isSensitivePost)}
                              className={`px-2 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1 border transition cursor-pointer ${
                                isSensitivePost
                                  ? 'bg-rose-500/20 border-rose-500/40 text-rose-300 shadow-sm'
                                  : 'bg-slate-850 border-slate-700/60 text-slate-400 hover:text-rose-300'
                              }`}
                              title={isSensitivePost ? '閲覧注意（NSFW）を解除' : '画像を閲覧注意（NSFWぼかし）に指定'}
                            >
                              <EyeOff className={`w-3.5 h-3.5 ${isSensitivePost ? 'text-rose-400' : 'text-slate-400'}`} />
                              <span className="text-[10px] font-bold">NSFW</span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => {
                              const next = !autoCompressImages;
                              setAutoCompressImages(next);
                              localStorage.setItem('spica_auto_compress', String(next));
                            }}
                            className={`px-2 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1 border transition cursor-pointer ${
                              autoCompressImages
                                ? 'bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25'
                                : 'bg-slate-850 border-slate-700/60 text-slate-500 hover:text-slate-300'
                            }`}
                            title={
                              autoCompressImages
                                ? '自動圧縮ON (WebP/長辺2048pxに最適化)'
                                : '自動圧縮OFF (元の解像度のまま)'
                            }
                          >
                            <Zap className={`w-3 h-3 ${autoCompressImages ? 'text-amber-400 fill-amber-400' : 'text-slate-500'}`} />
                            <span className="text-[10px]">{autoCompressImages ? '圧縮ON' : '圧縮OFF'}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => setShowCwInput(!showCwInput)}
                            className={`px-2 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1 border transition cursor-pointer ${
                              showCwInput
                                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300 shadow-sm'
                                : 'bg-slate-850 border-slate-700/60 text-slate-400 hover:text-amber-300'
                            }`}
                            title="閲覧注意・ネタバレ防止の折りたたみ (CW) を設定"
                          >
                            <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                            <span className="text-[10px] font-bold">CW</span>
                          </button>

                          {/* 🎨 絵文字ピッカー起動ボタン */}
                          <button
                            type="button"
                            onClick={() => setShowRichEmojiPicker({ target: 'post' })}
                            className="px-2 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1 border transition cursor-pointer bg-slate-900 border-slate-700/60 text-slate-300 hover:text-yellow-300 hover:border-yellow-500/40"
                            title="絵文字・カスタム絵文字ピッカーを開く"
                          >
                            <Smile className="w-3.5 h-3.5 text-yellow-400" />
                            <span className="text-[10px] font-bold">絵文字</span>
                          </button>

                          {/* 🍔 投稿機能まとめ（ハンバーガーメニュー: アンケート・下書き・予約・チャンネル） */}
                          <div className="relative inline-flex items-center" ref={postExtraMenuRef}>
                            <button
                              type="button"
                              onClick={() => setShowPostExtraMenu(!showPostExtraMenu)}
                              className={`px-2 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1 border transition cursor-pointer ${
                                showPostExtraMenu || showPollInput || postTargetChannelId || drafts.length > 0 || scheduledPosts.length > 0
                                  ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-300 shadow-sm'
                                  : 'bg-slate-900 border-slate-700/60 text-slate-300 hover:text-white hover:border-slate-600'
                              }`}
                              title="その他の投稿機能 (アンケート・下書き・予約・チャンネル)"
                            >
                              <Menu className="w-3.5 h-3.5" />
                              <span className="text-[10px] font-bold">その他</span>
                              {(showPollInput || postTargetChannelId) && (
                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
                              )}
                            </button>

                            {/* ポップオーバーメニュー */}
                            {showPostExtraMenu && (
                              <div className="absolute bottom-full left-0 mb-2 w-64 bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl p-2.5 z-50 space-y-1 backdrop-blur-xl">
                                <div className="px-2 py-1 text-[11px] font-bold text-slate-400 border-b border-slate-800 flex items-center justify-between">
                                  <span>その他の投稿機能</span>
                                  <button
                                    type="button"
                                    onClick={() => setShowPostExtraMenu(false)}
                                    className="text-slate-500 hover:text-slate-300 p-0.5 rounded-lg"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>

                                {/* 📊 アンケート */}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setShowPollInput(!showPollInput);
                                    setShowPostExtraMenu(false);
                                  }}
                                  className={`w-full px-2.5 py-2 rounded-xl text-xs font-semibold flex items-center justify-between transition cursor-pointer ${
                                    showPollInput
                                      ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/40'
                                      : 'hover:bg-slate-800 text-slate-300'
                                  }`}
                                >
                                  <div className="flex items-center space-x-2">
                                    <BarChart2 className="w-4 h-4 text-indigo-400" />
                                    <span>アンケート</span>
                                  </div>
                                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${showPollInput ? 'bg-indigo-500/30 text-indigo-200' : 'bg-slate-800 text-slate-400'}`}>
                                    {showPollInput ? '有効' : '追加'}
                                  </span>
                                </button>

                                {/* 📝 下書き保存・一覧 */}
                                <button
                                  type="button"
                                  onClick={openDraftsModal}
                                  className="w-full px-2.5 py-2 rounded-xl text-xs font-semibold flex items-center justify-between hover:bg-slate-800 text-slate-300 transition cursor-pointer"
                                >
                                  <div className="flex items-center space-x-2">
                                    <FileText className="w-4 h-4 text-cyan-400" />
                                    <span>下書き一覧・保存</span>
                                  </div>
                                  {drafts.length > 0 ? (
                                    <span className="text-[10px] font-bold font-mono px-1.5 py-0.2 rounded-full bg-cyan-500/20 text-cyan-300">
                                      {drafts.length}
                                    </span>
                                  ) : (
                                    <span className="text-[10px] text-slate-500">一覧</span>
                                  )}
                                </button>

                                {/* ⏰ 予約投稿 */}
                                <button
                                  type="button"
                                  onClick={openScheduleModal}
                                  className="w-full px-2.5 py-2 rounded-xl text-xs font-semibold flex items-center justify-between hover:bg-slate-800 text-slate-300 transition cursor-pointer"
                                >
                                  <div className="flex items-center space-x-2">
                                    <Clock className="w-4 h-4 text-amber-400" />
                                    <span>日時指定予約</span>
                                  </div>
                                  {scheduledPosts.length > 0 ? (
                                    <span className="text-[10px] font-bold font-mono px-1.5 py-0.2 rounded-full bg-amber-500/20 text-amber-300">
                                      {scheduledPosts.length}
                                    </span>
                                  ) : (
                                    <span className="text-[10px] text-slate-500">設定</span>
                                  )}
                                </button>

                                {/* 📢 投稿先チャンネル */}
                                <div className="pt-1.5 border-t border-slate-800">
                                  <label className="px-1 text-[10px] font-bold text-slate-400 block mb-1">
                                    投稿先チャンネル
                                  </label>
                                  <div className="relative">
                                    <select
                                      value={postTargetChannelId || ''}
                                      onChange={(e) => {
                                        setPostTargetChannelId(e.target.value || null);
                                      }}
                                      className={`w-full appearance-none pl-2.5 pr-7 py-1.5 rounded-xl text-xs font-semibold border transition cursor-pointer focus:outline-none ${
                                        postTargetChannelId
                                          ? 'bg-indigo-950/80 border-indigo-500/60 text-indigo-300'
                                          : 'bg-slate-800 border-slate-700/80 text-slate-200 hover:text-white hover:border-slate-600'
                                      }`}
                                    >
                                      <option value="" className="bg-slate-900 text-slate-200">📢 全体公開 (チャンネルなし)</option>
                                      {channels.map((ch) => (
                                        <option key={ch.id} value={ch.id} className="bg-slate-900 text-slate-200">
                                          📢 {ch.name}
                                        </option>
                                      ))}
                                    </select>
                                    <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400" />
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>

                          {/* 📢 チャンネル宛て選択中のバッジ表示 */}
                          {postTargetChannelId && (
                            <span className="inline-flex items-center space-x-1 px-2 py-1 rounded-lg bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 text-xs font-bold">
                              <span>📢 {channels.find((c) => c.id === postTargetChannelId)?.name || 'チャンネル'}</span>
                              <button
                                type="button"
                                onClick={() => setPostTargetChannelId(null)}
                                className="text-indigo-400 hover:text-indigo-200 p-0.5 rounded cursor-pointer"
                                title="チャンネル指定を解除 (全体公開にする)"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </span>
                          )}
                        </div>

                        <button
                          type="submit"
                          disabled={
                            (!postContent.trim() && postAttachments.length === 0 && !quoteTargetPost && (!showPollInput || pollChoices.filter((c) => c.trim()).length < 2)) ||
                            isPosting ||
                            isUploadingMedia
                          }
                          className="px-5 py-2 bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950 text-xs font-black rounded-xl shadow-lg shadow-emerald-500/20 transition flex items-center justify-center space-x-1.5 disabled:opacity-50 cursor-pointer"
                        >
                          <Send className="w-3.5 h-3.5" />
                          <span>
                            {isPosting
                              ? '送信中...'
                              : isUploadingMedia
                              ? uploadStatusText || 'アップロード中...'
                              : 'ノート'}
                          </span>
                        </button>
                      </div>
                    </form>
                  </div>
                ) : (
                  <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 text-center space-y-3">
                    <p className="text-sm text-slate-300 font-medium">
                      ノートを作成するにはログインしてください。
                    </p>
                    <button
                      onClick={() => setShowLoginModal(true)}
                      className="px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-black rounded-xl shadow-md transition cursor-pointer"
                    >
                      ログイン
                    </button>
                  </div>
                )}

                {/* 📢 お知らせ（運営からの告知） */}
                {publicAnnouncements.filter((a) => !dismissedAnnouncements.includes(a.id)).length > 0 && (
                  <div className="space-y-2">
                    {publicAnnouncements
                      .filter((a) => !dismissedAnnouncements.includes(a.id))
                      .slice(0, 3)
                      .map((a) => (
                        <div
                          key={a.id}
                          className="bg-amber-500/5 border border-amber-500/25 rounded-2xl p-3.5 flex items-start space-x-3"
                        >
                          <Megaphone className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <span className="font-bold text-xs text-amber-200 block break-words">{a.title}</span>
                            <p className="text-[11px] text-slate-300 mt-1 whitespace-pre-wrap break-words leading-relaxed">
                              {a.content}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => dismissAnnouncement(a.id)}
                            className="p-1 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition shrink-0 cursor-pointer"
                            title="閉じる"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                  </div>
                )}

                {/* 投稿一覧 */}
                <div className="space-y-4">
                  {/* 📡 新着投稿バッジ (Misskey風) */}
                  {newPostsQueue.length > 0 && (
                    <button
                      type="button"
                      onClick={applyNewPostsQueue}
                      className="w-full py-2.5 px-4 rounded-2xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold text-xs shadow-lg shadow-indigo-600/30 flex items-center justify-center space-x-2 transition cursor-pointer animate-in fade-in slide-in-from-top-2 duration-200"
                    >
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>⬆ 新しいノートが {newPostsQueue.length} 件あります（クリックで表示）</span>
                    </button>
                  )}
                  {timeline.length === 0 ? (
                    <div className="text-center py-16 bg-slate-900/40 rounded-3xl border border-dashed border-slate-800 text-slate-500 text-sm">
                      <Globe className="w-10 h-10 mx-auto mb-3 opacity-20" />
                      <p>まだ投稿がありません。</p>
                      <p className="text-xs text-slate-600 mt-1">
                        最初のノートを作成するか、右側の「話題のタグ」や検索から探してみましょう！
                      </p>
                    </div>
                  ) : (
                    timeline.map((post) => renderPostCard(post))
                  )}

                  {/* 📜 過去のノート追加読み込み（カーソルページネーション） */}
                  {timelineCursor && (
                    <button
                      type="button"
                      onClick={loadOlderPosts}
                      disabled={isLoadingOlderPosts}
                      className="w-full py-3 px-4 rounded-2xl bg-slate-900/60 border border-slate-800 hover:border-emerald-500/50 text-slate-300 hover:text-white text-xs transition cursor-pointer flex items-center justify-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isLoadingOlderPosts ? 'animate-spin' : ''}`} />
                      <span>{isLoadingOlderPosts ? '過去のノートを読み込み中...' : '📜 過去のノートを読み込む'}</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </main>

          {/* 🧩 右サイドバー (Misskey ウィジェット群) */}
          <aside className="hidden xl:block w-72 shrink-0 sticky top-16 h-[calc(100vh-5rem)] overflow-y-auto space-y-4 pr-1 select-none">
            {/* ウィジェット1: 話題のハッシュタグ */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-4 shadow-xl space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-300 flex items-center space-x-1.5">
                  <Hash className="w-4 h-4 text-emerald-400" />
                  <span>話題のタグ</span>
                </h3>
                <button
                  onClick={fetchPopularTags}
                  className="p-1 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition cursor-pointer"
                  title="更新"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              </div>
              {popularTags.length === 0 ? (
                <p className="text-xs text-slate-500 py-2">タグがまだありません</p>
              ) : (
                <div className="space-y-1">
                  {popularTags.slice(0, 8).map((item) => (
                    <button
                      key={item.tag}
                      onClick={() => handleSelectHashtag(item.tag)}
                      className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-xl text-xs hover:bg-slate-800/80 transition text-left group cursor-pointer"
                    >
                      <span className="font-bold text-slate-300 group-hover:text-emerald-400 transition truncate">
                        #{item.tag}
                      </span>
                      <span className="text-[10px] text-slate-500 font-mono">{item.count}件</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* ウィジェット2: サーバー情報 */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-4 shadow-xl space-y-3 text-xs">
              <h3 className="font-black uppercase tracking-wider text-slate-300 flex items-center space-x-1.5">
                <Server className="w-4 h-4 text-emerald-400" />
                <span>サーバー情報</span>
              </h3>
              <div className="space-y-2">
                <div>
                  <span className="text-slate-500 block text-[11px]">ドメイン</span>
                  <span className="font-mono text-emerald-400 font-bold">{serverStats?.domain || window.location.host}</span>
                </div>
                {serverStats && (
                  <div className="grid grid-cols-3 gap-1.5 pt-2 border-t border-slate-800 text-center">
                    <div className="bg-slate-950/80 p-2 rounded-xl border border-slate-800/60">
                      <span className="font-black text-sm text-slate-200 block">{serverStats.stats.users}</span>
                      <span className="text-[9px] text-slate-400">ユーザー</span>
                    </div>
                    <div className="bg-slate-950/80 p-2 rounded-xl border border-slate-800/60">
                      <span className="font-black text-sm text-slate-200 block">{serverStats.stats.totalPosts}</span>
                      <span className="text-[9px] text-slate-400">総投稿</span>
                    </div>
                    <div className="bg-slate-950/80 p-2 rounded-xl border border-slate-800/60">
                      <span className="font-black text-sm text-emerald-400 block">{serverStats.stats.federatedPosts}</span>
                      <span className="text-[9px] text-slate-400">連合受信</span>
                    </div>
                  </div>
                )}
                <div className="pt-2 border-t border-slate-800 space-y-1">
                  <a
                    href={`/.well-known/webfinger?resource=acct:${authUser?.id || 'admin'}@${serverStats?.domain || window.location.host}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between text-[11px] text-slate-400 hover:text-emerald-300 transition py-0.5"
                  >
                    <span>WebFinger JRD</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                  <a
                    href="/nodeinfo/2.1"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between text-[11px] text-slate-400 hover:text-emerald-300 transition py-0.5"
                  >
                    <span>NodeInfo 2.1</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            </div>

            {/* ウィジェット3: リモートフォロー導線 */}
            {authUser && (
              <div className="bg-gradient-to-br from-indigo-950/30 to-purple-950/30 border border-slate-800 rounded-3xl p-4 shadow-xl text-xs space-y-2.5">
                <h3 className="font-bold text-indigo-300 flex items-center space-x-1.5">
                  <Radio className="w-4 h-4 text-indigo-400" />
                  <span>外部フォロー</span>
                </h3>
                <form onSubmit={handleFollow} className="space-y-2">
                  <input
                    type="text"
                    placeholder="@user@domain"
                    value={followHandle}
                    onChange={(e) => setFollowHandle(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="submit"
                    disabled={followStatus?.type === 'loading'}
                    className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs transition cursor-pointer"
                  >
                    {followStatus?.type === 'loading' ? 'フォロー中...' : 'フォロー送信'}
                  </button>
                </form>
                {followStatus && (
                  <div
                    className={`mt-2 p-2 rounded-xl text-[11px] flex items-start space-x-1.5 ${
                      followStatus.type === 'success'
                        ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                        : followStatus.type === 'error'
                        ? 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        : 'bg-indigo-500/15 border border-indigo-500/30 text-indigo-300'
                    }`}
                  >
                    {followStatus.type === 'success' && <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                    {followStatus.type === 'error' && <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                    {followStatus.type === 'loading' && <RefreshCw className="w-3.5 h-3.5 shrink-0 mt-0.5 animate-spin" />}
                    <span className="leading-tight">{followStatus.msg}</span>
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      )}

      {/* 🌟 Spica 主権型ソーシャルポータル画面 */}
      {showAuthPortal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950 flex flex-col justify-between animate-in fade-in duration-300">
          {/* 背景バナーエリア (コズミック・星空スプリットレイアウト) */}
          <div className="fixed inset-0 pointer-events-none overflow-hidden">
            {serverStats?.banner_url ? (
              <>
                <img
                  src={serverStats.banner_url}
                  alt="Server Banner"
                  className="w-full h-full object-cover object-center scale-105 filter blur-[1px] opacity-65"
                />
                <div className="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-950/85 to-indigo-950/40" />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-slate-950/70" />
              </>
            ) : (
              <div className="w-full h-full relative bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/30 via-slate-950 to-slate-950">
                {/* Spica オリジナルの星空・コズミック光彩 */}
                <div className="absolute top-1/4 -right-20 w-[600px] h-[600px] rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
                <div className="absolute bottom-10 right-1/4 w-[500px] h-[500px] rounded-full bg-purple-500/10 blur-3xl pointer-events-none" />
                <div className="absolute inset-0 opacity-20 bg-[radial-gradient(#818cf8_1px,transparent_1px)] [background-size:32px_32px]" />
              </div>
            )}
          </div>

          {/* トップナビゲーションバー */}
          <header className="relative z-10 w-full px-6 py-5 flex items-center justify-between">
            {/* Spica ノードバッジ */}
            <div className="flex items-center space-x-2 bg-slate-900/80 backdrop-blur-md border border-indigo-500/20 px-3.5 py-1.5 rounded-full shadow-lg shadow-indigo-500/5">
              <div className="w-4 h-4 rounded-full bg-gradient-to-tr from-cyan-400 to-indigo-500 flex items-center justify-center text-[10px] text-white font-black">
                ✦
              </div>
              <span className="text-xs text-slate-300 font-medium">
                Spica Sovereign Node: <strong className="text-white font-bold">{serverStats?.domain || window.location.host}</strong>
              </span>
            </div>

            {/* ゲスト閲覧・閉じるボタン */}
            <button
              onClick={() => setShowAuthPortal(false)}
              className="group flex items-center space-x-2 px-4 py-1.5 bg-slate-900/80 hover:bg-slate-850 text-slate-300 hover:text-white rounded-full border border-slate-800 shadow-lg text-xs font-semibold backdrop-blur-md transition cursor-pointer"
              title="ゲストとしてタイムラインを見る"
            >
              <span>タイムラインを見る</span>
              <X className="w-4 h-4 group-hover:rotate-90 transition transform text-slate-400" />
            </button>
          </header>

          {/* メインコンテンツ (左右2ペイン) */}
          <main className="relative z-10 w-full max-w-6xl mx-auto px-4 py-4 sm:py-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* 左側: メインカード & 統計 & プレビュー */}
            <div className="lg:col-span-5 max-w-md w-full mx-auto lg:mx-0 space-y-4">
              {/* メインヒーローカード */}
              <div className="bg-slate-900/90 backdrop-blur-2xl border border-indigo-500/20 rounded-[28px] p-6 sm:p-7 shadow-2xl relative mt-10">
                {/* アプリアイコン (Spica オービタルリング付き: カード上端から自然に突き出し、下部要素と重ならないよう配置) */}
                <div className="-mt-14 sm:-mt-16 mx-auto w-20 h-20 rounded-3xl bg-gradient-to-tr from-cyan-400 via-indigo-500 to-purple-600 p-0.5 shadow-2xl shadow-indigo-500/30 mb-3 relative z-10">
                  <div className="w-full h-full rounded-[22px] overflow-hidden bg-slate-950 flex items-center justify-center relative">
                    <img
                      src={serverStats?.icon_url || '/logo.jpg'}
                      alt={serverStats?.name || 'Spica'}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.currentTarget as HTMLElement).style.display = 'none';
                      }}
                    />
                  </div>
                </div>

                {/* 右上メニュー (···) */}
                <div className="absolute top-4 right-4 z-20">
                  <button
                    onClick={() => setShowServerMenuPopover(!showServerMenuPopover)}
                    className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 rounded-xl transition cursor-pointer"
                    title="サーバー詳細メニュー"
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                  {showServerMenuPopover && (
                    <div className="absolute right-0 mt-2 w-48 bg-slate-900 border border-slate-800 rounded-2xl p-2 shadow-2xl z-30 space-y-1 text-xs text-slate-300 animate-in fade-in zoom-in-95 duration-150">
                      <div className="px-2.5 py-1.5 text-[11px] font-bold text-slate-400 border-b border-slate-800/80">
                        {serverStats?.domain || 'spica'}
                      </div>
                      <a
                        href="/actor"
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-between px-2.5 py-1.5 hover:bg-slate-800 rounded-lg text-slate-300 transition"
                      >
                        <span>Actor (/actor)</span>
                        <ExternalLink className="w-3 h-3 text-slate-500" />
                      </a>
                      <a
                        href="/nodeinfo/2.1"
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-between px-2.5 py-1.5 hover:bg-slate-800 rounded-lg text-slate-300 transition"
                      >
                        <span>NodeInfo 2.1</span>
                        <ExternalLink className="w-3 h-3 text-slate-500" />
                      </a>
                    </div>
                  )}
                </div>

                {/* ノードステータスバッジ */}
                <div className="flex justify-center mb-2">
                  <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-mono font-semibold shadow-sm">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span>NODE ONLINE • FEDERATED</span>
                  </div>
                </div>

                {/* サーバー名 */}
                <h1 className="text-xl sm:text-2xl font-black text-center text-slate-100 tracking-tight">
                  {serverStats?.name || 'Spica'}
                </h1>

                {/* サーバー説明 */}
                <p className="text-xs text-center text-slate-400 mt-2 leading-relaxed whitespace-pre-wrap max-h-24 overflow-y-auto">
                  {serverStats?.description || '誰にも支配されない、分散型ソーシャルネットワークへようこそ。'}
                </p>

                {/* Spica 参加ポリシー案内枠 */}
                {serverStats?.registration_mode === 'closed' ? (
                  <div className="mt-4 bg-rose-950/40 border border-rose-500/30 rounded-2xl p-3 text-left flex items-start space-x-2.5 shadow-sm">
                    <Lock className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <div className="text-xs text-rose-200/90 leading-relaxed">
                      <strong className="text-rose-300 font-bold block mb-0.5">新規アカウント登録を一時停止中</strong>
                      現在このサーバーは管理者により新規登録の受付を一時停止しています。
                    </div>
                  </div>
                ) : serverStats?.registration_mode === 'invite' ? (
                  <div className="mt-4 bg-amber-950/40 border border-amber-500/30 rounded-2xl p-3 text-left flex items-start space-x-2.5 shadow-sm">
                    <Ticket className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <div className="text-xs text-amber-200/90 leading-relaxed">
                      <strong className="text-amber-300 font-bold block mb-0.5">招待制コミュニティ</strong>
                      このサーバーへの新規参加には有効な招待コードが必要です。
                      {isPasswordAuthMode ? 'メールアドレスとパスワードで今すぐ利用開始できます。' : '暗号学的マスターキーで今すぐ利用開始できます。'}
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 bg-indigo-950/40 border border-indigo-500/20 rounded-2xl p-3 text-left flex items-start space-x-2.5 shadow-sm">
                    <Zap className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                    <div className="text-xs text-indigo-200/90 leading-relaxed">
                      <strong className="text-cyan-300 font-bold block mb-0.5">オープン参加受付中</strong>
                      {isPasswordAuthMode
                        ? '招待コードは不要です。メールアドレスとパスワードで今すぐ利用開始できます。'
                        : '招待コードや電話番号・メールアドレスは不要です。暗号学的マスターキーで今すぐ利用開始できます。'}
                    </div>
                  </div>
                )}

                {/* エラーメッセージ */}
                {authError && (
                  <div className="mt-4 bg-rose-500/15 border border-rose-500/30 text-rose-300 p-2.5 rounded-xl text-xs flex items-center space-x-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{authError}</span>
                  </div>
                )}

                {/* ビュー切り替え */}
                {authPortalTab === 'welcome' && (
                  <div className="mt-6 space-y-2.5">
                    {serverStats?.registration_mode === 'closed' ? (
                      <button
                        disabled
                        className="w-full py-3 bg-slate-800/60 text-slate-500 text-sm font-bold rounded-2xl border border-slate-700/50 cursor-not-allowed flex items-center justify-center space-x-2"
                      >
                        <Lock className="w-4 h-4" />
                        <span>新規登録は一時停止中です</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setAuthError(null);
                          const hasRules = (serverStats?.server_rules && serverStats.server_rules.length > 0) || serverStats?.tos_url || serverStats?.privacy_policy_url;
                          if (serverStats?.require_rules_agreement && hasRules) {
                            setAgreeRules(false);
                            setAgreeTosPrivacy(false);
                            setAgreeBasicNotes(false);
                            setAuthPortalTab('rules_agreement');
                          } else {
                            setAuthPortalTab('register');
                          }
                        }}
                        className="w-full py-3 bg-gradient-to-r from-cyan-500 via-indigo-600 to-purple-600 hover:from-cyan-400 hover:via-indigo-500 hover:to-purple-500 text-white text-sm font-bold rounded-2xl shadow-lg shadow-indigo-600/25 transition transform active:scale-98 flex items-center justify-center space-x-2 cursor-pointer"
                      >
                        <UserPlus className="w-4 h-4" />
                        <span>
                          {serverStats?.registration_mode === 'invite'
                            ? '招待コードで参加する'
                            : 'Spicaに参加する (アカウント作成)'}
                        </span>
                      </button>
                    )}

                    <button
                      onClick={() => setShowAuthPortal(false)}
                      className="w-full py-2.5 bg-slate-800/80 hover:bg-slate-700/80 text-slate-200 text-xs font-semibold rounded-2xl border border-slate-700/60 transition cursor-pointer flex items-center justify-center space-x-1.5"
                    >
                      <Eye className="w-3.5 h-3.5 text-slate-400" />
                      <span>ゲストとしてタイムラインを見る</span>
                    </button>

                    <button
                      onClick={handleLoginWithPasskey}
                      disabled={isLoggingInWithPasskey}
                      className="w-full py-2.5 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 text-xs font-bold rounded-2xl transition cursor-pointer flex items-center justify-center space-x-2 shadow-sm"
                    >
                      {isLoggingInWithPasskey ? (
                        <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                      ) : (
                        <Fingerprint className="w-4 h-4 text-indigo-400" />
                      )}
                      <span>{isLoggingInWithPasskey ? '生体認証を確認中...' : '🔐 パスキー / 生体認証でログイン'}</span>
                    </button>

                    <button
                      onClick={() => {
                        setAuthError(null);
                        setAuthPortalTab('login');
                      }}
                      className="w-full py-2.5 bg-slate-800/80 hover:bg-slate-700/80 text-slate-200 text-xs font-semibold rounded-2xl border border-slate-700/60 transition cursor-pointer flex items-center justify-center space-x-1.5"
                    >
                      <LogIn className="w-3.5 h-3.5 text-indigo-400" />
                      <span>{isPasswordAuthMode ? 'メールアドレスでログイン' : 'マスターキーでログイン'}</span>
                    </button>

                    {/* フッター規約・ポリシーリンク */}
                    {(serverStats?.tos_url || serverStats?.privacy_policy_url || serverStats?.contact_url || serverStats?.operator_url) && (
                      <div className="pt-4 border-t border-slate-800/60 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1.5 text-[11px] text-slate-500">
                        {serverStats?.tos_url && (
                          <a
                            href={serverStats.tos_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-indigo-400 hover:underline flex items-center space-x-1 transition"
                          >
                            <span>利用規約</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        )}
                        {serverStats?.privacy_policy_url && (
                          <a
                            href={serverStats.privacy_policy_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-indigo-400 hover:underline flex items-center space-x-1 transition"
                          >
                            <span>プライバシーポリシー</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        )}
                        {serverStats?.contact_url && (
                          <a
                            href={serverStats.contact_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-indigo-400 hover:underline flex items-center space-x-1 transition"
                          >
                            <span>お問い合わせ</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        )}
                        {serverStats?.operator_url && (
                          <a
                            href={serverStats.operator_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-indigo-400 hover:underline flex items-center space-x-1 transition"
                          >
                            <span>運営者情報</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* 📜 サーバールール・規約同意ビュー (Misskeyスタイル) */}
                {authPortalTab === 'rules_agreement' && (() => {
                  const rules = serverStats?.server_rules && serverStats.server_rules.length > 0
                    ? serverStats.server_rules
                    : [];
                  const hasRulesSection = rules.length > 0;
                  const hasTosSection = Boolean(serverStats?.tos_url || serverStats?.privacy_policy_url);
                  const hasBasicSection = Boolean(serverStats?.contact_url || serverStats?.operator_url || serverStats?.repository_url);

                  const allAgreed =
                    (!hasRulesSection || agreeRules) &&
                    (!hasTosSection || agreeTosPrivacy) &&
                    (!hasBasicSection || agreeBasicNotes);

                  return (
                    <div className="mt-4 space-y-4 animate-in fade-in duration-200 text-left">
                      {/* 上部ヘッダー (アイコン・タイトル・説明) */}
                      <div className="text-center space-y-2 pb-1">
                        <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center mx-auto shadow-md">
                          <ClipboardCheck className="w-6 h-6" />
                        </div>
                        <p className="text-xs text-slate-300 font-medium leading-relaxed">
                          このサーバーに登録するには、以下の内容を確認し同意する必要があります。<br />
                          <strong className="text-slate-100 font-bold">重要ですので必ずお読みください。</strong>
                        </p>
                      </div>

                      {/* アコーディオンリスト */}
                      <div className="space-y-3 max-h-[48vh] overflow-y-auto pr-1">
                        {/* セクション 1: サーバールール */}
                        {hasRulesSection && (
                          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 overflow-hidden shadow-sm">
                            <button
                              type="button"
                              onClick={() => setExpandedAccordions((prev) => ({ ...prev, rules: !prev.rules }))}
                              className="w-full px-4 py-3 bg-slate-900/90 hover:bg-slate-900 flex items-center justify-between text-xs font-bold text-slate-200 transition cursor-pointer"
                            >
                              <span>サーバールール</span>
                              {expandedAccordions.rules ? (
                                <ChevronUp className="w-4 h-4 text-slate-400" />
                              ) : (
                                <ChevronDown className="w-4 h-4 text-slate-400" />
                              )}
                            </button>

                            {expandedAccordions.rules && (
                              <div className="p-3.5 space-y-2.5 border-t border-slate-800/80 bg-slate-950/40">
                                {rules.map((rule, idx) => (
                                  <div key={idx} className="flex items-start space-x-2.5 text-xs text-slate-200 leading-relaxed">
                                    <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-[11px] flex items-center justify-center shrink-0 mt-0.5 shadow-sm">
                                      {idx + 1}
                                    </span>
                                    <span>{rule}</span>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* 同意するトグル */}
                            <div className="px-4 py-2.5 bg-slate-900/50 border-t border-slate-800/60 flex items-center justify-between">
                              <label
                                onClick={() => setAgreeRules(!agreeRules)}
                                className="flex items-center space-x-3 cursor-pointer select-none"
                              >
                                <div
                                  className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out ${
                                    agreeRules ? 'bg-emerald-500' : 'bg-slate-700'
                                  }`}
                                >
                                  <div
                                    className={`w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out ${
                                      agreeRules ? 'translate-x-4' : 'translate-x-0'
                                    }`}
                                  />
                                </div>
                                <span className={`text-xs font-bold ${agreeRules ? 'text-emerald-300' : 'text-slate-400'}`}>
                                  同意する
                                </span>
                              </label>
                            </div>
                          </div>
                        )}

                        {/* セクション 2: 利用規約・プライバシーポリシー */}
                        {hasTosSection && (
                          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 overflow-hidden shadow-sm">
                            <button
                              type="button"
                              onClick={() => setExpandedAccordions((prev) => ({ ...prev, tos: !prev.tos }))}
                              className="w-full px-4 py-3 bg-slate-900/90 hover:bg-slate-900 flex items-center justify-between text-xs font-bold text-slate-200 transition cursor-pointer"
                            >
                              <span>利用規約・プライバシーポリシー</span>
                              {expandedAccordions.tos ? (
                                <ChevronUp className="w-4 h-4 text-slate-400" />
                              ) : (
                                <ChevronDown className="w-4 h-4 text-slate-400" />
                              )}
                            </button>

                            {expandedAccordions.tos && (
                              <div className="p-3.5 space-y-2 border-t border-slate-800/80 bg-slate-950/40">
                                {serverStats?.tos_url && (
                                  <a
                                    href={serverStats.tos_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center space-x-1.5 text-xs font-semibold"
                                  >
                                    <span>利用規約</span>
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                )}
                                {serverStats?.privacy_policy_url && (
                                  <a
                                    href={serverStats.privacy_policy_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center space-x-1.5 text-xs font-semibold"
                                  >
                                    <span>プライバシーポリシー</span>
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                )}
                              </div>
                            )}

                            {/* 同意するトグル */}
                            <div className="px-4 py-2.5 bg-slate-900/50 border-t border-slate-800/60 flex items-center justify-between">
                              <label
                                onClick={() => setAgreeTosPrivacy(!agreeTosPrivacy)}
                                className="flex items-center space-x-3 cursor-pointer select-none"
                              >
                                <div
                                  className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out ${
                                    agreeTosPrivacy ? 'bg-emerald-500' : 'bg-slate-700'
                                  }`}
                                >
                                  <div
                                    className={`w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out ${
                                      agreeTosPrivacy ? 'translate-x-4' : 'translate-x-0'
                                    }`}
                                  />
                                </div>
                                <span className={`text-xs font-bold ${agreeTosPrivacy ? 'text-emerald-300' : 'text-slate-400'}`}>
                                  同意する
                                </span>
                              </label>
                            </div>
                          </div>
                        )}

                        {/* セクション 3: 基本的な注意事項・運営者情報 */}
                        {hasBasicSection && (
                          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 overflow-hidden shadow-sm">
                            <button
                              type="button"
                              onClick={() => setExpandedAccordions((prev) => ({ ...prev, basic: !prev.basic }))}
                              className="w-full px-4 py-3 bg-slate-900/90 hover:bg-slate-900 flex items-center justify-between text-xs font-bold text-slate-200 transition cursor-pointer"
                            >
                              <span>基本的な注意事項・運営者情報</span>
                              {expandedAccordions.basic ? (
                                <ChevronUp className="w-4 h-4 text-slate-400" />
                              ) : (
                                <ChevronDown className="w-4 h-4 text-slate-400" />
                              )}
                            </button>

                            {expandedAccordions.basic && (
                              <div className="p-3.5 space-y-2 border-t border-slate-800/80 bg-slate-950/40">
                                {serverStats?.contact_url && (
                                  <a
                                    href={serverStats.contact_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center space-x-1.5 text-xs font-semibold"
                                  >
                                    <span>お問い合わせ先</span>
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                )}
                                {serverStats?.operator_url && (
                                  <a
                                    href={serverStats.operator_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center space-x-1.5 text-xs font-semibold"
                                  >
                                    <span>運営者情報 (Impressum)</span>
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                )}
                                {serverStats?.repository_url && (
                                  <a
                                    href={serverStats.repository_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center space-x-1.5 text-xs font-semibold"
                                  >
                                    <span>リポジトリ</span>
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                )}
                              </div>
                            )}

                            {/* 同意するトグル */}
                            <div className="px-4 py-2.5 bg-slate-900/50 border-t border-slate-800/60 flex items-center justify-between">
                              <label
                                onClick={() => setAgreeBasicNotes(!agreeBasicNotes)}
                                className="flex items-center space-x-3 cursor-pointer select-none"
                              >
                                <div
                                  className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out ${
                                    agreeBasicNotes ? 'bg-emerald-500' : 'bg-slate-700'
                                  }`}
                                >
                                  <div
                                    className={`w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out ${
                                      agreeBasicNotes ? 'translate-x-4' : 'translate-x-0'
                                    }`}
                                  />
                                </div>
                                <span className={`text-xs font-bold ${agreeBasicNotes ? 'text-emerald-300' : 'text-slate-400'}`}>
                                  同意する
                                </span>
                              </label>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* 注意テキスト */}
                      <p className="text-[11px] text-center text-slate-400 leading-relaxed">
                        続けるには、全ての「同意する」にチェックが入っている必要があります。
                      </p>

                      {/* アクションボタン */}
                      <div className="flex items-center justify-center space-x-3 pt-2">
                        <button
                          type="button"
                          onClick={() => setAuthPortalTab('welcome')}
                          className="px-5 py-2.5 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition cursor-pointer"
                        >
                          キャンセル
                        </button>
                        <button
                          type="button"
                          disabled={!allAgreed}
                          onClick={() => {
                            setHasAgreedToRules(true);
                            setAuthPortalTab('register');
                          }}
                          className={`px-6 py-2.5 rounded-full text-xs font-bold transition flex items-center space-x-1.5 shadow-lg ${
                            allAgreed
                              ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/30 cursor-pointer transform active:scale-98'
                              : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/60'
                          }`}
                        >
                          <span>続ける</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {authPortalTab === 'register' && (
                  <div className="mt-5 space-y-3.5 animate-in fade-in duration-200">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                      <button
                        onClick={() => {
                          setAuthError(null);
                          setAuthPortalTab('welcome');
                        }}
                        className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition cursor-pointer"
                      >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        <span>戻る</span>
                      </button>
                      <span className="text-xs font-bold text-slate-300">アカウント新規登録</span>
                    </div>

                    {serverStats?.registration_mode === 'closed' ? (
                      <div className="py-6 px-4 bg-slate-950/80 rounded-2xl border border-slate-800 text-center space-y-3">
                        <div className="w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center mx-auto">
                          <Lock className="w-6 h-6" />
                        </div>
                        <div>
                          <h4 className="text-sm font-bold text-slate-200">新規登録を一時停止しています</h4>
                          <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                            現在このサーバーは管理者により新規登録の受付を一時停止しています。<br />
                            すでにアカウントをお持ちの方はログインしてご利用ください。
                          </p>
                        </div>
                        <div className="pt-2">
                          <button
                            type="button"
                            onClick={() => {
                              setAuthError(null);
                              setAuthPortalTab('login');
                            }}
                            className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl border border-slate-700 transition cursor-pointer"
                          >
                            {isPasswordAuthMode ? 'メールアドレスでログインする' : 'マスターキーでログインする'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <form onSubmit={handleRegister} className="space-y-3 text-left">
                        {/* 招待コード入力欄 */}
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-[11px] font-semibold text-slate-300">
                              招待コード {serverStats?.registration_mode === 'invite' ? (
                                <span className="text-rose-400 font-bold">*必須</span>
                              ) : (
                                <span className="text-slate-500 font-normal">(任意)</span>
                              )}
                            </label>
                            {inviteCodeInput && (
                              <span className="text-[10px] text-emerald-400 font-mono">コード適用中</span>
                            )}
                          </div>
                          <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                            <Ticket className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
                            <input
                              type="text"
                              required={serverStats?.registration_mode === 'invite'}
                              placeholder="SPICA-XXXXXX"
                              value={inviteCodeInput}
                              onChange={(e) => setInviteCodeInput(e.target.value.toUpperCase())}
                              className="bg-transparent text-slate-200 placeholder-slate-600 focus:outline-none flex-1 font-mono text-xs uppercase tracking-wider"
                            />
                            {inviteCodeInput && (
                              <button
                                type="button"
                                onClick={() => setInviteCodeInput('')}
                                className="text-slate-500 hover:text-slate-300 ml-1 cursor-pointer"
                                title="クリア"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                          {serverStats?.registration_mode === 'invite' && (
                            <p className="text-[10px] text-amber-400/90 mt-1 flex items-center space-x-1">
                              <AlertCircle className="w-3 h-3 shrink-0" />
                              <span>このサーバーは招待制です。有効な招待コードが必要です。</span>
                            </p>
                          )}
                        </div>

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            ユーザーID (英数字・小文字)
                          </label>
                          <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                            <span className="text-slate-500 mr-1 font-mono">@</span>
                            <input
                              type="text"
                              required
                              placeholder="例: alice"
                              value={regId}
                              onChange={(e) => setRegId(e.target.value)}
                              className="bg-transparent text-slate-200 focus:outline-none flex-1 font-mono text-xs"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            表示名
                          </label>
                          <input
                            type="text"
                            required
                            placeholder="例: Alice In Borderland"
                            value={regName}
                            onChange={(e) => setRegName(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                          />
                        </div>

                        {isPasswordAuthMode && (
                          <>
                            <div>
                              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                                メールアドレス <span className="text-rose-400 font-bold">*必須</span>
                              </label>
                              <input
                                type="email"
                                required
                                autoComplete="email"
                                placeholder="you@example.com"
                                value={regEmail}
                                onChange={(e) => setRegEmail(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                              />
                              <p className="text-[10px] text-slate-500 mt-1">
                                このサーバーはメールアドレス＋パスワード方式です。パスワードを忘れたときの復元にも使います。
                              </p>
                            </div>

                            {/* メール確認コード（SMTP が設定されているサーバーのみ） */}
                            {recoveryStatus.mailConfigured && (
                              <div>
                                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                                  メール確認コード <span className="text-rose-400 font-bold">*必須</span>
                                </label>
                                <div className="flex gap-2">
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    autoComplete="one-time-code"
                                    maxLength={6}
                                    placeholder="6桁のコード"
                                    value={regEmailCode}
                                    onChange={(e) => setRegEmailCode(e.target.value.replace(/[^0-9]/g, ''))}
                                    className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono tracking-widest focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                                  />
                                  <button
                                    type="button"
                                    onClick={handleSendRegisterCode}
                                    disabled={isSendingRegCode || !regEmail.trim()}
                                    className="px-3 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-[11px] font-bold rounded-xl shadow-md transition whitespace-nowrap cursor-pointer"
                                  >
                                    {isSendingRegCode ? '送信中...' : '確認コードを送信'}
                                  </button>
                                </div>
                                {regCodeMsg ? (
                                  <p className={`text-[10px] mt-1 ${regCodeMsg.type === 'success' ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    {regCodeMsg.text}
                                  </p>
                                ) : (
                                  <p className="text-[10px] text-slate-500 mt-1">
                                    入力したメールアドレスに6桁のコードを送ります（10分有効）。他人のメールアドレスでの登録を防ぐため必須です。
                                  </p>
                                )}
                              </div>
                            )}

                            <div>
                              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                                パスワード <span className="text-rose-400 font-bold">*必須</span>
                                <span className="text-slate-500 font-normal"> (8文字以上)</span>
                              </label>
                              <input
                                type="password"
                                required
                                minLength={8}
                                autoComplete="new-password"
                                placeholder="8文字以上"
                                value={regPassword}
                                onChange={(e) => setRegPassword(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                              />
                            </div>

                            <div>
                              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                                パスワード (確認)
                              </label>
                              <input
                                type="password"
                                required
                                autoComplete="new-password"
                                placeholder="同じパスワードをもう一度入力"
                                value={regPasswordConfirm}
                                onChange={(e) => setRegPasswordConfirm(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                              />
                            </div>
                          </>
                        )}

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            自己紹介 (Bio)
                          </label>
                          <textarea
                            rows={2}
                            placeholder="Spicaをはじめました！"
                            value={regBio}
                            onChange={(e) => setRegBio(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none resize-none"
                          />
                        </div>

                        <button
                          type="submit"
                          className="w-full py-2.5 bg-gradient-to-r from-cyan-500 via-indigo-600 to-purple-600 hover:from-cyan-400 hover:via-indigo-500 hover:to-purple-500 text-white text-xs font-bold rounded-xl shadow-md transition transform active:scale-98 cursor-pointer mt-2"
                        >
                          {isPasswordAuthMode ? 'メールアドレスで登録する' : 'マスターキーを発行して登録'}
                        </button>

                        <div className="text-center pt-1">
                          <button
                            type="button"
                            onClick={() => {
                              setAuthError(null);
                              setAuthPortalTab('login');
                            }}
                            className="text-[11px] text-indigo-400 hover:text-indigo-300 transition hover:underline cursor-pointer"
                          >
                            すでにアカウントをお持ちですか？ ログイン
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                )}

                {authPortalTab === 'login' && (
                  <div className="mt-5 space-y-3.5 animate-in fade-in duration-200">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                      <button
                        onClick={() => {
                          setAuthError(null);
                          setAuthPortalTab('welcome');
                        }}
                        className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition cursor-pointer"
                      >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        <span>戻る</span>
                      </button>
                      <span className="text-xs font-bold text-slate-300">
                        {showPasswordLoginForm ? 'メールアドレス・パスワードでログイン' : 'マスターキーでログイン'}
                      </span>
                    </div>

                    <form onSubmit={handleLogin} className="space-y-3 text-left">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          {showPasswordLoginForm ? 'ユーザーID または メールアドレス' : 'ユーザーID'}
                        </label>
                        <input
                          type="text"
                          required
                          placeholder={showPasswordLoginForm ? '例: alice または you@example.com' : '例: alice'}
                          value={loginId}
                          onChange={(e) => setLoginId(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        />
                      </div>

                      {showPasswordLoginForm ? (
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            パスワード
                          </label>
                          <input
                            type="password"
                            required
                            placeholder="••••••••"
                            autoComplete="current-password"
                            value={loginPassword}
                            onChange={(e) => setLoginPassword(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                          />
                        </div>
                      ) : (
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            マスターキー
                          </label>
                          <input
                            type="password"
                            required
                            autoComplete="off"
                            placeholder="spica_sk_... または astrabit_sk_..."
                            value={loginKey}
                            onChange={(e) => setLoginKey(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                          />
                        </div>
                      )}

                      <button
                        type="submit"
                        className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-md transition transform active:scale-98 cursor-pointer mt-2"
                      >
                        {showPasswordLoginForm ? 'ログイン' : '認証してログイン'}
                      </button>

                      {recoveryStatus.recoveryAvailable && (
                        <button
                          type="button"
                          onClick={() => { setShowRecoveryModal(true); setRecoveryStep('request'); setRecoveryMsg(null); }}
                          className="w-full text-[11px] text-slate-400 hover:text-amber-300 transition cursor-pointer underline decoration-dotted"
                        >
                          マスターキーを忘れた方はこちら（メールで復元）
                        </button>
                      )}

                      {isPasswordAuthMode && (
                        <button
                          type="button"
                          onClick={() => {
                            setAuthError(null);
                            setLoginMethod(showPasswordLoginForm ? 'master_key' : 'password');
                          }}
                          className="w-full text-[11px] text-indigo-400 hover:text-indigo-300 transition cursor-pointer underline decoration-dotted"
                        >
                          {showPasswordLoginForm
                            ? 'マスターキーでログインする'
                            : 'メールアドレス＋パスワードでログインする'}
                        </button>
                      )}

                      <div className="relative flex py-1 items-center">
                        <div className="flex-grow border-t border-slate-800"></div>
                        <span className="flex-shrink mx-2 text-[10px] text-slate-500 font-semibold">または</span>
                        <div className="flex-grow border-t border-slate-800"></div>
                      </div>

                      <button
                        type="button"
                        onClick={handleLoginWithPasskey}
                        disabled={isLoggingInWithPasskey}
                        className="w-full py-2.5 bg-slate-850 hover:bg-slate-800 text-slate-200 hover:text-white text-xs font-bold rounded-xl border border-slate-700 transition flex items-center justify-center space-x-2 shadow cursor-pointer disabled:opacity-50"
                      >
                        {isLoggingInWithPasskey ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                        ) : (
                          <Fingerprint className="w-3.5 h-3.5 text-emerald-400" />
                        )}
                        <span>{isLoggingInWithPasskey ? '生体認証を確認中...' : 'パスキー (Windows Hello / Touch ID) でログイン'}</span>
                      </button>

                      <div className="text-center pt-1">
                        <button
                          type="button"
                          onClick={() => {
                            setAuthError(null);
                            setAuthPortalTab('register');
                          }}
                          className="text-[11px] text-indigo-400 hover:text-indigo-300 transition hover:underline cursor-pointer"
                        >
                          アカウントをお持ちでないですか？ 新規登録
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </div>

              {/* 統計ボックス (ローカル参加者 / ローカルノート) */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-900/90 backdrop-blur-xl border border-indigo-500/20 rounded-2xl p-3.5 text-left shadow-lg">
                  <div className="flex items-center space-x-1.5 text-[11px] font-semibold text-slate-400">
                    <Users className="w-3.5 h-3.5 text-cyan-400" />
                    <span>ローカル参加者</span>
                  </div>
                  <div className="text-xl font-black text-white mt-0.5">
                    {serverStats?.stats?.users ?? 1}
                  </div>
                </div>
                <div className="bg-slate-900/90 backdrop-blur-xl border border-indigo-500/20 rounded-2xl p-3.5 text-left shadow-lg">
                  <div className="flex items-center space-x-1.5 text-[11px] font-semibold text-slate-400">
                    <MessageSquare className="w-3.5 h-3.5 text-purple-400" />
                    <span>ローカルノート</span>
                  </div>
                  <div className="text-xl font-black text-white mt-0.5">
                    {(serverStats?.stats?.totalPosts ?? 0).toLocaleString()}
                  </div>
                </div>
              </div>

              {/* タイムラインプレビューカード */}
              <div className="bg-slate-900/90 backdrop-blur-xl border border-indigo-500/20 rounded-2xl p-4 text-left shadow-lg space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-300">タイムラインを見てみる</span>
                  <span className="text-[10px] text-indigo-400 font-mono bg-indigo-500/10 px-2 py-0.5 rounded-full border border-indigo-500/20">LIVE FEED</span>
                </div>
                <button
                  onClick={() => setShowAuthPortal(false)}
                  className="w-full py-2 px-3 bg-slate-800/80 hover:bg-slate-800 text-indigo-300 hover:text-white text-xs font-bold rounded-xl transition flex items-center justify-center space-x-1.5 border border-slate-700/60 cursor-pointer shadow"
                >
                  <span>タイムラインへ進む</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* 右側: Spica 主権型機能ショーケース (PC向け) */}
            <div className="hidden lg:flex lg:col-span-7 flex-col justify-center items-start text-left p-8 relative min-h-[500px] space-y-6">
              <div>
                <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/25 text-indigo-300 text-xs font-semibold mb-3">
                  <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Sovereign & Decentralized Social Network</span>
                </div>
                <h2 className="text-3xl font-black text-white drop-shadow-md tracking-tight leading-tight">
                  星屑が集い、誰にも奪われない<br />
                  <span className="bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 via-indigo-300 to-purple-400">
                    あなた自身の自由なソーシャル空間
                  </span>
                </h2>
                <p className="text-xs text-slate-300 max-w-lg mt-3 leading-relaxed drop-shadow">
                  Spica（スピカ）はActivityPubプロトコルに完全準拠した次世代分散型SNSノードです。特定の巨大IT企業の規約変更やアルゴリズム操作に左右されず、自立したアイデンティティを保てます。
                </p>
              </div>

              {/* Spica 3大独自特徴カード */}
              <div className="grid grid-cols-1 gap-3 w-full max-w-lg">
                <div className="bg-slate-900/80 border border-slate-800/80 backdrop-blur-xl rounded-2xl p-3.5 flex items-start space-x-3 shadow-lg">
                  <div className="w-8 h-8 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
                    <Key className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-slate-100">完全自己主権マスターキー</h3>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-normal">
                      メールアドレス・電話番号の入力は一切不要。生成される暗号鍵ひとつで安全にログインできます。
                    </p>
                  </div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800/80 backdrop-blur-xl rounded-2xl p-3.5 flex items-start space-x-3 shadow-lg">
                  <div className="w-8 h-8 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-purple-400 shrink-0">
                    <Globe className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-slate-100">ActivityPub 分散型オープン連合</h3>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-normal">
                      Fediverse全体とつながり、世界中のリモートサーバーと自由にフォロー・ノート・リアクションを交換できます。
                    </p>
                  </div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800/80 backdrop-blur-xl rounded-2xl p-3.5 flex items-start space-x-3 shadow-lg">
                  <div className="w-8 h-8 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shrink-0">
                    <Zap className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-slate-100">ミリ秒単位のリアルタイム通信</h3>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-normal">
                      Server-Sent Events（SSE）による超低遅延ストリーミングで、新着投稿やリアクションが瞬時に届きます。
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </main>

          {/* 最下部: ActivityPub プロトコル表記 (外部サーバーリストは削除し公式プロトコルのみ表記) */}
          <footer className="relative z-10 w-full px-6 py-4 mt-auto border-t border-slate-800/50 bg-slate-950/60 backdrop-blur-md">
            <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-[11px] text-slate-400">
              <div className="flex items-center space-x-2">
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-mono font-bold bg-indigo-500/10 text-indigo-300 border border-indigo-500/25 shadow-sm">
                  <Globe className="w-3 h-3 mr-1 text-indigo-400" />
                  ActivityPub
                </span>
                <span className="text-slate-400 text-xs">Decentralized Sovereign Social Web Protocol</span>
              </div>
              <div className="flex items-center space-x-3 text-slate-500 text-[11px] font-mono">
                <span>Node: {serverStats?.domain || 'spica'}</span>
                <span>•</span>
                <span>Spica v1.0.0</span>
              </div>
            </div>
          </footer>
        </div>
      )}

      {/* マスターキー発行・保存確認モーダル */}
      {showMasterKeyModal && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-purple-500/30 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-purple-600 to-indigo-600 flex items-center justify-center text-white shadow-lg mx-auto">
              <Key className="w-6 h-6" />
            </div>

            <div className="text-center">
              <h3 className="font-black text-lg text-slate-100">
                アカウントが作成されました！
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                {isPasswordAuthMode ? (
                  <>緊急時用に、あなたのアカウントの<strong className="text-purple-300">マスターキー</strong>も発行されました。</>
                ) : (
                  <>以下があなたのアカウントの唯一の<strong className="text-purple-300">マスターキー</strong>です。</>
                )}
              </p>
            </div>

            {/* 警告バナー */}
            <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 p-3 rounded-xl text-xs flex items-start space-x-2">
              <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5 text-amber-400" />
              <div className="leading-relaxed">
                <strong>重要: このキーは二度と再表示・再発行できません。</strong><br />
                {isPasswordAuthMode
                  ? '通常はメールアドレスとパスワードでログインできます。このキーはパスワードを忘れたときの最終手段になるので、必ず安全なパスワードマネージャー等に保存してください。'
                  : '紛失すると二度とログインできなくなります。必ず安全なパスワードマネージャー等に保存してください。'}
              </div>
            </div>

            {/* マスターキー表示ボックス */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 relative group">
              <div className="font-mono text-xs text-indigo-300 break-all select-all pr-10">
                {issuedMasterKey}
              </div>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(issuedMasterKey);
                  setIsCopied(true);
                  setTimeout(() => setIsCopied(false), 2000);
                }}
                className="absolute right-2.5 top-2.5 p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition cursor-pointer"
                title="キーをコピー"
              >
                {isCopied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            {/* 確認チェックボックス */}
            <label className="flex items-start space-x-2.5 text-xs text-slate-300 cursor-pointer pt-2">
              <input
                type="checkbox"
                checked={hasConfirmedSaved}
                onChange={(e) => setHasConfirmedSaved(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 bg-slate-950 border-slate-700"
              />
              <span>
                マスターキーを安全な場所にコピー・保存したことを確認しました
              </span>
            </label>

            <button
              onClick={() => {
                if (hasConfirmedSaved) {
                  setShowMasterKeyModal(false);
                }
              }}
              disabled={!hasConfirmedSaved}
              className="w-full py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-40 text-white text-xs font-bold rounded-xl shadow-lg transition"
            >
              Spica をはじめる
            </button>
          </div>
        </div>
      )}

      {/* プロフィール編集モーダル */}
      {showEditProfileModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
              <h3 className="font-bold text-base text-slate-100 flex items-center space-x-2">
                <Edit3 className="w-4 h-4 text-indigo-400" />
                <span>プロフィールの編集</span>
              </h3>
              <button
                onClick={() => setShowEditProfileModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveProfile} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">表示名</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 transition"
                  placeholder="例: 山田 太郎"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  アイコン画像 (アバター)
                </label>
                <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
                  <label
                    className={`cursor-pointer px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold flex items-center space-x-1.5 transition shrink-0 ${
                      isUploadingIcon ? 'opacity-50 pointer-events-none' : ''
                    }`}
                  >
                    {isUploadingIcon ? (
                      <RefreshCw className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                    ) : (
                      <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
                    )}
                    <span>{isUploadingIcon ? '最適化・保存中...' : '画像をアップロード'}</span>
                    <input
                      type="file"
                      accept="image/*"
                      disabled={isUploadingIcon}
                      onChange={(e) => {
                        handleUploadAvatar(e.target.files);
                        e.target.value = '';
                      }}
                      className="hidden"
                    />
                  </label>
                  <div className="flex flex-1 w-full space-x-2 items-center">
                    <input
                      type="url"
                      value={editIconUrl}
                      onChange={(e) => setEditIconUrl(e.target.value)}
                      className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500 transition font-mono"
                      placeholder="または画像URL (https://...)"
                    />
                    {editIconUrl ? (
                      <img
                        src={editIconUrl}
                        alt="プレビュー"
                        className="w-8 h-8 rounded-xl object-cover border border-slate-700 shrink-0 bg-slate-800"
                        onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-500 text-[10px] shrink-0">
                        なし
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  ヘッダーバナー画像
                </label>
                <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
                  <label
                    className={`cursor-pointer px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold flex items-center space-x-1.5 transition shrink-0 ${
                      isUploadingBanner ? 'opacity-50 pointer-events-none' : ''
                    }`}
                  >
                    {isUploadingBanner ? (
                      <RefreshCw className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                    ) : (
                      <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
                    )}
                    <span>{isUploadingBanner ? '最適化・保存中...' : '画像をアップロード'}</span>
                    <input
                      type="file"
                      accept="image/*"
                      disabled={isUploadingBanner}
                      onChange={(e) => {
                        handleUploadBanner(e.target.files);
                        e.target.value = '';
                      }}
                      className="hidden"
                    />
                  </label>
                  <input
                    type="url"
                    value={editBannerUrl}
                    onChange={(e) => setEditBannerUrl(e.target.value)}
                    className="w-full sm:flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500 transition font-mono"
                    placeholder="または画像URL (https://...)"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">自己紹介 (bio)</label>
                <textarea
                  value={editBio}
                  onChange={(e) => setEditBio(e.target.value)}
                  rows={3}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 transition resize-none"
                  placeholder="自己紹介を入力..."
                />
              </div>

              <div className="flex justify-end space-x-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowEditProfileModal(false)}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-800 transition"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={isSavingProfile}
                  className="px-5 py-2 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition flex items-center space-x-1.5"
                >
                  {isSavingProfile ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  <span>保存する</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 返信モーダル (モバイルでは全画面100dvhシート、PCではモーダル) */}
      {replyTargetPost && (
        <div className="fixed inset-0 z-50 flex flex-col sm:items-center sm:justify-center sm:p-4 bg-slate-950 sm:bg-black/80 sm:backdrop-blur-sm h-[100dvh] sm:h-auto overflow-hidden animate-in fade-in duration-200">
          <div className="bg-slate-950 sm:bg-slate-900 border-0 sm:border sm:border-slate-800 sm:rounded-3xl w-full sm:max-w-lg shadow-2xl flex flex-col flex-1 sm:flex-initial sm:max-h-[85vh] overflow-hidden">
            {/* ヘッダー: 左にキャンセル、中央にタイトル、右に返信ボタン */}
            <div className="p-3 sm:p-4 border-b border-slate-800/80 flex items-center justify-between shrink-0 bg-slate-950 sm:bg-slate-900">
              <button
                type="button"
                onClick={() => setReplyTargetPost(null)}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-400 hover:text-white transition"
              >
                キャンセル
              </button>
              <h3 className="font-bold text-sm text-slate-100 flex items-center space-x-1.5">
                <MessageCircle className="w-4 h-4 text-indigo-400" />
                <span>返信</span>
              </h3>
              <button
                onClick={handleSubmitReply}
                disabled={!replyContent.trim() || isReplying}
                className="px-4 py-1.5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white shadow-md shadow-indigo-600/30 transition flex items-center space-x-1.5"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{isReplying ? '送信中...' : '返信する'}</span>
              </button>
            </div>

            {/* 返信先投稿の超コンパクトプレビュー (画像縮小・高さを抑える) */}
            <div className="px-4 py-2.5 bg-slate-900/60 sm:bg-slate-950/60 border-b border-slate-800/80 text-xs flex space-x-3 shrink-0 max-h-28 overflow-y-auto compact-preview">
              <div className="w-8 h-8 rounded-xl overflow-hidden bg-indigo-600 flex items-center justify-center font-bold text-xs text-white shrink-0 mt-0.5">
                {replyTargetPost.author_icon ? (
                  <img src={replyTargetPost.author_icon} alt={replyTargetPost.author_name} className="w-full h-full object-cover" />
                ) : (
                  replyTargetPost.author_name.slice(0, 1).toUpperCase()
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-1.5 mb-0.5">
                  <span className="font-bold text-slate-200 truncate max-w-[140px] sm:max-w-xs">{replyTargetPost.author_name}</span>
                  <span className="text-[10px] text-slate-500 truncate font-mono">{replyTargetPost.author_handle}</span>
                </div>
                <div className="text-slate-300 leading-snug">
                  <FormattedPostContent content={replyTargetPost.content} emojis={replyTargetPost.emojis} enableEmojis={showCustomEmojis} />
                  <PostMediaGrid
                    attachments={replyTargetPost.media_attachments}
                    onImageClick={openMediaPreview}
                    className="mt-2"
                  />
                </div>
              </div>
            </div>

            {/* 返信用入力フォーム (可変 flex-1 でキーボード上でも最大領域確保) */}
            <form onSubmit={handleSubmitReply} className="p-4 flex-1 flex flex-col min-h-0 bg-slate-950 sm:bg-slate-900 space-y-2">
              {/* CW (閲覧注意) 注記入力欄 */}
              {showReplyCwInput && (
                <div className="shrink-0 animate-in fade-in duration-150">
                  <input
                    type="text"
                    value={replyCwContent}
                    onChange={(e) => setReplyCwContent(e.target.value)}
                    placeholder="閲覧注意の理由・注記 (例: ネタバレ、閲覧注意など)"
                    className="w-full bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-1.5 text-xs text-amber-200 placeholder-amber-400/50 focus:ring-2 focus:ring-amber-500 focus:outline-none transition"
                  />
                </div>
              )}

              <textarea
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                placeholder={`${replyTargetPost.author_name} さんへ返信を入力...`}
                autoFocus
                className="w-full flex-1 bg-transparent text-sm sm:text-base text-slate-100 placeholder-slate-500 focus:outline-none resize-none leading-relaxed"
              />

              <div className="pt-2 border-t border-slate-800/60 flex items-center justify-between text-[11px] text-slate-500 shrink-0">
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => setShowReplyCwInput(!showReplyCwInput)}
                    className={`px-2 py-1 rounded-lg text-xs font-semibold flex items-center space-x-1 border transition cursor-pointer ${
                      showReplyCwInput
                        ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-amber-300'
                    }`}
                    title="閲覧注意 (CW) を設定"
                  >
                    <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                    <span className="text-[10px] font-bold">CW</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowRichEmojiPicker({ target: 'reply' })}
                    className="px-2 py-1 rounded-lg text-xs font-semibold flex items-center space-x-1 border transition cursor-pointer bg-slate-900 border-slate-800 text-slate-300 hover:text-yellow-300 hover:border-yellow-500/40"
                    title="絵文字・カスタム絵文字ピッカーを開く"
                  >
                    <Smile className="w-3.5 h-3.5 text-yellow-400" />
                    <span className="text-[10px] font-bold">絵文字</span>
                  </button>

                  <span className="flex items-center space-x-1 font-mono text-[10px]">
                    <ShieldCheck className="w-3 h-3 text-emerald-400" />
                    <span>ActivityPub inReplyTo</span>
                  </span>
                </div>
                <span className="font-mono text-slate-400">{replyContent.length} 文字</span>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 会話スレッドモーダル */}
      {threadModalPost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* ヘッダー */}
            <div className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0">
              <h3 className="font-bold text-base text-slate-100 flex items-center space-x-2">
                <GitBranch className="w-4 h-4 text-cyan-400" />
                <span>会話スレッド</span>
              </h3>
              <button
                onClick={closeThreadModal}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
              >
                ✕
              </button>
            </div>

            {/* スレッド本文・タイムラインリスト */}
            <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-4">
              {isLoadingThread ? (
                <div className="text-center py-12 text-slate-400 space-y-2">
                  <RefreshCw className="w-6 h-6 animate-spin mx-auto text-indigo-400" />
                  <p className="text-xs">スレッドを読み込み中...</p>
                </div>
              ) : threadData ? (
                <div className="space-y-4">
                  {/* 親投稿（ある場合） */}
                  {threadData.parent && (
                    <div className="relative pl-6 border-l-2 border-indigo-500/40 pb-4">
                      <span className="text-[10px] font-bold text-indigo-400 mb-1 block">⬆ 親投稿</span>
                      <div className="bg-slate-950/70 border border-slate-800/80 rounded-2xl p-4">
                        <div className="flex items-center space-x-2 mb-2 min-w-0">
                          <button onClick={() => openUserProfile(threadData.parent?.author_url || threadData.parent?.user_id || threadData.parent?.author_handle || '')} className="font-bold text-xs text-slate-200 hover:underline truncate text-left shrink-1 min-w-0">
                            {threadData.parent.author_name}
                          </button>
                          <span className="text-[11px] text-slate-500 font-mono truncate flex-1 min-w-0">{threadData.parent.author_handle}</span>
                        </div>
                        <FormattedPostContent content={threadData.parent.content} emojis={threadData.parent.emojis} enableEmojis={showCustomEmojis} />
                        <PostMediaGrid
                          attachments={threadData.parent.media_attachments}
                          onImageClick={openMediaPreview}
                          className="mt-2"
                          isSensitive={Boolean(threadData.parent.is_sensitive)}
                        />
                        {threadData.parent.poll && (
                          <PollCard
                            poll={threadData.parent.poll}
                            isVoting={isVotingPoll === threadData.parent.id}
                            onVote={(indices) => {
                              if (threadData?.parent?.id) {
                                handleVotePoll(threadData.parent.id, indices);
                              }
                            }}
                            isAuthenticated={Boolean(authToken)}
                            onRequireLogin={() => setShowLoginModal(true)}
                            isAuthor={Boolean(authUser && ((threadData.parent.is_local === 1 && threadData.parent.user_id === authUser.id) || threadData.parent.author_handle?.includes(`@${authUser.id}@`)))}
                          />
                        )}
                        {threadData.parent.quote && (
                          <QuoteCard
                            quote={threadData.parent.quote}
                            onClick={() => {
                              if (threadData?.parent?.quote) {
                                handleOpenThread(threadData.parent.quote);
                              }
                            }}
                            showCustomEmojis={showCustomEmojis}
                          />
                        )}
                      </div>
                    </div>
                  )}

                  {/* 対象投稿 (フォーカス中) */}
                  <div className="bg-slate-950 border-2 border-indigo-500/40 rounded-2xl p-4 sm:p-5 shadow-lg overflow-hidden">
                    <div className="flex items-start sm:items-center space-x-3 mb-3 min-w-0">
                      <button
                        onClick={() => openUserProfile(threadData.post.author_url || threadData.post.user_id || threadData.post.author_handle)}
                        className="w-10 h-10 rounded-xl overflow-hidden bg-indigo-600 flex items-center justify-center font-bold text-white shrink-0"
                      >
                        {threadData.post.author_icon ? (
                          <img src={threadData.post.author_icon} alt={threadData.post.author_name} className="w-full h-full object-cover" />
                        ) : (
                          threadData.post.author_name.slice(0, 1).toUpperCase()
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col sm:flex-row sm:items-baseline sm:space-x-2 min-w-0">
                          <button
                            onClick={() => openUserProfile(threadData.post.author_url || threadData.post.user_id || threadData.post.author_handle)}
                            className="font-bold text-sm text-slate-100 hover:underline truncate text-left max-w-full"
                          >
                            {threadData.post.author_name}
                          </button>
                          <span className="text-xs text-slate-400 font-mono truncate max-w-full">{threadData.post.author_handle}</span>
                        </div>
                        <span className="text-[11px] text-slate-500 block mt-0.5">{new Date(threadData.post.published_at).toLocaleString('ja-JP')}</span>
                      </div>
                    </div>
                    <FormattedPostContent content={threadData.post.content} emojis={threadData.post.emojis} enableEmojis={showCustomEmojis} />
                    <PostMediaGrid
                      attachments={threadData.post.media_attachments}
                      onImageClick={openMediaPreview}
                      className="mt-3"
                      isSensitive={Boolean(threadData.post.is_sensitive)}
                    />

                    {/* 💬 引用ノート（Quote）カード */}
                    {threadData.post.quote && (
                      <QuoteCard
                        quote={threadData.post.quote}
                        onClick={() => handleOpenThread(threadData.post.quote!)}
                        showCustomEmojis={showCustomEmojis}
                      />
                    )}

                    {/* 📊 アンケート（Poll） */}
                    {threadData.post.poll && (
                      <PollCard
                        poll={threadData.post.poll}
                        isVoting={isVotingPoll === threadData.post.id}
                        onVote={(indices) => handleVotePoll(threadData.post.id, indices)}
                        isAuthenticated={Boolean(authToken)}
                        onRequireLogin={() => setShowLoginModal(true)}
                        isAuthor={Boolean(authUser && ((threadData.post.is_local === 1 && threadData.post.user_id === authUser.id) || threadData.post.author_handle?.includes(`@${authUser.id}@`)))}
                      />
                    )}

                    {/* リアクション */}
                    {threadData.post.reactions && threadData.post.reactions.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-3 pt-2 border-t border-slate-800/50">
                        {threadData.post.reactions.map((r: any) => (
                          <button
                            key={r.reaction}
                            onClick={() => {
                              if (!authToken) {
                                setShowLoginModal(true);
                                return;
                              }
                              handleToggleReaction(threadData.post.id, r.reaction);
                            }}
                            className={`px-2.5 py-1 rounded-xl text-xs font-semibold flex items-center space-x-1.5 transition border ${
                              r.me ? 'bg-indigo-600/25 border-indigo-500/50 text-indigo-300' : 'bg-slate-800/60 border-slate-700/50 text-slate-300'
                            }`}
                          >
                            {renderReactionBadgeContent(r.reaction)}
                            <span className="text-[11px] font-mono opacity-80">{r.count}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    {/* 返信ボタン */}
                    <div className="mt-3 pt-2 border-t border-slate-800/60 flex justify-end">
                      <button
                        onClick={() => handleOpenReply(threadData.post)}
                        className="px-3 py-1.5 rounded-xl bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 text-xs font-bold flex items-center space-x-1.5 transition"
                      >
                        <MessageCircle className="w-3.5 h-3.5" />
                        <span>この投稿に返信する</span>
                      </button>
                    </div>
                  </div>

                  {/* 子返信一覧 */}
                  <div className="space-y-3 pl-4 sm:pl-6 border-l-2 border-slate-800">
                    <span className="text-xs font-bold text-slate-400 block mb-2">
                      💬 返信 ({threadData.replies?.length || 0}件)
                    </span>
                    {!threadData.replies || threadData.replies.length === 0 ? (
                      <p className="text-xs text-slate-500 py-4">まだ返信はありません。</p>
                    ) : (
                      threadData.replies.map((reply: any) => (
                        <div key={reply.id} className="bg-slate-950/70 border border-slate-800/80 rounded-2xl p-4 space-y-2">
                          <div className="flex items-center space-x-2 min-w-0">
                            <button onClick={() => openUserProfile(reply.author_url || reply.user_id || reply.author_handle)} className="font-bold text-xs text-slate-200 hover:underline truncate text-left shrink-1 min-w-0">
                              {reply.author_name}
                            </button>
                            <span className="text-[11px] text-slate-500 font-mono truncate min-w-0 flex-1">{reply.author_handle}</span>
                            <span className="text-[10px] text-slate-600 shrink-0 ml-auto">{new Date(reply.published_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                          <FormattedPostContent content={reply.content} emojis={reply.emojis} enableEmojis={showCustomEmojis} />
                          <PostMediaGrid
                            attachments={reply.media_attachments}
                            onImageClick={openMediaPreview}
                            className="mt-2"
                            isSensitive={Boolean(reply.is_sensitive)}
                          />
                          {reply.poll && (
                            <PollCard
                              poll={reply.poll}
                              isVoting={isVotingPoll === reply.id}
                              onVote={(indices) => handleVotePoll(reply.id, indices)}
                              isAuthenticated={Boolean(authToken)}
                              onRequireLogin={() => setShowLoginModal(true)}
                              isAuthor={Boolean(authUser && ((reply.is_local === 1 && reply.user_id === authUser.id) || reply.author_handle?.includes(`@${authUser.id}@`)))}
                            />
                          )}
                          {reply.quote && (
                            <QuoteCard
                              quote={reply.quote}
                              onClick={() => handleOpenThread(reply.quote!)}
                              showCustomEmojis={showCustomEmojis}
                            />
                          )}
                          <div className="flex items-center justify-between pt-1 text-slate-400 text-xs">
                            <button
                              onClick={() => handleOpenReply(reply)}
                              className="hover:text-indigo-400 flex items-center space-x-1 text-[11px]"
                            >
                              <MessageCircle className="w-3 h-3" />
                              <span>返信</span>
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-500 text-center py-8">スレッド情報が見つかりませんでした。</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 🎨 リッチ絵文字・カスタム絵文字ピッカーモーダル */}
      {showRichEmojiPicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setShowRichEmojiPicker(null)}
        >
          <div
            className="bg-slate-900 border border-slate-750 rounded-3xl w-full max-w-md max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            {/* ヘッダー */}
            <div className="p-3 sm:p-4 border-b border-slate-800 flex items-center justify-between shrink-0 bg-slate-950/60">
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 rounded-xl bg-yellow-500/20 border border-yellow-500/40 flex items-center justify-center text-yellow-400">
                  <Smile className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-xs sm:text-sm text-slate-100">
                    {showRichEmojiPicker.target === 'reaction' ? 'リアクション絵文字を選択' : '絵文字を挿入'}
                  </h3>
                  <p className="text-[10px] text-slate-400">
                    {showRichEmojiPicker.target === 'reaction' ? 'クリックしてリアクションをつけます' : 'ノート本文にショートコードを挿入します'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowRichEmojiPicker(null)}
                className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 検索入力欄 */}
            <div className="p-3 border-b border-slate-800/80 bg-slate-900">
              <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 focus-within:ring-2 focus-within:ring-indigo-500">
                <Search className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
                <input
                  type="text"
                  placeholder="絵文字を検索 (例: cat, like, smile)..."
                  value={emojiSearchTerm}
                  onChange={(e) => setEmojiSearchTerm(e.target.value)}
                  className="bg-transparent text-xs text-slate-200 placeholder-slate-500 focus:outline-none flex-1"
                />
                {emojiSearchTerm && (
                  <button
                    type="button"
                    onClick={() => setEmojiSearchTerm('')}
                    className="p-1 text-slate-500 hover:text-slate-300"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            {/* カテゴリタブ */}
            {!emojiSearchTerm && (
              <div className="flex items-center px-3 py-2 border-b border-slate-800/80 bg-slate-950/40 gap-1 overflow-x-auto text-[11px] font-bold">
                <button
                  type="button"
                  onClick={() => setEmojiCategoryTab('custom')}
                  className={`px-3 py-1 rounded-xl transition shrink-0 cursor-pointer ${
                    emojiCategoryTab === 'custom'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  🎨 カスタム ({customEmojis.length})
                </button>
                <button
                  type="button"
                  onClick={() => setEmojiCategoryTab('popular')}
                  className={`px-3 py-1 rounded-xl transition shrink-0 cursor-pointer ${
                    emojiCategoryTab === 'popular'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  🌟 定番
                </button>
                <button
                  type="button"
                  onClick={() => setEmojiCategoryTab('faces')}
                  className={`px-3 py-1 rounded-xl transition shrink-0 cursor-pointer ${
                    emojiCategoryTab === 'faces'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  😀 表情
                </button>
                <button
                  type="button"
                  onClick={() => setEmojiCategoryTab('hands')}
                  className={`px-3 py-1 rounded-xl transition shrink-0 cursor-pointer ${
                    emojiCategoryTab === 'hands'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  👍 ジェスチャー
                </button>
                <button
                  type="button"
                  onClick={() => setEmojiCategoryTab('symbols')}
                  className={`px-3 py-1 rounded-xl transition shrink-0 cursor-pointer ${
                    emojiCategoryTab === 'symbols'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  ✨ シンボル
                </button>
              </div>
            )}

            {/* 絵文字グリッドエリア */}
            <div className="p-3 overflow-y-auto max-h-72 divide-y divide-slate-800/50">
              {/* 検索時、または「カスタム」タブ */}
              {(emojiSearchTerm || emojiCategoryTab === 'custom') && (
                <div className="pb-3">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-2 px-1">
                    🎨 カスタム絵文字
                  </span>
                  {customEmojis.filter(
                    (e) => !emojiSearchTerm || e.name.toLowerCase().includes(emojiSearchTerm.toLowerCase()) || (e.category && e.category.toLowerCase().includes(emojiSearchTerm.toLowerCase()))
                  ).length === 0 ? (
                    <p className="text-xs text-slate-500 py-3 text-center">
                      {customEmojis.length === 0 ? '登録されているカスタム絵文字はありません（管理者画面から登録可能）' : '一致するカスタム絵文字がありません'}
                    </p>
                  ) : (
                    <div className="grid grid-cols-5 sm:grid-cols-6 gap-2">
                      {customEmojis
                        .filter(
                          (e) => !emojiSearchTerm || e.name.toLowerCase().includes(emojiSearchTerm.toLowerCase()) || (e.category && e.category.toLowerCase().includes(emojiSearchTerm.toLowerCase()))
                        )
                        .map((ce) => (
                          <button
                            key={ce.id}
                            type="button"
                            onClick={() => {
                              const val = `:${ce.name}:`;
                              if (showRichEmojiPicker.target === 'post') {
                                setPostContent((prev) => prev ? `${prev} ${val} ` : `${val} `);
                              } else if (showRichEmojiPicker.target === 'reply') {
                                setReplyContent((prev) => prev ? `${prev} ${val} ` : `${val} `);
                              } else if (showRichEmojiPicker.target === 'reaction' && showRichEmojiPicker.postId) {
                                handleToggleReaction(showRichEmojiPicker.postId, val);
                              }
                              setShowRichEmojiPicker(null);
                            }}
                            className="flex flex-col items-center justify-center p-2 rounded-2xl bg-slate-950/60 hover:bg-indigo-600/30 border border-slate-800 hover:border-indigo-500/50 transition hover:scale-105 group cursor-pointer"
                            title={`:${ce.name}:`}
                          >
                            <img src={ce.url} alt={ce.name} className="w-8 h-8 object-contain drop-shadow" loading="lazy" />
                            <span className="text-[9px] font-mono text-slate-400 group-hover:text-indigo-200 truncate max-w-full mt-1">
                              :{ce.name}:
                            </span>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              )}

              {/* 定番リアクション */}
              {(!emojiSearchTerm && emojiCategoryTab === 'popular') && (
                <div className="pt-2">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-2 px-1">
                    🌟 人気・定番リアクション
                  </span>
                  <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
                    {['👍', '❤️', '🚀', '🎉', '✨', '🔥', '🥺', '😂', '👀', '💯', '🙏', '👏', '🥰', '🥳', '😎', '💪', '🌸', '☕', '🍙', '⚡', '💡', '🌟', '🤝', '💖'].map((em) => (
                      <button
                        key={em}
                        type="button"
                        onClick={() => {
                          if (showRichEmojiPicker.target === 'post') {
                            setPostContent((prev) => prev ? `${prev} ${em} ` : `${em} `);
                          } else if (showRichEmojiPicker.target === 'reply') {
                            setReplyContent((prev) => prev ? `${prev} ${em} ` : `${em} `);
                          } else if (showRichEmojiPicker.target === 'reaction' && showRichEmojiPicker.postId) {
                            handleToggleReaction(showRichEmojiPicker.postId, em);
                          }
                          setShowRichEmojiPicker(null);
                        }}
                        className="h-10 rounded-2xl bg-slate-950/60 hover:bg-slate-800 flex items-center justify-center text-xl hover:scale-125 transition cursor-pointer border border-slate-800/60"
                      >
                        {em}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 表情 */}
              {(!emojiSearchTerm && emojiCategoryTab === 'faces') && (
                <div className="pt-2">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-2 px-1">
                    😀 表情・スマイリー
                  </span>
                  <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
                    {['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐', '😕', '😟', '🙁', '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👻', '👽', '👾', '🤖'].map((em) => (
                      <button
                        key={em}
                        type="button"
                        onClick={() => {
                          if (showRichEmojiPicker.target === 'post') {
                            setPostContent((prev) => prev ? `${prev} ${em} ` : `${em} `);
                          } else if (showRichEmojiPicker.target === 'reply') {
                            setReplyContent((prev) => prev ? `${prev} ${em} ` : `${em} `);
                          } else if (showRichEmojiPicker.target === 'reaction' && showRichEmojiPicker.postId) {
                            handleToggleReaction(showRichEmojiPicker.postId, em);
                          }
                          setShowRichEmojiPicker(null);
                        }}
                        className="h-10 rounded-2xl bg-slate-950/60 hover:bg-slate-800 flex items-center justify-center text-xl hover:scale-125 transition cursor-pointer border border-slate-800/60"
                      >
                        {em}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* ジェスチャー */}
              {(!emojiSearchTerm && emojiCategoryTab === 'hands') && (
                <div className="pt-2">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-2 px-1">
                    👍 手・ジェスチャー
                  </span>
                  <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
                    {['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '👃', '👀', '👁️', '👅', '👄'].map((em) => (
                      <button
                        key={em}
                        type="button"
                        onClick={() => {
                          if (showRichEmojiPicker.target === 'post') {
                            setPostContent((prev) => prev ? `${prev} ${em} ` : `${em} `);
                          } else if (showRichEmojiPicker.target === 'reply') {
                            setReplyContent((prev) => prev ? `${prev} ${em} ` : `${em} `);
                          } else if (showRichEmojiPicker.target === 'reaction' && showRichEmojiPicker.postId) {
                            handleToggleReaction(showRichEmojiPicker.postId, em);
                          }
                          setShowRichEmojiPicker(null);
                        }}
                        className="h-10 rounded-2xl bg-slate-950/60 hover:bg-slate-800 flex items-center justify-center text-xl hover:scale-125 transition cursor-pointer border border-slate-800/60"
                      >
                        {em}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* シンボル */}
              {(!emojiSearchTerm && emojiCategoryTab === 'symbols') && (
                <div className="pt-2">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-2 px-1">
                    ✨ シンボル・スター
                  </span>
                  <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
                    {['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☯️', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '❇️', '✳️', '❎', '🌐', '💠', '🌀', '💤', '🔞', '❗', '❓', '‼️', '⁉️', '⚠️', '🔰', '♻️', '✅', '💯', '💢', '♨️', '⭐', '🌟', '💫', '✨', '☄️', '🪐', '🌙', '☀️'].map((em) => (
                      <button
                        key={em}
                        type="button"
                        onClick={() => {
                          if (showRichEmojiPicker.target === 'post') {
                            setPostContent((prev) => prev ? `${prev} ${em} ` : `${em} `);
                          } else if (showRichEmojiPicker.target === 'reply') {
                            setReplyContent((prev) => prev ? `${prev} ${em} ` : `${em} `);
                          } else if (showRichEmojiPicker.target === 'reaction' && showRichEmojiPicker.postId) {
                            handleToggleReaction(showRichEmojiPicker.postId, em);
                          }
                          setShowRichEmojiPicker(null);
                        }}
                        className="h-10 rounded-2xl bg-slate-950/60 hover:bg-slate-800 flex items-center justify-center text-xl hover:scale-125 transition cursor-pointer border border-slate-800/60"
                      >
                        {em}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ⚠️ 管理者用ユーザーアカウント削除確認モーダル */}
      {adminDeleteTargetUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-slate-900 border border-rose-500/40 rounded-3xl p-6 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex items-center space-x-3 text-rose-400">
              <div className="w-10 h-10 rounded-2xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-100">アカウントの完全削除</h3>
                <span className="text-xs text-rose-400 font-semibold">元に戻すことはできません</span>
              </div>
            </div>

            <div className="bg-rose-950/30 border border-rose-500/20 rounded-2xl p-3.5 text-xs text-rose-200/90 leading-relaxed space-y-2">
              <p>
                ユーザー <strong className="text-white font-mono font-bold">@{adminDeleteTargetUser.id}</strong>（{adminDeleteTargetUser.name}）を完全に消去します。
              </p>
              <ul className="list-disc list-inside space-y-1 text-[11px] text-rose-300/80">
                <li>本人のすべての投稿・画像ファイル</li>
                <li>リアクション、リノート、ブックマーク、投票</li>
                <li>フォロー・フォロワー関係、通知履歴、セッション</li>
                <li>外部連合サーバーへのアクター削除通知 (Delete Actor)</li>
              </ul>
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2">
              <button
                type="button"
                disabled={isAdminDeletingUser}
                onClick={() => setAdminDeleteTargetUser(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-xl transition cursor-pointer"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={isAdminDeletingUser}
                onClick={handleAdminDeleteUser}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-rose-600/30 transition cursor-pointer flex items-center space-x-1.5"
              >
                {isAdminDeletingUser ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>削除中...</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>完全に削除する</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 👥 ユーザーディレクトリ */}
      {showDirectoryModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setShowDirectoryModal(false)}
        >
          <div
            className="bg-slate-900 border border-slate-800 rounded-3xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-5 sm:p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center space-x-2.5">
                <div className="w-9 h-9 rounded-2xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center">
                  <Users className="w-4 h-4 text-cyan-400" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-100">ユーザー一覧</h3>
                  <span className="text-[11px] text-slate-400">このサーバーにいるユーザー（{directoryUsers.length} 人）</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowDirectoryModal(false)}
                className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={(e) => { e.preventDefault(); fetchDirectory(directorySearch); }}
              className="flex gap-2"
            >
              <input
                type="text"
                value={directorySearch}
                onChange={(e) => setDirectorySearch(e.target.value)}
                placeholder="ユーザーID・表示名で絞り込み"
                className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
              <button
                type="submit"
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-bold transition cursor-pointer"
              >
                検索
              </button>
            </form>

            {isLoadingDirectory ? (
              <div className="text-center py-10">
                <RefreshCw className="w-6 h-6 animate-spin mx-auto text-cyan-400 mb-2" />
                <p className="text-xs text-slate-400">読み込み中...</p>
              </div>
            ) : directoryUsers.length === 0 ? (
              <div className="p-8 text-center bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                該当するユーザーが見つかりません。
              </div>
            ) : (
              <div className="space-y-2">
                {directoryUsers.map((user) => (
                  <div key={user.id} className="flex items-start space-x-3 bg-slate-950/50 border border-slate-800 rounded-2xl p-3.5">
                    {user.icon_url ? (
                      <img src={user.icon_url} alt="" className="w-11 h-11 rounded-full object-cover shrink-0" />
                    ) : (
                      <div className="w-11 h-11 rounded-full bg-slate-800 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => { setShowDirectoryModal(false); openUserProfile(user.id, false); }}
                          className="font-bold text-sm text-slate-100 hover:text-cyan-300 transition cursor-pointer"
                        >
                          {user.name}
                        </button>
                        {(user.roles || []).map((role: any) => (
                          <span
                            key={role.id}
                            className="text-[10px] px-2 py-0.5 rounded-full font-bold text-white"
                            style={{ backgroundColor: role.color || '#6366f1' }}
                          >
                            {role.name}
                          </span>
                        ))}
                      </div>
                      <span className="text-[11px] text-slate-400 block truncate">{user.handle}</span>
                      {user.summary && (
                        <p className="text-[11px] text-slate-300 mt-1 line-clamp-2 whitespace-pre-wrap break-words">{user.summary}</p>
                      )}
                      {Array.isArray(user.fields) && user.fields.length > 0 && (
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                          {user.fields.map((field: any, index: number) => (
                            <span key={index} className="text-[10px] text-slate-400">
                              <span className="text-slate-500">{field.name}:</span> {field.value}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center space-x-3 mt-1 text-[10px] text-slate-500 font-mono">
                        <span>投稿 {user.post_count}</span>
                        <span>フォロワー {user.follower_count}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 🗂️ ドライブ（自分のアップロード管理） */}
      {showDriveModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setShowDriveModal(false)}
        >
          <div
            className="bg-slate-900 border border-slate-800 rounded-3xl max-w-3xl w-full max-h-[85vh] overflow-y-auto p-5 sm:p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center space-x-2.5">
                <div className="w-9 h-9 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
                  <HardDrive className="w-4 h-4 text-emerald-400" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-100">ドライブ</h3>
                  <p className="text-[11px] text-slate-400">アップロードした画像・動画・音声の管理</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowDriveModal(false)}
                className="p-2 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition cursor-pointer"
                aria-label="閉じる"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 使用量 */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
              <span className="flex items-center space-x-1.5">
                <span className="text-slate-500">使用量</span>
                <strong className="text-slate-200">{driveStats.count}</strong> 件
                <strong className="text-slate-200">{(driveStats.bytes / 1024 / 1024).toFixed(1)}</strong> MB
                {driveStats.quotaBytes > 0 && (
                  <span className="text-slate-500">/ {(driveStats.quotaBytes / 1024 / 1024).toFixed(0)} MB</span>
                )}
              </span>
              {driveStats.quotaBytes > 0 && (
                <span className="flex-1 min-w-[120px] h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <span
                    className="block h-full bg-gradient-to-r from-emerald-500 to-teal-400"
                    style={{ width: `${Math.min(100, (driveStats.bytes / driveStats.quotaBytes) * 100).toFixed(1)}%` }}
                  />
                </span>
              )}
              <span className="text-slate-500">※ 投稿で使用中のファイルは削除できません</span>
            </div>

            {driveMsg && (
              <div className={`p-2.5 rounded-xl text-xs flex items-center space-x-2 ${
                driveMsg.type === 'success'
                  ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                  : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
              }`}>
                {driveMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                <span>{driveMsg.text}</span>
              </div>
            )}

            {/* アップロード */}
            <label className="flex items-center justify-center space-x-2 px-4 py-3 rounded-2xl border border-dashed border-slate-700 hover:border-emerald-500/60 hover:bg-emerald-500/5 transition cursor-pointer">
              <FolderOpen className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-bold text-slate-300">
                {isUploadingToDrive ? 'アップロード中...' : 'ファイルを追加（画像は最大4件まで / 動画・音声は1件）'}
              </span>
              <input
                type="file"
                multiple
                accept="image/*,video/*,audio/*"
                className="hidden"
                disabled={isUploadingToDrive}
                onChange={(e) => {
                  void handleDriveUpload(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>

            {isLoadingDrive ? (
              <p className="text-center text-xs text-slate-500 py-8">読み込み中...</p>
            ) : driveItems.length === 0 ? (
              <p className="text-center text-xs text-slate-500 py-8">
                アップロードしたファイルはまだありません。
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {driveItems.map((item) => {
                  const isVideo = String(item.mediaType || '').startsWith('video/');
                  const isAudio = String(item.mediaType || '').startsWith('audio/');
                  const preview = item.thumbnailUrl || (isAudio ? '' : item.url);
                  return (
                    <div key={item.id} className="bg-slate-950/60 border border-slate-800 rounded-2xl overflow-hidden flex flex-col">
                      <div className="relative aspect-video bg-black/40 flex items-center justify-center overflow-hidden">
                        {preview ? (
                          <img src={preview} alt={item.name || 'メディア'} className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <FileVideo className="w-8 h-8 text-slate-600" />
                        )}
                        {isVideo && (
                          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-black/70 text-white text-[10px] font-bold">
                            動画{item.duration ? ` ${Math.floor(item.duration / 60)}:${String(Math.floor(item.duration % 60)).padStart(2, '0')}` : ''}
                          </span>
                        )}
                        {isAudio && (
                          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-black/70 text-white text-[10px] font-bold">音声</span>
                        )}
                        {item.postId && (
                          <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-amber-500/80 text-white text-[10px] font-bold">使用中</span>
                        )}
                      </div>
                      <div className="p-2.5 space-y-1.5 flex-1 flex flex-col">
                        <p className="text-[11px] text-slate-300 truncate" title={item.name || item.url}>
                          {item.name || '(名前なし)'}
                        </p>
                        <p className="text-[10px] text-slate-500">
                          {(Number(item.size || 0) / 1024).toFixed(0)} KB ・ {new Date(item.createdAt).toLocaleDateString('ja-JP')}
                        </p>
                        {item.postExcerpt && (
                          <p className="text-[10px] text-slate-500 truncate" title={item.postExcerpt}>投稿: {item.postExcerpt}</p>
                        )}
                        <div className="flex items-center space-x-1.5 pt-1 mt-auto">
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(item.url);
                              setDriveMsg({ type: 'success', text: 'URL をコピーしました。' });
                            }}
                            className="flex-1 px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold transition cursor-pointer flex items-center justify-center space-x-1"
                          >
                            <Copy className="w-3 h-3" />
                            <span>URL</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteDriveMedia(item.id)}
                            disabled={Boolean(item.postId)}
                            title={item.postId ? '投稿で使用中のため削除できません' : '削除'}
                            className="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-600/80 text-slate-300 hover:text-white disabled:opacity-40 disabled:hover:bg-slate-800 text-[10px] font-bold transition cursor-pointer flex items-center justify-center"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 📋 リスト（管理 + 専用タイムライン） */}
      {showListsModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setShowListsModal(false)}
        >
          <div
            className="bg-slate-900 border border-slate-800 rounded-3xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-5 sm:p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center space-x-2.5">
                <div className="w-9 h-9 rounded-2xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center">
                  <ListIcon className="w-4 h-4 text-sky-400" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-100">リスト</h3>
                  <span className="text-[11px] text-slate-400">選んだユーザーだけの専用タイムライン</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowListsModal(false)}
                className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* リスト選択 */}
            <div className="flex flex-wrap gap-2">
              {lists.map((list) => (
                <button
                  key={list.id}
                  type="button"
                  onClick={() => { setActiveListId(list.id); setListTimelinePosts([]); }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition cursor-pointer ${
                    activeListId === list.id
                      ? 'bg-sky-600 border-sky-500 text-white'
                      : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800/60'
                  }`}
                >
                  {list.name} ({list.members?.length ?? 0})
                </button>
              ))}
              {lists.length === 0 && (
                <span className="text-xs text-slate-500">まだリストがありません。下のフォームから作成してください。</span>
              )}
            </div>

            {/* 作成フォーム */}
            <form onSubmit={handleCreateList} className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
                maxLength={60}
                placeholder="新しいリスト名（例: 親しい人たち）"
                className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
              <button
                type="submit"
                disabled={!newListName.trim()}
                className="px-4 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition whitespace-nowrap flex items-center justify-center space-x-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>リスト作成</span>
              </button>
            </form>

            {listActionMsg && (
              <div
                className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                  listActionMsg.type === 'success'
                    ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                    : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                }`}
              >
                {listActionMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                <span>{listActionMsg.text}</span>
              </div>
            )}

            {/* 選択中のリストの中身 */}
            {activeListId && (() => {
              const activeList = lists.find((l) => l.id === activeListId);
              if (!activeList) return null;
              return (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="font-bold text-sm text-slate-100">{activeList.name} のメンバー</h4>
                    <div className="flex items-center space-x-2">
                      <button
                        type="button"
                        onClick={() => openListTimeline(activeList.id)}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold transition cursor-pointer"
                      >
                        タイムラインを表示
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteList(activeList.id)}
                        className="px-3 py-1.5 bg-rose-600/80 hover:bg-rose-600 text-white rounded-lg text-xs font-bold transition cursor-pointer flex items-center space-x-1"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>削除</span>
                      </button>
                    </div>
                  </div>

                  <form onSubmit={(e) => handleAddListMember(activeList.id, e)} className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={newListMember}
                      onChange={(e) => setNewListMember(e.target.value)}
                      placeholder="追加するユーザー（@user または @user@domain）"
                      className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                    <button
                      type="submit"
                      disabled={!newListMember.trim()}
                      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 text-xs font-bold rounded-xl transition whitespace-nowrap cursor-pointer"
                    >
                      メンバー追加
                    </button>
                  </form>

                  {activeList.members?.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {activeList.members.map((m: any) => (
                        <span
                          key={m.id}
                          className="inline-flex items-center space-x-2 bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200"
                        >
                          <span className="truncate max-w-[180px]">{m.display_name || m.member}</span>
                          <button
                            type="button"
                            onClick={() => handleRemoveListMember(activeList.id, m.id)}
                            className="p-0.5 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
                            title="リストから外す"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-4 bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                      メンバーがいません。ユーザーを追加してください。
                    </div>
                  )}

                  {/* リストのタイムライン */}
                  <div className="space-y-3 pt-2 border-t border-slate-800">
                    {isLoadingListTimeline ? (
                      <div className="text-center py-10">
                        <RefreshCw className="w-6 h-6 animate-spin mx-auto text-sky-400 mb-2" />
                        <p className="text-xs text-slate-400">ノートを読み込み中...</p>
                      </div>
                    ) : listTimelinePosts.length === 0 ? (
                      <div className="text-center py-8 bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                        表示できるノートがありません。「タイムラインを表示」を押すか、メンバーを追加してください。
                      </div>
                    ) : (
                      listTimelinePosts.map((post) => renderPostCard(post))
                    )}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* 🔑 マスターキー復元モーダル */}
      {showRecoveryModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setShowRecoveryModal(false)}
        >
          <div
            className="bg-slate-900 border border-slate-800 rounded-3xl p-6 max-w-md w-full shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center space-x-2.5">
                <div className="w-9 h-9 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
                  <KeyRound className="w-4 h-4 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-100">マスターキーの復元</h3>
                  <span className="text-[11px] text-slate-400">
                    {recoveryStep === 'request' ? '① ユーザーIDとメールアドレス' : recoveryStep === 'verify' ? '② 確認コードの入力' : '完了'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowRecoveryModal(false)}
                className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {recoveryMsg && (
              <div className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                recoveryMsg.type === 'success'
                  ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                  : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
              }`}>
                {recoveryMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                <span>{recoveryMsg.text}</span>
              </div>
            )}

            {recoveryStep === 'request' && (
              <form onSubmit={handleRecoveryRequest} className="space-y-3">
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  事前に登録・確認済みのメールアドレスが必要です。入力された情報が一致する場合のみ確認コードをお送りします。
                </p>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">ユーザーID</label>
                  <input
                    type="text"
                    value={recoveryUserId}
                    onChange={(e) => setRecoveryUserId(e.target.value)}
                    placeholder="例: alice"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">登録済みのメールアドレス</label>
                  <input
                    type="email"
                    value={recoveryEmail}
                    onChange={(e) => setRecoveryEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-amber-500 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={isRecovering || !recoveryUserId.trim() || !recoveryEmail.trim()}
                  className="w-full py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition cursor-pointer"
                >
                  {isRecovering ? '送信中...' : '確認コードを送信'}
                </button>
              </form>
            )}

            {recoveryStep === 'verify' && (
              <form onSubmit={handleRecoveryVerify} className="space-y-3">
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  メールに記載された6桁のコードを入力してください（10分間有効）。
                  確認できると<strong>新しいマスターキーがメールで届きます</strong>。以前のキーは無効になります。
                </p>
                <input
                  type="text"
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                  maxLength={6}
                  placeholder="123456"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-slate-200 font-mono tracking-widest text-center focus:ring-2 focus:ring-amber-500 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={isRecovering || !recoveryCode.trim()}
                  className="w-full py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition cursor-pointer"
                >
                  {isRecovering ? '確認中...' : '復元する（新しいキーを受け取る）'}
                </button>
                <button
                  type="button"
                  onClick={() => { setRecoveryStep('request'); setRecoveryMsg(null); }}
                  className="w-full text-[11px] text-slate-400 hover:text-slate-200 transition cursor-pointer"
                >
                  戻る
                </button>
              </form>
            )}

            {recoveryStep === 'done' && (
              <div className="space-y-3">
                <p className="text-xs text-slate-300 leading-relaxed">
                  新しいマスターキーをメールで送信しました。メールをご確認のうえ、<strong>新しいキーでログイン</strong>してください。
                  安全のため、以前のキーと既存のログイン状態はすべて無効になっています。
                </p>
                <button
                  type="button"
                  onClick={() => setShowRecoveryModal(false)}
                  className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-xl transition cursor-pointer"
                >
                  閉じる
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 🚩 通報モーダル */}
      {reportTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => !isSubmittingReport && setReportTarget(null)}
        >
          <div
            className="bg-slate-900 border border-rose-500/30 rounded-3xl p-6 max-w-lg w-full shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center space-x-3 text-rose-400">
                <div className="w-10 h-10 rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-100">通報する</h3>
                  <span className="text-[11px] text-slate-400">{reportTarget.label}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setReportTarget(null)}
                className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">通報の理由 <span className="text-rose-400">*</span></label>
                <select
                  value={reportCategory}
                  onChange={(e) => setReportCategory(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-rose-500"
                >
                  <option value="spam">スパム</option>
                  <option value="abuse">嫌がらせ・誹謗中傷</option>
                  <option value="sensitive">不適切な内容</option>
                  <option value="impersonation">なりすまし</option>
                  <option value="other">その他</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">詳細（任意）</label>
                <textarea
                  value={reportComment}
                  onChange={(e) => setReportComment(e.target.value)}
                  maxLength={1000}
                  rows={3}
                  placeholder="状況を詳しく記載してください（運営が確認します）"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-rose-500 resize-none"
                />
              </div>

              <p className="text-[11px] text-slate-500 leading-relaxed bg-slate-950/60 border border-slate-800 rounded-xl p-3">
                通報内容は管理者のみが確認します。他サーバーのユーザーを通報した場合は、相手サーバーへも通報（Flag）が転送されます。
              </p>
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2">
              <button
                type="button"
                disabled={isSubmittingReport}
                onClick={() => setReportTarget(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-xl transition cursor-pointer disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={isSubmittingReport}
                onClick={handleSubmitReport}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-rose-600/30 transition cursor-pointer flex items-center space-x-1.5 disabled:opacity-50"
              >
                {isSubmittingReport ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>送信中...</span>
                  </>
                ) : (
                  <>
                    <ShieldAlert className="w-3.5 h-3.5" />
                    <span>通報を送信する</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ⚠️ 本人退会・アカウント削除モーダル */}
      {showSelfDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-150">
          <div className="bg-slate-900 border border-rose-500/40 rounded-3xl p-6 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex items-center space-x-3 text-rose-400">
              <div className="w-10 h-10 rounded-2xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-100">アカウントの削除（退会）</h3>
                <span className="text-xs text-rose-400 font-semibold">不可逆な操作です</span>
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              アカウントを削除すると、すべての投稿やデータが完全に抹消されます。誤操作を防ぐため、確認としてあなたのアカウントID（<span className="font-mono font-bold text-white">@{authUser?.id}</span>）を入力してください。
            </p>

            {selfDeleteError && (
              <div className="p-3 bg-rose-500/20 border border-rose-500/40 rounded-xl text-xs text-rose-300 flex items-center space-x-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{selfDeleteError}</span>
              </div>
            )}

            <form onSubmit={handleSelfDeleteAccount} className="space-y-3 pt-1">
              <div>
                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                  確認のためアカウントIDを入力してください <span className="text-rose-400 font-bold">*必須</span>
                </label>
                <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-rose-500">
                  <span className="text-slate-500 mr-1 font-mono">@</span>
                  <input
                    type="text"
                    required
                    placeholder={authUser?.id}
                    value={selfDeleteConfirmId}
                    onChange={(e) => setSelfDeleteConfirmId(e.target.value)}
                    className="bg-transparent text-slate-200 placeholder-slate-600 focus:outline-none flex-1 font-mono text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                  マスターキー (任意・本人再確認)
                </label>
                <input
                  type="password"
                  placeholder="spica_sk_..."
                  value={selfDeleteMasterKey}
                  onChange={(e) => setSelfDeleteMasterKey(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:ring-2 focus:ring-rose-500 focus:outline-none font-mono"
                />
              </div>

              <div className="flex items-center justify-end space-x-2 pt-3">
                <button
                  type="button"
                  disabled={isSelfDeleting}
                  onClick={() => setShowSelfDeleteModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-xl transition cursor-pointer"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={isSelfDeleting || selfDeleteConfirmId.trim().toLowerCase() !== authUser?.id?.toLowerCase()}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold rounded-xl shadow-lg shadow-rose-600/30 transition cursor-pointer flex items-center space-x-1.5"
                >
                  {isSelfDeleting ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>削除中...</span>
                    </>
                  ) : (
                    <>
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>退会してデータを完全消去</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* モバイル用新規投稿モーダル (全画面100dvhシート、PCではモーダル) */}
      {showMobilePostModal && (
        <div className="fixed inset-0 z-50 flex flex-col sm:items-center sm:justify-center sm:p-4 bg-slate-950 sm:bg-black/80 sm:backdrop-blur-sm h-[100dvh] sm:h-auto overflow-hidden animate-in fade-in duration-200">
          <div className="bg-slate-950 sm:bg-slate-900 border-0 sm:border sm:border-slate-800 sm:rounded-3xl w-full sm:max-w-lg shadow-2xl flex flex-col flex-1 sm:flex-initial sm:max-h-[85vh] overflow-hidden">
            {/* ヘッダー: 左にキャンセル、中央に公開範囲、右に送信ボタン */}
            <div className="p-3 sm:p-4 border-b border-slate-800/80 flex items-center justify-between shrink-0 bg-slate-950 sm:bg-slate-900">
              <button
                type="button"
                onClick={() => setShowMobilePostModal(false)}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-400 hover:text-white transition"
              >
                キャンセル
              </button>

              {/* 公開範囲セレクター (小型ピル) */}
              <div className="flex items-center bg-slate-900 sm:bg-slate-950 p-0.5 rounded-xl border border-slate-800">
                <button
                  type="button"
                  onClick={() => setPostVisibility('public')}
                  className={`px-2.5 py-1 text-[11px] font-bold rounded-lg transition flex items-center space-x-1 ${
                    postVisibility === 'public'
                      ? 'bg-indigo-600 text-white shadow'
                      : 'text-slate-400'
                  }`}
                >
                  <Globe className="w-3 h-3" />
                  <span>連合</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPostVisibility('local')}
                  className={`px-2.5 py-1 text-[11px] font-bold rounded-lg transition flex items-center space-x-1 ${
                    postVisibility === 'local'
                      ? 'bg-emerald-600 text-white shadow'
                      : 'text-slate-400'
                  }`}
                >
                  <Server className="w-3 h-3" />
                  <span>ローカル</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPostVisibility('followers')}
                  className={`px-2.5 py-1 text-[11px] font-bold rounded-lg transition flex items-center space-x-1 ${
                    postVisibility === 'followers'
                      ? 'bg-amber-600 text-white shadow'
                      : 'text-slate-400'
                  }`}
                >
                  <Users className="w-3 h-3" />
                  <span>フォロワー</span>
                </button>
              </div>

              <button
                onClick={async (e) => {
                  await handleCreatePost(e);
                  setShowMobilePostModal(false);
                }}
                disabled={(!postContent.trim() && postAttachments.length === 0 && !quoteTargetPost && (!showPollInput || pollChoices.filter((c) => c.trim()).length < 2)) || isPosting || isUploadingMedia}
                className="px-4 py-1.5 bg-gradient-to-r from-indigo-600 to-purple-600 disabled:opacity-40 text-white text-xs font-bold rounded-xl shadow-md transition flex items-center space-x-1.5 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span>
                  {isPosting
                    ? '配信中...'
                    : isUploadingMedia
                    ? uploadStatusText || '最適化中...'
                    : '投稿する'}
                </span>
              </button>
            </div>

            {/* テキスト入力エリア (可変 flex-1 でキーボードの高さに自動フィット) */}
            <form
              onSubmit={async (e) => {
                await handleCreatePost(e);
                setShowMobilePostModal(false);
              }}
              className="p-4 flex-1 flex flex-col min-h-0 bg-slate-950 sm:bg-slate-900 space-y-2 overflow-y-auto"
            >
              {/* 💬 引用ターゲットプレビュー (モバイル) */}
              {quoteTargetPost && (
                <div className="p-2.5 rounded-2xl bg-indigo-950/40 border border-indigo-500/40 flex items-start justify-between gap-2 shrink-0 animate-in fade-in duration-150">
                  <div className="flex items-start space-x-2 min-w-0">
                    <Quote className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <div className="flex items-center space-x-1 text-xs font-bold text-indigo-300">
                        <span>引用:</span>
                        <span className="truncate">{quoteTargetPost.author_name}</span>
                        <span className="text-[10px] text-slate-400 font-mono truncate">{quoteTargetPost.author_handle}</span>
                      </div>
                      <p className="text-xs text-slate-300 truncate mt-0.5">{quoteTargetPost.content}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setQuoteTargetPost(null)}
                    className="p-1 text-slate-400 hover:text-white rounded-lg transition shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* CW (閲覧注意) 注記入力欄 */}
              {showCwInput && (
                <div className="shrink-0 animate-in fade-in duration-150">
                  <input
                    type="text"
                    value={cwContent}
                    onChange={(e) => setCwContent(e.target.value)}
                    placeholder="閲覧注意の理由・注記 (例: ネタバレ、閲覧注意など)"
                    className="w-full bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-1.5 text-xs text-amber-200 placeholder-amber-400/50 focus:ring-2 focus:ring-amber-500 focus:outline-none transition"
                  />
                </div>
              )}

              <div className="relative flex-1 flex flex-col min-h-[100px]">
                <textarea
                  id="mobile-post-textarea"
                  value={postContent}
                  onChange={(e) => {
                    setPostContent(e.target.value);
                    checkAutocomplete(e.target.value, e.target.selectionStart);
                  }}
                  onKeyUp={(e) => checkAutocomplete(postContent, e.currentTarget.selectionStart)}
                  onKeyDown={(e) => handleAutocompleteKeyDown(e, postContent, setPostContent)}
                  placeholder={
                    postVisibility === 'public'
                      ? 'いまどうしてる？ (@ユーザー, #タグ自動補完)'
                      : postVisibility === 'followers'
                        ? 'いまどうしてる？ (🔒 フォロワー限定, @ユーザー, #タグ自動補完)'
                        : 'いまどうしてる？ (ローカル限定, @ユーザー, #タグ自動補完)'
                  }
                  autoFocus
                  className="w-full flex-1 min-h-[100px] bg-transparent text-sm sm:text-base text-slate-100 placeholder-slate-500 focus:outline-none resize-none leading-relaxed"
                />
                <AutocompleteDropdown
                  type={autocompleteType}
                  suggestions={autocompleteSuggestions}
                  selectedIndex={autocompleteIndex}
                  onSelect={(item) => applyAutocomplete(item, postContent, setPostContent, document.querySelector<HTMLTextAreaElement>('#mobile-post-textarea'))}
                />
              </div>

              {/* 📊 アンケート作成エディター (モバイル) */}
              {showPollInput && (
                <div className="shrink-0">
                  <PollInputEditor
                    choices={pollChoices}
                    onChangeChoices={setPollChoices}
                    multiple={pollMultiple}
                    onChangeMultiple={setPollMultiple}
                    expiresIn={pollExpiresIn}
                    onChangeExpiresIn={setPollExpiresIn}
                    onClose={() => {
                      setShowPollInput(false);
                      setPollChoices(['', '']);
                    }}
                  />
                </div>
              )}

              {/* 添付画像サムネイル */}
              {postAttachments.length > 0 && (
                <div className="flex flex-wrap gap-2 py-2 shrink-0">
                  {postAttachments.map((att, idx) => (
                    <div key={idx} className="relative group w-16 h-16 rounded-xl overflow-hidden border border-slate-700 bg-slate-950 shadow-md">
                      <img src={att.url} alt={`添付画像 ${idx + 1}`} className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => handleRemoveAttachment(idx)}
                        className="absolute top-1 right-1 p-0.5 bg-black/75 hover:bg-rose-600 rounded-full text-white transition shadow"
                        title="削除"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="pt-2 border-t border-slate-800/60 flex items-center justify-between text-[11px] text-slate-500 shrink-0">
                <div className="flex items-center space-x-1.5 flex-wrap gap-y-1.5">
                  <label
                    className={`cursor-pointer px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-indigo-300 text-xs font-semibold flex items-center space-x-1.5 transition ${
                      postAttachments.length >= 4 || isUploadingMedia ? 'opacity-50 pointer-events-none' : ''
                    }`}
                  >
                    {isUploadingMedia ? (
                      <RefreshCw className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                    ) : (
                      <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
                    )}
                    <span className="text-[11px]">{isUploadingMedia ? uploadStatusText || '処理中...' : `画像 (${postAttachments.length}/4)`}</span>
                    <input
                      type="file"
                      accept="image/*,video/*,audio/*"
                      multiple
                      disabled={isUploadingMedia || postAttachments.length >= 4}
                      onChange={(e) => {
                        handleSelectMedia(e.target.files);
                        e.target.value = '';
                      }}
                      className="hidden"
                    />
                  </label>

                  {/* ⚠️ センシティブ (NSFW) 指定トグル (モバイル) */}
                  {postAttachments.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setIsSensitivePost(!isSensitivePost)}
                      className={`px-1.5 py-1 rounded-lg text-xs font-semibold flex items-center space-x-0.5 border transition cursor-pointer ${
                        isSensitivePost
                          ? 'bg-rose-500/20 border-rose-500/40 text-rose-300'
                          : 'bg-slate-900 border-slate-800 text-slate-400'
                      }`}
                      title={isSensitivePost ? '閲覧注意（NSFW）を解除' : '画像を閲覧注意（NSFWぼかし）に指定'}
                    >
                      <EyeOff className={`w-3 h-3 ${isSensitivePost ? 'text-rose-400' : 'text-slate-400'}`} />
                      <span className="text-[10px] font-bold">NSFW</span>
                    </button>
                  )}

                  {/* ⚡ 自動圧縮トグルボタン (モバイル) */}
                  <button
                    type="button"
                    onClick={() => {
                      const next = !autoCompressImages;
                      setAutoCompressImages(next);
                      localStorage.setItem('spica_auto_compress', String(next));
                    }}
                    className={`px-1.5 py-1 rounded-lg text-xs font-semibold flex items-center space-x-0.5 border transition cursor-pointer ${
                      autoCompressImages
                        ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                        : 'bg-slate-900 border-slate-800 text-slate-500'
                    }`}
                    title={autoCompressImages ? '自動圧縮ON (WebP高速化)' : '自動圧縮OFF (元画像のまま)'}
                  >
                    <Zap className={`w-3 h-3 ${autoCompressImages ? 'text-amber-400 fill-amber-400' : 'text-slate-500'}`} />
                    <span className="text-[10px]">{autoCompressImages ? '圧縮ON' : 'OFF'}</span>
                  </button>

                  {/* 🤫 CWトグルボタン (モバイル) */}
                  <button
                    type="button"
                    onClick={() => setShowCwInput(!showCwInput)}
                    className={`px-2 py-1 rounded-lg text-xs font-semibold flex items-center space-x-1 border transition cursor-pointer ${
                      showCwInput
                        ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-amber-300'
                    }`}
                    title="閲覧注意 (CW) を設定"
                  >
                    <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                    <span className="text-[10px] font-bold">CW</span>
                  </button>

                  {/* 📊 アンケートトグルボタン (モバイル) */}
                  <button
                    type="button"
                    onClick={() => setShowPollInput(!showPollInput)}
                    className={`px-2 py-1 rounded-lg text-xs font-semibold flex items-center space-x-1 border transition cursor-pointer ${
                      showPollInput
                        ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-300'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-indigo-300'
                    }`}
                    title="アンケートを設定"
                  >
                    <BarChart2 className="w-3.5 h-3.5 text-indigo-400" />
                    <span className="text-[10px] font-bold">投票</span>
                  </button>

                  <span className="flex items-center space-x-1 text-indigo-400/80 font-mono text-[10px]">
                    <ShieldCheck className="w-3 h-3 text-emerald-400" />
                    <span>{postVisibility === 'public' ? '連合' : postVisibility === 'followers' ? '🔒 フォロワー限定' : 'ローカル'}</span>
                  </span>
                </div>

                <span className="font-mono text-slate-400">{postContent.length} 文字</span>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 📱 モバイル専用 Misskey スタイル 右下浮遊 FAB (ノート投稿ボタン) */}
      {authUser && (
        <button
          type="button"
          onClick={openMobilePostModal}
          className="fixed bottom-20 right-5 z-40 md:hidden w-14 h-14 rounded-full bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950 flex items-center justify-center shadow-2xl shadow-emerald-500/40 hover:scale-105 active:scale-95 transition cursor-pointer border-2 border-emerald-400/50"
          title="ノートを作成"
        >
          <Edit3 className="w-6 h-6 stroke-[2.5]" />
        </button>
      )}

      {/* 📱 モバイル専用固定ボトムナビゲーションバー (Misskeyスタイル) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-slate-950/95 backdrop-blur-xl border-t border-slate-800/80 px-2 py-1.5 flex justify-around items-center shadow-2xl safe-area-bottom select-none">
        {/* メニュー (ドロワーオープン) */}
        <button
          type="button"
          onClick={() => {
            setIsMobileMenuOpen(true);
            pushModalState('mobile_menu');
          }}
          className="flex flex-col items-center space-y-0.5 py-1 px-3 rounded-xl transition text-slate-400 hover:text-slate-200 cursor-pointer"
        >
          <Menu className="w-5 h-5" />
          <span className="text-[10px] font-bold">メニュー</span>
        </button>

        {/* タイムライン (ホーム) */}
        <button
          type="button"
          onClick={() => {
            navigateToView('timeline');
            handleSwitchTimelineMode('home');
          }}
          className={`flex flex-col items-center space-y-0.5 py-1 px-3 rounded-xl transition cursor-pointer ${
            currentView === 'timeline'
              ? 'text-emerald-400 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Home className="w-5 h-5" />
          <span className="text-[10px] font-bold">ホーム</span>
        </button>

        {/* 通知 */}
        <button
          type="button"
          onClick={() => {
            if (authUser) {
              navigateToView('notifications');
            } else {
              setShowLoginModal(true);
            }
          }}
          className={`relative flex flex-col items-center space-y-0.5 py-1 px-2.5 rounded-xl transition cursor-pointer ${
            currentView === 'notifications'
              ? 'text-emerald-400 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <div className="relative">
            <Bell className="w-5 h-5" />
            {unreadNotificationsCount > 0 && (
              <span className="absolute -top-1.5 -right-2 bg-rose-500 text-white text-[9px] font-black px-1.5 py-0.2 rounded-full min-w-[15px] text-center border-2 border-slate-950 shadow">
                {unreadNotificationsCount > 99 ? '99+' : unreadNotificationsCount}
              </span>
            )}
          </div>
          <span className="text-[10px] font-bold">通知</span>
        </button>

        {/* 検索・見つける */}
        <button
          type="button"
          onClick={() => navigateToView('search')}
          className={`flex flex-col items-center space-y-0.5 py-1 px-3 rounded-xl transition cursor-pointer ${
            currentView === 'search'
              ? 'text-emerald-400 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Search className="w-5 h-5" />
          <span className="text-[10px] font-bold">検索</span>
        </button>

        {/* マイページ */}
        <button
          type="button"
          onClick={() => {
            if (authUser) {
              openUserProfile(authUser.id);
            } else {
              setShowLoginModal(true);
            }
          }}
          className={`flex flex-col items-center space-y-0.5 py-1 px-3 rounded-xl transition cursor-pointer ${
            currentView === 'profile' && profileTarget === authUser?.id
              ? 'text-emerald-400 font-bold'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <User className="w-5 h-5" />
          <span className="text-[10px] font-bold">マイページ</span>
        </button>
      </nav>

      {/* 📱 モバイル メニュードロワー */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex md:hidden animate-in fade-in duration-200"
          onClick={() => setIsMobileMenuOpen(false)}
        >
          <div
            className="w-72 bg-slate-900 h-full border-r border-slate-800 p-5 flex flex-col justify-between overflow-y-auto animate-in slide-in-from-left duration-200 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-6">
              {/* ヘッダー */}
              <div className="flex items-center justify-between pb-4 border-b border-slate-800">
                <div className="flex items-center space-x-2.5">
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-cyan-500 via-indigo-600 to-purple-600 flex items-center justify-center text-white overflow-hidden shadow">
                    <img
                      src={serverStats?.icon_url || "/logo.jpg"}
                      alt={serverStats?.name || "Spica"}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.currentTarget as HTMLElement).style.display = 'none';
                      }}
                    />
                  </div>
                  <span className="font-black text-lg text-white">{serverStats?.name || 'Spica'}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* ユーザーアカウント情報 */}
              {authUser ? (
                <div
                  onClick={() => {
                    openUserProfile(authUser.id);
                    setIsMobileMenuOpen(false);
                  }}
                  className="flex items-center space-x-3 p-3 rounded-2xl bg-slate-950/80 border border-slate-800 cursor-pointer"
                >
                  <div className="w-10 h-10 rounded-xl overflow-hidden bg-gradient-to-tr from-cyan-500 to-indigo-600 flex items-center justify-center font-bold text-white shrink-0 shadow">
                    {authUser.icon_url ? (
                      <img src={authUser.icon_url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      authUser.name.slice(0, 1).toUpperCase()
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-sm text-white truncate">{authUser.name}</p>
                    <p className="text-xs text-indigo-400 font-mono truncate">{authUser.handle}</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowLoginModal(true);
                      setIsMobileMenuOpen(false);
                    }}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs transition"
                  >
                    ログイン
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowRegisterModal(true);
                      setIsMobileMenuOpen(false);
                    }}
                    className="w-full py-2.5 bg-slate-850 hover:bg-slate-800 border border-slate-700/60 text-slate-200 font-bold rounded-xl text-xs transition"
                  >
                    新規登録
                  </button>
                </div>
              )}

              {/* ナビゲーション */}
              <div className="space-y-1 text-sm font-bold">
                <button
                  type="button"
                  onClick={() => {
                    navigateToView('timeline');
                    handleSwitchTimelineMode('home');
                    setIsMobileMenuOpen(false);
                  }}
                  className="w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition cursor-pointer"
                >
                  <Home className="w-4 h-4 text-emerald-400" />
                  <span>タイムライン</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    navigateToView('search');
                    setIsMobileMenuOpen(false);
                  }}
                  className="w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition cursor-pointer"
                >
                  <Search className="w-4 h-4 text-indigo-400" />
                  <span>見つける・検索</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (authUser) {
                      navigateToView('bookmarks');
                      fetchBookmarks();
                    } else {
                      setShowLoginModal(true);
                    }
                    setIsMobileMenuOpen(false);
                  }}
                  className="w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition cursor-pointer"
                >
                  <Bookmark className="w-4 h-4 text-amber-400" />
                  <span>ブックマーク</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    navigateToView('channels');
                    fetchChannels();
                    setIsMobileMenuOpen(false);
                  }}
                  className="w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition cursor-pointer"
                >
                  <Hash className="w-4 h-4 text-indigo-400" />
                  <span>チャンネル</span>
                </button>

                {/* 👥 ユーザーディレクトリ */}
                <button
                  type="button"
                  onClick={() => {
                    setShowDirectoryModal(true);
                    fetchDirectory('');
                    setIsMobileMenuOpen(false);
                  }}
                  className="w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition cursor-pointer"
                >
                  <Users className="w-4 h-4 text-cyan-400" />
                  <span>ユーザー一覧</span>
                </button>

                {/* 📋 リスト */}
                <button
                  type="button"
                  onClick={() => {
                    if (authUser) {
                      setShowListsModal(true);
                      fetchLists();
                    } else {
                      setShowLoginModal(true);
                    }
                    setIsMobileMenuOpen(false);
                  }}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition cursor-pointer"
                >
                  <span className="flex items-center space-x-3">
                    <ListIcon className="w-4 h-4 text-sky-400" />
                    <span>リスト</span>
                  </span>
                  {lists.length > 0 && (
                    <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-sky-500/20 text-sky-300 font-mono">
                      {lists.length}
                    </span>
                  )}
                </button>

                {/* 📡 アンテナ */}
                <button
                  type="button"
                  onClick={() => {
                    openAntennaManageModal();
                    setIsMobileMenuOpen(false);
                  }}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition cursor-pointer"
                >
                  <span className="flex items-center space-x-3">
                    <Radio className="w-4 h-4 text-emerald-400" />
                    <span>アンテナ</span>
                  </span>
                  {antennas.length > 0 && (
                    <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-500/20 text-emerald-300 font-mono">
                      {antennas.length}
                    </span>
                  )}
                </button>
                {/* 🗂️ ドライブ */}
                <button
                  type="button"
                  onClick={() => {
                    if (authUser) {
                      setShowDriveModal(true);
                      fetchDrive();
                    } else {
                      setShowLoginModal(true);
                    }
                    setIsMobileMenuOpen(false);
                  }}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition cursor-pointer"
                >
                  <span className="flex items-center space-x-3">
                    <HardDrive className="w-4 h-4 text-emerald-400" />
                    <span>ドライブ</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    openSettings('profile');
                    setIsMobileMenuOpen(false);
                  }}
                  className="w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-slate-300 hover:bg-slate-800 hover:text-emerald-400 transition cursor-pointer"
                >
                  <Settings className="w-4 h-4 text-slate-400" />
                  <span>ユーザー設定</span>
                </button>
                {authUser?.role === 'admin' && (
                  <button
                    type="button"
                    onClick={() => {
                      navigateToView('admin');
                      setIsMobileMenuOpen(false);
                    }}
                    className="w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-purple-400 hover:bg-purple-950/30 transition cursor-pointer"
                  >
                    <ShieldCheck className="w-4 h-4 text-purple-400" />
                    <span>コントロールパネル</span>
                  </button>
                )}
              </div>
            </div>

            {/* ログアウト */}
            {authUser && (
              <button
                type="button"
                onClick={() => {
                  handleLogout();
                  setIsMobileMenuOpen(false);
                }}
                className="w-full flex items-center space-x-2 px-3 py-2 rounded-xl text-rose-400 hover:bg-rose-950/30 text-xs font-bold transition mt-6 cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
                <span>ログアウト</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 🖼️ 画像拡大・プレビューモーダル (Lightbox) */}
      {previewMediaUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/95 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200"
          onClick={() => setPreviewMediaUrl(null)}
        >
          <button
            onClick={() => setPreviewMediaUrl(null)}
            className="absolute top-4 right-4 p-2.5 rounded-full bg-slate-900/80 hover:bg-slate-800 text-slate-300 hover:text-white transition z-10"
            title="閉じる"
          >
            <X className="w-6 h-6" />
          </button>
          <div
            className="relative max-w-5xl max-h-[90vh] flex flex-col items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={previewMediaUrl}
              alt="画像プレビュー"
              className="max-w-full max-h-[85vh] object-contain rounded-2xl shadow-2xl"
            />
            <div className="mt-3 flex items-center space-x-2">
              <a
                href={previewMediaUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3.5 py-1.5 rounded-xl bg-slate-900/90 hover:bg-slate-800 text-xs text-slate-300 hover:text-white transition flex items-center space-x-1.5 border border-slate-700/60"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>新しいタブで元画像を開く</span>
              </a>
            </div>
          </div>
        </div>
      )}

      {/* 🔔 リアルタイム新着通知トースト (Misskey風) */}
      {notificationToast && (
        <div
          onClick={() => {
            handleNotificationClick(notificationToast);
            setNotificationToast(null);
          }}
          className="fixed bottom-6 right-6 z-50 max-w-sm w-full bg-slate-900/95 border border-indigo-500/50 shadow-2xl rounded-2xl p-4 backdrop-blur-md cursor-pointer hover:border-indigo-400 transition animate-in fade-in slide-in-from-bottom-4 duration-300 select-none"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center space-x-3 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center shrink-0">
                {notificationToast.type === 'reaction' ? (
                  <span className="text-lg">{notificationToast.content || '✨'}</span>
                ) : notificationToast.type === 'renote' || notificationToast.type === 'announce' ? (
                  <Repeat className="w-4 h-4 text-emerald-400" />
                ) : notificationToast.type === 'reply' ? (
                  <MessageSquare className="w-4 h-4 text-indigo-400" />
                ) : notificationToast.type === 'antenna' ? (
                  <Radio className="w-4 h-4 text-emerald-400" />
                ) : notificationToast.type === 'scheduled_published' ? (
                  <Clock className="w-4 h-4 text-amber-400" />
                ) : (
                  <UserPlus className="w-4 h-4 text-purple-400" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-slate-100 truncate">
                  {notificationToast.actor_name}{' '}
                  <span className="text-slate-400 font-normal">
                    {notificationToast.type === 'reaction'
                      ? 'がリアクション'
                      : notificationToast.type === 'renote' || notificationToast.type === 'announce'
                      ? 'がリノートしました'
                      : notificationToast.type === 'reply'
                      ? 'が返信しました'
                      : notificationToast.type === 'antenna'
                      ? `アンテナ「${notificationToast.content}」を受信`
                      : notificationToast.type === 'scheduled_published'
                      ? '予約投稿が公開されました'
                      : 'があなたをフォローしました'}
                  </span>
                </p>
                {notificationToast.post_content && (
                  <p className="text-[11px] text-slate-400 line-clamp-1 mt-0.5 font-sans">
                    "{notificationToast.post_content}"
                  </p>
                )}
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setNotificationToast(null);
              }}
              className="text-slate-500 hover:text-slate-300 p-1 rounded-lg hover:bg-slate-800 transition shrink-0"
              title="閉じる"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* 📡 アンテナ一覧・管理モーダル */}
      {showAntennaManageModal && (
        <AntennaManageModal
          antennas={antennas}
          activeAntenna={activeAntenna}
          onSelectAntenna={(ant) => handleSwitchTimelineMode('antenna', ant)}
          onOpenCreate={() => openAntennaModal(null)}
          onEditAntenna={(ant) => openAntennaModal(ant)}
          onDeleteAntenna={handleDeleteAntenna}
          onClose={() => setShowAntennaManageModal(false)}
        />
      )}

      {/* 📡 アンテナ作成・編集モーダル */}
      {showAntennaModal && (
        <AntennaEditModal
          initialData={editingAntenna}
          onSave={handleSaveAntenna}
          onClose={() => {
            setShowAntennaModal(false);
            setEditingAntenna(null);
          }}
        />
      )}

      {/* 📝 下書き一覧・保存モーダル */}
      {showDraftsModal && (
        <DraftsModal
          drafts={drafts}
          hasCurrentContent={Boolean(postContent.trim() || postAttachments.length > 0 || quoteTargetPost)}
          onSaveCurrent={handleSaveDraft}
          onLoadDraft={handleLoadDraft}
          onDeleteDraft={handleDeleteDraft}
          onClose={() => setShowDraftsModal(false)}
        />
      )}

      {/* ⏰ 予約投稿モーダル */}
      {showScheduleModal && (
        <ScheduleModal
          scheduledPosts={scheduledPosts}
          scheduledDateTime={scheduledDateTime}
          setScheduledDateTime={setScheduledDateTime}
          hasCurrentContent={Boolean(postContent.trim() || postAttachments.length > 0 || quoteTargetPost)}
          onSubmitSchedule={handleCreateScheduledPost}
          onCancelScheduledPost={handleCancelScheduledPost}
          onClose={() => setShowScheduleModal(false)}
        />
      )}

      {/* 📢 チャンネル作成モーダル */}
      {showCreateChannelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-slate-900 border border-slate-800 w-full max-w-lg rounded-3xl p-6 shadow-2xl space-y-5 animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center space-x-2.5">
                <div className="w-8 h-8 rounded-xl bg-indigo-500/20 flex items-center justify-center text-indigo-400">
                  <Hash className="w-4 h-4" />
                </div>
                <h3 className="text-base font-bold text-slate-100">新規チャンネル作成</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateChannelModal(false)}
                className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateChannel} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  チャンネル名 <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  maxLength={50}
                  placeholder="例: ゲーム部屋、技術談義、雑談広場など"
                  value={newChannelName}
                  onChange={(e) => setNewChannelName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  チャンネルの説明
                </label>
                <textarea
                  rows={3}
                  maxLength={200}
                  placeholder="このチャンネルの話題やルールを簡単に記載してください"
                  value={newChannelDesc}
                  onChange={(e) => setNewChannelDesc(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">
                    カテゴリ
                  </label>
                  <select
                    value={newChannelCategory}
                    onChange={(e) => setNewChannelCategory(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="general">総合・雑談</option>
                    <option value="gaming">ゲーム</option>
                    <option value="tech">技術・IT</option>
                    <option value="art">イラスト・創作</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">
                    テーマカラー
                  </label>
                  <div className="flex items-center space-x-2 pt-1">
                    {['#6366f1', '#06b6d4', '#10b981', '#a855f7', '#f43f5e', '#f59e0b'].map((col) => (
                      <button
                        key={col}
                        type="button"
                        onClick={() => setNewChannelColor(col)}
                        className={`w-6 h-6 rounded-full transition transform hover:scale-110 cursor-pointer ${
                          newChannelColor === col ? 'ring-2 ring-white ring-offset-2 ring-offset-slate-900 scale-110' : ''
                        }`}
                        style={{ backgroundColor: col }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="pt-3 flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setShowCreateChannelModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-300 text-xs font-bold transition cursor-pointer"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={isCreatingChannel || !newChannelName.trim()}
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow-lg shadow-indigo-600/30 flex items-center space-x-1.5 disabled:opacity-50 cursor-pointer"
                >
                  {isCreatingChannel ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Plus className="w-3.5 h-3.5" />
                  )}
                  <span>作成する</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 📱 PWA / モバイル ホームガード案内トースト */}
      {showExitToast && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-slate-900/95 text-slate-200 text-xs font-semibold rounded-full shadow-2xl border border-slate-700/80 backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-150 pointer-events-none flex items-center space-x-2 whitespace-nowrap">
          <span>ホーム画面です（閉じるにはホームボタンを押してください）</span>
        </div>
      )}
    </div>
  );
}
