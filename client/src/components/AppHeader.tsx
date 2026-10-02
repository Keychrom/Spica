/**
 * アプリのヘッダー（デスクトップとモバイルの 2 つ）
 *
 * App.tsx から切り出しただけ。状態は App 側のままで props で受け取る。
 */
export interface AppHeaderProps {
  authUser: any;
  openWelcomePortal: any;
  navigateToView: any;
  handleSwitchTimelineMode: any;
  serverStats: any;
  handleSearchSubmit: any;
  Search: any;
  searchQuery: any;
  setSearchQuery: any;
  setSearchResults: any;
  X: any;
  canModerate: any;
  currentView: any;
  ShieldCheck: any;
  Bell: any;
  unreadNotificationsCount: any;
  openUserProfile: any;
  setShowLoginModal: any;
  LogIn: any;
  setShowRegisterModal: any;
  Key: any;
  setThemeMode: any;
  themeMode: any;
  Moon: any;
  Sun: any;
  Palette: any;
  timelineMode: any;
  activeHashtag: any;
  fetchTimeline: any;
  isLoadingTimeline: any;
  RefreshCw: any;
}

export default function AppHeader(props: AppHeaderProps) {
  const { authUser, openWelcomePortal, navigateToView, handleSwitchTimelineMode, serverStats, handleSearchSubmit, Search, searchQuery, setSearchQuery, setSearchResults, X, canModerate, currentView, ShieldCheck, Bell, unreadNotificationsCount, openUserProfile, setShowLoginModal, LogIn, setShowRegisterModal, Key, setThemeMode, themeMode, Moon, Sun, Palette, timelineMode, activeHashtag, fetchTimeline, isLoadingTimeline, RefreshCw } = props;
  const {} = props;
  return (
    <>
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
                setThemeMode((prev: any) => (prev === 'dark' ? 'pure_black' : prev === 'pure_black' ? 'light' : 'dark'));
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
              setThemeMode((prev: any) => (prev === 'dark' ? 'pure_black' : prev === 'pure_black' ? 'light' : 'dark'));
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
    </>
  );
}
