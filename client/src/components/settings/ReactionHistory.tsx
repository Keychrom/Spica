/**
 * 設定 → データ → リアクションの履歴（自分が付けたもの）。
 * 数が多いので「もっと見る」で増やす（サーバーの上限は 100 件）。
 */
import { useEffect, useState } from 'react';
import { loadMyReactions, type MyReaction } from '../../lib/me';
import { relativeTime } from '../../lib/format';
import { navigate } from '../../lib/router';
import { postPath } from '../../lib/permalink';

export default function ReactionHistory() {
  const [rows, setRows] = useState<MyReaction[]>([]);
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setRows(await loadMyReactions(limit));
      setLoading(false);
    })();
  }, [limit]);

  return (
    <>
      <div className="set__group">
        <h3>リアクションの履歴</h3>
      </div>

      {loading && rows.length === 0 && <div className="feed__state">読み込んでいます…</div>}
      {!loading && rows.length === 0 && <div className="feed__state">まだリアクションは付けていません。</div>}

      {rows.map((row) => {
        const post = row.post;
        const excerpt = (post?.cw || post?.content || '').replace(/\s+/g, ' ').trim();
        const target = post ? postPath(post) : '';
        return (
          <div className="set" key={row.id}>
            <div className="set__body">
              <span className="set__label">
                {row.reaction}{' '}
                <button type="button" className="btn btn--text" onClick={() => target && navigate(target)}>
                  {excerpt.length > 50 ? excerpt.slice(0, 50) + '…' : excerpt || '（本文なし）'}
                </button>
              </span>
              <p className="set__hint">
                {/* author_handle は @ 付きで返る（PostCard と同じ出し方にする） */}
                {post?.author_handle || '@' + (post?.author_name || '不明')}
                {row.created_at ? ` ・ ${relativeTime(row.created_at)}` : ''}
              </p>
            </div>
          </div>
        );
      })}

      {rows.length >= limit && limit < 100 && (
        <div className="set">
          <div className="set__body" />
          <div className="set__control">
            <button type="button" className="btn btn--text" disabled={loading} onClick={() => setLimit(limit + 40)}>
              {loading ? '読み込んでいます…' : 'もっと見る'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
