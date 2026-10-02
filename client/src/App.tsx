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
import { api, setApiToken } from './api/client';
import ErrorBoundary from './components/ErrorBoundary';
import AppHeader from './components/AppHeader';

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
const SettingsView = React.lazy(() => import('./views/SettingsView'));

// 画面ごとのコード分割（初回に読み込まない）

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
  const [followRequests, setFollowRequests] = useState<any[]>([]);
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

  // 新規登録時の同意ステート
  const [agreeRules, setAgreeRules] = useState<boolean>(false);
  const [agreeTosPrivacy, setAgreeTosPrivacy] = useState<boolean>(false);
  const [agreeBasicNotes, setAgreeBasicNotes] = useState<boolean>(false);
  const [hasAgreedToRules, setHasAgreedToRules] = useState<boolean>(false);

  // データエクスポートステート
  // 📦 引っ越し（Move）の状態
  const [migrationInfo, setMigrationInfo] = useState<{ actorUrl: string; movedTo: string; alsoKnownAs: string; followers: number }>({
    actorUrl: '',
    movedTo: '',
    alsoKnownAs: '',
    followers: 0,
  });
  const [migrationAliasInput, setMigrationAliasInput] = useState<string>('');

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
  // ログイン画面で表示する方式 (auth_mode = password のときはパスワード方式を既定にする)
  const [loginMethod, setLoginMethod] = useState<'master_key' | 'password'>('master_key');
  // 登録前のメール確認コード（SMTP 設定済みのサーバーでのみ使う）
  const [authError, setAuthError] = useState<string | null>(null);

  // タイムライン ('local' = 自ノードのみ, 'home' = 自ノード+フォロー中, 'all' = 連合・リレー含む全件, 'tag' = ハッシュタグ, 'antenna' = アンテナ)
  const [timeline, setTimeline] = useState<Post[]>([]);
  const [timelineMode, setTimelineMode] = useState<'local' | 'home' | 'all' | 'tag' | 'antenna'>(defaultTimeline);
  const [activeHashtag, setActiveHashtag] = useState<string>('');
  // サーバーが返す X-Next-Cursor（続きがある場合のみ）。過去のノート追加読み込みに使う
  const [timelineCursor, setTimelineCursor] = useState<string | null>(null);
  const [followingUrls, setFollowingUrls] = useState<Set<string>>(new Set());

  // 📡 アンテナ管理状態
  const [antennas, setAntennas] = useState<Antenna[]>([]);
  const [activeAntenna, setActiveAntenna] = useState<Antenna | null>(null);
  const [showAntennaManageModal, setShowAntennaManageModal] = useState<boolean>(false);
  const [showAntennaModal, setShowAntennaModal] = useState<boolean>(false);
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

  // 統合検索 & ハッシュタグステート
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [searchResults, setSearchResults] = useState<{
    remoteUser: any;
    users: any[];
    posts: any[];
  } | null>(null);
  const [popularTags, setPopularTags] = useState<{ tag: string; count: number }[]>([]);
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

  // 会話スレッドモーダルステート
  const [threadModalPost, setThreadModalPost] = useState<Post | null>(null);
  const [threadData, setThreadData] = useState<{ post: Post; parent: Post | null; replies: Post[] } | null>(null);
  const [isLoadingThread, setIsLoadingThread] = useState<boolean>(false);

  // リモートフォロー

  // サーバー情報
  const [serverStats, setServerStats] = useState<ServerStats | null>(null);

  // 管理者画面ナビゲーションステート (Misskey風サイドバー)
  const [adminTab, setAdminTab] = useState<'dashboard' | 'users' | 'federation' | 'blocks' | 'storage' | 'settings' | 'emojis' | 'invites' | 'reports' | 'announcements' | 'roles' | 'mail' | 'delivery' | 'audit'>('dashboard');

  // 🎨 カスタム絵文字管理ステート
  const [adminEmojis, setAdminEmojis] = useState<CustomEmoji[]>([]);

  // 🎟 招待コード管理ステート
  const [adminInvitations, setAdminInvitations] = useState<InvitationCode[]>([]);

  // 🗑 アカウント削除ステート（管理者による削除 ＆ 本人による退会）
  const [adminDeleteTargetUser, setAdminDeleteTargetUser] = useState<any | null>(null);
  const [showSelfDeleteModal, setShowSelfDeleteModal] = useState<boolean>(false);
  const [selfDeleteConfirmId, setSelfDeleteConfirmId] = useState<string>('');
  const [selfDeleteMasterKey, setSelfDeleteMasterKey] = useState<string>('');
  const [selfDeleteError, setSelfDeleteError] = useState<string | null>(null);

  // 🔔 Web Push 通知ステート
  const [isPushSubscribed, setIsPushSubscribed] = useState<boolean>(false);
  const [pushPermission, setPushPermission] = useState<NotificationPermission>(() => {
    return typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'default';
  });

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
  // 🧹 容量・メンテナンス状況
  const [maintenanceStats, setMaintenanceStats] = useState<any | null>(null);
  // 🧾 監査ログ（管理操作の履歴）
  const [adminRequireRulesAgreement, setAdminRequireRulesAgreement] = useState<boolean>(true);

  // 管理者画面データ
  const [adminStats, setAdminStats] = useState<any>(null);
  const [adminUsers, setAdminUsers] = useState<any[]>([]);
  const [adminFederation, setAdminFederation] = useState<any>(null);
  const [adminRelays, setAdminRelays] = useState<any[]>([]);
  const [isLoadingAdmin, setIsLoadingAdmin] = useState<boolean>(false);

  // ドメインブロック管理ステート
  const [adminBlockedDomains, setAdminBlockedDomains] = useState<any[]>([]);
  const [blockInputDomain, setBlockInputDomain] = useState<string>('');
  const [blockInputReason, setBlockInputReason] = useState<string>('');
  // 'suspend' = 完全ブロック（通信遮断・データ削除）/ 'silence' = サイレンス（タイムラインから隠すだけ）
  const [isBlockingDomain, setIsBlockingDomain] = useState<boolean>(false);
  const [blockMessage, setBlockMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 🚩 通報（モデレーション）ステート
  const [adminReports, setAdminReports] = useState<any[]>([]);
  const [adminReportCounts, setAdminReportCounts] = useState<{ open: number; total: number }>({ open: 0, total: 0 });
  const [reportStatusFilter, setReportStatusFilter] = useState<'open' | 'all' | 'resolved' | 'rejected'>('open');
  // 通報フォーム（一般ユーザー向け）
  const [reportTarget, setReportTarget] = useState<{ type: 'post' | 'user'; id: string; label: string } | null>(null);
  const [reportCategory, setReportCategory] = useState<string>('spam');
  const [reportComment, setReportComment] = useState<string>('');

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

  // プロフィール画面ステート
  const [profileTarget, setProfileTarget] = useState<string | null>(null);
  const [profileData, setProfileData] = useState<UserProfile | null>(null);
  const [profilePosts, setProfilePosts] = useState<Post[]>([]);
  const [isLoadingProfile, setIsLoadingProfile] = useState<boolean>(false);

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

  function openAntennaManageModal() {
    if (!authUser) {
      setShowLoginModal(true);
      return;
    }
    setShowAntennaManageModal(true);
    pushModalState('antenna_manage');
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

  // プロフィール画面からのフォロー/アンフォロー切り替え

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

  // 🚩 通報の分類ラベル

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

  // 🚩 通報の送信（一般ユーザー）

  // 管理者データの取得
  // 🧾 監査ログの取得（管理者のみ）

  // 🧾 古い監査ログの削除

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

  // 🧹 定期メンテナンスを今すぐ実行（バックアップ＋方針適用＋保持期間削除。VACUUM はしません）

  // 🧹 自動整理の ON/OFF と実行時刻

  // 🖼️ 画像プロキシのキャッシュ整理

  // ✉️ メール通知の ON/OFF

  // サーバーアイコンのアップロード

  // サーバーバナー画像のアップロード

  // 🎨 カスタム絵文字の登録 (管理者)

  // 🎨 カスタム絵文字の削除 (管理者)

  // 🎟 招待コードの発行 (管理者)

  // 🎟 招待コードの削除 (管理者)

  // 🔒 登録モードの切り替え (管理者)

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

  // 📢 お知らせ
  const [adminAnnouncements, setAdminAnnouncements] = useState<any[]>([]);
  const [publicAnnouncements, setPublicAnnouncements] = useState<any[]>([]);

  // 📋 リスト（ユーザーを束ねた専用タイムライン）
  const [lists, setLists] = useState<any[]>([]);
  const [showListsModal, setShowListsModal] = useState<boolean>(false);
  const [activeListId, setActiveListId] = useState<string | null>(null);

  // 🗂️ ドライブ（自分のアップロード管理）
  const [showDriveModal, setShowDriveModal] = useState<boolean>(false);
  const [driveItems, setDriveItems] = useState<any[]>([]);
  const [driveStats, setDriveStats] = useState<{ count: number; bytes: number; quotaBytes: number }>({ count: 0, bytes: 0, quotaBytes: 0 });
  const [isLoadingDrive, setIsLoadingDrive] = useState<boolean>(false);
  const [driveMsg, setDriveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 🔔 通知の種類別設定
  const [notificationPrefs, setNotificationPrefs] = useState<Record<string, boolean> | null>(null);
  // ✉️ メール通知（SMTP 設定時のみ。オプトイン）
  const [emailNotification, setEmailNotification] = useState<{ available: boolean; enabled: boolean; email: string; verified: boolean } | null>(null);
  const [notificationTypes, setNotificationTypes] = useState<{ type: string; label: string }[]>([]);

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

  // 🗂️ ドライブ: ファイルを追加アップロード（投稿には添付せずドライブに置く）

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

  // 🎭 ロール（権限）管理
  const [adminRoles, setAdminRoles] = useState<any[]>([]);
  const [availablePermissions, setAvailablePermissions] = useState<{ key: string; label: string }[]>([]);

  // 👥 プロフィール項目 / バッジ / ユーザーディレクトリ
  const [editFields, setEditFields] = useState<{ name: string; value: string }[]>([]);
  const [profileDiscoverable, setProfileDiscoverable] = useState<boolean>(true);
  const [showDirectoryModal, setShowDirectoryModal] = useState<boolean>(false);
  const [directoryUsers, setDirectoryUsers] = useState<any[]>([]);
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
  const isValidEmailFormat = (value: string): boolean =>
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254;

  useEffect(() => {
    setLoginMethod(isPasswordAuthMode ? 'password' : 'master_key');
  }, [isPasswordAuthMode]);

  const [myEmail, setMyEmail] = useState<string>('');
  const [myEmailVerified, setMyEmailVerified] = useState<boolean>(false);
  const [emailCode, setEmailCode] = useState<string>('');
  // 🔑 パスワードの設定・変更（password 方式）
  const [showRecoveryModal, setShowRecoveryModal] = useState<boolean>(false);
  const [recoveryStep, setRecoveryStep] = useState<'request' | 'verify' | 'done'>('request');
  const [recoveryMsg, setRecoveryMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // 📮 配送再送キューの状態（管理画面）

  const fetchRecoveryStatus = async () => {
    try {
      const res = await api.get('/api/auth/recovery/status', { auth: false });
      if (res.ok) setRecoveryStatus(await res.json());
    } catch (err) {
      console.error('認証設定の取得エラー:', err);
    }
  };

  // 📮 配送再送キュー（ActivityPub 配送の指数バックオフ再送）

  // メールアドレスの登録（確認コード送信 → 検証）

  // 🔑 パスワードの設定・変更（password 方式のサーバー用）
  //    パスワード未設定ならマスターキー必須、設定済みなら現在のパスワードかマスターキーで認証する

  // 🔑 マスターキー復元（ID+メール → 確認コード → 新しいキーをメールで受領）

  /**
   * フォロワー / フォロー中の一覧を開く。
   * `userId` は表示したい相手（自分以外のプロフィールからも開ける。API は公開）。
   */

  /** チャンネル設定の保存（作成者・管理者のみ。API 側でも権限を検査している） */

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

  // ユーザーへのロール付与（チップのクリックで付け外し）

  // 📥 アカウント移行インポート

  // 📢 お知らせの取得（全ユーザー向け / 管理者向け）
  const fetchAnnouncements = async () => {
    try {
      const res = await api.get('/api/announcements', { auth: false });
      if (res.ok) setPublicAnnouncements(await res.json());
    } catch (err) {
      console.error('お知らせの取得エラー:', err);
    }
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

  // 新規登録ハンドラ

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

  // 📦 データエクスポートハンドラ (JSON / ZIP)
  // サーバー側でジョブとして作る（大きなアカウントでも待たされない）。
  // 受け付けたら状態を見に行き、出来上がったらダウンロードする。

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

  // ログインハンドラ (マスターキー方式 / メールアドレス＋パスワード方式)

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

  // メディアストレージ疎通テスト

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

  // 管理者操作: ロール変更

  // 管理者操作: 凍結

  // 管理者操作: アカウント完全削除

  // ユーザー自身によるアカウント削除（退会）

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

  // プッシュ通知の解除

  // テスト通知の送信

  // リレー接続

  // リレー購読解除

  // 管理者操作: リモートキャッシュ全消去

  // 管理者操作: リレーステータス手動切替

  // 管理者操作: リレー Follow 再送 (個別または一括)

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

  // 手動ブロックフォーム送信

  // ブロック解除ハンドラ

  // 投稿カードレンダリング共通関数 (タイムライン・検索・プロフィール共通)

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-indigo-500 selection:text-white">
      <AppHeader {...{authUser, openWelcomePortal, navigateToView, handleSwitchTimelineMode, serverStats, handleSearchSubmit, Search, searchQuery, setSearchQuery, setSearchResults, X, canModerate, currentView, ShieldCheck, Bell, unreadNotificationsCount, openUserProfile, setShowLoginModal, LogIn, setShowRegisterModal, Key, setThemeMode, themeMode, Moon, Sun, Palette, timelineMode, activeHashtag, fetchTimeline, isLoadingTimeline, RefreshCw }} />

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
 <AdminDashboard {...{adminTab, maintenanceStats, setAdminTab, canAdmin, serverStats, adminUsers, adminRoles, adminRelays, storageForm, setStorageForm, adminStorageConfig, adminStats, adminReportCounts, reportStatusFilter, adminBlockedDomains, adminAnnouncements, blockMessage, adminFederation, adminEmojis, fetchReports, fetchAdminData, adminServerRulesText, adminServerBanner, adminInvitations, navigateToView, isLoadingAdmin, isBlockingDomain, contentPolicy, blockInputDomain, availablePermissions, adminServerIcon, adminReports, setReportStatusFilter, setBlockInputReason, setBlockInputDomain, setAdminTosUrl, setAdminServerRulesText, setAdminServerName, setAdminServerIcon, setAdminServerDesc, setAdminServerBanner, setAdminRequireRulesAgreement, setAdminRepositoryUrl, setAdminPrivacyPolicyUrl, setAdminOperatorUrl, setAdminDeleteTargetUser, setAdminContactUrl, fetchRoles, blockInputReason, authUser, adminTosUrl, adminServerName, adminServerDesc, adminRequireRulesAgreement, adminRepositoryUrl, adminPrivacyPolicyUrl, adminOperatorUrl, adminContactUrl, authToken, api, setContentPolicy, setMaintenanceStats, setAdminAnnouncements, setAdminBlockedDomains, setAdminEmojis, setAdminFederation, setAdminInvitations, setAdminRelays, setAdminReportCounts, setAdminReports, setAdminRoles, setAdminStats, setAdminStorageConfig, setServerStats, fetchCustomEmojis, fetchServerStats, fetchRecoveryStatus, fetchAnnouncements, fetchTimeline, executeBlockDomain, setBlockMessage }} />
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
 <SettingsView {...{accentColor, authToken, authUser, autoCompressImages, blockedUsers, defaultTimeline, defaultVisibility, editBannerUrl, editBio, editFields, editIconUrl, editName, emailCode, emailNotification, fetchBlocksAndMutes, followRequests, handleLogout, handleSaveProfile, handleUnblockUser, handleUnmuteUser, handleUploadAvatar, handleUploadBanner, isLoadingBlocksMutes, isLoadingMyReports, isLoadingPasskeys, isPasswordAuthMode, isPushSubscribed, isSavingProfile, isUploadingBanner, isUploadingIcon, migrationAliasInput, migrationInfo, mutedUsers, mutedWords, myEmail, myEmailVerified, myReports, navigateToView, notificationPrefs, notificationTypes, passkeys, profileDiscoverable, profileIsLocked, pushPermission, recoveryStatus, serverStats, setAccentColor, setAutoCompressImages, setDefaultTimeline, setDefaultVisibility, setEditBannerUrl, setEditBio, setEditFields, setEditIconUrl, setEditName, setEmailCode, setMigrationAliasInput, setProfileDiscoverable, setProfileIsLocked, setSelfDeleteConfirmId, setSelfDeleteError, setSelfDeleteMasterKey, setSettingsMessage, setSettingsTab, setShowCustomEmojis, setShowSelfDeleteModal, setThemeMode, settingsMessage, settingsTab, showCustomEmojis, themeMode, setPostVisibility, api, setEmailNotification, fetchMutedWords, fetchTimeline, fetchFollowRequests, setNotificationPrefs, setMyEmail, setMyEmailVerified, setAuthUser, fetchMigrationInfo, fetchPasskeys, setPasskeys, setPushPermission, urlBase64ToUint8Array, setIsPushSubscribed }} />
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
          <NotificationsView {...{NotificationsView, fetchNotifications, handleMarkNotificationRead, handleNotificationClick, isLoadingNotifications, navigateToView, notificationFilter, notifications, openUserProfile, setNotificationFilter, unreadNotificationsCount, authToken, api, setNotifications, setUnreadNotificationsCount, notifGroups}} />
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
          <ProfileView {...{setEditName, setEditBio, setEditIconUrl, setEditBannerUrl, setShowEditProfileModal, pushModalState, authToken, api, setProfileData, fetchMyFollowingUrls, setFollowList, setFollowListRows, setFollowListError, setIsLoadingFollowList, authUser, handleBlockUser, handleMuteUser, handleUnblockUser, handleUnmuteUser, isLoadingProfile, navigateToView, openSettings, profileData, profilePosts, profileTarget, setReportCategory, setReportComment, setReportTarget, setShowLoginModal, postDeps: { activeMenuPostId, activeReactionPostId, activeRenoteMenuPostId, authToken, authUser, customEmojis, customReactionInput, handleBlockUser, handleDeletePost, handleMuteUser, handleOpenReply, handleOpenThread, handleSelectHashtag, handleStartQuote, handleToggleAnnounce, handleToggleBookmark, handleTogglePinPost, handleToggleReaction, handleVotePoll, isVotingPoll, openChannelDetail, openMediaPreview, openUserProfile, openedCwPostIds, quickEmojis, setActiveMenuPostId, setActiveReactionPostId, setActiveRenoteMenuPostId, setCurrentView, setCustomReactionInput, setReportCategory, setReportComment, setReportTarget, setShowLoginModal, setShowRichEmojiPicker, sharePost, showCustomEmojis, toggleCw } }} />
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
          <TimelineView {...{setTimeline, isPostMatchingTimeline, followingUrls, setNewPostsQueue, setShowCreateChannelModal, pushModalState, api, timelineModeRef, activeHashtagRef, setTimelineCursor, authToken, setSearchResults, fetchMyFollowingUrls, setChannels, checkAuth, ArrowRight, BarChart2, Bell, Bookmark, ChevronDown, Clock, Edit3, FileText, Hash, Home, ImageIcon, Layers, ListIcon, LogOut, Menu, MessageSquare, Quote, UserCheck, X, Zap, activeAntenna, activeHashtag, antennas, applyAutocomplete, authUser, autoCompressImages, autocompleteIndex, autocompleteSuggestions, autocompleteType, bookmarks, channelCategoryFilter, channelTimelinePosts, channels, checkAutocomplete, currentView, cwContent, drafts, fetchBookmarks, fetchChannels, fetchDirectory, fetchDrive, fetchLists, fetchPopularTags, fetchTimeline, handleAutocompleteKeyDown, handleCreatePost, handleLogout, handleRemoveAttachment, handleSearchSubmit, handleSelectHashtag, handleSelectMedia, handleSwitchTimelineMode, isLoadingBookmarks, isLoadingChannelTimeline, isLoadingChannels, isLoadingTimeline, isPosting, isSearching, isSensitivePost, isStreamingConnected, isUploadingMedia, lists, navigateToView, newPostsQueue, openAntennaManageModal, openChannelDetail, openDraftsModal, openScheduleModal, openSettings, openUserProfile, pollChoices, pollExpiresIn, pollMultiple, popularTags, postAttachments, postContent, postExtraMenuRef, postTargetChannelId, postVisibility, profileTarget, publicAnnouncements, quoteTargetPost, scheduledPosts, searchQuery, searchResults, selectedChannel, serverStats, setAutoCompressImages, setChannelCategoryFilter, setCwContent, setEditingChannel, setIsSensitivePost, setPollChoices, setPollExpiresIn, setPollMultiple, setPostAttachments, setPostContent, setPostTargetChannelId, setPostVisibility, setQuoteTargetPost, setSearchQuery, setSelectedChannel, setShowCwInput, setShowDirectoryModal, setShowDriveModal, setShowListsModal, setShowLoginModal, setShowPollInput, setShowPostExtraMenu, setShowRegisterModal, setShowRichEmojiPicker, showCwInput, showPollInput, showPostExtraMenu, timeline, timelineCursor, timelineMode, unreadNotificationsCount, uploadStatusText, postDeps: { activeMenuPostId, activeReactionPostId, activeRenoteMenuPostId, authToken, authUser, customEmojis, customReactionInput, handleBlockUser, handleDeletePost, handleMuteUser, handleOpenReply, handleOpenThread, handleSelectHashtag, handleStartQuote, handleToggleAnnounce, handleToggleBookmark, handleTogglePinPost, handleToggleReaction, handleVotePoll, isVotingPoll, openChannelDetail, openMediaPreview, openUserProfile, openedCwPostIds, quickEmojis, setActiveMenuPostId, setActiveReactionPostId, setActiveRenoteMenuPostId, setCurrentView, setCustomReactionInput, setReportCategory, setReportComment, setReportTarget, setShowLoginModal, setShowRichEmojiPicker, sharePost, showCustomEmojis, toggleCw } }} />
        </Suspense>
        </ErrorBoundary>
      )}

      {/* 🌟 Spica 主権型ソーシャルポータル画面 */}
      {showAuthPortal && (
        <ErrorBoundary key="portal" label="ポータル">
        <Suspense fallback={null}>
          <AuthPortalView {...{AuthPortalView, agreeBasicNotes, agreeRules, agreeTosPrivacy, authError, authPortalTab, inviteCodeInput, isPasswordAuthMode, recoveryStatus, serverStats, setAgreeBasicNotes, setAgreeRules, setAgreeTosPrivacy, setAuthError, setAuthPortalTab, setHasAgreedToRules, setInviteCodeInput, setLoginMethod, setRecoveryMsg, setRecoveryStep, setShowAuthPortal, setShowRecoveryModal, showAuthPortal, loginMethod, isValidEmailFormat, api, hasAgreedToRules, setIssuedMasterKey, setAuthToken, setAuthUser, fetchMyFollowingUrls, setShowRegisterModal, setShowMasterKeyModal, setHasConfirmedSaved, setIsCopied, fetchServerStats, setShowLoginModal, fetchTimeline }} />
        </Suspense>
        </ErrorBoundary>
      )}

      <ErrorBoundary key="modals" label="モーダル">
      <Suspense fallback={null}>
 <ModalsView {...{ModalsView, activeAntenna, activeListId, adminDeleteTargetUser, antennas, applyAutocomplete, authToken, authUser, autoCompressImages, autocompleteIndex, autocompleteSuggestions, autocompleteType, channels, checkAutocomplete, currentView, customEmojis, cwContent, directoryUsers, drafts, driveItems, driveMsg, driveStats, editBannerUrl, editBio, editIconUrl, editName, editingChannel, fetchBookmarks, fetchChannels, fetchDirectory, fetchDrive, fetchLists, followList, followListError, followListRows, handleAutocompleteKeyDown, handleCreatePost, handleLogout, handleNotificationClick, handleOpenReply, handleOpenThread, handleRemoveAttachment, handleSaveProfile, handleSelectMedia, handleSwitchTimelineMode, handleToggleReaction, handleUploadAvatar, handleUploadBanner, handleVotePoll, hasConfirmedSaved, isCopied, isLoadingDirectory, isLoadingDrive, isLoadingFollowList, isLoadingThread, isMobileMenuOpen, isPasswordAuthMode, isPosting, isSavingProfile, isSensitivePost, isUploadingBanner, isUploadingIcon, isUploadingMedia, isVotingPoll, issuedMasterKey, lists, miAuthSession, navigateToView, notificationToast, openAntennaManageModal, openDraftsModal, openMediaPreview, openMobilePostModal, openScheduleModal, openSettings, openUserProfile, pollChoices, pollExpiresIn, pollMultiple, postAttachments, postContent, postTargetChannelId, postVisibility, previewMediaUrl, profileTarget, pushModalState, quoteTargetPost, recoveryMsg, recoveryStep, replyContent, replyTargetPost, reportCategory, reportComment, reportTarget, scheduledPosts, selfDeleteConfirmId, selfDeleteError, selfDeleteMasterKey, serverStats, setActiveListId, setAdminDeleteTargetUser, setAutoCompressImages, setCwContent, setDriveMsg, setEditBannerUrl, setEditBio, setEditIconUrl, setEditName, setEditingChannel, setFollowList, setHasConfirmedSaved, setIsCopied, setIsMobileMenuOpen, setIsSensitivePost, setMiAuthSession, setNotificationToast, setPollChoices, setPollExpiresIn, setPollMultiple, setPostContent, setPostTargetChannelId, setPostVisibility, setPreviewMediaUrl, setQuoteTargetPost, setRecoveryMsg, setRecoveryStep, setReplyContent, setReplyTargetPost, setReportCategory, setReportComment, setReportTarget, setSelfDeleteConfirmId, setSelfDeleteMasterKey, setShowAntennaManageModal, setShowAntennaModal, setShowCreateChannelModal, setShowCwInput, setShowDirectoryModal, setShowDraftsModal, setShowDriveModal, setShowEditProfileModal, setShowListsModal, setShowLoginModal, setShowMasterKeyModal, setShowMobilePostModal, setShowPollInput, setShowRecoveryModal, setShowRegisterModal, setShowRichEmojiPicker, setShowScheduleModal, setShowSelfDeleteModal, showAntennaManageModal, showAntennaModal, showCreateChannelModal, showCustomEmojis, showCwInput, showDirectoryModal, showDraftsModal, showDriveModal, showEditProfileModal, showExitToast, showListsModal, showMasterKeyModal, showMobilePostModal, showPollInput, showRecoveryModal, showRichEmojiPicker, showScheduleModal, showSelfDeleteModal, threadData, threadModalPost, unreadNotificationsCount, uploadStatusText, setThreadModalPost, setThreadData, currentViewRef, fetchAntennas, setActiveAntenna, fetchDrafts, setPostAttachments, fetchScheduledPosts, setDriveItems, setDriveStats, listAbortRef, setChannels, selectedChannel, setSelectedChannel, openChannelDetail, fetchTimeline, fetchAdminData, setSelfDeleteError, setAuthToken, setAuthUser, setCurrentView, setShowAuthPortal, setAuthPortalTab, postDeps: { activeMenuPostId, activeReactionPostId, activeRenoteMenuPostId, customReactionInput, handleBlockUser, handleDeletePost, handleMuteUser, handleSelectHashtag, handleStartQuote, handleToggleAnnounce, handleToggleBookmark, handleTogglePinPost, openedCwPostIds, quickEmojis, setActiveMenuPostId, setActiveReactionPostId, setActiveRenoteMenuPostId, setCustomReactionInput, sharePost, toggleCw  } }} />
      </Suspense>
      </ErrorBoundary>
    </div>
  );
}
