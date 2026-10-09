/**
 * 管理パネル ③通報（対応する / 対応しない / 保留に戻す）。
 */
import { useEffect, useState } from 'react';
import { loadReports, resolveReport, type AdminReport } from '../../lib/admin';
import { relativeTime } from '../../lib/format';

const REASON: Record<string, string> = {
  spam: 'スパム',
  abuse: '嫌がらせ・誹謗中傷',
  sensitive: '不適切な内容',
  impersonation: 'なりすまし',
  other: 'その他',
};

const STATUS: Record<string, string> = {
  open: '未対応',
  resolved: '対応済み',
  rejected: '対応しない',
};

export default function AdminReports() {
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  async function load() {
    const data = await loadReports();
    setReports(data.reports);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function act(report: AdminReport, action: 'resolve' | 'reject' | 'reopen') {
    setBusy(report.id);
    setErr('');
    const problem = await resolveReport(report.id, action);
    setBusy('');
    if (problem) {
      setErr(problem);
      return;
    }
    await load();
  }

  if (loading) return <div className="feed__state">読み込んでいます…</div>;

  const shown = filter === 'open' ? reports.filter((row) => (row.status || 'open') === 'open') : reports;

  return (
    <>
      <div className="headrow">
        <div className="seg">
          <button
            type="button"
            className={'seg__t' + (filter === 'open' ? ' seg__t--on' : '')}
            onClick={() => setFilter('open')}
          >
            未対応（{reports.filter((row) => (row.status || 'open') === 'open').length}）
          </button>
          <button
            type="button"
            className={'seg__t' + (filter === 'all' ? ' seg__t--on' : '')}
            onClick={() => setFilter('all')}
          >
            すべて（{reports.length}）
          </button>
        </div>
      </div>
      <div className="divider" />

      {err && <p className="set__err">{err}</p>}
      {shown.length === 0 && <div className="feed__state">通報はありません。</div>}

      {shown.map((report) => (
        <div className="set" key={report.id}>
          <div className="set__body">
            <span className="set__label">
              {report.target_post_preview ? report.target_post_preview.slice(0, 70) : report.target_handle || report.target_user_id}
            </span>
            <p className="set__hint">
              {report.reporter_handle || report.reporter_user_id} さんから ・{' '}
              {REASON[report.category || 'other'] || report.category} ・ {STATUS[report.status || 'open']}
              {report.created_at ? ` ・ ${relativeTime(report.created_at)}` : ''}
            </p>
            {report.comment && <p className="set__hint">「{report.comment}」</p>}
          </div>
          <div className="set__control">
            {(report.status || 'open') === 'open' ? (
              <>
                <button
                  type="button"
                  className="btn btn--quiet"
                  disabled={busy === report.id}
                  onClick={() => void act(report, 'resolve')}
                >
                  対応した
                </button>
                <button
                  type="button"
                  className="btn btn--text"
                  disabled={busy === report.id}
                  onClick={() => void act(report, 'reject')}
                >
                  対応しない
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn--text"
                disabled={busy === report.id}
                onClick={() => void act(report, 'reopen')}
              >
                未対応に戻す
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
