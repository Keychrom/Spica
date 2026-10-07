/**
 * NotificationsView（App.tsx から切り出した画面）
 *
 * 見た目・挙動は App.tsx にあったときのまま。状態は App 側に置いたままにして、
 * ここへは props で渡す（切り出しであって作り直しではない）。
 * App からは React.lazy で読み込むので、初期バンドルには含まれない。
 */
import { useState, useMemo } from 'react';
import type { AppNotification } from '../App';
import { ArrowLeft, AtSign, Bell, Check, CheckCheck, Clock, Heart, KeyRound, MessageCircle, Radio, RefreshCw, Repeat, Send, ShieldAlert, UserCheck } from 'lucide-react';
import { usePrefs } from '../prefs';

export interface NotificationsViewProps {
  authToken: any;
  api: any;
  setNotifications: any;
  setUnreadNotificationsCount: any;
  notifGroups: any;
  fetchNotifications: any;
  handleMarkNotificationRead: any;
  handleNotificationClick: any;
  isLoadingNotifications: any;
  navigateToView: any;
  notificationFilter: any;
  notifications: any;
  openUserProfile: any;
  setNotificationFilter: any;
  unreadNotificationsCount: any;
}

export default function NotificationsView(props: NotificationsViewProps) {
  const { notifGroups, setUnreadNotificationsCount, setNotifications, api, authToken, fetchNotifications, handleMarkNotificationRead, handleNotificationClick, isLoadingNotifications, navigateToView, notificationFilter, notifications, openUserProfile, setNotificationFilter, unreadNotificationsCount } = props;

  // --- App.tsx から移した state とハンドラ（この画面だけで使う） ---
  const [expandedNotifGroups, setExpandedNotifGroups] = useState<Set<string>>(new Set());

  const handleReadAllNotifications = async () => {
    if (!authToken) return;
    try {
      const res = await api.post('/api/notifications/read-all');
      if (res.ok) {
        setNotifications((prev: any) => prev.map((n: any) => ({ ...n, is_read: 1 })));
        setUnreadNotificationsCount(0);
      }
    } catch (err) {
      console.error('一括既読エラー:', err);
    }
  };

  // 設定「通知のまとめ方」: 「個別に表示」なら 1 件ずつのグループに割って、まとめをやめる
  const prefs = usePrefs();
  const effectiveGroups = useMemo(() => {
    if (prefs.notificationGrouping !== 'individual') return notifGroups;
    return (notifications || []).map((n: any) => ({ key: n.id, items: [n] }));
  }, [prefs.notificationGrouping, notifGroups, notifications]);

  const groupByFirstId = useMemo(() => {
    const map = new Map<string, { key: string; items: AppNotification[] }>();
    for (const group of effectiveGroups) map.set(group.items[0].id, group);
    return map;
  }, [effectiveGroups]);

  const groupedAwayIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of effectiveGroups) {
      if (group.items.length > 1) for (const item of group.items.slice(1)) ids.add(item.id);
    }
    return ids;
  }, [notifGroups]);
  return (
    <>
        {/* 通知センター (Notifications View) */}
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
              {notifications.map((notif: any) => {
                const isUnread = notif.is_read === 0;

                // まとめた通知の 2 件目以降は、グループカード側で描画する
                if (groupedAwayIds.has(notif.id)) return null;

                // まとめられる通知は、まずグループカードとして描画する
                const group = groupByFirstId.get(notif.id);
                if (group && group.items.length > 1 && !expandedNotifGroups.has(group.key)) {
                  const members = group.items;
                  const anyUnread = members.some((m: any) => m.is_read === 0);
                  const kindLabel = notif.type === 'follow' ? 'フォロー' : notif.type === 'reaction' ? 'リアクション' : 'リノート';
                  // リアクションは絵文字ごとの内訳も出す（「❤️ ×2  ⭐ ×1」）
                  const reactionSummary: [string, number][] = notif.type === 'reaction'
                    ? (Array.from(
                        members.reduce((acc: any, m: any) => {
                          const key = m.content || '❤️';
                          acc.set(key, (acc.get(key) || 0) + 1);
                          return acc;
                        }, new Map<string, number>()),
                      ).slice(0, 6) as [string, number][])
                    : [];

                  return (
                    <div
                      key={`group_${group.key}`}
                      onClick={() => handleNotificationClick(members[0])}
                      className={`p-4 rounded-2xl border transition cursor-pointer relative ${
                        anyUnread
                          ? 'bg-slate-900/95 border-indigo-500/40 shadow-lg shadow-indigo-500/5 hover:border-indigo-500/70'
                          : 'bg-slate-900/60 border-slate-800/80 hover:bg-slate-900/90 hover:border-slate-700/80'
                      }`}
                    >
                      {anyUnread && (
                        <span className="absolute top-4 right-4 w-2.5 h-2.5 rounded-full bg-indigo-500 ring-4 ring-indigo-500/20" />
                      )}
                      <div className="flex items-start space-x-3.5">
                        {/* まとまった人数分のアイコンを重ねて表示 */}
                        <div className="relative shrink-0 w-14 h-11">
                          {members.slice(0, 3).map((m: any, index: any) => (
                            <button
                              key={m.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                openUserProfile(m.actor_id);
                              }}
                              title={m.actor_name}
                              style={{ left: `${index * 14}px`, zIndex: 10 - index }}
                              className="absolute top-0 w-11 h-11 rounded-2xl overflow-hidden bg-gradient-to-tr from-cyan-500 to-indigo-600 flex items-center justify-center font-bold text-white shadow-md border-2 border-slate-900 hover:scale-105 transition"
                            >
                              {m.actor_icon ? (
                                <img
                                  src={m.actor_icon}
                                  alt={m.actor_name}
                                  className="w-full h-full object-cover"
                                  onError={(e) => {
                                    (e.target as HTMLElement).style.display = 'none';
                                  }}
                                />
                              ) : (
                                m.actor_name.slice(0, 1).toUpperCase()
                              )}
                            </button>
                          ))}
                          {members.length > 3 && (
                            <span
                              style={{ left: '42px' }}
                              className="absolute top-0 w-11 h-11 rounded-2xl bg-slate-800 border-2 border-slate-900 text-slate-300 text-xs font-bold flex items-center justify-center"
                            >
                              +{members.length - 3}
                            </span>
                          )}
                        </div>

                        <div className="flex-1 min-w-0 pr-6">
                          <div className="flex flex-wrap items-center gap-1.5 mb-1">
                            <span className="font-bold text-sm text-slate-200">
                              {members.length}人が{kindLabel}しました
                            </span>
                            <span className="text-[10px] text-slate-500">
                              （{members.map((m: any) => m.actor_name).slice(0, 3).join('、')}
                              {members.length > 3 ? ' ほか' : ''}）
                            </span>
                          </div>

                          {reactionSummary.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                              {reactionSummary.map(([emoji, count]) => (
                                <span key={emoji} className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-lg bg-slate-800 text-sm border border-slate-700">
                                  <span>{emoji}</span>
                                  <span className="text-[10px] text-slate-400">×{count}</span>
                                </span>
                              ))}
                            </div>
                          )}

                          {members[0].post_content && (
                            <div className="mt-1.5 px-3 py-1.5 rounded-xl bg-slate-950/40 border-l-2 border-indigo-500/50 text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                              「{members[0].post_content}」
                            </div>
                          )}

                          <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-slate-800/40 text-[10px] text-slate-500">
                            <span>{new Date(members[0].created_at).toLocaleString('ja-JP')}</span>
                            <div className="flex items-center space-x-3">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedNotifGroups((prev: any) => new Set<string>(prev).add(group.key));
                                }}
                                className="text-slate-400 hover:text-slate-200 hover:underline transition"
                              >
                                個別に表示
                              </button>
                              {anyUnread && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    members.filter((m: any) => m.is_read === 0).forEach((m: any) => handleMarkNotificationRead(m.id));
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
                    </div>
                  );
                }

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
                } else if (notif.type === 'report') {
                  typeIcon = <ShieldAlert className="w-4 h-4 text-rose-400" />;
                  typeBadgeBg = 'bg-rose-500/15 text-rose-300 border-rose-500/30';
                  typeLabel = '通報';
                } else if (notif.type === 'login') {
                  // 新しい端末からのログイン（content にユーザーエージェントが入る）
                  typeIcon = <KeyRound className="w-4 h-4 text-amber-400" />;
                  typeBadgeBg = 'bg-amber-500/15 text-amber-300 border-amber-500/30';
                  typeLabel = 'ログイン';
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
                          {notif.type === 'report' && (
                            <span className="text-rose-300">新しい通報が届きました: {notif.content}</span>
                          )}
                          {notif.type === 'login' && (
                            <span className="text-amber-300">
                              新しい端末からログインしました{notif.content ? `（${notif.content}）` : ''}
                            </span>
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
    </>
  );
}
