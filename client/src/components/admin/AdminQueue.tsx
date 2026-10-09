/**
 * 管理パネル ⑪配信キュー（ほかのサーバーへの配送のようす）。
 */
import { useEffect, useState } from 'react';
import { clearFailedDeliveries, loadDeliveryQueue, retryDeliveries, type DeliveryQueue } from '../../lib/adminOps';
import { relativeTime } from '../../lib/format';

function shortUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export default function AdminQueue() {
  const [queue, setQueue] = useState<DeliveryQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  async function load() {
    setQueue(await loadDeliveryQueue());
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function run(kind: 'retry' | 'clear') {
    setBusy(kind);
    setMessage('');
    const result = kind === 'retry' ? await retryDeliveries() : await clearFailedDeliveries();
    setBusy('');
    setMessage(result.message);
    setFailed(!result.ok);
    await load();
  }

  if (loading) return <div className="feed__state">読み込んでいます…</div>;

  const stats = queue?.stats ?? {};
  const rows: [string, string][] = [
    ['届くのを待っている', String(stats.pending ?? 0)],
    ['いま送信中', String(stats.delivering ?? 0)],
    ['届いた', String(stats.delivered ?? 0)],
    ['あきらめた', String(stats.failed ?? 0)],
    ['次に試す', stats.nextAttemptAt ? relativeTime(stats.nextAttemptAt) : '—'],
    ['いちばん古い待ち', stats.oldestPendingAt ? relativeTime(stats.oldestPendingAt) : '—'],
  ];

  return (
    <>
      <div className="set__hint">
        ほかのサーバーへ送るノートやリアクションは、いちどここに並べて順番に送ります。失敗しても何度か自動で試します。
      </div>

      {rows.map(([label, value]) => (
        <div className="set" key={label}>
          <div className="set__body">
            <span className="set__label">{label}</span>
          </div>
          <div className="set__control">
            <span className="set__value">{value}</span>
          </div>
        </div>
      ))}

      <div className="set">
        <div className="set__body" />
        <div className="set__control set__actions">
          <button type="button" className="btn btn--quiet" disabled={Boolean(busy)} onClick={() => void run('retry')}>
            {busy === 'retry' ? '送っています…' : '待っている分をいま送る'}
          </button>
          <button type="button" className="btn btn--text" disabled={Boolean(busy)} onClick={() => void run('clear')}>
            {busy === 'clear' ? '消しています…' : 'あきらめた分を消す'}
          </button>
        </div>
      </div>
      {message && <p className={failed ? 'set__err' : 'set__ok'}>{message}</p>}

      <div className="set__group">
        <h3>待っているもの</h3>
      </div>
      {(queue?.pending || []).length === 0 && <div className="feed__state">待っているものはありません。</div>}
      {(queue?.pending || []).map((row) => (
        <div className="set" key={row.id}>
          <div className="set__body">
            <span className="set__label">{shortUrl(row.inbox_url)}</span>
            <p className="set__hint">
              {row.activity_type || '配送'} ・ {row.attempts ?? 0} 回試した ・{' '}
              {row.next_attempt_at ? `${relativeTime(row.next_attempt_at)}に再挑戦` : 'まもなく'}
            </p>
          </div>
        </div>
      ))}

      <div className="set__group">
        <h3>最近あきらめたもの</h3>
      </div>
      {(queue?.recentFailures || []).length === 0 && <div className="feed__state">あきらめたものはありません。</div>}
      {(queue?.recentFailures || []).map((row) => (
        <div className="set" key={row.id}>
          <div className="set__body">
            <span className="set__label">{shortUrl(row.inbox_url)}</span>
            <p className="set__hint">
              {row.last_error || row.last_status || '理由は不明'} ・ {row.attempts ?? 0} 回試した
              {row.updated_at ? ` ・ ${relativeTime(row.updated_at)}` : ''}
            </p>
          </div>
        </div>
      ))}
    </>
  );
}
