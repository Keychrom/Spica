/**
 * ProfileView（App.tsx から切り出した画面）
 *
 * 見た目・挙動は App.tsx にあったときのまま。状態は App 側に置いたままにして、
 * ここへは props で渡す（切り出しであって作り直しではない）。
 * App からは React.lazy で読み込むので、初期バンドルには含まれない。
 */
import { useState } from 'react';
import { AlertCircle, ArrowLeft, Ban, Calendar, Edit3, ExternalLink, Globe, Mail, MessageSquare, Pin, RefreshCw, Server, Settings, ShieldAlert, UserCheck, UserPlus, Volume2, VolumeX } from 'lucide-react';
import { FormattedPostContent, createRenderPostCard, markThreadContinuations } from '../components/PostRendering';

export interface ProfileViewProps {
  setEditName: any;
  setEditBio: any;
  setEditIconUrl: any;
  setEditBannerUrl: any;
  /** プロフィール編集モーダルは privacy 系のトグルを持たないので、開くときに現在値へ揃えておく（保存で巻き戻さないため） */
  setProfileNoindex: any;
  setProfileNoAiTraining: any;
  setProfileIsLocked: any;
  setProfileDiscoverable: any;
  setShowEditProfileModal: any;
  pushModalState: any;
  authToken: any;
  api: any;
  setProfileData: any;
  fetchMyFollowingUrls: any;
  setFollowList: any;
  setFollowListRows: any;
  setFollowListError: any;
  setIsLoadingFollowList: any;
  authUser: any;
  handleBlockUser: any;
  handleMuteUser: any;
  handleUnblockUser: any;
  handleUnmuteUser: any;
  isLoadingProfile: any;
  navigateToView: any;
  openSettings: any;
  profileData: any;
  profilePosts: any;
  profileTarget: any;
  postDeps: any;
  setReportCategory: any;
  setReportComment: any;
  setReportTarget: any;
  setShowLoginModal: any;
  /** ✉️ DM の導線を出すか（サーバー設定 `dm_enabled`） */
  featuresDm: any;
  /** DM 画面をその相手とのスレッドで開く（`/dm?to=<handle>`） */
  openDm: any;
}

export default function ProfileView(props: ProfileViewProps) {
  const { setIsLoadingFollowList, setFollowListError, setFollowListRows, setFollowList, fetchMyFollowingUrls, setProfileData, api, authToken, pushModalState, setShowEditProfileModal, setEditBannerUrl, setEditIconUrl, setEditBio, setEditName, setProfileNoindex, setProfileNoAiTraining, setProfileIsLocked, setProfileDiscoverable, authUser, handleBlockUser, handleMuteUser, handleUnblockUser, handleUnmuteUser, isLoadingProfile, navigateToView, openSettings, profileData, profilePosts, profileTarget, postDeps, setReportCategory, setReportComment, setReportTarget, setShowLoginModal, featuresDm, openDm } = props;

  // --- App.tsx から移した state とハンドラ（この画面だけで使う） ---
  const [isTogglingFollow, setIsTogglingFollow] = useState<boolean>(false);

  const openEditProfileModal = () => {
    if (!authUser) return;
    setEditName(authUser.name || '');
    setEditBio(authUser.summary || '');
    setEditIconUrl(authUser.icon_url || '');
    setEditBannerUrl(authUser.banner_url || '');
    // 編集モーダルにトグルの無いプライバシー項目は、保存時に古い値で上書きしないよう今の値へ揃える
    setProfileNoindex(Number(authUser.noindex) === 1);
    setProfileNoAiTraining(Number(authUser.no_ai_training) === 1);
    // 鍵アカウントとディレクトリ掲載も同じ理由で揃える（揃えないと、ここからの保存で解除されてしまう）
    setProfileIsLocked(Number(authUser.is_locked) === 1);
    setProfileDiscoverable(Number(authUser.discoverable ?? 1) === 1);
    setShowEditProfileModal(true);
    pushModalState('edit_profile');
  };

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
        setProfileData((prev: any) => prev ? {
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
  const { renderPostCard } = createRenderPostCard(postDeps);
  return (
    <>
        {/* ユーザー詳細プロフィールビュー (Misskey / X 風) */}
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

                              {/* ✉️ メッセージを送る（サーバー設定 dm_enabled のときだけ） */}
                              {featuresDm && (
                                <button
                                  onClick={() => openDm({ to: profileData.handle || profileData.id })}
                                  className="px-3.5 py-2 rounded-xl font-bold text-xs bg-slate-800/80 border border-slate-700 text-indigo-300 hover:bg-slate-800 hover:text-indigo-200 transition flex items-center space-x-1.5 cursor-pointer"
                                  title="この相手にメッセージを送る"
                                >
                                  <Mail className="w-3.5 h-3.5 text-indigo-400" />
                                  <span>メッセージ</span>
                                </button>
                              )}

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
                        <button
                          type="button"
                          onClick={() => openFollowList('following', profileData.id, profileData.name)}
                          className="hover:text-white transition cursor-pointer"
                          title="フォロー中の一覧を表示"
                        >
                          <span className="font-bold text-white text-sm sm:text-base mr-1.5">{profileData.following_count}</span>
                          <span className="text-slate-400">フォロー中</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => openFollowList('followers', profileData.id, profileData.name)}
                          className="hover:text-white transition cursor-pointer"
                          title="フォロワーの一覧を表示"
                        >
                          <span className="font-bold text-white text-sm sm:text-base mr-1.5">{profileData.follower_count}</span>
                          <span className="text-slate-400">フォロワー</span>
                        </button>
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
                    {profileData.pinned_posts.map((post: any) => renderPostCard({ ...post, is_pinned: true }))}
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
                  markThreadContinuations(profilePosts).map((post: any) => renderPostCard(post))
                )}
              </div>
            </div>
          )}
        </main>
    </>
  );
}
