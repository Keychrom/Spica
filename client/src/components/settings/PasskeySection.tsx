/**
 * 設定 → 安全 → パスキー（指紋・顔・PIN でログイン）。
 * ※ 実機の認証器が要るため、動作確認はできていない（理論上動く形にはしてある）。
 */
import { useEffect, useState } from 'react';
import { loadPasskeys, registerPasskey, removePasskey, type Passkey } from '../../lib/webauthn';
import { relativeTime } from '../../lib/format';

export default function PasskeySection() {
  const [keys, setKeys] = useState<Passkey[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  async function load() {
    setKeys(await loadPasskeys());
  }

  useEffect(() => {
    void load();
  }, []);

  async function add() {
    setBusy(true);
    setErr('');
    setOk('');
    const problem = await registerPasskey(name.trim());
    setBusy(false);
    if (problem) {
      setErr(problem);
      return;
    }
    setName('');
    setOk('パスキーを登録しました。');
    await load();
  }

  async function remove(id: string) {
    if (!window.confirm('このパスキーを削除しますか？')) return;
    if (await removePasskey(id)) setKeys((current) => current.filter((key) => key.id !== id));
    else setErr('削除できませんでした。');
  }

  return (
    <>
      <div className="set__group">
        <h3>パスキー（指紋・顔・PIN でログイン）</h3>
        <p className="set__hint">
          この端末の指紋や顔でログインできるようにします。パスワードを覚えなくてもよくなります。
          <br />※ まだ動作確認ができていない機能です（端末の認証器が要るため）。
        </p>
      </div>

      {keys.map((key) => (
        <div className="set" key={key.id}>
          <div className="set__body">
            <span className="set__label">{key.device_name || 'パスキー'}</span>
            <p className="set__hint">
              {key.created_at ? `${relativeTime(key.created_at)}に登録` : ''}
              {key.last_used_at ? ` ・ 最後に使用: ${relativeTime(key.last_used_at)}` : ''}
            </p>
          </div>
          <div className="set__control">
            <button type="button" className="btn btn--text" onClick={() => void remove(key.id)}>
              削除
            </button>
          </div>
        </div>
      ))}

      <div className="set">
        <div className="set__body">
          <span className="set__label">この端末を登録する</span>
          <div className="extra__choice" style={{ marginTop: 8 }}>
            <input
              className="field"
              value={name}
              placeholder="端末の名前（例: iPhone）"
              onChange={(event) => setName(event.target.value)}
            />
            <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => void add()}>
              {busy ? '待っています…' : '登録する'}
            </button>
          </div>
        </div>
      </div>

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}
    </>
  );
}
