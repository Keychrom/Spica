/**
 * 設定 → アカウント（端末 / パスワード / メールアドレス / ログアウト）。
 */
import { useEffect, useState } from 'react';
import {
  loadSessions,
  removeEmail,
  requestEmailChange,
  revokeOtherSessions,
  revokeSession,
  setPassword,
  verifyEmail,
  type DeviceSession,
} from '../../lib/settings';
import { relativeTime } from '../../lib/format';

interface Props {
  email: string;
  emailVerified: boolean;
  hasPassword: boolean;
  onLogout: () => void;
  /** 端末の一覧を変えたあと、何か知らせたいとき */
  onChanged?: () => void;
}

function deviceName(userAgent: string | undefined): string {
  const ua = userAgent || '';
  if (!ua) return '不明な端末';
  if (/iPhone|iPad/i.test(ua)) return 'iPhone / iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows のブラウザ';
  if (/Macintosh/i.test(ua)) return 'Mac のブラウザ';
  return ua.slice(0, 60);
}

/** 期限は未来の日付なので「◯月◯日まで」の形で出す */
function untilDate(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getMonth() + 1}月${date.getDate()}日まで`;
}

export default function AccountSection({ email, emailVerified, hasPassword, onLogout, onChanged }: Props) {
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [ok, setOk] = useState('');
  const [err, setErr] = useState('');

  const [newPassword, setNewPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [masterKey, setMasterKey] = useState('');

  const [newEmail, setNewEmail] = useState('');
  const [code, setCode] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');

  useEffect(() => {
    void (async () => {
      setSessions(await loadSessions());
      setLoading(false);
    })();
  }, []);

  function flash(message: string) {
    setOk(message);
    setErr('');
  }

  async function revoke(id: string) {
    if (!(await revokeSession(id))) {
      setErr('この端末を解除できませんでした。');
      return;
    }
    setSessions((current) => current.filter((session) => session.id !== id));
    onChanged?.();
  }

  async function revokeOthers() {
    if (!(await revokeOtherSessions())) {
      setErr('まとめて解除できませんでした。');
      return;
    }
    setSessions((current) => current.filter((session) => session.current));
    flash('ほかの端末をすべて解除しました。');
  }

  async function submitPassword() {
    setErr('');
    const message = await setPassword(newPassword, currentPassword, masterKey.trim());
    if (message) {
      setErr(message);
      return;
    }
    setNewPassword('');
    setCurrentPassword('');
    setMasterKey('');
    flash(hasPassword ? 'パスワードを変更しました。' : 'パスワードを設定しました。');
  }

  async function submitEmail() {
    setErr('');
    const message = await requestEmailChange(newEmail.trim());
    if (message) {
      setErr(message);
      return;
    }
    setPendingEmail(newEmail.trim());
    flash('確認コードを送りました。メールを見て入力してください。');
  }

  async function submitCode() {
    setErr('');
    const message = await verifyEmail(pendingEmail || newEmail.trim(), code.trim());
    if (message) {
      setErr(message);
      return;
    }
    setCode('');
    setNewEmail('');
    setPendingEmail('');
    flash('メールアドレスを確認しました。');
  }

  return (
    <>
      <div className="set__group">
        <h3>ログインしている端末</h3>
      </div>
      {loading && <div className="feed__state">読み込んでいます…</div>}
      {sessions.map((session) => (
        <div className="set" key={session.id}>
          <div className="set__body">
            <span className="set__label">
              {deviceName(session.user_agent)} {session.current && <span className="set__ok">（この端末）</span>}
            </span>
            <p className="set__hint">
              {session.created_at ? `${relativeTime(session.created_at)} から` : ''}
              {session.expires_at ? ` ／ ${untilDate(session.expires_at)}` : ''}
            </p>
          </div>
          {!session.current && (
            <div className="set__control">
              <button type="button" className="btn btn--text" onClick={() => void revoke(session.id)}>
                解除
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="set">
        <div className="set__body">
          <button type="button" className="btn btn--quiet" onClick={() => void revokeOthers()}>
            ほかの端末をすべて解除
          </button>
        </div>
        <div className="set__control">
          <button type="button" className="btn btn--text" onClick={onLogout}>
            この端末からログアウト
          </button>
        </div>
      </div>

      <div className="set__group">
        <h3>パスワード</h3>
        <p className="set__hint">
          {hasPassword
            ? '設定済みです。変更するには今のパスワードが必要です（マスターキーは使いません）。'
            : '未設定です。設定すると、マスターキーが手元に無くてもログインできます（8 文字以上）。'}
        </p>
      </div>
      <div className="set">
        <div className="set__body">
          <div className="set__form">
            <input
              className="field"
              type="password"
              value={newPassword}
              placeholder="新しいパスワード（8 文字以上）"
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
            {hasPassword ? (
              <input
                className="field"
                type="password"
                value={currentPassword}
                placeholder="今のパスワード"
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            ) : (
              <input
                className="field"
                type="text"
                value={masterKey}
                placeholder="マスターキー"
                onChange={(e) => setMasterKey(e.target.value)}
                autoComplete="off"
              />
            )}
          </div>
        </div>
        <div className="set__control">
          <button
            type="button"
            className="btn btn--quiet"
            disabled={newPassword.length < 8}
            onClick={() => void submitPassword()}
          >
            {hasPassword ? '変更する' : '設定する'}
          </button>
        </div>
      </div>

      <div className="set__group">
        <h3>メールアドレス</h3>
        <p className="set__hint">
          {email
            ? `${email}（${emailVerified ? '確認済み' : '未確認'}）。設定すると、ログインや復元に使えます。`
            : 'まだ設定していません。設定すると、ログインや復元に使えます。'}
        </p>
      </div>
      <div className="set">
        <div className="set__body">
          <div className="set__form">
            <input
              className="field"
              type="email"
              value={newEmail}
              placeholder="you@example.com"
              onChange={(e) => setNewEmail(e.target.value)}
              autoComplete="email"
            />
            {pendingEmail && (
              <input
                className="field"
                value={code}
                placeholder="確認コード（メールに届いた数字）"
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </div>
        </div>
        <div className="set__control">
          {pendingEmail ? (
            <button type="button" className="btn btn--quiet" disabled={!code.trim()} onClick={() => void submitCode()}>
              確認する
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--quiet"
              disabled={!newEmail.includes('@')}
              onClick={() => void submitEmail()}
            >
              コードを送る
            </button>
          )}
          {email && (
            <button
              type="button"
              className="btn btn--text"
              onClick={() =>
                void (async () => {
                  if (await removeEmail()) flash('メールアドレスを外しました。');
                  else setErr('外せませんでした。');
                })()
              }
            >
              外す
            </button>
          )}
        </div>
      </div>

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}
    </>
  );
}
