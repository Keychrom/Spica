/**
 * 設定 → つながり → ドメインミュート（そのサーバーのノートを隠す）。
 * 実際に隠すのはサーバー側（タイムラインを組み立てるときに外す）。
 */
import { useEffect, useState } from 'react';
import { loadPrefs } from '../../lib/settings';
import { updatePrefs } from '../../lib/prefs';

export default function DomainMutes() {
  const [domains, setDomains] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    void (async () => {
      const prefs = await loadPrefs();
      const list = prefs?.mutedDomains;
      setDomains(Array.isArray(list) ? (list as string[]) : []);
      setLoading(false);
    })();
  }, []);

  async function save(next: string[]) {
    setErr('');
    await updatePrefs({ mutedDomains: next });
    setDomains(next);
  }

  function add() {
    const domain = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain) return;
    if (domains.includes(domain)) {
      setErr('もう入っています。');
      return;
    }
    setInput('');
    void save([...domains, domain]);
  }

  if (loading) return null;

  return (
    <>
      <div className="set__group">
        <h3>ドメインミュート（{domains.length}）</h3>
        <p className="set__hint">そのサーバーからのノートを、タイムラインに出しません。</p>
      </div>

      {domains.length === 0 && <div className="feed__state">ミュートしているサーバーはありません。</div>}

      {domains.map((domain) => (
        <div className="set" key={domain}>
          <div className="set__body">
            <span className="set__label">{domain}</span>
          </div>
          <div className="set__control">
            <button type="button" className="btn btn--text" onClick={() => void save(domains.filter((item) => item !== domain))}>
              外す
            </button>
          </div>
        </div>
      ))}

      <div className="set">
        <div className="set__body">
          <span className="set__label">サーバーを足す</span>
          <div className="set__form">
            <input
              className="field"
              value={input}
              placeholder="example.com"
              onChange={(event) => setInput(event.target.value)}
            />
            <button type="button" className="btn btn--quiet" disabled={!input.trim()} onClick={add}>
              足す
            </button>
          </div>
          {err && <p className="set__err">{err}</p>}
        </div>
      </div>
    </>
  );
}
