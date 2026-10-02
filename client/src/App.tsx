import React, { useState, useEffect, useRef, useMemo, Suspense } from 'react';
import DOMPurify from 'dompurify';
import {
  RefreshCw,
  MessageSquare,
  ShieldCheck,
  Key,
  LogOut,
  LogIn,
  List as ListIcon,
  UserCheck,
  Edit3,
  Home,
  Bell,
  Image as ImageIcon,
  X,
  Zap,
  Search,
  Hash,
  Menu,
  Bookmark,
  BarChart2,
  Quote,
  ArrowRight,
  FileText,
  ChevronDown,
  Clock,
  Palette,
  Sun,
  Moon,
  Layers,
} from 'lucide-react';
import { compressImage } from './utils/imageCompressor';
import { api, setApiToken, type ApiResult } from './api/client';
import ErrorBoundary from './components/ErrorBoundary';

// 画面ごとのコード分割（初回に読み込まない）
const TimelineView = React.lazy(() => import('./views/TimelineView'));

// 画面ごとのコード分割（初回に読み込まない）
const AuthPortalView = React.lazy(() => import('./views/AuthPortalView'));

// 画面ごとのコード分割（初回に読み込まない）
const ModalsView = React.lazy(() => import('./views/ModalsView'));


// 画面ごとのコード分割（初回に読み込まない）
const ProfileView = React.lazy(() => import('./views/ProfileView'));

// 画面ごとのコード分割（初回に読み込まない）
const NotificationsView = React.lazy(() => import('./views/NotificationsView'));

// 画面ごとのコード分割（初回に読み込まない）
const SettingsView = React.lazy(() => import('./views/SettingsView'));

// 画面ごとのコード分割（初回に読み込まない）
const AdminDashboard = React.lazy(() => import('./views/AdminDashboard'));

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

// 投稿に添付された画像グリッド表示 (1〜4枚・センシティブ/NSFWぼかし対応)

// 💬 引用ノート（Quote）カード

// ✨ メンション & ハッシュタグ 入力補完ドロップダウン UI

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
  /** 代替テキスト（alt）。連合先には添付の name として届く */
  description?: string;
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

export interface Post {
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

/** `/api/followers` / `/api/following` の 1 行（表示用にローカルの名前・アイコンも埋めてある） */
export interface FollowListEntry {
  actor_url: string;
  user_id: string;
  username: string;
  domain: string;
  name: string;
  icon_url: string;
  is_local: number;
  created_at?: string;
}

/**
 * 投稿の共有 URL。
 *
 * ローカル投稿の正規 ID は `${origin}/users/<user>/posts/<id>` で、これはサーバーが
 * OGP 付きの HTML も返す（＝そのまま共有リンクとして使える）。リモート投稿の正規 ID は
 * 他サーバーを指すので、このインスタンスの `/?post=<正規 ID>` を使う。
 *
 * ⚠️ 以前は `post.url` に頼って `${origin}/posts/<正規 ID>` を組み立てており、
 *    **開いても投稿に辿り着けない URL**（正規 ID 自体が URL なので二重 URL になる）を
 *    コピーしていた。サーバー側は旧形式を 301 で救済している（index.ts の `/posts/*`）。
 */
function buildPostPermalink(post: { id?: string; is_local?: number }): string {
  const id = post?.id || '';
  const origin = window.location.origin;
  if (id.startsWith(`${origin}/users/`)) {
    return id;
  }
  return `${origin}/?post=${encodeURIComponent(id)}`;
}

/**
 * 共有ボタンの動作。共有シートが使える端末（スマホなど）では OS の共有を開き、
 * 無ければ URL をクリップボードへコピーする。
 */
async function sharePost(post: { id?: string; is_local?: number; author_name?: string }) {
  const url = buildPostPermalink(post);
  const title = post?.author_name ? `${post.author_name} のノート` : 'Spica のノート';
  const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title, url });
      return;
    } catch (err) {
      // ユーザーが共有シートを閉じただけの場合は何もしない
      if ((err as Error)?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    alert('投稿URLをクリップボードにコピーしました！');
  } catch {
    window.prompt('この投稿の URL です', url);
  }
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
  type: 'reply' | 'follow' | 'renote' | 'announce' | 'reaction' | 'antenna' | 'scheduled_published' | 'mention' | 'move' | 'report';
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

// 📊 アンケート作成エディター（投稿フォーム用）

// 📡 アンテナ作成・編集モーダル

// 📡 アンテナ管理・一覧モーダル

// 📋 投稿の「その他」メニュー（三点リーダー）
//
// カードは角丸のため `overflow-hidden` を付けており、中に置いた absolute のメニューは
// **カードの外側で切り取られてしまう**（下端の項目が見えない）。そこで本体（document.body）へ
// 描き出し、ボタンの位置に fixed で置く。下に入らなければ上に開き、画面外へはみ出さない。

// 👥 フォロワー / フォロー中の一覧モーダル
//    プロフィールの数字は数えるだけで、誰なのかが見られなかった（`/api/followers` は
//    実装済みなのにクライアントから一度も呼ばれていなかった）。

// 🛠 チャンネル設定モーダル（作成した人・管理者だけが開ける）

// 🔐 MiAuth の承認画面（Misskey 互換クライアントがブラウザで開く URL）
//    クライアントは `/miauth/<session>?name=…&permission=…` を開き、承認されると
//    `/api/miauth/<session>/check` でトークンを受け取る。

// 📝 下書き一覧モーダル

// ⏰ 予約投稿モーダル

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
  // 「3人がリアクション」のようにまとめた通知を個別表示に切り替えたもの
  const [expandedNotifGroups, setExpandedNotifGroups] = useState<Set<string>>(new Set());
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
  // 権限（サーバーの /auth/me が返す permissions）。画面の出し分けはこれで判断する。
  //   'admin'    … すべての管理操作
  //   'moderate' … 通報・凍結・ドメイン制限のみ
  const myPermissions: string[] = Array.isArray((authUser as any)?.permissions) ? (authUser as any).permissions : [];
  const canAdmin = authUser?.role === 'admin' || myPermissions.includes('admin');
  const canModerate = canAdmin || myPermissions.includes('moderate');
  const [authToken, setAuthToken] = useState<string | null>(localStorage.getItem('spica_token') || localStorage.getItem('astrabit_token'));

  // 通信はすべて api/client.ts を通る。トークンの在処を 1 か所にする
  useEffect(() => { setApiToken(authToken); }, [authToken]);

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

  // 画面遷移・再取得で前の要求を中断する（速く切り替えたときに古い応答が新しい画面を上書きしないように）
  const timelineAbortRef = useRef<AbortController | null>(null);
  const profileAbortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const notificationsAbortRef = useRef<AbortController | null>(null);
  const bookmarksAbortRef = useRef<AbortController | null>(null);
  const channelsAbortRef = useRef<AbortController | null>(null);
  const listAbortRef = useRef<AbortController | null>(null);
  const threadAbortRef = useRef<AbortController | null>(null);
  const adminAbortRef = useRef<AbortController | null>(null);

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
          const res = await api.get(endpoint);
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
  const [adminTab, setAdminTab] = useState<'dashboard' | 'users' | 'federation' | 'blocks' | 'storage' | 'settings' | 'emojis' | 'invites' | 'reports' | 'announcements' | 'roles' | 'mail' | 'delivery' | 'audit'>('dashboard');
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
  // 🔎 リモートコンテンツの保存・索引ポリシー
  const [contentPolicy, setContentPolicy] = useState<{ ftsIndexScope: string; remoteAnnouncePolicy: string }>({
    ftsIndexScope: 'local',
    remoteAnnouncePolicy: 'follows',
  });
  const [isSavingContentPolicy, setIsSavingContentPolicy] = useState<boolean>(false);
  const [contentPolicyMsg, setContentPolicyMsg] = useState<string | null>(null);
  // 🧹 容量・メンテナンス状況
  const [maintenanceStats, setMaintenanceStats] = useState<any | null>(null);
  // 🧾 監査ログ（管理操作の履歴）
  const [auditLog, setAuditLog] = useState<any[]>([]);
  const [auditKinds, setAuditKinds] = useState<any[]>([]);
  const [auditFilter, setAuditFilter] = useState<string>('');
  const [auditTotal, setAuditTotal] = useState<number>(0);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [isLoadingAudit, setIsLoadingAudit] = useState<boolean>(false);
  const [auditMsg, setAuditMsg] = useState<string | null>(null);
  const [isClearingProxyCache, setIsClearingProxyCache] = useState<boolean>(false);
  const [isRunningMaintenance, setIsRunningMaintenance] = useState<boolean>(false);
  const [maintenanceMsg, setMaintenanceMsg] = useState<string | null>(null);
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
  // 'suspend' = 完全ブロック（通信遮断・データ削除）/ 'silence' = サイレンス（タイムラインから隠すだけ）
  const [blockInputSeverity, setBlockInputSeverity] = useState<'suspend' | 'silence'>('suspend');
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
  // モデレーター（admin 権限なし）は管理者専用タブに入れないよう、通報タブへ寄せる
  useEffect(() => {
    if (!canModerate || canAdmin) return;
    const adminOnlyTabs = ['dashboard', 'users', 'federation', 'storage', 'settings', 'emojis', 'invites', 'announcements', 'roles', 'mail', 'delivery', 'audit'];
    if (adminOnlyTabs.includes(adminTab)) {
      setAdminTab('reports');
    }
  }, [canAdmin, canModerate, adminTab]);

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
    // 別のプロフィールへ速く切り替えたときは前の要求を中断する
    profileAbortRef.current?.abort();
    const ac = new AbortController();
    profileAbortRef.current = ac;
    try {
      const encoded = encodeURIComponent(identifier);

      const [userRes, postsRes] = await Promise.all([
        api.get(`/api/users/${encoded}`, { signal: ac.signal }),
        api.get(`/api/users/${encoded}/posts`, { signal: ac.signal }),
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
      if (ac.signal.aborted) return;
      console.error('Failed to load profile:', e);
    } finally {
      if (!ac.signal.aborted) setIsLoadingProfile(false);
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
      const res = await api.put('/api/user/profile', { name: editName, summary: editBio, icon_url: editIconUrl, banner_url: editBannerUrl, is_locked: profileIsLocked, discoverable: profileDiscoverable, fields: editFields.filter((f) => f.name.trim() && f.value.trim()), });

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

      const res = await api.post('/api/media/upload', formData);
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

      const res = await api.post('/api/media/upload', formData);
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
      const res = await api.post(endpoint, { targetHandle: profileData.handle, targetActorUrl: profileData.actor_url, });

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
      const res = await api.get('/api/following', { token });
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
      const res = await api.get('/api/auth/me', { token });
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
      const res = await api.get('/api/server-info', { auth: false });
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
      const res = await api.get('/api/emojis', { auth: false });
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
    // モード・タグ・アンテナを続けて切り替えたときは前の要求を中断する
    timelineAbortRef.current?.abort();
    const ac = new AbortController();
    timelineAbortRef.current = ac;
    try {
      if (mode === 'antenna') {
        const targetAntennaId = antennaIdParam || activeAntenna?.id;
        if (!targetAntennaId) {
          setTimeline([]);
          setTimelineCursor(null);
          return;
        }
        const res = await api.get(`/api/antennas/${targetAntennaId}/timeline`, { signal: ac.signal });
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
      const res = await api.get(url, { signal: ac.signal });
      if (res.ok) {
        setTimeline(await res.json());
        setTimelineCursor(res.headers.get('X-Next-Cursor'));
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      console.error(err);
    } finally {
      if (!ac.signal.aborted) setIsLoadingTimeline(false);
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

      const res = await api.get(url);
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
      const res = await api.get('/api/antennas');
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
      const res = await api.request(method, url, antennaData);
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
      const res = await api.delete(`/api/antennas/${id}`);
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
      const res = await api.get('/api/drafts');
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
      const res = await api.post('/api/drafts', { content: postContent, cw: showCwInput ? cwContent : '', visibility: postVisibility, attachments: postAttachments, poll: pollData, quote_id: quoteTargetPost?.id || null, });
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
      const res = await api.delete(`/api/drafts/${id}`);
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
      const res = await api.get('/api/scheduled-posts');
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
      const res = await api.post('/api/scheduled-posts', { content: postContent, cw: showCwInput ? cwContent : '', visibility: postVisibility, attachments: postAttachments, poll: pollData, quote_id: quoteTargetPost?.id || null, scheduled_at: scheduledDate.toISOString(), });
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
      const res = await api.delete(`/api/scheduled-posts/${id}`);
      if (res.ok) {
        await fetchScheduledPosts();
      }
    } catch (err) {
      console.error('予約投稿キャンセルエラー:', err);
    }
  };

  // ハッシュタグ選択
  const handleSelectHashtag = (tag: string, updateUrl = true) => {
    const clean = tag.replace(/^#/, '');
    setNewPostsQueue([]);
    setTimelineCursor(null);
    setActiveHashtag(clean);
    setTimelineMode('tag');
    navigateToView('timeline', false);
    fetchTimeline('tag', clean);
    // URL を残す（タグページは共有もできる。/tags/<tag> はサーバーが OGP を差し込む）
    if (updateUrl) {
      window.history.pushState({ view: 'tag', tag: clean }, '', `/tags/${encodeURIComponent(clean)}`);
    }
  };

  // トレンド・人気タグ一覧取得
  const fetchPopularTags = async () => {
    try {
      const res = await api.get('/api/tags/popular', { auth: false });
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
    // 続けて検索したときは前の要求を中断する
    searchAbortRef.current?.abort();
    const ac = new AbortController();
    searchAbortRef.current = ac;
    try {
      const res = await api.get(`/api/search?q=${encodeURIComponent(cleanQ)}`, { signal: ac.signal });
      if (res.ok) {
        setSearchResults(await res.json());
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      console.error('検索失敗:', err);
    } finally {
      if (!ac.signal.aborted) setIsSearching(false);
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
      const res = await api.post(endpoint, { targetHandle: handle, targetActorUrl, });
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
      const res = await api.get(`/api/admin/reports?status=${status}`);
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
      const res = await api.post(`/api/admin/reports/${encodeURIComponent(reportId)}/resolve`, { action });
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
      const res = await api.post('/api/reports', reportTarget.type === 'post' ? { targetPostId: reportTarget.id, category: reportCategory, comment: reportComment } : { targetUserId: reportTarget.id, category: reportCategory, comment: reportComment },);
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
  // 🧾 監査ログの取得（管理者のみ）
  const fetchAuditLog = async (opts: { before?: string | null; action?: string } = {}) => {
    if (!authToken || !canAdmin) return;
    setIsLoadingAudit(true);
    try {
      const params = new URLSearchParams({ limit: '60' });
      if (opts.before) params.set('before', opts.before);
      const action = opts.action !== undefined ? opts.action : auditFilter;
      if (action) params.set('action', action);
      const res = await api.get(`/api/admin/audit?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setAuditMsg(data.error || '監査ログの取得に失敗しました。');
        return;
      }
      const rows: any[] = Array.isArray(data.actions) ? data.actions : [];
      setAuditLog(opts.before ? [...auditLog, ...rows] : rows);
      setAuditCursor(data.nextCursor || null);
      setAuditTotal(Number(data.total) || 0);
      setAuditKinds(Array.isArray(data.kinds) ? data.kinds : []);
      setAuditMsg(null);
    } catch (err: any) {
      setAuditMsg(err.message);
    } finally {
      setIsLoadingAudit(false);
    }
  };

  // 🧾 古い監査ログの削除
  const handlePruneAuditLog = async () => {
    if (!authToken || !canAdmin) return;
    if (!confirm('180 日より古い監査ログを削除しますか？')) return;
    try {
      const res = await api.post('/api/admin/audit/prune', { days: 180 });
      const data = await res.json();
      if (!res.ok) {
        setAuditMsg(data.error || '削除に失敗しました。');
        return;
      }
      setAuditMsg(data.message || '削除しました。');
      await fetchAuditLog();
    } catch (err: any) {
      setAuditMsg(err.message);
    }
  };

  const fetchAdminData = async () => {
    if (!authToken || !canModerate) return;
    setIsLoadingAdmin(true);
    // 管理画面を開き直したときは前の要求を中断する
    adminAbortRef.current?.abort();
    const ac = new AbortController();
    adminAbortRef.current = ac;
    try {
      // モデレーターは通報とドメイン制限だけを取得する（それ以外は 403 になる）
      if (!canAdmin) {
        const [bRes, repRes] = await Promise.all([
          api.get('/api/admin/blocks', { signal: ac.signal }),
          api.get('/api/admin/reports?status=all', { signal: ac.signal }),
        ]);
        if (bRes.ok) setAdminBlockedDomains(await bRes.json());
        if (repRes.ok) {
          const repData = await repRes.json();
          setAdminReports(repData.reports || []);
          setAdminReportCounts(repData.counts || { open: 0, total: 0 });
        }
        return;
      }

      const [sRes, uRes, fRes, rRes, bRes, stRes, setRes, emRes, invRes, repRes, annRes, mtRes] = await Promise.all([
        api.get('/api/admin/stats', { signal: ac.signal }),
        api.get('/api/admin/users', { signal: ac.signal }),
        api.get('/api/admin/federation', { signal: ac.signal }),
        api.get('/api/admin/relays', { signal: ac.signal }),
        api.get('/api/admin/blocks', { signal: ac.signal }),
        api.get('/api/admin/storage', { signal: ac.signal }),
        api.get('/api/admin/server-settings', { signal: ac.signal }),
        api.get('/api/admin/emojis', { signal: ac.signal }),
        api.get('/api/admin/invitations', { signal: ac.signal }),
        api.get('/api/admin/reports?status=all', { signal: ac.signal }),
        api.get('/api/admin/announcements', { signal: ac.signal }),
        api.get('/api/admin/maintenance', { signal: ac.signal }),
      ]);
      if (mtRes.ok) setMaintenanceStats(await mtRes.json());
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
        setContentPolicy({
          ftsIndexScope: setData.fts_index_scope || 'local',
          remoteAnnouncePolicy: setData.remote_announce_policy || 'follows',
        });
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      console.error('管理者データ取得エラー:', err);
    } finally {
      if (!ac.signal.aborted) setIsLoadingAdmin(false);
    }
  };

  // サーバー基本設定の保存
  // 🔎 リモートコンテンツの保存・索引ポリシーを保存
  const handleSaveContentPolicy = async (next: { ftsIndexScope?: string; remoteAnnouncePolicy?: string }) => {
    if (!authToken) return;
    const previous = contentPolicy;
    const updated = { ...contentPolicy, ...next };
    setContentPolicy(updated);
    setIsSavingContentPolicy(true);
    setContentPolicyMsg(null);
    try {
      const res = await api.post('/api/admin/content-policy', next);
      const data = await res.json();
      if (!res.ok) {
        setContentPolicy(previous);
        setContentPolicyMsg(data.error || '保存に失敗しました。');
        return;
      }
      setContentPolicy({
        ftsIndexScope: data.fts_index_scope || updated.ftsIndexScope,
        remoteAnnouncePolicy: data.remote_announce_policy || updated.remoteAnnouncePolicy,
      });
      setContentPolicyMsg(data.message || '保存しました。');
    } catch (err: any) {
      setContentPolicy(previous);
      setContentPolicyMsg(err.message);
    } finally {
      setIsSavingContentPolicy(false);
    }
  };

  // 🧹 定期メンテナンスを今すぐ実行（バックアップ＋方針適用＋保持期間削除。VACUUM はしません）
  const handleRunMaintenance = async () => {
    if (!authToken) return;
    if (!confirm('定期メンテナンスを実行しますか？（バックアップ → 方針適用 → 保持期間を超えたリモート投稿の削除）')) return;
    setIsRunningMaintenance(true);
    setMaintenanceMsg(null);
    try {
      const res = await api.post('/api/admin/maintenance/run');
      const data = await res.json();
      if (!res.ok) {
        setMaintenanceMsg(data.error || '実行に失敗しました。');
        return;
      }
      setMaintenanceMsg(data.message || '実行しました。');
      if (data.stats) setMaintenanceStats(data.stats);
    } catch (err: any) {
      setMaintenanceMsg(err.message);
    } finally {
      setIsRunningMaintenance(false);
    }
  };

  // 🧹 自動整理の ON/OFF と実行時刻
  const handleSaveMaintenanceSettings = async (next: { autoMaintenance?: boolean; hour?: number; imageProxy?: boolean; imageProxyMaxMb?: number }) => {
    if (!authToken) return;
    try {
      const res = await api.post('/api/admin/maintenance/settings', next);
      const data = await res.json();
      if (!res.ok) {
        setMaintenanceMsg(data.error || '設定の保存に失敗しました。');
        return;
      }
      setMaintenanceMsg(data.message || '設定を保存しました。');
      if (data.stats) setMaintenanceStats(data.stats);
    } catch (err: any) {
      setMaintenanceMsg(err.message);
    }
  };

  // 🖼️ 画像プロキシのキャッシュ整理
  const handleClearProxyCache = async () => {
    if (!authToken) return;
    setIsClearingProxyCache(true);
    try {
      const res = await api.post('/api/admin/image-proxy/cache', {});
      const data = await res.json();
      if (res.ok) {
        setMaintenanceMsg(data.message || 'キャッシュを整理しました。');
        if (data.stats) {
          setMaintenanceStats((prev: any) => (prev ? { ...prev, imageProxy: data.stats } : prev));
          fetchAdminData();
        }
      } else {
        setMaintenanceMsg(data.error || 'キャッシュの整理に失敗しました。');
      }
    } catch (err: any) {
      setMaintenanceMsg(err.message);
    } finally {
      setIsClearingProxyCache(false);
    }
  };

  // ✉️ メール通知の ON/OFF
  const handleToggleEmailNotification = async (enabled: boolean) => {
    if (!authToken) return;
    setIsSavingNotifPrefs(true);
    try {
      const res = await api.post('/api/notifications/email', { enabled });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'メール通知の設定に失敗しました。');
        return;
      }
      setEmailNotification(data.email || null);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsSavingNotifPrefs(false);
    }
  };

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
      const res = await api.post('/api/admin/server-settings', { name: adminServerName.trim(), description: adminServerDesc.trim(), icon_url: adminServerIcon.trim(), banner_url: adminServerBanner.trim(), tos_url: adminTosUrl.trim(), privacy_policy_url: adminPrivacyPolicyUrl.trim(), contact_url: adminContactUrl.trim(), repository_url: adminRepositoryUrl.trim(), operator_url: adminOperatorUrl.trim(), server_rules: adminServerRulesText.split('\n').map((r) => r.trim()).filter((r) => r.length > 0), require_rules_agreement: adminRequireRulesAgreement, });
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
      const res = await api.post('/api/admin/server-icon', formData);
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
      const res = await api.post('/api/admin/server-banner', formData);
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
      let res: ApiResult;
      if (file) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('name', newEmojiName.trim());
        formData.append('category', newEmojiCategory.trim() || '一般');
        res = await api.post('/api/admin/emojis', formData);
      } else {
        res = await api.post('/api/admin/emojis', { name: newEmojiName.trim(), category: newEmojiCategory.trim() || '一般', url: newEmojiUrl.trim(), });
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
      const res = await api.delete(`/api/admin/emojis/${encodeURIComponent(emojiId)}`);
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
      const res = await api.post('/api/admin/invitations', { maxUses: newInviteMaxUses, expiresInDays: newInviteExpiresDays === 'infinite' ? null : parseInt(newInviteExpiresDays, 10), memo: newInviteMemo.trim(), });
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
      const res = await api.delete(`/api/admin/invitations/${encodeURIComponent(code)}`);
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
      const res = await api.post('/api/admin/registration-mode', { mode });
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
      const res = await api.get('/api/notifications/unread-count');
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
    // フィルタを続けて切り替えたときは前の要求を中断する
    notificationsAbortRef.current?.abort();
    const ac = new AbortController();
    notificationsAbortRef.current = ac;
    try {
      const query = filter !== 'all' ? `?filter=${filter}` : '';
      const res = await api.get(`/api/notifications${query}`, { signal: ac.signal });
      if (res.ok) {
        const data = await res.json();
        setNotifications(data);
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      console.error('通知一覧取得エラー:', err);
    } finally {
      if (!ac.signal.aborted) setIsLoadingNotifications(false);
    }
  };

  // 全通知を既読にする
  const handleReadAllNotifications = async () => {
    if (!authToken) return;
    try {
      const res = await api.post('/api/notifications/read-all');
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
      const res = await api.post(`/api/notifications/${id}/read`);
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
        // ローカル投稿は `/users/<user>/posts/<id>` を共有 URL として使う（サーバーが OGP を返す）
        window.history.pushState({ modal: 'thread', postId }, '', buildPostPermalink({ id: postId }));
      } catch {}
    }
    setIsLoadingThread(true);
    setThreadModalPost({ id: postId } as any);
    // 別のスレッドを開いたときは前の要求を中断する
    threadAbortRef.current?.abort();
    const ac = new AbortController();
    threadAbortRef.current = ac;
    try {
      const res = await api.get(`/api/posts/${encodeURIComponent(postId)}/thread`, { signal: ac.signal });
      if (res.ok) {
        const data = await res.json();
        setThreadData(data);
        setThreadModalPost(data.post);
      } else {
        alert('該当の投稿が見つかりませんでした。');
        setThreadModalPost(null);
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      console.error('会話スレッド読み込みエラー:', err);
      setThreadModalPost(null);
    } finally {
      if (!ac.signal.aborted) setIsLoadingThread(false);
    }
  };

  // 通知をクリックした時のインタラクション
  const handleNotificationClick = async (notif: AppNotification) => {
    if (!notif.is_read) {
      handleMarkNotificationRead(notif.id);
    }
    // 運営向けの通報通知は管理パネルの「通報」タブを開く
    if (notif.type === 'report') {
      if (canModerate) {
        setAdminTab('reports');
        fetchReports(reportStatusFilter);
        navigateToView('admin');
      }
      return;
    }
    if (notif.type === 'follow') {
      openUserProfile(notif.actor_id);
    } else if (notif.post_id) {
      handleOpenThreadById(notif.post_id);
    }
  };

  /**
   * 通知のグルーピング（同じ種類・同じ投稿の連続した通知をまとめる）
   * 例: 「3人がリアクションしました」
   * メンションや返信、予約公開など「1 件ずつ読む意味がある」ものはまとめません。
   */
  const notifGroups = useMemo(() => {
    const GROUPABLE = new Set(['reaction', 'announce', 'renote', 'follow']);
    const groups: { key: string; items: AppNotification[] }[] = [];
    for (const notif of notifications) {
      const last = groups[groups.length - 1];
      const sameKind = last
        && GROUPABLE.has(notif.type)
        && last.items[0].type === notif.type
        && (last.items[0].post_id || '') === (notif.post_id || '');
      if (sameKind) {
        last!.items.push(notif);
      } else {
        groups.push({ key: notif.id, items: [notif] });
      }
    }
    return groups;
  }, [notifications]);

  const groupByFirstId = useMemo(() => {
    const map = new Map<string, { key: string; items: AppNotification[] }>();
    for (const group of notifGroups) map.set(group.items[0].id, group);
    return map;
  }, [notifGroups]);

  const groupedAwayIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of notifGroups) {
      if (group.items.length > 1) for (const item of group.items.slice(1)) ids.add(item.id);
    }
    return ids;
  }, [notifGroups]);

  // ブックマーク一覧取得
  const fetchBookmarks = async () => {
    if (!authToken) return;
    setIsLoadingBookmarks(true);
    // 別の画面へ移ってから戻ったときなど、前の要求を中断する
    bookmarksAbortRef.current?.abort();
    const ac = new AbortController();
    bookmarksAbortRef.current = ac;
    try {
      const res = await api.get('/api/bookmarks', { signal: ac.signal });
      if (res.ok) {
        const data = await res.json();
        setBookmarks(data);
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      console.error('ブックマーク取得エラー:', err);
    } finally {
      if (!ac.signal.aborted) setIsLoadingBookmarks(false);
    }
  };

  // ブックマーク追加・解除トグル
  const handleToggleBookmark = async (postId: string) => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    try {
      const res = await api.post('/api/bookmarks/toggle', { postId });
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
      const res = await api.post('/api/posts/pin/toggle', { postId });
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
      const res = await api.get('/api/muted-words');
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
      const res = await api.post('/api/muted-words', { keyword: newMutedWord.trim(), caseSensitive: mutedWordCaseSensitive, wholeWord: mutedWordWholeWord, });
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
      const res = await api.delete(`/api/muted-words/${encodeURIComponent(id)}`);
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
      const res = await api.get('/api/follow-requests');
      if (res.ok) setFollowRequests(await res.json());
    } catch (err) {
      console.error('フォローリクエストの取得エラー:', err);
    }
  };

  const handleRespondFollowRequest = async (actorUrl: string, action: 'accept' | 'reject') => {
    if (!authToken) return;
    setIsRespondingRequest(actorUrl);
    try {
      const res = await api.post('/api/follow-requests/respond', { actorUrl, action });
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
  // ✉️ メール通知（SMTP 設定時のみ。オプトイン）
  const [emailNotification, setEmailNotification] = useState<{ available: boolean; enabled: boolean; email: string; verified: boolean } | null>(null);
  const [notificationTypes, setNotificationTypes] = useState<{ type: string; label: string }[]>([]);
  const [isSavingNotifPrefs, setIsSavingNotifPrefs] = useState<boolean>(false);

  // 🗂️ ドライブ: 一覧と使用量を取得
  const fetchDrive = async () => {
    if (!authToken) return;
    setIsLoadingDrive(true);
    try {
      const res = await api.get('/api/drive');
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
      const res = await api.delete(`/api/drive/${encodeURIComponent(id)}`);
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
      const res = await api.post('/api/media/upload', form);
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
      const res = await api.get('/api/notifications/settings');
      if (!res.ok) return;
      const data = await res.json();
      setNotificationPrefs(data.prefs || {});
      setNotificationTypes(Array.isArray(data.types) ? data.types : []);
      setEmailNotification(data.email || null);
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
      const res = await api.post('/api/notifications/settings', { prefs: next });
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
      const res = await api.get('/api/lists');
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
      const res = await api.post('/api/lists', { name: newListName.trim() });
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
      const res = await api.delete(`/api/lists/${encodeURIComponent(id)}`);
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
      const res = await api.post(`/api/lists/${encodeURIComponent(listId)}/members`, { member: newListMember.trim() });
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
      const res = await api.delete(`/api/lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(memberId)}`);
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
    // 別のリストへ速く切り替えたときは前の要求を中断する
    listAbortRef.current?.abort();
    const ac = new AbortController();
    listAbortRef.current = ac;
    try {
      const res = await api.get(`/api/lists/${encodeURIComponent(listId)}/timeline`, { signal: ac.signal });
      if (res.ok) {
        const data = await res.json();
        setListTimelinePosts(data.posts || []);
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      console.error('リストタイムラインの取得エラー:', err);
    } finally {
      if (!ac.signal.aborted) setIsLoadingListTimeline(false);
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

  // 👥 フォロワー / フォロー中の一覧（プロフィールの数字から開く）
  const [followList, setFollowList] = useState<{ mode: 'followers' | 'following'; userId: string; name: string } | null>(null);
  const [followListRows, setFollowListRows] = useState<FollowListEntry[]>([]);
  const [isLoadingFollowList, setIsLoadingFollowList] = useState<boolean>(false);
  const [followListError, setFollowListError] = useState<string | null>(null);

  // 🛠 チャンネル設定（作成者・管理者のみ）
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);

  // 🔐 MiAuth: Misskey 互換クライアントの承認画面（/miauth/<session> で開く）
  const [miAuthSession, setMiAuthSession] = useState<string | null>(null);

  // 🚩 自分の通報一覧
  const [myReports, setMyReports] = useState<
    { id: string; target_handle: string; target_post_preview: string | null; category: string; comment: string; status: string; resolution_note: string; created_at: string; resolved_at: string | null }[]
  >([]);
  const [isLoadingMyReports, setIsLoadingMyReports] = useState<boolean>(false);

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
      const res = await api.get('/api/auth/recovery/status', { auth: false });
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
      const res = await api.get('/api/admin/delivery-queue');
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
      const res = await api.post('/api/admin/delivery-queue/retry');
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
      const res = await api.post('/api/admin/delivery-queue/clear-failed');
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
      const res = await api.get('/api/admin/mail-settings');
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
      const res = await api.post('/api/admin/mail-settings', { host: mailSettings.host, port: mailSettings.port, secure: mailSettings.secure, user: mailSettings.user, pass: mailSettings.pass, from: mailSettings.from, });
      const data = await res.json();
      if (!res.ok) {
        setMailSettingsMsg({ type: 'error', text: data.error || '保存に失敗しました。' });
        return;
      }

      // 認証方式・メール登録可否も同時に保存する
      const authRes = await api.post('/api/admin/auth-settings', { authMode: mailSettings.authMode, allowEmailRegistration: mailSettings.allowEmailRegistration, });
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
      const res = await api.post('/api/admin/mail-settings/test', { host: mailSettings.host, port: mailSettings.port, user: mailSettings.user, pass: mailSettings.pass, from: mailSettings.from });
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
      const res = await api.post('/api/user/email', { email: emailInput.trim() });
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
      const res = await api.post('/api/user/email/verify', { email: emailInput.trim(), code: emailCode.trim() });
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
      const res = await api.delete('/api/user/email');
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
      const res = await api.post('/api/user/password', { newPassword: pwNew, ...(pwCurrent ? { currentPassword: pwCurrent } : {}), ...(pwMasterKey.trim() ? { masterKey: pwMasterKey.trim() } : {}), });
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
      const res = await api.post('/api/auth/recovery/request', { userId: recoveryUserId.trim(), email: recoveryEmail.trim() });
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
      const res = await api.post('/api/auth/recovery/verify', { userId: recoveryUserId.trim(), email: recoveryEmail.trim(), code: recoveryCode.trim() });
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

  /**
   * フォロワー / フォロー中の一覧を開く。
   * `userId` は表示したい相手（自分以外のプロフィールからも開ける。API は公開）。
   */
  const openFollowList = async (mode: 'followers' | 'following', userId: string, name: string) => {
    setFollowList({ mode, userId, name });
    setFollowListRows([]);
    setFollowListError(null);
    setIsLoadingFollowList(true);
    try {
      const res = await api.get(`/api/${mode}?userId=${encodeURIComponent(userId)}`, { auth: false });
      if (!res.ok) {
        throw new Error('一覧を取得できませんでした。');
      }
      const data = (await res.json()) as any[];
      setFollowListRows(
        data.map((row) => {
          const actorUrl = String(mode === 'followers' ? row.follower_url : row.following_url || '');
          const username = row.username || '';
          const domain = row.domain || '';
          const isLocal = Number(row.is_local || 0) === 1;
          return {
            actor_url: actorUrl,
            // ローカルの相手は actor URL からユーザー ID を取り出す（そのままプロフィールを開ける）
            user_id: isLocal && username ? username : actorUrl,
            username,
            domain,
            name: row.name || username || actorUrl,
            icon_url: row.icon_url || '',
            is_local: isLocal ? 1 : 0,
            created_at: row.created_at,
          };
        }),
      );
    } catch (err) {
      console.error('フォロー一覧の取得エラー:', err);
      setFollowListError(err instanceof Error ? err.message : '一覧を取得できませんでした。');
    } finally {
      setIsLoadingFollowList(false);
    }
  };

  /** チャンネル設定の保存（作成者・管理者のみ。API 側でも権限を検査している） */
  const saveChannelEdit = async (patch: {
    name: string;
    description: string;
    banner_url: string;
    color: string;
    category: string;
    is_archived: boolean;
  }) => {
    if (!editingChannel || !authToken) return;
    const res = await api.put(`/api/channels/${encodeURIComponent(editingChannel.id)}`, patch);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'チャンネルの更新に失敗しました。');
      return;
    }
    const updated = (await res.json()) as Channel;
    setChannels((prev) => prev.map((ch) => (ch.id === updated.id ? { ...ch, ...updated } : ch)));
    if (selectedChannel?.id === updated.id) {
      setSelectedChannel((prev) => (prev ? { ...prev, ...updated } : prev));
    }
    alert('チャンネルを更新しました！');
  };

  /** 自分が出した通報の一覧（結果が見えなかったので追加した） */
  const fetchMyReports = async () => {
    if (!authToken) return;
    setIsLoadingMyReports(true);
    try {
      const res = await api.get('/api/reports/mine');
      if (res.ok) {
        setMyReports(await res.json());
      }
    } catch (err) {
      console.error('通報履歴の取得エラー:', err);
    } finally {
      setIsLoadingMyReports(false);
    }
  };

  const fetchDirectory = async (query = '') => {
    setIsLoadingDirectory(true);
    try {
      const res = await api.get(`/api/directory?limit=100${query ? `&q=${encodeURIComponent(query)}` : ''}`, { auth: false });
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
      const res = await api.get('/api/admin/roles');
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
      const res = await api.request(isEdit ? 'PUT' : 'POST', isEdit ? `/api/admin/roles/${encodeURIComponent(editingRoleId as string)}` : '/api/admin/roles', { name: newRoleName.trim(), color: newRoleColor, permissions: newRolePermissions });
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
      const res = await api.delete(`/api/admin/roles/${encodeURIComponent(id)}`);
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
      const res = await api.post(`/api/admin/users/${encodeURIComponent(userId)}/roles`, { roleIds: Array.from(currentIds) });
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
      const res = await api.get('/api/announcements', { auth: false });
      if (res.ok) setPublicAnnouncements(await res.json());
    } catch (err) {
      console.error('お知らせの取得エラー:', err);
    }
  };

  const fetchAdminAnnouncements = async () => {
    if (!authToken) return;
    try {
      const res = await api.get('/api/admin/announcements');
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
      const res = await api.post('/api/admin/announcements', { title: newAnnouncementTitle.trim(), content: newAnnouncementContent.trim() });
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
      const res = await api.put(`/api/admin/announcements/${encodeURIComponent(id)}`, { isActive });
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
      const res = await api.delete(`/api/admin/announcements/${encodeURIComponent(id)}`);
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

      const res = await api.post('/api/import/archive', form);
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
        api.get('/api/user/blocks'),
        api.get('/api/user/mutes'),
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
      const res = await api.post(`/api/users/${encodeURIComponent(targetIdentifier)}/block`);
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
      const res = await api.post(`/api/users/${encodeURIComponent(targetIdentifier)}/unblock`);
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
      const res = await api.post(`/api/users/${encodeURIComponent(targetIdentifier)}/mute`);
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
      const res = await api.post(`/api/users/${encodeURIComponent(targetIdentifier)}/unmute`);
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
      // 投稿のパーマリンク（/users/<user>/posts/<id>）はプロフィールより先に判定する
      // （そうしないと userId = "alice/posts/123" としてプロフィールを開きにいってしまう）
      const permalink = pathname.match(/^\/users\/([^/]+)\/posts\/([^/]+)$/);
      if (permalink) {
        const canonicalId = `${window.location.origin}/users/${decodeURIComponent(permalink[1])}/posts/${decodeURIComponent(permalink[2])}`;
        handleOpenThreadById(canonicalId, false);
        return;
      }

      if (pathname.startsWith('/users/')) {
        const userId = decodeURIComponent(pathname.replace('/users/', ''));
        if (userId) {
          openUserProfile(userId, false);
          return;
        }
      }

      if (pathname.startsWith('/tags/')) {
        const tag = decodeURIComponent(pathname.replace('/tags/', ''));
        if (tag) {
          handleSelectHashtag(tag, false);
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

      // MiAuth（Misskey 互換クライアントのログイン承認）
      if (pathname.startsWith('/miauth/')) {
        const session = decodeURIComponent(pathname.replace('/miauth/', '')).replace(/\/.*$/, '');
        if (session) {
          setMiAuthSession(session);
          return;
        }
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
      fetchMyReports();
    } else if (currentView === 'settings' && settingsTab === 'account') {
      fetchMigrationInfo();
    } else if (currentView === 'settings' && settingsTab === 'preferences') {
      fetchNotificationSettings();
    }
  }, [currentView, notificationFilter, settingsTab]);

  // 📡 SSE で受け取りたいストリームの申告
  //    サーバーはこれを見て配信先を絞る（リモート投稿の洪水を全員に流さないため）。
  //    アンテナは本文の条件で絞る仕組みなので、全部受け取ってクライアント側で判定する。
  const sseStreams = useMemo(() => {
    if (currentView === 'channels') {
      return selectedChannel ? `channel:${selectedChannel.id}` : 'all';
    }
    switch (timelineMode) {
      case 'local':
        return 'local';
      case 'home':
        return 'home';
      case 'tag':
        return activeHashtag ? `tag:${activeHashtag.replace(/^#/, '')}` : 'all';
      case 'antenna':
      default:
        return 'all';
    }
  }, [currentView, timelineMode, activeHashtag, selectedChannel]);

  // 📡 リアルタイム SSE (Server-Sent Events) ストリーミング接続
  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimeout: any = null;
    let attempt = 0;
    let cancelled = false;

    const connectSSE = async () => {
      if (cancelled) return;
      // トークンはクエリ文字列に載せない（アクセスログに残るため）。
      // 接続のたびに 60 秒・1 回限りのチケットを取ってから張る。
      let ticket: string | null = null;
      if (authToken) {
        try {
          const res = await api.post('/api/streaming/ticket');
          if (res.ok && res.data?.ticket) ticket = String(res.data.ticket);
        } catch {
          // 取れなかったときは未認証でつなぐ（公開ストリームは受けられる）
        }
        if (cancelled) return;
      }
      const params = new URLSearchParams({ streams: sseStreams });
      if (ticket) params.set('ticket', ticket);
      try {
        eventSource = new EventSource(`/api/streaming?${params.toString()}`);

        eventSource.onopen = () => {
          attempt = 0;
          setIsStreamingConnected(true);
        };

        eventSource.onerror = () => {
          setIsStreamingConnected(false);
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          // 指数バックオフ + ゆらぎ（1s → 2s → 4s … 最大 30s）。
          // サーバー再起動時に全クライアントが同時に再接続しないようにする
          attempt += 1;
          const base = Math.min(1000 * 2 ** (attempt - 1), 30000);
          const delay = Math.round(base * (0.5 + Math.random() * 0.5));
          reconnectTimeout = setTimeout(() => { void connectSSE(); }, delay);
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

    void connectSSE();

    return () => {
      cancelled = true;
      if (eventSource) eventSource.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    };
  }, [authToken, authUser?.id, sseStreams]);

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
      const res = await api.post('/api/auth/register/email-code', { email });
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
      const res = await api.post('/api/auth/register', { id: regId.trim(), name: regName.trim(), summary: regBio.trim(), inviteCode: inviteCodeInput.trim() || undefined, agreedToRules: hasAgreedToRules || true, ...(isPasswordAuthMode ? { email: regEmail.trim(), password: regPassword, emailCode: regEmailCode.trim() || undefined } : {}), });

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
      const res = await api.get('/api/user/migration');
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
      const res = await api.post('/api/user/migration/alias', { alias: migrationAliasInput.trim() });
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
      const res = await api.post('/api/user/migration/move', { target });
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
      const res = await api.post('/api/user/migration/cancel');
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
  // サーバー側でジョブとして作る（大きなアカウントでも待たされない）。
  // 受け付けたら状態を見に行き、出来上がったらダウンロードする。
  const handleExportData = async (format: 'json' | 'zip') => {
    if (!authToken) return;
    setIsExportingData(true);
    setExportingFormat(format);
    try {
      const started = await api.post('/api/user/export', { format });
      if (!started.ok) {
        const err = await started.json().catch(() => ({}));
        alert(err.error || 'データのエクスポートを開始できませんでした。');
        return;
      }
      const { jobId } = await started.json();
      setSettingsMessage({ type: 'success', text: `${format.toUpperCase()} を作成しています…（そのままお待ちください）` });

      // 出来上がるまで見に行く（最大 2 分。ZIP はアカウントが大きいと時間がかかる）
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const statusRes = await api.get(`/api/user/export/${jobId}`);
        if (!statusRes.ok) continue;
        const info = await statusRes.json();
        if (info.status === 'failed') {
          alert(info.error || 'エクスポートに失敗しました。');
          setSettingsMessage(null);
          return;
        }
        if (info.status !== 'done') continue;

        const fileRes = await api.fetch(info.downloadUrl);
        if (!fileRes.ok) {
          alert('エクスポートのダウンロードに失敗しました。');
          setSettingsMessage(null);
          return;
        }
        const blob = await fileRes.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = info.filename || `spica-export-${authUser?.id || 'me'}.${format}`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        setSettingsMessage({ type: 'success', text: `データを${format.toUpperCase()}形式でダウンロードしました！` });
        setTimeout(() => setSettingsMessage(null), 4000);
        return;
      }
      alert('エクスポートに時間がかかっています。しばらくしてから、もう一度お試しください。');
      setSettingsMessage(null);
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
    // カテゴリを続けて切り替えたときは前の要求を中断する
    channelsAbortRef.current?.abort();
    const ac = new AbortController();
    channelsAbortRef.current = ac;
    try {
      const url = channelCategoryFilter && channelCategoryFilter !== 'all'
        ? `/api/channels?category=${encodeURIComponent(channelCategoryFilter)}`
        : '/api/channels';
      const res = await api.get(url, { signal: ac.signal });
      if (res.ok) {
        const data = await res.json();
        setChannels(data);
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      console.error('Failed to fetch channels:', e);
    } finally {
      if (!ac.signal.aborted) setIsLoadingChannels(false);
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
    // 別のチャンネルへ速く切り替えたときは前の要求を中断する
    channelsAbortRef.current?.abort();
    const ac = new AbortController();
    channelsAbortRef.current = ac;
    try {
      const res = await api.get(`/api/channels/${channel.id}/timeline`, { signal: ac.signal });
      if (res.ok) {
        const data = await res.json();
        setChannelTimelinePosts(data.posts || []);
        if (data.channel) {
          setSelectedChannel(data.channel);
        }
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      console.error('Failed to fetch channel timeline:', e);
    } finally {
      if (!ac.signal.aborted) setIsLoadingChannelTimeline(false);
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
    // 別のチャンネルへ速く切り替えたときは前の要求を中断する
    channelsAbortRef.current?.abort();
    const ac = new AbortController();
    channelsAbortRef.current = ac;
    try {
      const res = await api.get(`/api/channels/${channelId}/timeline`, { signal: ac.signal });
      if (res.ok) {
        const data = await res.json();
        setChannelTimelinePosts(data.posts || []);
        if (data.channel) {
          setSelectedChannel(data.channel);
        }
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      console.error('Failed to fetch channel timeline:', e);
    } finally {
      if (!ac.signal.aborted) setIsLoadingChannelTimeline(false);
    }
  };

  const handleToggleChannelFollow = async (channelId: string) => {
    if (!authToken) {
      setShowLoginModal(true);
      return;
    }
    try {
      const res = await api.post(`/api/channels/${channelId}/follow`);
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
      const res = await api.post('/api/channels', { name: newChannelName.trim(), description: newChannelDesc.trim(), color: newChannelColor, category: newChannelCategory, });
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
      const res = await api.get('/api/webauthn/credentials');
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
      const optRes = await api.post('/api/webauthn/register/options');
      if (!optRes.ok) {
        const err = await optRes.json();
        throw new Error(err.error || 'オプション取得に失敗しました。');
      }
      const options = await optRes.json();

      // SimpleWebAuthn ブラウザ側 API 実行
      const { startRegistration } = await import('@simplewebauthn/browser');
      const regResponse = await startRegistration({ optionsJSON: options });

      const verifyRes = await api.post('/api/webauthn/register/verify', { response: regResponse, credential: regResponse, device_name: passkeyDeviceName.trim() || undefined, });

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
      const res = await api.delete(`/api/webauthn/credentials/${credId}`);
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
      const optRes = await api.post('/api/webauthn/authenticate/options', { user_id: loginId.trim() || undefined });
      if (!optRes.ok) {
        const err = await optRes.json();
        throw new Error(err.error || '認証オプションの取得に失敗しました。');
      }
      const options = await optRes.json();

      // SimpleWebAuthn ブラウザ側 生体認証 / パスキープロンプト起動
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const authResponse = await startAuthentication({ optionsJSON: options });

      const verifyRes = await api.post('/api/webauthn/authenticate/verify', { credential: authResponse, expectedChallenge: options.challenge, });

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
      const res = await api.post('/api/auth/login', usePassword // 入力がメールアドレス形式なら email、それ以外はユーザーIDとして送信する
 ? { password: loginPassword, ...(isValidEmailFormat(identifier) ? { email: identifier } : { id: identifier }) } : { id: identifier, masterKey: loginKey.trim() },);

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
        await api.post('/api/auth/logout');
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

        const res = await api.post('/api/media/upload', formData);

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
      const res = await api.post('/api/admin/storage', storageForm);
      const data = await res.json();
      if (res.ok) {
        setStorageMessage({ type: 'success', text: data.message || '保存しました。' });
        // 再取得してステート反映
        const stRes = await api.get('/api/admin/storage');
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
      const res = await api.post('/api/admin/storage/test', storageForm);
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
      const res = await api.post(`/api/posts/${encodeURIComponent(postId)}/poll/vote`, { choices: selectedChoiceIndices });
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
      const res = await api.post('/api/posts', { content: trimmed, visibility: postVisibility, attachments: postAttachments, quote_id: quoteTargetPost ? quoteTargetPost.id : undefined, is_sensitive: isSensitivePost, cw: showCwInput && cwContent.trim() ? cwContent.trim() : undefined, channel_id: postTargetChannelId || undefined, poll: hasPoll ? { choices: validChoices, multiple: pollMultiple, expires_in: pollExpiresIn, } : undefined, });

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
      const res = await api.delete(`/api/posts/${encodeURIComponent(postId)}`);
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
      const res = await api.post(`/api/posts/${encodeURIComponent(postId)}/react`, { reaction });
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
      const res = await api.post(`/api/posts/${encodeURIComponent(postId)}/announce`);
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
      const res = await api.post('/api/posts', { content: replyContent.trim(), visibility: postVisibility, in_reply_to: replyTargetPost.id, cw: showReplyCwInput && replyCwContent.trim() ? replyCwContent.trim() : undefined, });
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
        window.history.pushState({ modal: 'thread', postId: post.id }, '', buildPostPermalink(post));
      } catch {}
    }
    setThreadModalPost(post);
    setIsLoadingThread(true);
    // 別のスレッドを開いたときは前の要求を中断する
    threadAbortRef.current?.abort();
    const ac = new AbortController();
    threadAbortRef.current = ac;
    try {
      const res = await api.get(`/api/posts/${encodeURIComponent(post.id)}/thread`, { signal: ac.signal });
      if (res.ok) {
        setThreadData(await res.json());
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      console.error(err);
    } finally {
      if (!ac.signal.aborted) setIsLoadingThread(false);
    }
  };

  // リモートフォロー
  const handleFollow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !followHandle.trim()) return;

    setFollowStatus({ type: 'loading', msg: 'WebFinger解決 ＆ Follow Activity送信中...' });
    try {
      const res = await api.post('/api/follow', { targetHandle: followHandle.trim() });

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
      const res = await api.post(`/api/admin/users/${userId}/role`, { role: newRole });
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
      const res = await api.post(`/api/admin/users/${userId}/freeze`, { isFrozen: !isFrozen });
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
      const res = await api.delete(`/api/admin/users/${adminDeleteTargetUser.id}`);
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
      const res = await api.post('/api/user/delete-me', { confirmUserId: selfDeleteConfirmId.trim(), masterKey: selfDeleteMasterKey.trim() || undefined, });

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
      const keyRes = await api.get('/api/push/vapid-public-key', { auth: false });
      const { publicKey } = await keyRes.json();
      if (!publicKey) throw new Error('VAPID 公開鍵を取得できませんでした。');

      // 3. Service Worker で PushManager.subscribe
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      // 4. サーバーへ登録
      const subRes = await api.post('/api/push/subscribe', { subscription: sub.toJSON() });

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
        await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint });
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
      const res = await api.post('/api/push/test');
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
      const res = await api.post('/api/admin/relays', { url: relayInputUrl.trim() });
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
      const res = await api.delete('/api/admin/relays', { inboxUrl });
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
      const res = await api.post('/api/admin/cache/clear', { clearPosts: true });
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
      const res = await api.post('/api/admin/relays/toggle-status', { inboxUrl, status: newStatus });
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
      const res = await api.post('/api/admin/relays/resend', inboxUrl ? { inboxUrl } : {});
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
  const executeBlockDomain = async (domain: string, reason = '', severity: 'suspend' | 'silence' = 'suspend') => {
    if (!authToken) return;
    setIsBlockingDomain(true);
    setBlockMessage(null);
    try {
      const res = await api.post('/api/admin/blocks', { domain, reason, severity, purgeData: severity === 'suspend' });
      const data = await res.json();
      if (res.ok) {
        setBlockMessage({
          type: 'success',
          text: severity === 'silence'
            ? `ドメイン "${data.domain}" をサイレンスにしました。（タイムライン・検索・通知から非表示 / 配送とフォロー関係は維持）`
            : `ドメイン "${data.domain}" をブロックしました。（投稿 ${data.purgeStats?.posts ?? 0}件, Actor ${data.purgeStats?.actors ?? 0}件をパージ）`,
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
    await executeBlockDomain(blockInputDomain.trim(), blockInputReason.trim(), blockInputSeverity);
  };

  // ブロック解除ハンドラ
  const handleUnblockDomain = async (domain: string) => {
    if (!authToken) return;
    if (!confirm(`ドメイン "${domain}" のブロックを解除しますか？`)) return;

    try {
      const res = await api.delete(`/api/admin/blocks/${encodeURIComponent(domain)}`);
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
                {canModerate && (
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
          {authUser && (
            // モバイルでも通知センターへ行けるようにする（PC 側と同じ未読バッジ）
            <button
              onClick={() => navigateToView('notifications')}
              className={`relative p-1.5 rounded-xl transition ${
                currentView === 'notifications' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
              title="通知センター"
            >
              <Bell className="w-4 h-4" />
              {unreadNotificationsCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center px-1 text-[9px] font-black rounded-full bg-rose-500 text-white shadow min-w-[15px]">
                  {unreadNotificationsCount > 99 ? '99+' : unreadNotificationsCount}
                </span>
              )}
            </button>
          )}
        </div>
      </header>

      {/* メインビュー */}
      {currentView === 'admin' ? (
        <ErrorBoundary key="admin" label="管理パネル">
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center py-24">
              <RefreshCw className="w-6 h-6 animate-spin text-indigo-400" />
            </div>
          }
        >
          <AdminDashboard {...{adminTab, maintenanceStats, setAdminTab, deliveryQueue, canAdmin, mailSettings, serverStats, setMailSettings, adminUsers, blockInputSeverity, adminRoles, adminRelays, storageForm, setStorageForm, adminStorageConfig, adminStats, adminReportCounts, reportStatusFilter, adminBlockedDomains, adminAnnouncements, storageMessage, serverSettingsMessage, roleActionMsg, reportActionMsg, relayMessage, mailSettingsMsg, isUploadingEmoji, isUpdatingReport, isUpdatingRegMode, isTestingStorage, isLoadingAudit, inviteActionMsg, fetchAuditLog, emojiActionMsg, deliveryQueueMsg, blockMessage, announcementMsg, adminUserSearch, adminFederation, adminEmojis, setAdminUserSearch, isUploadingServerIcon, isUploadingServerBanner, isSavingStorage, isSavingServerSettings, isSavingMail, isRunningMaintenance, isCreatingInvite, isActingOnDelivery, handleSaveMaintenanceSettings, handleResolveReport, handleChangeRegistrationMode, fetchReports, fetchAdminData, adminServerRulesText, adminServerBanner, adminInvitations, setNewRolePermissions, setNewRoleName, setBlockInputSeverity, relayInputUrl, newRolePermissions, newRoleName, newEmojiUrl, newEmojiName, newAnnouncementTitle, newAnnouncementContent, navigateToView, maintenanceMsg, isSavingContentPolicy, isSavingAnnouncement, isLoadingDeliveryQueue, isLoadingAdmin, isConnectingRelay, isClearingProxyCache, isBlockingDomain, handleSaveContentPolicy, handleCreateEmoji, handleAdminResendRelay, fetchDeliveryQueue, editingRoleId, contentPolicyMsg, contentPolicy, blockInputDomain, availablePermissions, auditMsg, auditLog, auditCursor, adminServerIcon, adminReports, setReportStatusFilter, setRelayInputUrl, setNewRoleColor, setNewInviteMemo, setNewInviteMaxUses, setNewInviteExpiresDays, setNewEmojiUrl, setNewEmojiName, setNewEmojiCategory, setNewAnnouncementTitle, setNewAnnouncementContent, setEditingRoleId, setDeliveryQueueMsg, setBlockInputReason, setBlockInputDomain, setAuditFilter, setAdminTosUrl, setAdminServerRulesText, setAdminServerName, setAdminServerIcon, setAdminServerDesc, setAdminServerBanner, setAdminRequireRulesAgreement, setAdminRepositoryUrl, setAdminPrivacyPolicyUrl, setAdminOperatorUrl, setAdminDeleteTargetUser, setAdminContactUrl, newRoleColor, newInviteMemo, newInviteMaxUses, newInviteExpiresDays, newEmojiCategory, handleUploadServerIcon, handleUploadServerBanner, handleUnblockDomain, handleToggleUserRole, handleToggleAnnouncement, handleTestStorage, handleTestMailSettings, handleSaveStorage, handleSaveServerSettings, handleSaveRole, handleSaveMailSettings, handleRunMaintenance, handleRetryDeliveries, handleQuickBlockDomain, handlePruneAuditLog, handleManualBlockDomain, handleEditRole, handleDisconnectRelay, handleDeleteRole, handleDeleteInvitation, handleDeleteEmoji, handleDeleteAnnouncement, handleCreateInvitation, handleCreateAnnouncement, handleConnectRelay, handleClearProxyCache, handleClearFailedDeliveries, handleAdminToggleRelayStatus, handleAdminToggleFreeze, handleAdminClearCache, handleAdminChangeRole, fetchRoles, fetchMailSettings, fetchAdminAnnouncements, blockInputReason, authUser, auditTotal, auditKinds, auditFilter, adminTosUrl, adminServerName, adminServerDesc, adminRequireRulesAgreement, adminRepositoryUrl, adminPrivacyPolicyUrl, adminOperatorUrl, adminContactUrl, REPORT_CATEGORY_LABELS}} />
        </Suspense>
        </ErrorBoundary>
      ) : currentView === 'settings' ? (
        <ErrorBoundary key="settings" label="設定">
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center py-24">
              <RefreshCw className="w-6 h-6 animate-spin text-indigo-400" />
            </div>
          }
        >
          <SettingsView {...{SettingsView, accentColor, authToken, authUser, autoCompressImages, blockedUsers, defaultTimeline, defaultVisibility, editBannerUrl, editBio, editFields, editIconUrl, editName, emailCode, emailInput, emailMsg, emailNotification, exportingFormat, fetchBlocksAndMutes, followRequests, handleAddMutedWord, handleCancelMove, handleChangePassword, handleDeleteEmail, handleDeleteMutedWord, handleDeletePasskey, handleExecuteMove, handleExportData, handleImportArchive, handleLogout, handleRegisterPasskey, handleRespondFollowRequest, handleSaveMigrationAlias, handleSavePreferences, handleSaveProfile, handleSendEmailCode, handleSendTestPush, handleSubscribePush, handleToggleEmailNotification, handleToggleNotificationPref, handleUnblockUser, handleUnmuteUser, handleUnsubscribePush, handleUploadAvatar, handleUploadBanner, handleVerifyEmail, importFile, importResult, isExportingData, isImporting, isLoadingBlocksMutes, isLoadingMyReports, isLoadingPasskeys, isMigrating, isPasswordAuthMode, isPushSubscribed, isRegisteringPasskey, isRespondingRequest, isSavingMutedWord, isSavingNotifPrefs, isSavingPassword, isSavingProfile, isSendingEmail, isSendingTestPush, isSubscribingPush, isUploadingBanner, isUploadingIcon, migrationAliasInput, migrationInfo, migrationMsg, migrationTargetInput, mutedUsers, mutedWordCaseSensitive, mutedWordWholeWord, mutedWords, myEmail, myEmailVerified, myReports, navigateToView, newMutedWord, notificationPrefs, notificationTypes, passkeyActionMessage, passkeyDeviceName, passkeys, passwordMsg, profileDiscoverable, profileIsLocked, pushPermission, pwCurrent, pwMasterKey, pwNew, pwNewConfirm, recoveryStatus, serverStats, setAccentColor, setAutoCompressImages, setDefaultTimeline, setDefaultVisibility, setEditBannerUrl, setEditBio, setEditFields, setEditIconUrl, setEditName, setEmailCode, setEmailInput, setImportFile, setMigrationAliasInput, setMigrationTargetInput, setMutedWordCaseSensitive, setMutedWordWholeWord, setNewMutedWord, setPasskeyDeviceName, setProfileDiscoverable, setProfileIsLocked, setPwCurrent, setPwMasterKey, setPwNew, setPwNewConfirm, setSelfDeleteConfirmId, setSelfDeleteError, setSelfDeleteMasterKey, setSettingsMessage, setSettingsTab, setShowCustomEmojis, setShowSelfDeleteModal, setThemeMode, settingsMessage, settingsTab, showCustomEmojis, themeMode}} />
        </Suspense>
        </ErrorBoundary>
      ) : currentView === 'notifications' ? (
        <ErrorBoundary key="notifications" label="通知">
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center py-24">
              <RefreshCw className="w-6 h-6 animate-spin text-indigo-400" />
            </div>
          }
        >
          <NotificationsView {...{NotificationsView, expandedNotifGroups, fetchNotifications, groupByFirstId, groupedAwayIds, handleMarkNotificationRead, handleNotificationClick, handleReadAllNotifications, isLoadingNotifications, navigateToView, notificationFilter, notifications, openUserProfile, setExpandedNotifGroups, setNotificationFilter, unreadNotificationsCount}} />
        </Suspense>
        </ErrorBoundary>
      ) : currentView === 'profile' ? (
        <ErrorBoundary key="profile" label="プロフィール">
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center py-24">
              <RefreshCw className="w-6 h-6 animate-spin text-indigo-400" />
            </div>
          }
        >
          <ProfileView {...{ProfileView, authUser, handleBlockUser, handleMuteUser, handleToggleProfileFollow, handleUnblockUser, handleUnmuteUser, isLoadingProfile, isTogglingFollow, navigateToView, openEditProfileModal, openFollowList, openSettings, profileData, profilePosts, profileTarget, setReportCategory, setReportComment, setReportTarget, setShowLoginModal, postDeps: { activeMenuPostId, activeReactionPostId, activeRenoteMenuPostId, authToken, authUser, customEmojis, customReactionInput, handleBlockUser, handleDeletePost, handleMuteUser, handleOpenReply, handleOpenThread, handleSelectHashtag, handleStartQuote, handleToggleAnnounce, handleToggleBookmark, handleTogglePinPost, handleToggleReaction, handleVotePoll, isVotingPoll, openChannelDetail, openMediaPreview, openUserProfile, openedCwPostIds, quickEmojis, setActiveMenuPostId, setActiveReactionPostId, setActiveRenoteMenuPostId, setCurrentView, setCustomReactionInput, setReportCategory, setReportComment, setReportTarget, setShowLoginModal, setShowRichEmojiPicker, sharePost, showCustomEmojis, toggleCw } }} />
        </Suspense>
        </ErrorBoundary>
      ) : (
        <ErrorBoundary key="timeline" label="タイムライン">
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center py-24">
              <RefreshCw className="w-6 h-6 animate-spin text-indigo-400" />
            </div>
          }
        >
          <TimelineView {...{ArrowRight, BarChart2, Bell, Bookmark, ChevronDown, Clock, Edit3, FileText, Hash, Home, ImageIcon, Layers, ListIcon, LogOut, Menu, MessageSquare, Quote, UserCheck, X, Zap, activeAntenna, activeHashtag, antennas, applyAutocomplete, applyNewPostsQueue, authUser, autoCompressImages, autocompleteIndex, autocompleteSuggestions, autocompleteType, bookmarks, channelCategoryFilter, channelTimelinePosts, channels, checkAutocomplete, currentView, cwContent, dismissAnnouncement, dismissedAnnouncements, drafts, fetchBookmarks, fetchChannels, fetchDirectory, fetchDrive, fetchLists, fetchPopularTags, fetchTimeline, followHandle, followStatus, handleAutocompleteKeyDown, handleCreatePost, handleFollow, handleLogout, handleRemoveAttachment, handleSearchSubmit, handleSelectHashtag, handleSelectMedia, handleSwitchTimelineMode, handleToggleChannelFollow, handleToggleSearchUserFollow, isLoadingBookmarks, isLoadingChannelTimeline, isLoadingChannels, isLoadingOlderPosts, isLoadingTimeline, isPosting, isSearching, isSensitivePost, isStreamingConnected, isUploadingMedia, lists, loadOlderPosts, navigateToView, newPostsQueue, openAntennaManageModal, openChannelDetail, openCreateChannelModal, openDraftsModal, openScheduleModal, openSettings, openUserProfile, pollChoices, pollExpiresIn, pollMultiple, popularTags, postAttachments, postContent, postExtraMenuRef, postTargetChannelId, postVisibility, profileTarget, publicAnnouncements, quoteTargetPost, scheduledPosts, searchQuery, searchResults, searchTab, selectedChannel, serverStats, setAutoCompressImages, setChannelCategoryFilter, setCwContent, setEditingChannel, setFollowHandle, setIsSensitivePost, setPollChoices, setPollExpiresIn, setPollMultiple, setPostAttachments, setPostContent, setPostTargetChannelId, setPostVisibility, setQuoteTargetPost, setSearchQuery, setSearchTab, setSelectedChannel, setShowCwInput, setShowDirectoryModal, setShowDriveModal, setShowListsModal, setShowLoginModal, setShowPollInput, setShowPostExtraMenu, setShowRegisterModal, setShowRichEmojiPicker, showCwInput, showPollInput, showPostExtraMenu, timeline, timelineCursor, timelineMode, unreadNotificationsCount, uploadStatusText, postDeps: { activeMenuPostId, activeReactionPostId, activeRenoteMenuPostId, authToken, authUser, customEmojis, customReactionInput, handleBlockUser, handleDeletePost, handleMuteUser, handleOpenReply, handleOpenThread, handleSelectHashtag, handleStartQuote, handleToggleAnnounce, handleToggleBookmark, handleTogglePinPost, handleToggleReaction, handleVotePoll, isVotingPoll, openChannelDetail, openMediaPreview, openUserProfile, openedCwPostIds, quickEmojis, setActiveMenuPostId, setActiveReactionPostId, setActiveRenoteMenuPostId, setCurrentView, setCustomReactionInput, setReportCategory, setReportComment, setReportTarget, setShowLoginModal, setShowRichEmojiPicker, sharePost, showCustomEmojis, toggleCw } }} />
        </Suspense>
        </ErrorBoundary>
      )}

      {/* 🌟 Spica 主権型ソーシャルポータル画面 */}
      {showAuthPortal && (
        <ErrorBoundary key="portal" label="ポータル">
        <Suspense fallback={null}>
          <AuthPortalView {...{AuthPortalView, agreeBasicNotes, agreeRules, agreeTosPrivacy, authError, authPortalTab, expandedAccordions, handleLogin, handleLoginWithPasskey, handleRegister, handleSendRegisterCode, inviteCodeInput, isLoggingInWithPasskey, isPasswordAuthMode, isSendingRegCode, loginId, loginKey, loginPassword, recoveryStatus, regBio, regCodeMsg, regEmail, regEmailCode, regId, regName, regPassword, regPasswordConfirm, serverStats, setAgreeBasicNotes, setAgreeRules, setAgreeTosPrivacy, setAuthError, setAuthPortalTab, setExpandedAccordions, setHasAgreedToRules, setInviteCodeInput, setLoginId, setLoginKey, setLoginMethod, setLoginPassword, setRecoveryMsg, setRecoveryStep, setRegBio, setRegEmail, setRegEmailCode, setRegId, setRegName, setRegPassword, setRegPasswordConfirm, setShowAuthPortal, setShowRecoveryModal, setShowServerMenuPopover, showAuthPortal, showPasswordLoginForm, showServerMenuPopover}} />
        </Suspense>
        </ErrorBoundary>
      )}

      <ErrorBoundary key="modals" label="モーダル">
      <Suspense fallback={null}>
        <ModalsView {...{ModalsView, activeAntenna, activeListId, adminDeleteTargetUser, antennas, applyAutocomplete, authToken, authUser, autoCompressImages, autocompleteIndex, autocompleteSuggestions, autocompleteType, channels, checkAutocomplete, closeThreadModal, currentView, customEmojis, cwContent, directorySearch, directoryUsers, drafts, driveItems, driveMsg, driveStats, editBannerUrl, editBio, editIconUrl, editName, editingAntenna, editingChannel, emojiCategoryTab, emojiSearchTerm, fetchBookmarks, fetchChannels, fetchDirectory, fetchDrive, fetchLists, followList, followListError, followListRows, handleAddListMember, handleAdminDeleteUser, handleAutocompleteKeyDown, handleCancelScheduledPost, handleCreateChannel, handleCreateList, handleCreatePost, handleCreateScheduledPost, handleDeleteAntenna, handleDeleteDraft, handleDeleteDriveMedia, handleDeleteList, handleDriveUpload, handleLoadDraft, handleLogout, handleNotificationClick, handleOpenReply, handleOpenThread, handleRecoveryRequest, handleRecoveryVerify, handleRemoveAttachment, handleRemoveListMember, handleSaveAntenna, handleSaveDraft, handleSaveProfile, handleSelectMedia, handleSelfDeleteAccount, handleSubmitReply, handleSubmitReport, handleSwitchTimelineMode, handleToggleReaction, handleUploadAvatar, handleUploadBanner, handleVotePoll, hasConfirmedSaved, isAdminDeletingUser, isCopied, isCreatingChannel, isLoadingDirectory, isLoadingDrive, isLoadingFollowList, isLoadingListTimeline, isLoadingThread, isMobileMenuOpen, isPasswordAuthMode, isPosting, isRecovering, isReplying, isSavingProfile, isSelfDeleting, isSensitivePost, isSubmittingReport, isUploadingBanner, isUploadingIcon, isUploadingMedia, isUploadingToDrive, isVotingPoll, issuedMasterKey, listActionMsg, listTimelinePosts, lists, miAuthSession, navigateToView, newChannelCategory, newChannelColor, newChannelDesc, newChannelName, newListMember, newListName, notificationToast, openAntennaManageModal, openAntennaModal, openDraftsModal, openListTimeline, openMediaPreview, openMobilePostModal, openScheduleModal, openSettings, openUserProfile, pollChoices, pollExpiresIn, pollMultiple, postAttachments, postContent, postTargetChannelId, postVisibility, previewMediaUrl, profileTarget, pushModalState, quoteTargetPost, recoveryCode, recoveryEmail, recoveryMsg, recoveryStep, recoveryUserId, replyContent, replyCwContent, replyTargetPost, reportCategory, reportComment, reportTarget, saveChannelEdit, scheduledDateTime, scheduledPosts, selfDeleteConfirmId, selfDeleteError, selfDeleteMasterKey, serverStats, setActiveListId, setAdminDeleteTargetUser, setAutoCompressImages, setCwContent, setDirectorySearch, setDriveMsg, setEditBannerUrl, setEditBio, setEditIconUrl, setEditName, setEditingAntenna, setEditingChannel, setEmojiCategoryTab, setEmojiSearchTerm, setFollowList, setHasConfirmedSaved, setIsCopied, setIsMobileMenuOpen, setIsSensitivePost, setListTimelinePosts, setMiAuthSession, setNewChannelCategory, setNewChannelColor, setNewChannelDesc, setNewChannelName, setNewListMember, setNewListName, setNotificationToast, setPollChoices, setPollExpiresIn, setPollMultiple, setPostContent, setPostTargetChannelId, setPostVisibility, setPreviewMediaUrl, setQuoteTargetPost, setRecoveryCode, setRecoveryEmail, setRecoveryMsg, setRecoveryStep, setRecoveryUserId, setReplyContent, setReplyCwContent, setReplyTargetPost, setReportCategory, setReportComment, setReportTarget, setScheduledDateTime, setSelfDeleteConfirmId, setSelfDeleteMasterKey, setShowAntennaManageModal, setShowAntennaModal, setShowCreateChannelModal, setShowCwInput, setShowDirectoryModal, setShowDraftsModal, setShowDriveModal, setShowEditProfileModal, setShowListsModal, setShowLoginModal, setShowMasterKeyModal, setShowMobilePostModal, setShowPollInput, setShowRecoveryModal, setShowRegisterModal, setShowReplyCwInput, setShowRichEmojiPicker, setShowScheduleModal, setShowSelfDeleteModal, showAntennaManageModal, showAntennaModal, showCreateChannelModal, showCustomEmojis, showCwInput, showDirectoryModal, showDraftsModal, showDriveModal, showEditProfileModal, showExitToast, showListsModal, showMasterKeyModal, showMobilePostModal, showPollInput, showRecoveryModal, showReplyCwInput, showRichEmojiPicker, showScheduleModal, showSelfDeleteModal, threadData, threadModalPost, unreadNotificationsCount, uploadStatusText, postDeps: { activeMenuPostId, activeReactionPostId, activeRenoteMenuPostId, authToken, authUser, customEmojis, customReactionInput, handleBlockUser, handleDeletePost, handleMuteUser, handleOpenReply, handleOpenThread, handleSelectHashtag, handleStartQuote, handleToggleAnnounce, handleToggleBookmark, handleTogglePinPost, handleToggleReaction, handleVotePoll, isVotingPoll, openChannelDetail, openMediaPreview, openUserProfile, openedCwPostIds, quickEmojis, setActiveMenuPostId, setActiveReactionPostId, setActiveRenoteMenuPostId, setCurrentView, setCustomReactionInput, setReportCategory, setReportComment, setReportTarget, setShowLoginModal, setShowRichEmojiPicker, sharePost, showCustomEmojis, toggleCw } }} />
      </Suspense>
      </ErrorBoundary>
    </div>
  );
}
