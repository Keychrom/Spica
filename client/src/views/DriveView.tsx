/**
 * ドライブ（アップロードしたメディアの一覧・容量・削除）。
 * ・投稿で使っているファイルはサーバーが削除を拒否する（画面にもその旨を出す）
 * ・アップロードは投稿画面から（この画面は一覧と削除だけ）
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import ScreenHead from '../components/ScreenHead';
import { api, messageOf } from '../lib/api';
import { navigate } from '../lib/router';
import { formatCount, relativeTime } from '../lib/format';

interface DriveItem {
  id: string;
  name?: string;
  url: string;
  /** サムネイル（動画・画像とも） */
  thumbnailUrl?: string;
  size?: number;
  duration?: number | null;
  /** MIME タイプ（image/png, video/mp4 …） */
  mediaType?: string;
  createdAt?: string;
  /** 投稿で使われているときだけ入る */
  postId?: string | null;
  postExcerpt?: string;
}

interface DriveStats {
  count?: number;
  bytes?: number;
  quotaBytes?: number;
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface DriveViewProps {
  menuButton: ReactNode;
  signedIn: boolean;
}

export default function DriveView({ menuButton, signedIn }: DriveViewProps) {
  const [items, setItems] = useState<DriveItem[]>([]);
  const [stats, setStats] = useState<DriveStats>({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    if (!signedIn) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const res = await api.get('/api/drive');
    if (res.ok && res.data && typeof res.data === 'object') {
      const data = res.data as { items?: DriveItem[]; stats?: DriveStats };
      setItems(data.items ?? []);
      setStats(data.stats ?? {});
      setMessage('');
    } else {
      setMessage(messageOf(res.data, 'ドライブを読み込めませんでした。'));
    }
    setLoading(false);
  }, [signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(item: DriveItem) {
    if (!window.confirm('このファイルを削除しますか？（投稿で使っているものは削除できません）')) return;
    const res = await api.del('/api/drive/' + encodeURIComponent(item.id));
    if (res.ok) {
      setItems((current) => current.filter((i) => i.id !== item.id));
      setStats((current) => ({
        ...current,
        count: (current.count ?? 1) - 1,
        bytes: Math.max(0, (current.bytes ?? 0) - (item.size ?? 0)),
      }));
    } else {
      setMessage(messageOf(res.data, '削除できませんでした（投稿で使われている可能性があります）。'));
    }
  }

  const quota = stats.quotaBytes ?? 0;
  const usedRatio = quota > 0 ? Math.min(100, ((stats.bytes ?? 0) / quota) * 100) : 0;

  return (
    <>
      <ScreenHead
        title="ドライブ"
        sub={
          !signedIn
            ? undefined
            : loading
              ? '読み込み中…'
              : `${formatCount(stats.count)}件 ・ ${formatBytes(stats.bytes)}${quota > 0 ? ' / ' + formatBytes(quota) : ''}`
        }
        menuButton={menuButton}
      />
      <div className="divider" />

      {!signedIn && (
        <div className="feed">
          <div className="feed__state">
            ドライブを見るにはログインしてください。
            <br />
            <button type="button" className="btn btn--text" onClick={() => navigate('/login')}>
              ログイン / 新規登録
            </button>
          </div>
        </div>
      )}

      {signedIn && (
        <div className="drive">
          {quota > 0 && (
            <div className="drive__gauge" title="使用量">
              <span className="drive__gauge-fill" style={{ width: `${usedRatio}%` }} />
            </div>
          )}

          {message && <p className="drive__message">{message}</p>}

          {loading && items.length === 0 && <div className="feed__state">読み込んでいます…</div>}
          {!loading && items.length === 0 && (
            <div className="feed__state">
              まだファイルがありません。
              <br />
              ノートに画像を添付すると、ここに残ります。
            </div>
          )}

          <div className="drive__grid">
            {items.map((item) => {
              const isVideo = Boolean(item.duration) || Boolean(item.mediaType?.startsWith('video')) || Boolean(item.mediaType?.startsWith('audio'));
              const inUse = Boolean(item.postId);
              return (
                <figure className="drive__item" key={item.id}>
                  <div className="drive__thumb">
                    {isVideo ? (
                      <span className="drive__play">▶</span>
                    ) : (
                      <img src={item.thumbnailUrl || item.url} alt={item.name || ''} loading="lazy" />
                    )}
                  </div>
                  <figcaption className="drive__meta">
                    <span className="drive__name" title={item.name}>
                      {item.name || 'ファイル'}
                    </span>
                    <span className="drive__sub">
                      {formatBytes(item.size)} ・ {relativeTime(item.createdAt)}
                    </span>
                    <span className="drive__actions">
                      <span className={`drive__used${inUse ? ' drive__used--on' : ''}`}>
                        {inUse ? '投稿で使用中' : '未使用'}
                      </span>
                      <button
                        type="button"
                        className="iconbtn"
                        onClick={() => void remove(item)}
                        disabled={inUse}
                        aria-label="削除"
                        title={inUse ? '投稿で使っているので削除できません' : '削除'}
                      >
                        <Trash2 size={16} strokeWidth={1.5} />
                      </button>
                    </span>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
