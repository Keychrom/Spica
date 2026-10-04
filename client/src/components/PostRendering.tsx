/**
 * 投稿カードの描画（App.tsx から切り出し）
 *
 * App 側の状態（ミュート・フォロー中・各種ハンドラ）は postDeps で受け取る。
 * タイムライン / プロフィール / モーダルの各遅延チャンクが import するので、
 * 初期バンドルには含まれない。
 */
import DOMPurify from 'dompurify';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Ban, BarChart2, Bookmark, Check, Eye, EyeOff, GitBranch, Globe, Hash, Lock, MessageCircle, MessageSquare, MoreHorizontal, Pin, Quote, Radio, RefreshCw, Repeat, Server, Share2, ShieldAlert, Smile, SmilePlus, Trash2, VolumeX, X } from 'lucide-react';
import type { MediaAttachment, PollData, Post } from '../App';
import { getPrefs } from '../prefs';

/**
 * 相対時刻（設定 → 表示 → 時刻の表し方）。
 * 1 週間より古いものは日付にフォールバックする（「365日前」は嬉しくない）。
 */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}日前`;
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('ja-JP', sameYear ? { month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'numeric', day: 'numeric' });
}

export interface PostRendererDeps {
  activeMenuPostId: any;
  activeReactionPostId: any;
  activeRenoteMenuPostId: any;
  authToken: any;
  authUser: any;
  customEmojis: any;
  customReactionInput: any;
  handleBlockUser: any;
  handleDeletePost: any;
  handleMuteUser: any;
  handleOpenReply: any;
  handleOpenThread: any;
  handleSelectHashtag: any;
  handleStartQuote: any;
  handleToggleAnnounce: any;
  handleToggleBookmark: any;
  handleTogglePinPost: any;
  handleToggleReaction: any;
  handleVotePoll: any;
  isVotingPoll: any;
  openChannelDetail: any;
  openMediaPreview: any;
  openUserProfile: any;
  openedCwPostIds: any;
  quickEmojis: any;
  setActiveMenuPostId: any;
  setActiveReactionPostId: any;
  setActiveRenoteMenuPostId: any;
  setCurrentView: any;
  setCustomReactionInput: any;
  setReportCategory: any;
  setReportComment: any;
  setReportTarget: any;
  setShowLoginModal: any;
  setShowRichEmojiPicker: any;
  sharePost: any;
  showCustomEmojis: any;
  toggleCw: any;
}

export function FormattedPostContent({
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
      '$1<a href="/tags/$2" data-tag="$2" class="hashtag text-indigo-400 hover:text-indigo-300 font-semibold hover:underline cursor-pointer">#$2</a>'
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
      '$1<a href="/tags/$2" data-tag="$2" class="hashtag text-indigo-400 hover:text-indigo-300 font-semibold hover:underline cursor-pointer">#$2</a>'
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

export function PostMediaGrid({
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
  // 利用者が自分でミュートを外したか（自動再生の既定ミュートを勝手に戻さない）
  const [userUnmuted, setUserUnmuted] = useState(false);
  const mediaPrefs = getPrefs();
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
              autoPlay={videoPlaying || mediaPrefs.autoPlayMedia}
              muted={!userUnmuted && !videoPlaying && mediaPrefs.muteMediaByDefault}
              onVolumeChange={(e) => setUserUnmuted(!(e.target as HTMLVideoElement).muted)}
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
            alt={att.description || att.name || '投稿画像'}
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
                alt={att.description || att.name || `投稿画像 ${idx + 1}`}
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
              alt={attachments[0].description || attachments[0].name || '投稿画像 1'}
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
                  alt={att.description || att.name || `投稿画像 ${idx + 2}`}
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

export function QuoteCard({
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

export function PollCard({
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

export function PostOptionsMenu({
  isOpen,
  onToggle,
  onClose,
  children,
}: {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 192; // w-48
    const height = menuRef.current?.offsetHeight || 0;
    let top = rect.bottom + 4;
    if (height && top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 4);
    }
    const left = Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8));
    setPosition({ top, left });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    // スクロールや画面幅の変化でボタンとずれるので、その時は閉じる（開き直せば正しい位置に出る）
    const close = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [isOpen, onClose]);

  return (
    <>
      <button
        ref={buttonRef}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/80 transition"
        title="その他の操作"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[70] w-48 bg-slate-900 border border-slate-750 rounded-2xl shadow-2xl p-1.5 space-y-0.5 text-xs animate-in fade-in zoom-in-95 duration-100"
            style={{ top: position?.top ?? -9999, left: position?.left ?? -9999 }}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

export function AutocompleteDropdown({
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

export function PollInputEditor({
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

export function createRenderPostCard(deps: PostRendererDeps) {
  const { activeMenuPostId, activeReactionPostId, activeRenoteMenuPostId, authToken, authUser, customEmojis, customReactionInput, handleBlockUser, handleDeletePost, handleMuteUser, handleOpenReply, handleOpenThread, handleSelectHashtag, handleStartQuote, handleToggleAnnounce, handleToggleBookmark, handleTogglePinPost, handleToggleReaction, handleVotePoll, isVotingPoll, openChannelDetail, openMediaPreview, openUserProfile, openedCwPostIds, quickEmojis, setActiveMenuPostId, setActiveReactionPostId, setActiveRenoteMenuPostId, setCurrentView, setCustomReactionInput, setReportCategory, setReportComment, setReportTarget, setShowLoginModal, setShowRichEmojiPicker, sharePost, showCustomEmojis, toggleCw } = deps;

  const renderReactionBadgeContent = (reaction: string) => {
    if (reaction.startsWith(':') && reaction.endsWith(':')) {
      const clean = reaction.slice(1, -1).toLowerCase();
      const found = customEmojis.find((e: any) => e.name.toLowerCase() === clean);
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

  const renderPostCard = (post: Post) => {
    const isCwOpen = openedCwPostIds.has(post.id);

    return (
      <div
        key={post.feed_id || post.id}
        className="post-card bg-slate-900/90 border border-slate-800 hover:border-slate-700/80 rounded-2xl p-4 sm:p-5 shadow-lg transition overflow-hidden"
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
                <span className="shrink-0" title={new Date(post.published_at).toLocaleString('ja-JP')}>
                  {getPrefs().timeFormat === 'relative'
                    ? formatRelativeTime(post.published_at)
                    : new Date(post.published_at).toLocaleString('ja-JP')}
                </span>
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
            <PostOptionsMenu
              isOpen={activeMenuPostId === (post.feed_id || post.id)}
              onToggle={() =>
                setActiveMenuPostId(activeMenuPostId === (post.feed_id || post.id) ? null : (post.feed_id || post.id))
              }
              onClose={() => setActiveMenuPostId(null)}
            >

                      <button
                        onClick={() => {
                          void sharePost(post);
                          setActiveMenuPostId(null);
                        }}
                    className="w-full flex items-center space-x-2 px-2.5 py-2 rounded-xl text-slate-300 hover:bg-slate-800 hover:text-white transition text-left"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span>投稿URLを共有</span>
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
            </PostOptionsMenu>
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
              isSensitive={Boolean(post.is_sensitive) && getPrefs().alwaysHideSensitive}
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
              {quickEmojis.map((emoji: any) => (
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
                  {customEmojis.slice(0, 4).map((ce: any) => (
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
            void sharePost(post);
          }}
          className="flex items-center space-x-1 hover:text-slate-200 py-1 px-2 rounded-lg hover:bg-slate-800/50 transition"
          title="投稿URLを共有"
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

  return { renderPostCard, renderReactionBadgeContent };
}
