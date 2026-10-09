/**
 * 管理パネル ⑨ブロックしたサーバー（ドメイン単位で断る）。
 */
import { useEffect, useState } from 'react';
import { blockDomain, loadBlockedDomains, unblockDomain, type BlockedDomain } from '../../lib/adminOps';
import { relativeTime } from '../../lib/format';

export default function AdminBlocks() {
  const [blocks, setBlocks] = useState<BlockedDomain[]>([]);
  const [domain, setDomain] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  async function load() {
    setBlocks(await loadBlockedDomains());
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function add() {
    setErr('');
    setOk('');
    const problem = await blockDomain(domain.trim().toLowerCase(), reason.trim());
    if (problem) {
      setErr(problem);
      return;
    }
    setDomain('');
    setReason('');
    setOk('ブロックしました。');
    await load();
  }

  if (loading) return <div className="feed__state">読み込んでいます…</div>;

  return (
    <>
      <div className="set__hint">
        ブロックしたサーバーとは、フォローもノートのやりとりもできなくなります。
      </div>

      {blocks.length === 0 && <div className="feed__state">ブロックしているサーバーはありません。</div>}

      {blocks.map((row) => (
        <div className="set" key={row.domain}>
          <div className="set__body">
            <span className="set__label">{row.domain}</span>
            <p className="set__hint">
              {row.reason || '理由なし'}
              {row.created_at ? ` ・ ${relativeTime(row.created_at)}` : ''}
            </p>
          </div>
          <div className="set__control">
            <button
              type="button"
              className="btn btn--text"
              onClick={() =>
                void (async () => {
                  if (await unblockDomain(row.domain)) {
                    setOk(`${row.domain} のブロックを外しました。`);
                    await load();
                  } else {
                    setErr('外せませんでした。');
                  }
                })()
              }
            >
              解除
            </button>
          </div>
        </div>
      ))}

      <div className="set">
        <div className="set__body">
          <span className="set__label">サーバーをブロック</span>
          <div className="set__form">
            <input className="field" value={domain} placeholder="example.com" onChange={(e) => setDomain(e.target.value)} />
            <input className="field" value={reason} placeholder="理由（任意）" onChange={(e) => setReason(e.target.value)} />
            <button type="button" className="btn btn--quiet" disabled={!domain.trim()} onClick={() => void add()}>
              ブロック
            </button>
          </div>
        </div>
      </div>

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}
    </>
  );
}
