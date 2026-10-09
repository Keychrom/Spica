/**
 * 通知（一覧・絞り込み・まとめ表示・既読）。
 * まとめの計算は lib/notifications.ts（純関数）、ここは表示と操作だけ。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Bell, Heart, Repeat2, UserPlus } from 'lucide-react';
import ScreenHead from '../components/ScreenHead';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { postPath } from '../lib/permalink';
import { formatCount, relativeTime } from '../lib/format';
import {
  groupNotifications,
  isUnread,
  notificationAction,
  notificationGroupAction,
  notificationHeadline,
  type AppNotification,
} from '../lib/notifications';

const FILTERS = [
  { value: 'all', label: 'すべて' },
  { value: 'mention', label: 'メンション' },
  { value: 'reaction', label: 'リアクション' },
  { value: 'follow', label: 'フォロー' },
];

function iconFor(type: string): ReactNode {
  if (type === 'reaction') return <Heart size={16} strokeWidth={1.6} />;
  if (type === 'announce' || type === 'renote') return <Repeat2 size={16} strokeWidth={1.6} />;
  if (type === 'follow') return <UserPlus size={16} strokeWidth={1.6} />;
  return <Bell size={16} strokeWidth={1.6} />;
}

interface NotificationsViewProps {
  menuButton: ReactNode;
  signedIn: boolean;
  /** 既読にしたあと、未読バッジを更新してもらう */
  onRead: () => void;
  onOpenProfile: (userId: string) => void;
}

export default function NotificationsView({ menuButton, signedIn, onRead, onOpenProfile }: NotificationsViewProps) {
  const [filter, setFilter] = useState('all');
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (target: string) => {
    if (!signedIn) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const query = target === 'all' ? '' : '?filter=' + encodeURIComponent(target);
    const res = await api.get('/api/notifications' + query);
    if (res.ok && Array.isArray(res.data)) setItems(res.data as AppNotification[]);
    setLoading(false);
  }, [signedIn]);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  async function markAllRead() {
    await api.post('/api/notifications/read-all');
    setItems((current) => current.map((n) => ({ ...n, is_read: true })));
    onRead();
  }

  async function open(notification: AppNotification) {
    if (isUnread(notification)) {
      await api.post('/api/notifications/' + encodeURIComponent(notification.id) + '/read');
      setItems((current) =>
        current.map((n) => (n.id === notification.id ? { ...n, is_read: true } : n)),
      );
      onRead();
    }
    if (notification.post_id) {
      // ローカルは `/users/<user>/posts/<id>`、リモートは `/?post=<正規 ID>` へ送る
      navigate(postPath({ id: notification.post_id }));
      return;
    }
    if (notification.actor_id) onOpenProfile(notification.actor_id);
  }

  const groups = groupNotifications(items);
  const unreadCount = items.filter(isUnread).length;

  return (
    <>
      <ScreenHead
        title="通知"
        sub={loading ? '読み込み中…' : unreadCount > 0 ? `未読 ${unreadCount}` : 'すべて既読'}
        tabs={FILTERS}
        activeTab={filter}
        onTab={setFilter}
        right={
          unreadCount > 0 ? (
            <button type="button" className="btn btn--text" onClick={() => void markAllRead()}>
              すべて既読にする
            </button>
          ) : undefined
        }
        menuButton={menuButton}
      />
      <div className="divider" />

      <div className="feed">
        {!signedIn && (
          <div className="feed__state">
            通知を見るにはログインしてください。
            <br />
            <button type="button" className="btn btn--text" onClick={() => navigate('/login')}>
              ログイン / 新規登録
            </button>
          </div>
        )}
        {signedIn && loading && items.length === 0 && <div className="feed__state">読み込んでいます…</div>}
        {signedIn && !loading && groups.length === 0 && (
          <div className="feed__state">通知はまだありません。</div>
        )}

        {groups.map((group) => {
          const first = group.items[0];
          const multi = group.items.length > 1;
          const unread = group.items.some(isUnread);
          const headline = notificationHeadline(first);
          const reactionSummary = new Map<string, number>();
          if (first.type === 'reaction') {
            for (const item of group.items) {
              const key = item.content || '⭐';
              reactionSummary.set(key, (reactionSummary.get(key) || 0) + 1);
            }
          }
          return (
            <article key={group.key} className={`notif${unread ? ' notif--unread' : ''}`}>
              <span className="notif__ico">{iconFor(first.type)}</span>
              <div className="notif__body">
                <button type="button" className="notif__main" onClick={() => void open(first)}>
                  <span className="notif__text">
                    {multi
                      ? notificationGroupAction(first.type, group.items.length)
                      : headline || (
                          <>
                            <b>{first.actor_name}</b> {notificationAction(first.type)}
                          </>
                        )}
                  </span>
                  {!multi && (first.type === 'login' || first.type === 'reply' || first.type === 'mention') && first.content && (
                    <span className="notif__quote">{first.content}</span>
                  )}
                  {!multi && first.type === 'reaction' && first.content && (
                    <span className="notif__reaction">{first.content}</span>
                  )}
                </button>

                {multi && (
                  <div className="notif__faces">
                    {group.items.slice(0, 4).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="av av--s"
                        title={item.actor_name}
                        onClick={() => item.actor_id && onOpenProfile(item.actor_id)}
                      >
                        {item.actor_icon ? <img src={item.actor_icon} alt="" /> : (item.actor_name || '?').slice(0, 1)}
                      </button>
                    ))}
                    {first.type === 'reaction' && (
                      <span className="notif__summary">
                        {Array.from(reactionSummary.entries())
                          .map(([emoji, count]) => `${emoji} ${formatCount(count)}`)
                          .join(' ・ ')}
                      </span>
                    )}
                  </div>
                )}

                {first.post_content && (
                  <button type="button" className="notif__post" onClick={() => void open(first)}>
                    {first.post_content.slice(0, 120)}
                  </button>
                )}
                <span className="notif__time">{relativeTime(first.created_at)}</span>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
