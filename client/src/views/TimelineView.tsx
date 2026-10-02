/**
 * TimelineView（App.tsx から切り出した画面）
 *
 * 表示条件は App 側の state のままで、ここは props で受け取る。
 * App からは React.lazy で読み込むので、初期バンドルには含まれない。
 */
import DOMPurify from 'dompurify';
import type { Post } from '../App';
import { AlertCircle, ArrowLeft, CheckCircle2, ExternalLink, EyeOff, Globe, HardDrive, Megaphone, Plus, Radio, RefreshCw, Search, Send, Server, Settings, ShieldAlert, ShieldCheck, Smile, User, UserPlus, Users } from 'lucide-react';
import { AutocompleteDropdown, PollInputEditor, createRenderPostCard } from '../components/PostRendering';
import { Virtuoso } from 'react-virtuoso';
import { useEffect, useRef, useState } from 'react';

export interface TimelineViewProps {
  ArrowRight: any;
  BarChart2: any;
  Bell: any;
  Bookmark: any;
  ChevronDown: any;
  Clock: any;
  Edit3: any;
  FileText: any;
  Hash: any;
  Home: any;
  ImageIcon: any;
  Layers: any;
  ListIcon: any;
  LogOut: any;
  Menu: any;
  MessageSquare: any;
  Quote: any;
  UserCheck: any;
  X: any;
  Zap: any;
  activeAntenna: any;
  activeHashtag: any;
  antennas: any;
  applyAutocomplete: any;
  applyNewPostsQueue: any;
  authUser: any;
  autoCompressImages: any;
  autocompleteIndex: any;
  autocompleteSuggestions: any;
  autocompleteType: any;
  bookmarks: any;
  channelCategoryFilter: any;
  channelTimelinePosts: any;
  channels: any;
  checkAutocomplete: any;
  currentView: any;
  cwContent: any;
  dismissAnnouncement: any;
  dismissedAnnouncements: any;
  drafts: any;
  fetchBookmarks: any;
  fetchChannels: any;
  fetchDirectory: any;
  fetchDrive: any;
  fetchLists: any;
  fetchPopularTags: any;
  fetchTimeline: any;
  followHandle: any;
  followStatus: any;
  handleAutocompleteKeyDown: any;
  handleCreatePost: any;
  handleFollow: any;
  handleLogout: any;
  handleRemoveAttachment: any;
  handleSearchSubmit: any;
  handleSelectHashtag: any;
  handleSelectMedia: any;
  handleSwitchTimelineMode: any;
  handleToggleChannelFollow: any;
  handleToggleSearchUserFollow: any;
  isLoadingBookmarks: any;
  isLoadingChannelTimeline: any;
  isLoadingChannels: any;
  isLoadingOlderPosts: any;
  isLoadingTimeline: any;
  isPosting: any;
  isSearching: any;
  isSensitivePost: any;
  isStreamingConnected: any;
  isUploadingMedia: any;
  lists: any;
  loadOlderPosts: any;
  navigateToView: any;
  newPostsQueue: any;
  openAntennaManageModal: any;
  openChannelDetail: any;
  openCreateChannelModal: any;
  openDraftsModal: any;
  openScheduleModal: any;
  openSettings: any;
  openUserProfile: any;
  pollChoices: any;
  pollExpiresIn: any;
  pollMultiple: any;
  popularTags: any;
  postAttachments: any;
  postContent: any;
  postExtraMenuRef: any;
  postTargetChannelId: any;
  postVisibility: any;
  profileTarget: any;
  publicAnnouncements: any;
  quoteTargetPost: any;
  postDeps: any;
  scheduledPosts: any;
  searchQuery: any;
  searchResults: any;
  searchTab: any;
  selectedChannel: any;
  serverStats: any;
  setAutoCompressImages: any;
  setChannelCategoryFilter: any;
  setCwContent: any;
  setEditingChannel: any;
  setFollowHandle: any;
  setIsSensitivePost: any;
  setPollChoices: any;
  setPollExpiresIn: any;
  setPollMultiple: any;
  setPostAttachments: any;
  setPostContent: any;
  setPostTargetChannelId: any;
  setPostVisibility: any;
  setQuoteTargetPost: any;
  setSearchQuery: any;
  setSearchTab: any;
  setSelectedChannel: any;
  setShowCwInput: any;
  setShowDirectoryModal: any;
  setShowDriveModal: any;
  setShowListsModal: any;
  setShowLoginModal: any;
  setShowPollInput: any;
  setShowPostExtraMenu: any;
  setShowRegisterModal: any;
  setShowRichEmojiPicker: any;
  showCwInput: any;
  showPollInput: any;
  showPostExtraMenu: any;
  timeline: any;
  timelineCursor: any;
  timelineMode: any;
  unreadNotificationsCount: any;
  uploadStatusText: any;
}

export default function TimelineView(props: TimelineViewProps) {
  const { ArrowRight, BarChart2, Bell, Bookmark, ChevronDown, Clock, Edit3, FileText, Hash, Home, ImageIcon, Layers, ListIcon, LogOut, Menu, MessageSquare, Quote, UserCheck, X, Zap, activeAntenna, activeHashtag, antennas, applyAutocomplete, applyNewPostsQueue, authUser, autoCompressImages, autocompleteIndex, autocompleteSuggestions, autocompleteType, bookmarks, channelCategoryFilter, channelTimelinePosts, channels, checkAutocomplete, currentView, cwContent, dismissAnnouncement, dismissedAnnouncements, drafts, fetchBookmarks, fetchChannels, fetchDirectory, fetchDrive, fetchLists, fetchPopularTags, fetchTimeline, followHandle, followStatus, handleAutocompleteKeyDown, handleCreatePost, handleFollow, handleLogout, handleRemoveAttachment, handleSearchSubmit, handleSelectHashtag, handleSelectMedia, handleSwitchTimelineMode, handleToggleChannelFollow, handleToggleSearchUserFollow, isLoadingBookmarks, isLoadingChannelTimeline, isLoadingChannels, isLoadingOlderPosts, isLoadingTimeline, isPosting, isSearching, isSensitivePost, isStreamingConnected, isUploadingMedia, lists, loadOlderPosts, navigateToView, newPostsQueue, openAntennaManageModal, openChannelDetail, openCreateChannelModal, openDraftsModal, openScheduleModal, openSettings, openUserProfile, pollChoices, pollExpiresIn, pollMultiple, popularTags, postAttachments, postContent, postExtraMenuRef, postTargetChannelId, postVisibility, profileTarget, publicAnnouncements, quoteTargetPost, postDeps, scheduledPosts, searchQuery, searchResults, searchTab, selectedChannel, serverStats, setAutoCompressImages, setChannelCategoryFilter, setCwContent, setEditingChannel, setFollowHandle, setIsSensitivePost, setPollChoices, setPollExpiresIn, setPollMultiple, setPostAttachments, setPostContent, setPostTargetChannelId, setPostVisibility, setQuoteTargetPost, setSearchQuery, setSearchTab, setSelectedChannel, setShowCwInput, setShowDirectoryModal, setShowDriveModal, setShowListsModal, setShowLoginModal, setShowPollInput, setShowPostExtraMenu, setShowRegisterModal, setShowRichEmojiPicker, showCwInput, showPollInput, showPostExtraMenu, timeline, timelineCursor, timelineMode, unreadNotificationsCount, uploadStatusText } = props;
  const { renderPostCard } = createRenderPostCard(postDeps);

  // 仮想化のための「先頭に何件挿したか」。SSE の新着を先頭に挿しても
  // スクロール位置が飛ばないように firstItemIndex をずらす
  const [firstItemIndex, setFirstItemIndex] = useState(1000000);
  const headIdRef = useRef<string | null>(null);
  useEffect(() => {
    const list = timeline as any[];
    const head = list[0]?.id ?? null;
    const prevHead = headIdRef.current;
    if (head && prevHead && head !== prevHead) {
      const idx = list.findIndex((p: any) => p.id === prevHead);
      if (idx > 0) setFirstItemIndex((i) => i - idx);
      else if (idx === -1) setFirstItemIndex(1000000);
    } else if (head && !prevHead) {
      setFirstItemIndex(1000000);
    }
    headIdRef.current = head;
  }, [timeline]);

  return (
    <>
        {/* 🌟 Misskey風 3カラム統合レイアウト (PC: 左固定ナビ+中央タイムライン/検索+右ウィジェット / モバイル: 1カラム) */}
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

                {/* 設定（一般ユーザーも開ける。プロフィール編集・ミュート/ブロック・
                    パスキー・エクスポートなどはここにしかない） */}
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
                        {popularTags.map((item: any) => (
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
                    bookmarks.map((post: any) => renderPostCard(post))
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
                          {(authUser?.role === 'admin' || selectedChannel.user_id === authUser?.id) && (
                            <button
                              type="button"
                              onClick={() => setEditingChannel(selectedChannel)}
                              className="p-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-300 transition cursor-pointer"
                              title="チャンネル設定（名前・説明・バナー・アーカイブ）"
                            >
                              <Settings className="w-3.5 h-3.5" />
                            </button>
                          )}
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
                        channelTimelinePosts.map((post: any) => renderPostCard(post))
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
                        channels.map((ch: any) => (
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
                    {antennas.map((ant: any) => {
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
                              投稿先: {channels.find((c: any) => c.id === postTargetChannelId)?.name || 'チャンネル'}
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
                          onSelect={(item: any) => applyAutocomplete(item, postContent, setPostContent, document.querySelector<HTMLTextAreaElement>('#main-post-textarea'))}
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

                      {/* 添付画像プレビュー（ALT = 代替テキストも設定できる） */}
                      {postAttachments.length > 0 && (
                        <div className="space-y-2 pt-1">
                          <div className="flex flex-wrap gap-2">
                            {postAttachments.map((att: any, idx: any) => (
                              <div key={idx} className="relative group w-20 h-20 rounded-xl overflow-hidden border border-slate-700 bg-slate-950 shadow-md">
                                <img
                                  src={att.thumbnailUrl || att.url}
                                  alt={att.description || `添付画像 ${idx + 1}`}
                                  className="w-full h-full object-cover"
                                />
                                {att.description ? (
                                  <span className="absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-black/70 text-[9px] font-bold text-emerald-300 text-center" title={att.description}>
                                    ALT
                                  </span>
                                ) : null}
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
                          {/* 各添付の代替テキスト（スクリーンリーダー・連合先の alt として使われる） */}
                          <div className="space-y-1">
                            {postAttachments.map((att: any, idx: any) => (
                              <div key={`alt-${idx}`} className="flex items-center space-x-2">
                                <span className="text-[10px] font-bold text-slate-500 shrink-0 w-10">ALT {idx + 1}</span>
                                <input
                                  type="text"
                                  value={att.description || ''}
                                  maxLength={1500}
                                  placeholder="画像の説明（任意・空でも投稿できます）"
                                  onChange={(e) => {
                                    const value = e.target.value;
                                    setPostAttachments((prev: any) => prev.map((a: any, i: any) => (i === idx ? { ...a, description: value } : a)));
                                  }}
                                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 placeholder-slate-600 focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                                />
                              </div>
                            ))}
                          </div>
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
                                      {channels.map((ch: any) => (
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
                              <span>📢 {channels.find((c: any) => c.id === postTargetChannelId)?.name || 'チャンネル'}</span>
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
                            (!postContent.trim() && postAttachments.length === 0 && !quoteTargetPost && (!showPollInput || pollChoices.filter((c: any) => c.trim()).length < 2)) ||
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
                {publicAnnouncements.filter((a: any) => !dismissedAnnouncements.includes(a.id)).length > 0 && (
                  <div className="space-y-2">
                    {publicAnnouncements
                      .filter((a: any) => !dismissedAnnouncements.includes(a.id))
                      .slice(0, 3)
                      .map((a: any) => (
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
                    /* 仮想化: 見えている行だけを DOM に置く（1,000 件でもノード数が一定）。
                       ページ全体がスクロールするので useWindowScroll を使う */
                    <Virtuoso
                      useWindowScroll
                      data={timeline}
                      firstItemIndex={firstItemIndex}
                      computeItemKey={(_i, post: any) => post.id}
                      itemContent={(_index, post: any) => <div className="pb-3">{renderPostCard(post)}</div>}
                      components={{
                        Footer: () =>
                          timelineCursor ? (
                            <button
                              type="button"
                              onClick={loadOlderPosts}
                              disabled={isLoadingOlderPosts}
                              className="w-full py-3 px-4 rounded-2xl bg-slate-900/60 border border-slate-800 hover:border-emerald-500/50 text-slate-300 hover:text-white text-xs transition cursor-pointer flex items-center justify-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingOlderPosts ? 'animate-spin' : ''}`} />
                              <span>{isLoadingOlderPosts ? '過去のノートを読み込み中...' : '📜 過去のノートを読み込む'}</span>
                            </button>
                          ) : null,
                      }}
                    />
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
                  {popularTags.slice(0, 8).map((item: any) => (
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
    </>
  );
}
