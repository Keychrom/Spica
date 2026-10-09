/**
 * 設定 → 安全 → 2段階認証（TOTP）。
 * 設定する → 認証アプリに登録 → 6 けたを入れて有効化 → リカバリーコードを控える。
 */
import { useEffect, useState } from 'react';
import KeyBox from '../KeyBox';
import { api, messageOf } from '../../lib/api';

interface TotpState {
  enabled: boolean;
  remainingCodes: number;
}

export default function TotpSection() {
  const [totp, setTotp] = useState<TotpState | null>(null);
  const [secret, setSecret] = useState('');
  const [uri, setUri] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  async function load() {
    const res = await api.get('/api/me/totp');
    if (res.ok && res.data) setTotp(res.data as TotpState);
  }

  useEffect(() => {
    void load();
  }, []);

  function flash(message: string) {
    setOk(message);
    setErr('');
  }

  async function startSetup() {
    setBusy(true);
    setErr('');
    setRecovery([]);
    const res = await api.post('/api/me/totp/setup');
    setBusy(false);
    if (!res.ok) {
      setErr(messageOf(res.data, '設定を始められませんでした。'));
      return;
    }
    const data = res.data as { secret?: string; otpauth_uri?: string };
    setSecret(data.secret || '');
    setUri(data.otpauth_uri || '');
  }

  async function enable() {
    setBusy(true);
    setErr('');
    const res = await api.post('/api/me/totp/enable', { code: code.trim() });
    setBusy(false);
    if (!res.ok) {
      setErr(messageOf(res.data, 'コードが違うようです。'));
      return;
    }
    const data = res.data as { recovery_codes?: string[] };
    setRecovery(data.recovery_codes || []);
    setCode('');
    setSecret('');
    setUri('');
    await load();
    flash('2段階認証を有効にしました。');
  }

  async function disable() {
    setBusy(true);
    setErr('');
    const res = await api.post('/api/me/totp/disable', { code: code.trim() });
    setBusy(false);
    if (!res.ok) {
      setErr(messageOf(res.data, 'コードが違うようです。'));
      return;
    }
    setCode('');
    setRecovery([]);
    await load();
    flash('2段階認証を無効にしました。');
  }

  async function remakeRecovery() {
    setBusy(true);
    setErr('');
    const res = await api.post('/api/me/totp/recovery-codes', { code: code.trim() });
    setBusy(false);
    if (!res.ok) {
      setErr(messageOf(res.data, '作り直せませんでした。'));
      return;
    }
    const data = res.data as { recovery_codes?: string[] };
    setRecovery(data.recovery_codes || []);
    setCode('');
    await load();
    flash('リカバリーコードを作り直しました（古いものは無効です）。');
  }

  return (
    <>
      <div className="set__group">
        <h3>2段階認証</h3>
        <p className="set__hint">
          スマホの認証アプリ（Google Authenticator など）の 6 けたの数字を、ログイン時にも求めます。
          マスターキーを盗まれても、これがあれば入られません。
        </p>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">
            {totp?.enabled ? '有効' : '無効'}
            {totp?.enabled && totp.remainingCodes > 0 ? `（リカバリーコード 残り ${totp.remainingCodes}）` : ''}
          </span>
        </div>
        <div className="set__control">
          {!totp?.enabled && !secret && (
            <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => void startSetup()}>
              設定する
            </button>
          )}
        </div>
      </div>

      {secret && (
        <div className="set">
          <div className="set__body">
            <span className="set__label">認証アプリに登録</span>
            <p className="set__hint">
              「手動で追加」を選んで、この鍵を入れてください（対応していれば下の URL を読み取ってもらう形でも構いません）。
            </p>
            <KeyBox value={secret} />
            <p className="set__hint" style={{ wordBreak: 'break-all' }}>{uri}</p>
            <div className="extra__choice" style={{ marginTop: 10 }}>
              <input
                className="field"
                value={code}
                placeholder="アプリに出ている 6 けた"
                inputMode="numeric"
                onChange={(event) => setCode(event.target.value)}
              />
              <button
                type="button"
                className="btn btn--quiet"
                disabled={busy || code.trim().length < 6}
                onClick={() => void enable()}
              >
                有効にする
              </button>
            </div>
          </div>
        </div>
      )}

      {totp?.enabled && (
        <div className="set">
          <div className="set__body">
            <span className="set__label">コードを入れて操作する</span>
            <p className="set__hint">リカバリーコードを作り直すか、2段階認証を無効にできます。</p>
            <div className="extra__choice" style={{ marginTop: 10 }}>
              <input
                className="field"
                value={code}
                placeholder="アプリの 6 けた または リカバリーコード"
                onChange={(event) => setCode(event.target.value)}
              />
              <button
                type="button"
                className="btn btn--quiet"
                disabled={busy || !code.trim()}
                onClick={() => void remakeRecovery()}
              >
                作り直す
              </button>
              <button type="button" className="btn btn--text" disabled={busy || !code.trim()} onClick={() => void disable()}>
                無効にする
              </button>
            </div>
          </div>
        </div>
      )}

      {recovery.length > 0 && (
        <div className="set">
          <div className="set__body">
            <span className="set__label">リカバリーコード（いまだけ表示）</span>
            <p className="set__hint">
              スマホを無くしたときのための 1 回きりのコードです。安全な場所に控えてください。
            </p>
            <KeyBox value={recovery.join('  ')} />
          </div>
        </div>
      )}

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}
    </>
  );
}
