/**
 * ログイン / 新規登録の入口。
 * マスターキー方式と（設定されていれば）メール＋パスワード方式の両方を受ける。
 * 2段階認証が有効なアカウントは、コードの入力欄が現れる。
 */
import { useState, type FormEvent } from 'react';
import { api, messageOf, setToken } from '../lib/api';
import { navigate } from '../lib/router';
import type { SessionUser } from '../lib/format';

interface LoginViewProps {
  onSignedIn: (user: SessionUser) => void;
}

export default function LoginView({ onSignedIn }: LoginViewProps) {
  const [identifier, setIdentifier] = useState('');
  const [secret, setSecret] = useState('');
  const [usePassword, setUsePassword] = useState(false);
  const [totp, setTotp] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const isEmail = identifier.includes('@') && !identifier.startsWith('@');
    const res = await api.post(
      '/api/auth/login',
      {
        ...(usePassword
          ? { password: secret, ...(isEmail ? { email: identifier } : { id: identifier }) }
          : { id: identifier, masterKey: secret.trim() }),
        ...(totp.trim() ? { totpCode: totp.trim() } : {}),
      },
      { auth: false },
    );
    setBusy(false);

    const data = res.data as
      | { sessionToken?: string; user?: SessionUser; totp_required?: boolean; error?: string }
      | null;

    if (!res.ok) {
      if (res.status === 401 && data?.totp_required) {
        setTotpRequired(true);
        setError(totp.trim() ? 'コードが正しくありません。' : '');
        return;
      }
      setError(messageOf(res.data, 'ログインできませんでした。'));
      return;
    }
    if (data?.sessionToken && data.user) {
      setToken(data.sessionToken);
      onSignedIn(data.user);
      navigate('/');
    }
  }

  return (
    <div className="auth">
      <div className="auth__card">
        <div className="auth__brand">
          <span className="nav__mark" style={{ width: 30, height: 30, fontSize: 15 }}>
            ✦
          </span>
          <b>Spica</b>
        </div>
        <p className="auth__lead">
          {usePassword
            ? 'メールアドレス（またはユーザー ID）とパスワードでログインします。'
            : 'マスターキーでログインします。アカウントの完全な所有権はあなたの手にあります。'}
        </p>

        <form onSubmit={submit} className="auth__form">
          <label className="auth__label" htmlFor="login-id">
            {usePassword ? 'メールアドレス または ユーザー ID' : 'ユーザー ID'}
          </label>
          <input
            id="login-id"
            className="field"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder={usePassword ? 'you@example.com または suiren' : 'suiren'}
            autoComplete="username"
          />

          <label className="auth__label" htmlFor="login-secret">
            {usePassword ? 'パスワード' : 'マスターキー'}
          </label>
          <input
            id="login-secret"
            className="field"
            type={usePassword ? 'password' : 'text'}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={usePassword ? '' : 'XXXX-XXXX-XXXX-XXXX'}
            autoComplete={usePassword ? 'current-password' : 'off'}
          />

          {totpRequired && (
            <>
              <label className="auth__label" htmlFor="login-totp">
                2段階認証コード
              </label>
              <input
                id="login-totp"
                className="field"
                value={totp}
                onChange={(event) => setTotp(event.target.value)}
                placeholder="123456 または リカバリーコード"
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </>
          )}

          {error && <p className="auth__error">{error}</p>}

          <button className="btn btn--solid auth__submit" type="submit" disabled={busy}>
            {busy ? '確認しています…' : 'ログイン'}
          </button>
        </form>

        <div className="auth__foot">
          <button type="button" className="btn btn--text" onClick={() => setUsePassword((v) => !v)}>
            {usePassword ? 'マスターキーでログインする' : 'メールアドレスとパスワードでログインする'}
          </button>
          <button type="button" className="btn btn--text" onClick={() => navigate('/register')}>
            アカウントを作る
          </button>
          <button type="button" className="btn btn--text" onClick={() => navigate('/')}>
            タイムラインへ戻る
          </button>
        </div>
      </div>
    </div>
  );
}
