/**
 * ログイン / 新規登録の入口。
 * マスターキー方式・メール＋パスワード方式・パスキーの 3 つを受ける。
 * 2段階認証が有効なアカウントは、コードの入力欄が現れる
 * （パスキーは確認後にコードだけ入れ直せる）。
 */
import { useState, type FormEvent } from 'react';
import { api, messageOf, setToken } from '../lib/api';
import { navigate } from '../lib/router';
import type { SessionUser } from '../lib/format';
import { completePasskeyTotp, loginWithPasskey, type PasskeyLoginResult } from '../lib/webauthn';

interface LoginViewProps {
  onSignedIn: (user: SessionUser) => void;
}

export default function LoginView({ onSignedIn }: LoginViewProps) {
  const [identifier, setIdentifier] = useState('');
  const [secret, setSecret] = useState('');
  const [usePassword, setUsePassword] = useState(false);
  const [totp, setTotp] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [passkeyPending, setPasskeyPending] = useState('');
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const busyAny = busy || passkeyBusy;

  /** パスキーでもパスワードでも、セッションができたら同じ後処理をする */
  async function finishSignIn(token: string, fallback?: PasskeyLoginResult['user']) {
    setToken(token);
    const me = await api.get('/api/auth/me');
    const signedIn =
      me.ok && me.data && typeof me.data === 'object'
        ? (me.data as SessionUser)
        : ({
            id: fallback?.id || '',
            name: fallback?.name || '',
            handle: fallback?.id ? `@${fallback.id}@${window.location.host}` : '',
            icon_url: fallback?.icon_url,
          } as SessionUser);
    onSignedIn(signedIn);
    navigate('/');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyAny) return;
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

  async function signInWithPasskey() {
    if (busyAny) return;
    setError('');
    setTotpRequired(false);
    setPasskeyBusy(true);
    const typed = identifier.trim();
    // メールアドレスは user_id ではない。渡すとサーバーがその文字列でチャレンジを
    // 紐付けてしまい、実際の持ち主のクレデンシャルと一致せず弾かれるので省略する
    const userId = typed && !typed.includes('@') ? typed : undefined;
    const result = await loginWithPasskey(userId);
    setPasskeyBusy(false);
    if (result.ok && result.token) {
      await finishSignIn(result.token, result.user);
      return;
    }
    if (result.totpRequired && result.pendingToken) {
      setPasskeyPending(result.pendingToken);
      setTotpRequired(true);
      setError(result.error || '2段階認証コードを入力してください。');
      return;
    }
    setError(result.error || 'パスキーでログインできませんでした。');
  }

  async function submitPasskeyTotp(event: FormEvent) {
    event.preventDefault();
    if (busyAny) return;
    if (!totp.trim()) {
      setError('2段階認証コードを入力してください。');
      return;
    }
    setBusy(true);
    setError('');
    const result = await completePasskeyTotp(passkeyPending, totp.trim());
    setBusy(false);
    if (result.ok && result.token) {
      await finishSignIn(result.token, result.user);
      return;
    }
    setError(result.error || '2段階認証コードが正しくありません。');
    setTotp('');
  }

  function restartPasskey() {
    setPasskeyPending('');
    setTotp('');
    setTotpRequired(false);
    setError('');
  }

  const lead = passkeyPending
    ? 'パスキーの確認が済みました。2段階認証コードを入力してください。'
    : usePassword
      ? 'メールアドレス（またはユーザー ID）とパスワードでログインします。'
      : 'マスターキーでログインします。アカウントの完全な所有権はあなたの手にあります。';

  return (
    <div className="auth">
      <div className="auth__card">
        <div className="auth__brand">
          <span className="nav__mark" style={{ width: 30, height: 30, fontSize: 15 }}>
            ✦
          </span>
          <b>Spica</b>
        </div>
        <p className="auth__lead">{lead}</p>

        {passkeyPending ? (
          <form onSubmit={submitPasskeyTotp} className="auth__form">
            <label className="auth__label" htmlFor="passkey-totp">
              2段階認証コード
            </label>
            <input
              id="passkey-totp"
              className="field"
              value={totp}
              onChange={(event) => setTotp(event.target.value)}
              placeholder="123456 または リカバリーコード"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
            />

            {error && <p className="auth__error">{error}</p>}

            <button className="btn btn--solid auth__submit" type="submit" disabled={busy}>
              {busy ? '確認しています…' : 'コードを確認してログイン'}
            </button>

            <div className="auth__foot">
              <button type="button" className="btn btn--text" onClick={restartPasskey}>
                パスキーからやり直す
              </button>
              <button type="button" className="btn btn--text" onClick={() => navigate('/')}>
                タイムラインへ戻る
              </button>
            </div>
          </form>
        ) : (
          <>
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

              <button className="btn btn--solid auth__submit" type="submit" disabled={busyAny}>
                {busy ? '確認しています…' : 'ログイン'}
              </button>
            </form>

            <div className="auth__or" role="separator">
              <span>または</span>
            </div>
            <button
              type="button"
              className="btn btn--outline auth__passkey"
              onClick={signInWithPasskey}
              disabled={busyAny}
            >
              {passkeyBusy ? '端末で確認しています…' : 'パスキーでログイン'}
            </button>
            <p className="auth__hint">
              ユーザー ID を入れておくと、そのアカウントのパスキーに絞り込みます。空欄のままでも、この端末に保存されたパスキーから選べます。
            </p>

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
          </>
        )}
      </div>
    </div>
  );
}
