/**
 * ModalsView（App.tsx から切り出したモーダル・オーバーレイ群）
 *
 * 表示条件（showXxx）は App 側の state のままで、ここは props で受け取る。
 * App からは React.lazy で読み込むので、初期バンドルには含まれない（開いたときに読み込む）。
 */
import { useEffect, useState } from 'react';
import { AlertCircle, BarChart2, Bell, Bookmark, Check, CheckCircle2, Clock, Copy, Edit3, ExternalLink, EyeOff, FileText, FileVideo, FolderArchive, FolderOpen, GitBranch, Globe, HardDrive, Hash, Home, ImageIcon, Key, KeyRound, ListIcon, Lock, LogOut, Menu, MessageCircle, MessageSquare, Plus, Quote, Radio, RefreshCw, Repeat, Search, Send, Server, Settings, ShieldAlert, ShieldCheck, Smile, Trash2, User, UserPlus, Users, X, Zap } from 'lucide-react';
import { api } from '../api/client';
import { AutocompleteDropdown, FormattedPostContent, PollCard, PollInputEditor, PostMediaGrid, QuoteCard, createRenderPostCard } from '../components/PostRendering';
import type { Antenna, Channel, Draft, FollowListEntry, Post, ScheduledPost } from '../App';

export interface ModalsViewProps {
  setThreadModalPost: any;
  setThreadData: any;
  currentViewRef: any;
  fetchAntennas: any;
  setActiveAntenna: any;
  fetchDrafts: any;
  setPostAttachments: any;
  fetchScheduledPosts: any;
  setDriveItems: any;
  setDriveStats: any;
  listAbortRef: any;
  setChannels: any;
  selectedChannel: any;
  setSelectedChannel: any;
  openChannelDetail: any;
  fetchTimeline: any;
  fetchAdminData: any;
  setSelfDeleteError: any;
  setAuthToken: any;
  setAuthUser: any;
  setCurrentView: any;
  setShowAuthPortal: any;
  setAuthPortalTab: any;
  activeAntenna: any;
  activeListId: any;
  adminDeleteTargetUser: any;
  antennas: any;
  applyAutocomplete: any;
  authToken: any;
  authUser: any;
  autoCompressImages: any;
  autocompleteIndex: any;
  autocompleteSuggestions: any;
  autocompleteType: any;
  channels: any;
  checkAutocomplete: any;
  currentView: any;
  customEmojis: any;
  cwContent: any;
  directoryUsers: any;
  drafts: any;
  driveItems: any;
  driveMsg: any;
  driveStats: any;
  editBannerUrl: any;
  editBio: any;
  editIconUrl: any;
  editName: any;
  editingChannel: any;
  fetchBookmarks: any;
  fetchChannels: any;
  fetchDirectory: any;
  fetchDrive: any;
  fetchLists: any;
  followList: any;
  followListError: any;
  followListRows: any;
  handleAutocompleteKeyDown: any;
  handleCreatePost: any;
  handleLogout: any;
  handleNotificationClick: any;
  handleOpenReply: any;
  handleOpenThread: any;
  handleRemoveAttachment: any;
  handleSaveProfile: any;
  handleSelectMedia: any;
  handleSwitchTimelineMode: any;
  handleToggleReaction: any;
  handleUploadAvatar: any;
  handleUploadBanner: any;
  handleVotePoll: any;
  hasConfirmedSaved: any;
  isCopied: any;
  isLoadingDirectory: any;
  isLoadingDrive: any;
  isLoadingFollowList: any;
  isLoadingThread: any;
  isMobileMenuOpen: any;
  isPasswordAuthMode: any;
  isPosting: any;
  isSavingProfile: any;
  isSensitivePost: any;
  isUploadingBanner: any;
  isUploadingIcon: any;
  isUploadingMedia: any;
  isVotingPoll: any;
  issuedMasterKey: any;
  lists: any;
  miAuthSession: any;
  navigateToView: any;
  notificationToast: any;
  openAntennaManageModal: any;
  openDraftsModal: any;
  openMediaPreview: any;
  openMobilePostModal: any;
  openScheduleModal: any;
  openSettings: any;
  openUserProfile: any;
  pollChoices: any;
  pollExpiresIn: any;
  pollMultiple: any;
  postAttachments: any;
  postContent: any;
  postTargetChannelId: any;
  postVisibility: any;
  previewMediaUrl: any;
  profileTarget: any;
  pushModalState: any;
  quoteTargetPost: any;
  recoveryMsg: any;
  recoveryStep: any;
  postDeps: any;
  replyContent: any;
  replyTargetPost: any;
  reportCategory: any;
  reportComment: any;
  reportTarget: any;
  scheduledPosts: any;
  selfDeleteConfirmId: any;
  selfDeleteError: any;
  selfDeleteMasterKey: any;
  serverStats: any;
  setActiveListId: any;
  setAdminDeleteTargetUser: any;
  setAutoCompressImages: any;
  setCwContent: any;
  setDriveMsg: any;
  setEditBannerUrl: any;
  setEditBio: any;
  setEditIconUrl: any;
  setEditName: any;
  setEditingChannel: any;
  setFollowList: any;
  setHasConfirmedSaved: any;
  setIsCopied: any;
  setIsMobileMenuOpen: any;
  setIsSensitivePost: any;
  setMiAuthSession: any;
  setNotificationToast: any;
  setPollChoices: any;
  setPollExpiresIn: any;
  setPollMultiple: any;
  setPostContent: any;
  setPostTargetChannelId: any;
  setPostVisibility: any;
  setPreviewMediaUrl: any;
  setQuoteTargetPost: any;
  setRecoveryMsg: any;
  setRecoveryStep: any;
  setReplyContent: any;
  setReplyTargetPost: any;
  setReportCategory: any;
  setReportComment: any;
  setReportTarget: any;
  setSelfDeleteConfirmId: any;
  setSelfDeleteMasterKey: any;
  setShowAntennaManageModal: any;
  setShowAntennaModal: any;
  setShowCreateChannelModal: any;
  setShowCwInput: any;
  setShowDirectoryModal: any;
  setShowDraftsModal: any;
  setShowDriveModal: any;
  setShowEditProfileModal: any;
  setShowListsModal: any;
  setShowLoginModal: any;
  setShowMasterKeyModal: any;
  setShowMobilePostModal: any;
  setShowPollInput: any;
  setShowRecoveryModal: any;
  setShowRegisterModal: any;
  setShowRichEmojiPicker: any;
  setShowScheduleModal: any;
  setShowSelfDeleteModal: any;
  showAntennaManageModal: any;
  showAntennaModal: any;
  showCreateChannelModal: any;
  showCustomEmojis: any;
  showCwInput: any;
  showDirectoryModal: any;
  showDraftsModal: any;
  showDriveModal: any;
  showEditProfileModal: any;
  showExitToast: any;
  showListsModal: any;
  showMasterKeyModal: any;
  showMobilePostModal: any;
  showPollInput: any;
  showRecoveryModal: any;
  showRichEmojiPicker: any;
  showScheduleModal: any;
  showSelfDeleteModal: any;
  threadData: any;
  threadModalPost: any;
  unreadNotificationsCount: any;
  uploadStatusText: any;
}

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

function FollowListModal({
  title,
  rows,
  isLoading,
  error,
  onOpenProfile,
  onClose,
}: {
  title: string;
  rows: FollowListEntry[];
  isLoading: boolean;
  error: string | null;
  onOpenProfile: (userId: string) => void;
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
          <div className="flex items-center space-x-2 text-sky-400">
            <Users className="w-5 h-5" />
            <h3 className="font-bold text-base text-slate-100">
              {title} ({rows.length})
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
            title="閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {isLoading ? (
          <p className="text-sm text-slate-400 py-6 text-center">読み込み中…</p>
        ) : error ? (
          <p className="text-sm text-rose-400 py-6 text-center">{error}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-500 py-6 text-center">まだ誰もいません。</p>
        ) : (
          <div className="space-y-1 max-h-[60vh] overflow-y-auto">
            {rows.map((row) => (
              <button
                key={row.actor_url}
                type="button"
                onClick={() => onOpenProfile(row.user_id)}
                className="w-full flex items-center space-x-3 p-2 rounded-2xl hover:bg-slate-800/70 transition text-left"
              >
                <div className="w-10 h-10 rounded-xl overflow-hidden bg-gradient-to-tr from-cyan-500 via-indigo-600 to-purple-600 flex items-center justify-center text-sm font-bold text-white shrink-0">
                  {row.icon_url ? (
                    <img src={row.icon_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    (row.name || row.username || '?').slice(0, 1).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-slate-100 truncate">{row.name || row.username}</p>
                  <p className="text-xs text-slate-500 font-mono truncate">
                    {row.username ? `@${row.username}${row.domain ? `@${row.domain}` : ''}` : row.actor_url}
                  </p>
                </div>
                {!row.is_local && (
                  <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-indigo-500/15 text-indigo-300 shrink-0">
                    連合
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChannelEditModal({
  channel,
  onSave,
  onClose,
}: {
  channel: Channel;
  onSave: (patch: { name: string; description: string; banner_url: string; color: string; category: string; is_archived: boolean }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(channel.name || '');
  const [description, setDescription] = useState(channel.description || '');
  const [bannerUrl, setBannerUrl] = useState(channel.banner_url || '');
  const [color, setColor] = useState(channel.color || '#6366f1');
  const [category, setCategory] = useState(channel.category || 'general');
  const [isArchived, setIsArchived] = useState(Boolean(channel.is_archived));
  const [isSaving, setIsSaving] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200"
      onClick={onClose}
    >
      <form
        className="bg-slate-900 border border-slate-700/80 rounded-3xl max-w-lg w-full p-5 sm:p-6 shadow-2xl space-y-4 my-8"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          setIsSaving(true);
          try {
            await onSave({ name, description, banner_url: bannerUrl, color, category, is_archived: isArchived });
            onClose();
          } finally {
            setIsSaving(false);
          }
        }}
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center space-x-2 text-indigo-400">
            <Settings className="w-5 h-5" />
            <h3 className="font-bold text-base text-slate-100">チャンネル設定</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
            title="閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-bold text-slate-400">名前</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={50}
            required
            className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-bold text-slate-400">説明</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={500}
            className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 focus:outline-none focus:border-indigo-500 resize-none"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-bold text-slate-400">バナー画像 URL</span>
          <input
            value={bannerUrl}
            onChange={(e) => setBannerUrl(e.target.value)}
            placeholder="https://…"
            className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-bold text-slate-400">テーマ色</span>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-full h-10 bg-slate-950 border border-slate-800 rounded-xl cursor-pointer"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-bold text-slate-400">カテゴリ</span>
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              maxLength={30}
              className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
            />
          </label>
        </div>

        <label className="flex items-center space-x-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={isArchived}
            onChange={(e) => setIsArchived(e.target.checked)}
            className="w-4 h-4 accent-indigo-500"
          />
          <span>アーカイブする（一覧に出さず、投稿も受け付けない）</span>
        </label>

        <div className="flex items-center justify-end space-x-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-bold transition"
          >
            キャンセル
          </button>
          <button
            type="submit"
            disabled={isSaving}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-bold transition"
          >
            {isSaving ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}

function MiAuthApproval({
  session,
  token,
  isLoggedIn,
  onClose,
  onRequestLogin,
}: {
  session: string;
  token: string | null;
  isLoggedIn: boolean;
  onClose: () => void;
  onRequestLogin: () => void;
}) {
  const [info, setInfo] = useState<{ name: string; callback: string; permissions: string[]; status: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!isLoggedIn || !token) {
        setIsLoading(false);
        return;
      }
      try {
        const res = await api.get(`/miauth/${encodeURIComponent(session)}/info`, { token });
        if (!res.ok) throw new Error('この承認リクエストは見つかりませんでした。');
        const data = await res.json();
        if (!cancelled) setInfo(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '読み込みに失敗しました。');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [session, token, isLoggedIn]);

  const respond = async (action: 'approve' | 'deny') => {
    if (!token) return;
    try {
      const res = await api.post(`/miauth/${encodeURIComponent(session)}/${action}`, { token });
      if (!res.ok) throw new Error('操作に失敗しました。');
      setDone(action === 'approve' ? 'approved' : 'denied');
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作に失敗しました。');
    }
  };

  return (
    <div className="fixed inset-0 z-[90] bg-slate-950/95 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700/80 rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-4 my-8">
        <div className="flex items-center space-x-2 text-indigo-400">
          <Lock className="w-5 h-5" />
          <h3 className="font-bold text-base text-slate-100">アプリの連携を許可しますか？</h3>
        </div>

        {!isLoggedIn ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">
              このアプリを使うには、先に Spica にログインしてください。
            </p>
            <p className="text-xs text-slate-500">
              承認すると、アプリはあなたのアカウントで読み書きできるようになります（投稿・通知・フォローなど）。
            </p>
            <div className="flex items-center justify-end space-x-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-bold transition"
              >
                あとで
              </button>
              <button
                type="button"
                onClick={onRequestLogin}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition"
              >
                ログインする
              </button>
            </div>
          </div>
        ) : done ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-200">
              {done === 'approved'
                ? '承認しました。アプリの画面に戻ってください。'
                : '拒否しました。アプリにはトークンが渡りません。'}
            </p>
            <div className="flex items-center justify-end space-x-2">
              {done === 'approved' && info?.callback && (
                <a
                  href={info.callback}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition"
                >
                  アプリに戻る
                </a>
              )}
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-bold transition"
              >
                閉じる
              </button>
            </div>
          </div>
        ) : isLoading ? (
          <p className="text-sm text-slate-400 py-4 text-center">読み込み中…</p>
        ) : error ? (
          <div className="space-y-3">
            <p className="text-sm text-rose-400">{error}</p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-bold transition"
              >
                閉じる
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-4 space-y-1.5">
              <p className="text-xs text-slate-500">連携しようとしているアプリ</p>
              <p className="text-sm font-bold text-slate-100 break-all">{info?.name || '不明なアプリ'}</p>
              {info?.callback && (
                <p className="text-[11px] text-slate-500 font-mono break-all">{info.callback}</p>
              )}
            </div>

            {info?.permissions && info.permissions.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-slate-500">要求されている権限</p>
                <div className="flex flex-wrap gap-1.5">
                  {info.permissions.map((permission) => (
                    <span key={permission} className="px-2 py-0.5 rounded-lg bg-slate-800 text-[11px] font-mono text-slate-300">
                      {permission}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <p className="text-[11px] text-slate-500 leading-relaxed">
              Spica はアプリごとに権限を分けていません。承認すると、このアプリは
              <strong className="text-slate-400">あなたのアカウントでできること全部</strong>
              （投稿・削除・フォロー・通知の閲覧など）ができるようになります。
              不要になったら「設定 → セッション・ログアウト」からログアウトしてください。
            </p>

            <div className="flex items-center justify-end space-x-2">
              <button
                type="button"
                onClick={() => void respond('deny')}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-bold transition"
              >
                拒否
              </button>
              <button
                type="button"
                onClick={() => void respond('approve')}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition"
              >
                許可する
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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

export default function ModalsView(props: ModalsViewProps) {
  const { setThreadModalPost, setThreadData, currentViewRef, fetchAntennas, setActiveAntenna, fetchDrafts, setPostAttachments, fetchScheduledPosts, setDriveItems, setDriveStats, listAbortRef, setChannels, selectedChannel, setSelectedChannel, openChannelDetail, fetchTimeline, fetchAdminData, setSelfDeleteError, setAuthToken, setAuthUser, setCurrentView, setShowAuthPortal, setAuthPortalTab, activeAntenna, activeListId, adminDeleteTargetUser, antennas, applyAutocomplete, authToken, authUser, autoCompressImages, autocompleteIndex, autocompleteSuggestions, autocompleteType, channels, checkAutocomplete, currentView, customEmojis, cwContent, directoryUsers, drafts, driveItems, driveMsg, driveStats, editBannerUrl, editBio, editIconUrl, editName, editingChannel, fetchBookmarks, fetchChannels, fetchDirectory, fetchDrive, fetchLists, followList, followListError, followListRows, handleAutocompleteKeyDown, handleCreatePost, handleLogout, handleNotificationClick, handleOpenReply, handleOpenThread, handleRemoveAttachment, handleSaveProfile, handleSelectMedia, handleSwitchTimelineMode, handleToggleReaction, handleUploadAvatar, handleUploadBanner, handleVotePoll, hasConfirmedSaved, isCopied, isLoadingDirectory, isLoadingDrive, isLoadingFollowList, isLoadingThread, isMobileMenuOpen, isPasswordAuthMode, isPosting, isSavingProfile, isSensitivePost, isUploadingBanner, isUploadingIcon, isUploadingMedia, isVotingPoll, issuedMasterKey, lists, miAuthSession, navigateToView, notificationToast, openAntennaManageModal, openDraftsModal, openMediaPreview, openMobilePostModal, openScheduleModal, openSettings, openUserProfile, pollChoices, pollExpiresIn, pollMultiple, postAttachments, postContent, postTargetChannelId, postVisibility, previewMediaUrl, profileTarget, pushModalState, quoteTargetPost, recoveryMsg, recoveryStep, postDeps, replyContent, replyTargetPost, reportCategory, reportComment, reportTarget, scheduledPosts, selfDeleteConfirmId, selfDeleteError, selfDeleteMasterKey, serverStats, setActiveListId, setAdminDeleteTargetUser, setAutoCompressImages, setCwContent, setDriveMsg, setEditBannerUrl, setEditBio, setEditIconUrl, setEditName, setEditingChannel, setFollowList, setHasConfirmedSaved, setIsCopied, setIsMobileMenuOpen, setIsSensitivePost, setMiAuthSession, setNotificationToast, setPollChoices, setPollExpiresIn, setPollMultiple, setPostContent, setPostTargetChannelId, setPostVisibility, setPreviewMediaUrl, setQuoteTargetPost, setRecoveryMsg, setRecoveryStep, setReplyContent, setReplyTargetPost, setReportCategory, setReportComment, setReportTarget, setSelfDeleteConfirmId, setSelfDeleteMasterKey, setShowAntennaManageModal, setShowAntennaModal, setShowCreateChannelModal, setShowCwInput, setShowDirectoryModal, setShowDraftsModal, setShowDriveModal, setShowEditProfileModal, setShowListsModal, setShowLoginModal, setShowMasterKeyModal, setShowMobilePostModal, setShowPollInput, setShowRecoveryModal, setShowRegisterModal, setShowRichEmojiPicker, setShowScheduleModal, setShowSelfDeleteModal, showAntennaManageModal, showAntennaModal, showCreateChannelModal, showCustomEmojis, showCwInput, showDirectoryModal, showDraftsModal, showDriveModal, showEditProfileModal, showExitToast, showListsModal, showMasterKeyModal, showMobilePostModal, showPollInput, showRecoveryModal, showRichEmojiPicker, showScheduleModal, showSelfDeleteModal, threadData, threadModalPost, unreadNotificationsCount, uploadStatusText } = props;

  // --- App.tsx から移した state とハンドラ（この画面だけで使う） ---
  const [newChannelName, setNewChannelName] = useState<string>('');

  const [newChannelDesc, setNewChannelDesc] = useState<string>('');

  const [newChannelColor, setNewChannelColor] = useState<string>('#6366f1');

  const [newChannelCategory, setNewChannelCategory] = useState<string>('general');

  const [isCreatingChannel, setIsCreatingChannel] = useState<boolean>(false);

  const [editingAntenna, setEditingAntenna] = useState<Partial<Antenna> | null>(null);

  const [scheduledDateTime, setScheduledDateTime] = useState<string>('');

  const [emojiSearchTerm, setEmojiSearchTerm] = useState<string>('');

  const [emojiCategoryTab, setEmojiCategoryTab] = useState<string>('custom');

  const [showReplyCwInput, setShowReplyCwInput] = useState<boolean>(false);

  const [replyCwContent, setReplyCwContent] = useState<string>('');

  const [isReplying, setIsReplying] = useState<boolean>(false);

  const [isAdminDeletingUser, setIsAdminDeletingUser] = useState<boolean>(false);

  const [isSelfDeleting, setIsSelfDeleting] = useState<boolean>(false);

  const [isSubmittingReport, setIsSubmittingReport] = useState<boolean>(false);

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

  function openAntennaModal(ant?: Partial<Antenna> | null) {
    setEditingAntenna(ant || null);
    setShowAntennaModal(true);
    pushModalState('edit_antenna');
  }

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

  const handleSaveDraft = async () => {
    if (!authToken) return;
    if (!postContent.trim() && postAttachments.length === 0 && !quoteTargetPost) {
      alert('保存する内容がありません。');
      return;
    }
    try {
      const pollData = showPollInput && pollChoices.filter((c: any) => c.trim()).length >= 2
        ? { choices: pollChoices.filter((c: any) => c.trim()), multiple: pollMultiple, expiresIn: pollExpiresIn }
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
      const pollData = showPollInput && pollChoices.filter((c: any) => c.trim()).length >= 2
        ? { choices: pollChoices.filter((c: any) => c.trim()), multiple: pollMultiple, expiresIn: pollExpiresIn }
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

  const [listTimelinePosts, setListTimelinePosts] = useState<Post[]>([]);

  const [isLoadingListTimeline, setIsLoadingListTimeline] = useState<boolean>(false);

  const [newListName, setNewListName] = useState<string>('');

  const [newListMember, setNewListMember] = useState<string>('');

  const [listActionMsg, setListActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [isUploadingToDrive, setIsUploadingToDrive] = useState<boolean>(false);

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
      setDriveItems((prev: any) => prev.filter((item: any) => item.id !== id));
      if (data.stats) setDriveStats(data.stats);
      setDriveMsg({ type: 'success', text: 'ファイルを削除しました。' });
    } catch (err: any) {
      setDriveMsg({ type: 'error', text: err.message });
    }
  };

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

  const [directorySearch, setDirectorySearch] = useState<string>('');

  const [recoveryUserId, setRecoveryUserId] = useState<string>('');

  const [recoveryEmail, setRecoveryEmail] = useState<string>('');

  const [recoveryCode, setRecoveryCode] = useState<string>('');

  const [isRecovering, setIsRecovering] = useState<boolean>(false);

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
    setChannels((prev: any) => prev.map((ch: any) => (ch.id === updated.id ? { ...ch, ...updated } : ch)));
    if (selectedChannel?.id === updated.id) {
      setSelectedChannel((prev: any) => (prev ? { ...prev, ...updated } : prev));
    }
    alert('チャンネルを更新しました！');
  };

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !newChannelName.trim()) return;
    setIsCreatingChannel(true);
    try {
      const res = await api.post('/api/channels', { name: newChannelName.trim(), description: newChannelDesc.trim(), color: newChannelColor, category: newChannelCategory, });
      if (res.ok) {
        const created = await res.json();
        setChannels((prev: any) => [created, ...prev]);
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
  const { renderPostCard, renderReactionBadgeContent } = createRenderPostCard(postDeps);
  return (
    <>
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

      {/* 返信モーダル (モバイルでは全画面100dvhシート、PCではモーダル)
          ⚠️ 会話スレッド（z-50）の**上**に出す。どちらも z-50 だと、DOM の順番が
             早いこちらがスレッドに隠れて「返信画面が出ない」状態になる */}
      {replyTargetPost && (
        <div className="fixed inset-0 z-[60] flex flex-col sm:items-center sm:justify-center sm:p-4 bg-slate-950 sm:bg-black/80 sm:backdrop-blur-sm h-[100dvh] sm:h-auto overflow-hidden animate-in fade-in duration-200">
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
                            onVote={(indices: any) => {
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
                        onVote={(indices: any) => handleVotePoll(threadData.post.id, indices)}
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
                              onVote={(indices: any) => handleVotePoll(reply.id, indices)}
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
          className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150"
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
                    (e: any) => !emojiSearchTerm || e.name.toLowerCase().includes(emojiSearchTerm.toLowerCase()) || (e.category && e.category.toLowerCase().includes(emojiSearchTerm.toLowerCase()))
                  ).length === 0 ? (
                    <p className="text-xs text-slate-500 py-3 text-center">
                      {customEmojis.length === 0 ? '登録されているカスタム絵文字はありません（管理者画面から登録可能）' : '一致するカスタム絵文字がありません'}
                    </p>
                  ) : (
                    <div className="grid grid-cols-5 sm:grid-cols-6 gap-2">
                      {customEmojis
                        .filter(
                          (e: any) => !emojiSearchTerm || e.name.toLowerCase().includes(emojiSearchTerm.toLowerCase()) || (e.category && e.category.toLowerCase().includes(emojiSearchTerm.toLowerCase()))
                        )
                        .map((ce: any) => (
                          <button
                            key={ce.id}
                            type="button"
                            onClick={() => {
                              const val = `:${ce.name}:`;
                              if (showRichEmojiPicker.target === 'post') {
                                setPostContent((prev: any) => prev ? `${prev} ${val} ` : `${val} `);
                              } else if (showRichEmojiPicker.target === 'reply') {
                                setReplyContent((prev: any) => prev ? `${prev} ${val} ` : `${val} `);
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
                            setPostContent((prev: any) => prev ? `${prev} ${em} ` : `${em} `);
                          } else if (showRichEmojiPicker.target === 'reply') {
                            setReplyContent((prev: any) => prev ? `${prev} ${em} ` : `${em} `);
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
                            setPostContent((prev: any) => prev ? `${prev} ${em} ` : `${em} `);
                          } else if (showRichEmojiPicker.target === 'reply') {
                            setReplyContent((prev: any) => prev ? `${prev} ${em} ` : `${em} `);
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
                            setPostContent((prev: any) => prev ? `${prev} ${em} ` : `${em} `);
                          } else if (showRichEmojiPicker.target === 'reply') {
                            setReplyContent((prev: any) => prev ? `${prev} ${em} ` : `${em} `);
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
                            setPostContent((prev: any) => prev ? `${prev} ${em} ` : `${em} `);
                          } else if (showRichEmojiPicker.target === 'reply') {
                            setReplyContent((prev: any) => prev ? `${prev} ${em} ` : `${em} `);
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

      {/* 👥 フォロワー / フォロー中の一覧 */}
      {followList && (
        <FollowListModal
          title={followList.mode === 'followers' ? `${followList.name} のフォロワー` : `${followList.name} のフォロー中`}
          rows={followListRows}
          isLoading={isLoadingFollowList}
          error={followListError}
          onOpenProfile={(userId: any) => {
            setFollowList(null);
            openUserProfile(userId);
          }}
          onClose={() => setFollowList(null)}
        />
      )}

      {/* 🛠 チャンネル設定 */}
      {editingChannel && (
        <ChannelEditModal channel={editingChannel} onSave={saveChannelEdit} onClose={() => setEditingChannel(null)} />
      )}

      {/* 🔐 MiAuth の承認画面（クライアントがブラウザで開く） */}
      {miAuthSession && (
        <MiAuthApproval
          session={miAuthSession}
          token={authToken}
          isLoggedIn={Boolean(authToken)}
          onClose={() => {
            setMiAuthSession(null);
            try {
              window.history.pushState({}, '', '/');
            } catch {}
          }}
          onRequestLogin={() => setShowLoginModal(true)}
        />
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
                {directoryUsers.map((user: any) => (
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
                {driveItems.map((item: any) => {
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
              {lists.map((list: any) => (
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
              const activeList = lists.find((l: any) => l.id === activeListId);
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
                      listTimelinePosts.map((post: any) => renderPostCard(post))
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
                disabled={(!postContent.trim() && postAttachments.length === 0 && !quoteTargetPost && (!showPollInput || pollChoices.filter((c: any) => c.trim()).length < 2)) || isPosting || isUploadingMedia}
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
                  onSelect={(item: any) => applyAutocomplete(item, postContent, setPostContent, document.querySelector<HTMLTextAreaElement>('#mobile-post-textarea'))}
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
                  {postAttachments.map((att: any, idx: any) => (
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

                  {/* 💾 下書き（デスクトップの「その他」メニューにしか無かった） */}
                  <button
                    type="button"
                    onClick={openDraftsModal}
                    className="px-2 py-1 rounded-lg text-xs font-semibold flex items-center space-x-1 border bg-slate-900 border-slate-800 text-slate-400 hover:text-cyan-300 transition cursor-pointer"
                    title="下書き（保存・読み込み）"
                  >
                    <FileText className="w-3.5 h-3.5 text-cyan-400" />
                    <span className="text-[10px] font-bold">下書き{drafts.length > 0 ? ` (${drafts.length})` : ''}</span>
                  </button>

                  {/* ⏰ 予約投稿（同上） */}
                  <button
                    type="button"
                    onClick={openScheduleModal}
                    className="px-2 py-1 rounded-lg text-xs font-semibold flex items-center space-x-1 border bg-slate-900 border-slate-800 text-slate-400 hover:text-amber-300 transition cursor-pointer"
                    title="予約投稿"
                  >
                    <Clock className="w-3.5 h-3.5 text-amber-400" />
                    <span className="text-[10px] font-bold">予約{scheduledPosts.length > 0 ? ` (${scheduledPosts.length})` : ''}</span>
                  </button>

                  {/* 📢 投稿先チャンネル（デスクトップと同じ選択肢） */}
                  {channels.length > 0 && (
                    <select
                      value={postTargetChannelId || ''}
                      onChange={(e) => setPostTargetChannelId(e.target.value || null)}
                      className={`max-w-[9rem] px-2 py-1 rounded-lg text-[10px] font-bold border transition cursor-pointer focus:outline-none ${
                        postTargetChannelId
                          ? 'bg-indigo-950/80 border-indigo-500/60 text-indigo-300'
                          : 'bg-slate-900 border-slate-800 text-slate-400'
                      }`}
                      title="投稿先チャンネル"
                    >
                      <option value="" className="bg-slate-900 text-slate-200">📢 チャンネルなし</option>
                      {channels.map((ch: any) => (
                        <option key={ch.id} value={ch.id} className="bg-slate-900 text-slate-200">
                          📢 {ch.name}
                        </option>
                      ))}
                    </select>
                  )}

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
          className="fixed inset-0 z-[80] bg-black/95 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200"
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
          onSelectAntenna={(ant: any) => handleSwitchTimelineMode('antenna', ant)}
          onOpenCreate={() => openAntennaModal(null)}
          onEditAntenna={(ant: any) => openAntennaModal(ant)}
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
    </>
  );
}
