/**
 * 下書きと予約投稿（/drafts）。
 * 「まだ出していないノート」を 1 つの画面で見る（下書き / 予約 のタブ）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import ScreenHead from '../components/ScreenHead';
import { navigate } from '../lib/router';
import { relativeTime } from '../lib/format';
import {
  cancelScheduled,
  deleteDraft,
  loadDrafts,
  loadScheduled,
  type DraftedPost,
} from '../lib/drafts';

type Kind = 'drafts' | 'scheduled';

const TABS = [
  { value: 'drafts', label: '下書き' },
  { value: 'scheduled', label: '予約投稿' },
];

interface DraftsViewProps {
  menuButton: ReactNode;
  signedIn: boolean;
  /** 下書きを続きから書く（コンポーザを開く） */
  onResume: (draft: DraftedPost) => void;
}

function preview(post: DraftedPost): string {
  const text = (post.content || '').trim();
  if (text) return text.length > 120 ? text.slice(0, 120) + '…' : text;
  return '（本文なし）';
}

export default function DraftsView({ menuButton, signedIn, onResume }: DraftsViewProps) {
  const [tab, setTab] = useState<Kind>('drafts');
  const [items, setItems] = useState<DraftedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(
    async (kind: Kind) => {
      if (!signedIn) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setErr('');
      const list = kind === 'drafts' ? await loadDrafts() : await loadScheduled();
      setItems(list);
      setLoading(false);
    },
    [signedIn],
  );

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  async function remove(post: DraftedPost) {
    const ok = tab === 'drafts' ? await deleteDraft(post.id) : await cancelScheduled(post.id);
    if (!ok) {
      setErr('消せませんでした。');
      return;
    }
    setItems((current) => current.filter((item) => item.id !== post.id));
  }

  if (!signedIn) {
    return (
      <>
        <ScreenHead title="下書きと予約" menuButton={menuButton} />
        <div className="divider" />
        <div className="feed">
          <div className="feed__state">
            下書きと予約投稿を見るにはログインしてください。
            <br />
            <button type="button" className="btn btn--text" onClick={() => navigate('/login')}>
              ログイン / 新規登録
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <ScreenHead
        title="下書きと予約"
        sub={loading ? '読み込み中…' : `${items.length}件`}
        menuButton={menuButton}
        onReload={() => void load(tab)}
        reloading={loading}
      />
      <div className="headrow">
        <div className="seg">
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={'seg__t' + (tab === item.value ? ' seg__t--on' : '')}
              onClick={() => setTab(item.value as Kind)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="divider" />

      <div className="feed">
        {loading && items.length === 0 && <div className="feed__state">読み込んでいます…</div>}
        {!loading && items.length === 0 && (
          <div className="feed__state">
            {tab === 'drafts'
              ? '下書きはまだありません。ノートを作成の「下書き」から保存できます。'
              : '予約した投稿はまだありません。ノートを作成の「予約」から予約できます。'}
          </div>
        )}
        {err && <p className="set__err">{err}</p>}

        {items.map((post) => (
          <div className="people" key={post.id}>
            <div className="people__body">
              <b>{preview(post)}</b>
              <span>
                {tab === 'scheduled' && post.scheduled_at
                  ? `${relativeTime(post.scheduled_at)}に投稿`
                  : `${relativeTime(post.updated_at || post.created_at)}に保存`}
                {post.status === 'failed' && post.error_message ? ` ・ 失敗: ${post.error_message}` : ''}
              </span>
            </div>
            {tab === 'drafts' && (
              <button type="button" className="btn btn--outline" onClick={() => onResume(post)}>
                続きを書く
              </button>
            )}
            <button type="button" className="btn btn--text" onClick={() => void remove(post)}>
              {tab === 'drafts' ? '削除' : '取り消す'}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
