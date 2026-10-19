/**
 * 設定 → アカウント → API キー（Misskey 互換クライアント用）。
 *
 * MiAuth の承認画面を通さずに、自分の設定からトークンを発行する。
 * 権限は MiAuth と同じスコープで、選んだ範囲だけが許可される。
 * トークンは発行時に一度だけ表示し、一覧・失効はこの節で行う。
 */
import { useEffect, useState } from 'react';
import { APP_SCOPE_LABELS, scopeLabels } from '../../lib/appScopes';
import {
  createApiKey,
  loadApiKeys,
  revokeApiKey,
  type ApiKey,
} from '../../lib/apiKeys';
import { relativeTime } from '../../lib/format';

/** `legacy` は新規発行しない（旧トークンの表示用） */
const SELECTABLE_SCOPES = Object.keys(APP_SCOPE_LABELS).filter((scope) => scope !== 'legacy');

function expiryLabel(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日まで`;
}

export default function ApiKeySection() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [createdToken, setCreatedToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [copied, setCopied] = useState(false);

  async function reload() {
    setKeys(await loadApiKeys());
  }

  useEffect(() => {
    void reload();
  }, []);

  function toggleScope(scope: string) {
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setErr('');
    setOk('');
    setCopied(false);
    const result = await createApiKey(name.trim(), scopes);
    setBusy(false);
    if (result.error) {
      setErr(result.error);
      return;
    }
    setCreatedToken(result.token || '');
    setName('');
    await reload();
    setOk('API キーを発行しました。トークンはこの画面に一度だけ表示されます。');
  }

  async function revoke(key: ApiKey) {
    if (!window.confirm(`「${key.name}」を失効させます。このキーを使っているアプリはログインできなくなります。`)) {
      return;
    }
    setErr('');
    if (!(await revokeApiKey(key.id))) {
      setErr('失効できませんでした。');
      return;
    }
    setKeys((current) => current.filter((k) => k.id !== key.id));
    if (createdToken) setCreatedToken('');
    setOk('API キーを失効させました。');
  }

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopied(true);
    } catch {
      setErr('コピーできませんでした。表示されているトークンを選択して控えてください。');
    }
  }

  return (
    <>
      <div className="set__group">
        <h3>API キー（Misskey 互換）</h3>
        <p className="set__hint">
          Misskey 互換クライアントの「アクセストークン（i）」に貼り付けて使います。
          選んだ権限の範囲でだけ動き、不要になったらこの画面から失効できます。
          有効期限は発行から 1 年です。MiAuth で承認したアプリは「ログインしている端末」に表示されます。
        </p>
      </div>

      {createdToken && (
        <div className="set">
          <div className="set__body">
            <span className="set__label">発行したトークン（この画面でだけ表示）</span>
            <div className="extra__choice" style={{ marginTop: 8 }}>
              <input
                className="field"
                value={createdToken}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
              <button type="button" className="btn btn--quiet" onClick={() => void copyToken()}>
                {copied ? 'コピーしました' : 'コピー'}
              </button>
            </div>
            <p className="set__hint">
              パスワードと同じ扱いにしてください。この画面を離れると二度と表示されません。
            </p>
          </div>
        </div>
      )}

      {keys.length > 0 && (
        <>
          <div className="set__group">
            <h3>発行済みの API キー</h3>
          </div>
          {keys.map((key) => (
            <div className="set" key={key.id}>
              <div className="set__body">
                <span className="set__label">{key.name}</span>
                <p className="set__hint">
                  {key.created_at ? `${relativeTime(key.created_at)} に発行` : ''}
                  {key.expires_at ? ` ／ ${expiryLabel(key.expires_at)}` : ''}
                </p>
                <p className="set__hint">権限: {scopeLabels(key.scopes).join('、') || 'なし'}</p>
              </div>
              <div className="set__control">
                <button type="button" className="btn btn--text" onClick={() => void revoke(key)}>
                  失効
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      <div className="set">
        <div className="set__body">
          <span className="set__label">新しい API キー</span>
          <input
            className="field"
            value={name}
            placeholder="名前（例: Misskey クライアント）"
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
          />
          <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
            {SELECTABLE_SCOPES.map((scope) => (
              <label className="extra__choice" key={scope}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                />
                <span className="set__hint">{APP_SCOPE_LABELS[scope]}</span>
              </label>
            ))}
          </div>
          <div className="extra__choice" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn btn--quiet"
              disabled={busy || !name.trim() || scopes.length === 0}
              onClick={() => void create()}
            >
              {busy ? '発行しています…' : 'API キーを発行'}
            </button>
          </div>
        </div>
      </div>

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}
    </>
  );
}
