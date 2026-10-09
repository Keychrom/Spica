/**
 * 管理パネル ⑦リレー（ほかのサーバーの公開タイムラインをまとめて受け取る相手）。
 */
import { useEffect, useState } from 'react';
import { addRelay, loadRelays, removeRelay, resendRelay, setRelayStatus, type Relay } from '../../lib/adminOps';

export default function AdminRelays() {
  const [relays, setRelays] = useState<Relay[]>([]);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  async function load() {
    setRelays(await loadRelays());
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  function urlOf(relay: Relay): string {
    return relay.inbox_url || relay.url || relay.id || '';
  }

  const STATUS_LABEL: Record<string, string> = {
    accepted: '受け入れ中',
    pending: '承認待ち',
    rejected: '断られています',
  };

  async function run(work: () => Promise<string | null>, message: string, id = '*') {
    setBusy(id);
    setErr('');
    setOk('');
    const problem = await work();
    setBusy('');
    if (problem) {
      setErr(problem);
      return;
    }
    setOk(message);
    await load();
  }

  if (loading) return <div className="feed__state">読み込んでいます…</div>;

  return (
    <>
      <div className="set__hint">
        リレーを追加すると、そのサーバーの公開ノートがまとめて入ってきます。ふつうは必要ありません。
      </div>

      {relays.length === 0 && <div className="feed__state">リレーはまだありません。</div>}

      {relays.map((relay) => {
        const target = urlOf(relay);
        const accepted = relay.status === 'accepted';
        return (
          <div className="set" key={target}>
            <div className="set__body">
              <span className="set__label" style={{ wordBreak: 'break-all' }}>{target}</span>
              <p className="set__hint">{STATUS_LABEL[relay.status || ''] || relay.status || '確認中'}</p>
            </div>
            <div className="set__control">
              <button
                type="button"
                className="btn btn--quiet"
                disabled={busy === target}
                onClick={() => void run(() => setRelayStatus(target, accepted ? 'rejected' : 'accepted'), '状態を変えました。', target)}
              >
                {accepted ? '止める' : '受け入れる'}
              </button>
              <button
                type="button"
                className="btn btn--text"
                disabled={busy === target}
                onClick={() => void run(() => resendRelay(target), 'フォローを送り直しました。', target)}
              >
                再送
              </button>
              <button
                type="button"
                className="btn btn--text"
                disabled={busy === target}
                onClick={() => {
                  if (!window.confirm('このリレーを外しますか？')) return;
                  void run(() => removeRelay(target), 'リレーを外しました。', target);
                }}
              >
                削除
              </button>
            </div>
          </div>
        );
      })}

      <div className="set">
        <div className="set__body">
          <span className="set__label">リレーを追加</span>
          <div className="set__form">
            <input
              className="field"
              value={url}
              placeholder="https://relay.example.com/inbox"
              onChange={(event) => setUrl(event.target.value)}
            />
            <button
              type="button"
              className="btn btn--quiet"
              disabled={!url.trim() || busy === '*'}
              onClick={() => void run(() => addRelay(url.trim()), 'リレーを追加しました。')}
            >
              追加
            </button>
          </div>
        </div>
      </div>

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}
    </>
  );
}
