/**
 * 管理パネル ①概要（サーバーの数字・連合の様子・最近の運営操作）。
 */
import { useEffect, useState } from 'react';
import { formatCount, relativeTime } from '../../lib/format';
import { loadAudit, loadFederation, loadStats, type AdminFederation, type AdminStats, type AuditAction } from '../../lib/admin';
import { pruneAudit } from '../../lib/adminOps';

export default function AdminOverview() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [federation, setFederation] = useState<AdminFederation>({});
  const [audit, setAudit] = useState<AuditAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [pruneNote, setPruneNote] = useState('');

  useEffect(() => {
    void (async () => {
      const [nextStats, nextFederation, nextAudit] = await Promise.all([
        loadStats(),
        loadFederation(),
        loadAudit(),
      ]);
      setStats(nextStats);
      setFederation(nextFederation);
      setAudit(nextAudit.slice(0, 8));
      setLoading(false);
    })();
  }, []);

  if (loading) return <div className="feed__state">読み込んでいます…</div>;

  const numbers = stats?.stats ?? {};

  return (
    <>
      <div className="set__group">
        <h3>このサーバー</h3>
      </div>
      {[
        ['利用者', numbers.users],
        ['ローカルのノート', numbers.localPosts],
        ['連合から受信', numbers.federatedPosts ?? numbers.remotePosts],
        ['管理者', numbers.admins],
        ['承認待ちの登録', numbers.pendingRegistrations],
      ].map(([label, value]) => (
        <div className="set" key={String(label)}>
          <div className="set__body">
            <span className="set__label">{label}</span>
          </div>
          <div className="set__control">
            <span className="set__value">{formatCount(Number(value ?? 0))}</span>
          </div>
        </div>
      ))}

      <div className="set__group">
        <h3>連合（ほかのサーバー）</h3>
      </div>
      {(federation.domainStats || []).length === 0 && (
        <div className="feed__state">まだほかのサーバーとはつながっていません。</div>
      )}
      {(federation.domainStats || []).slice(0, 8).map((row) => (
        <div className="set" key={row.domain}>
          <div className="set__body">
            <span className="set__label">{row.domain}</span>
            <p className="set__hint">受け取ったノート {formatCount(row.posts ?? 0)} 件</p>
          </div>
          <div className="set__control">
            <span className="set__value">{formatCount(row.actors ?? 0)} 人</span>
          </div>
        </div>
      ))}

      <div className="set__group">
        <h3>最近の運営の操作</h3>
      </div>
      {audit.length === 0 && <div className="feed__state">まだ記録はありません。</div>}
      {audit.map((row) => (
        <div className="set" key={row.id}>
          <div className="set__body">
            <span className="set__label">{row.label || row.action}</span>
            <p className="set__hint">
              @{row.actor_id} ・ {row.method} {row.path}
              {row.target_id ? ` ・ ${row.target_id}` : ''}
              {row.created_at ? ` ・ ${relativeTime(row.created_at)}` : ''}
            </p>
          </div>
        </div>
      ))}

      <div className="set">
        <div className="set__body">
          <span className="set__label">古い記録を消す</span>
          <p className="set__hint">180 日より前の運営の記録を消します（消した件数は記録に残ります）。</p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className="btn btn--text"
            onClick={() => {
              if (!window.confirm('180 日より前の記録を消しますか？')) return;
              void (async () => {
                const result = await pruneAudit(180);
                setPruneNote(result.message);
                if (result.ok) {
                  setAudit(await loadAudit());
                }
              })();
            }}
          >
            消す
          </button>
        </div>
      </div>
      {pruneNote && <p className="set__ok">{pruneNote}</p>}
    </>
  );
}
