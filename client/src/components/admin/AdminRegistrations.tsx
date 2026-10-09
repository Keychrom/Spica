/**
 * 管理パネル ⑤登録の承認（承認制のときの申請を承認 / 拒否）。
 */
import { useEffect, useState } from 'react';
import {
  approveRegistration,
  loadRegistrationRequests,
  rejectRegistration,
  type RegistrationRequest,
} from '../../lib/admin';
import { relativeTime } from '../../lib/format';

export default function AdminRegistrations() {
  const [requests, setRequests] = useState<RegistrationRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  async function load() {
    setRequests(await loadRegistrationRequests());
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function act(id: string, approve: boolean) {
    setBusy(id);
    setErr('');
    const problem = approve ? await approveRegistration(id) : await rejectRegistration(id, reason);
    setBusy('');
    if (problem) {
      setErr(problem);
      return;
    }
    setReason('');
    await load();
  }

  if (loading) return <div className="feed__state">読み込んでいます…</div>;
  if (requests.length === 0) {
    return <div className="feed__state">承認待ちの申請はありません。</div>;
  }

  return (
    <>
      <div className="set__hint">承認すると、その人はすぐログインできるようになります。</div>
      {err && <p className="set__err">{err}</p>}
      {requests.map((request) => (
        <div className="set" key={request.id}>
          <div className="set__body">
            <span className="set__label">
              {request.name || request.user_id}（@{request.user_id}）
            </span>
            <p className="set__hint">
              {request.summary || 'ひとことなし'}
              {request.created_at ? ` ・ ${relativeTime(request.created_at)}` : ''}
            </p>
            {(request.note || request.message) && <p className="set__hint">「{request.note || request.message}」</p>}
          </div>
          <div className="set__control">
            <input
              className="field"
              style={{ width: 160, padding: '6px 10px', fontSize: 12 }}
              value={reason}
              placeholder="断る理由（任意）"
              onChange={(event) => setReason(event.target.value)}
            />
            <button type="button" className="btn btn--quiet" disabled={busy === request.id} onClick={() => void act(request.id, true)}>
              承認
            </button>
            <button type="button" className="btn btn--text" disabled={busy === request.id} onClick={() => void act(request.id, false)}>
              断る
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
