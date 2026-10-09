/**
 * 設定 → 安全 → 自分が送った通報（あとから経過を確認できる）。
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { relativeTime } from '../../lib/format';

interface Report {
  id: string;
  targetActorUrl?: string;
  target_actor_url?: string;
  targetHandle?: string;
  target_handle?: string;
  targetPostContent?: string;
  target_post_content?: string;
  category?: string;
  comment?: string;
  status?: string;
  created_at?: string;
  resolution_note?: string;
}

const STATUS: Record<string, string> = {
  open: '受け付けました',
  pending: '確認中',
  resolved: '対応済み',
  rejected: '対応しませんでした',
};

const REASON: Record<string, string> = {
  spam: 'スパム',
  abuse: '嫌がらせ・誹謗中傷',
  sensitive: '不適切な内容',
  impersonation: 'なりすまし',
  other: 'その他',
};

export default function ReportHistory() {
  const [rows, setRows] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const res = await api.get('/api/reports/mine');
      if (res.ok && Array.isArray(res.data)) setRows(res.data as Report[]);
      setLoading(false);
    })();
  }, []);

  return (
    <>
      <div className="set__group">
        <h3>自分が送った通報（{rows.length}）</h3>
        <p className="set__hint">送った通報のその後です。運営が見て、対応したかどうかが分かります。</p>
      </div>
      {loading && <div className="feed__state">読み込んでいます…</div>}
      {!loading && rows.length === 0 && (
        <div className="feed__state">まだ通報はありません。</div>
      )}
      {rows.map((row) => {
        const handle = row.targetHandle || row.target_handle || '';
        const actor = row.targetActorUrl || row.target_actor_url || '';
        const post = row.targetPostContent || row.target_post_content || '';
        return (
          <div className="set" key={row.id}>
            <div className="set__body">
              <span className="set__label">
                {post ? (post.length > 60 ? post.slice(0, 60) + '…' : post) : handle || actor}
              </span>
              <p className="set__hint">
                {REASON[row.category || 'other'] || row.category}
                {row.comment ? ` ・ ${row.comment}` : ''}
                {` ・ ${STATUS[row.status || 'open'] || row.status}`}
                {row.created_at ? ` ・ ${relativeTime(row.created_at)}` : ''}
              </p>
              {row.resolution_note && <p className="set__hint">運営から: {row.resolution_note}</p>}
            </div>
          </div>
        );
      })}
    </>
  );
}
