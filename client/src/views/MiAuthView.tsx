/**
 * MiAuth の承認画面（アプリがブラウザで開く `/miauth/<session>`）。
 *
 * アプリ名と、要求された権限を Spica のスコープに直したものを表示する。
 * 許可するとアプリの callback（http/https のみ）へ `session` を付けて戻る。
 */
import { useEffect, useState } from 'react';
import { api, messageOf } from '../lib/api';
import { navigate } from '../lib/router';
import { scopeLabels } from '../lib/appScopes';

interface Props {
  sessionId: string;
  signedIn: boolean;
  /** /auth/me の確認が終わるまでは「確認しています」を出す */
  ready: boolean;
}

interface MiAuthInfo {
  session: string;
  name: string;
  callback: string;
  permissions: string[];
  scopes: string[];
  unknown: string[];
  status: string;
}

export default function MiAuthView({ sessionId, signedIn, ready }: Props) {
  const [info, setInfo] = useState<MiAuthInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  useEffect(() => {
    if (!ready || !signedIn) return;
    void (async () => {
      const res = await api.get(`/api/miauth/${encodeURIComponent(sessionId)}/info`);
      if (!res.ok) {
        setError(messageOf(res.data, '承認情報を取得できませんでした。'));
        return;
      }
      setInfo(res.data as MiAuthInfo);
    })();
  }, [ready, signedIn, sessionId]);

  async function approve() {
    if (busy || !info) return;
    setBusy(true);
    setError('');
    const res = await api.post(`/api/miauth/${encodeURIComponent(sessionId)}/approve`);
    setBusy(false);
    if (!res.ok) {
      setError(messageOf(res.data, '承認できませんでした。'));
      return;
    }
    // callback は http(s) のときだけ開く（javascript: 等を踏まない）
    if (/^https?:\/\//i.test(info.callback)) {
      const separator = info.callback.includes('?') ? '&' : '?';
      window.location.href = `${info.callback}${separator}session=${encodeURIComponent(sessionId)}`;
      return;
    }
    setDone('承認しました。アプリに戻ってください。');
  }

  async function deny() {
    if (busy) return;
    setBusy(true);
    setError('');
    const res = await api.post(`/api/miauth/${encodeURIComponent(sessionId)}/deny`);
    setBusy(false);
    if (!res.ok) {
      setError(messageOf(res.data, '拒否できませんでした。'));
      return;
    }
    setDone('拒否しました。アプリに戻ってください。');
  }

  const callbackHost = (() => {
    try {
      return new URL(info?.callback || '').host;
    } catch {
      return '';
    }
  })();

  return (
    <div className="auth">
      <div className="auth__card">
        <div className="auth__brand">
          <span className="nav__mark" style={{ width: 30, height: 30, fontSize: 15 }}>
            ✦
          </span>
          <b>Spica</b>
        </div>

        {!ready ? (
          <p className="auth__lead">確認しています…</p>
        ) : !signedIn ? (
          <>
            <p className="auth__lead">
              アプリの承認にはログインが必要です。ログインしてから、アプリの画面でもう一度このページを開いてください。
            </p>
            <button className="btn btn--solid auth__submit" type="button" onClick={() => navigate('/login')}>
              ログインへ
            </button>
          </>
        ) : done ? (
          <p className="auth__lead">{done}</p>
        ) : error && !info ? (
          <p className="auth__error">{error}</p>
        ) : !info ? (
          <p className="auth__lead">読み込んでいます…</p>
        ) : info.status !== 'pending' ? (
          <p className="auth__lead">
            {info.status === 'approved' ? 'このアプリは承認済みです。' : 'このアプリの承認は拒否されています。'}
          </p>
        ) : (
          <>
            <p className="auth__lead">
              <b>{info.name || 'アプリ'}</b> が、あなたのアカウントへのアクセスを求めています。
              {callbackHost && (
                <>
                  <br />
                  戻り先: {callbackHost}
                </>
              )}
            </p>

            <h3 style={{ fontSize: 14, margin: '4px 0 8px' }}>許可する権限</h3>
            {info.scopes.length > 0 ? (
              <ul className="auth__scopes">
                {scopeLabels(info.scopes).map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            ) : (
              <p className="auth__error">
                このアプリが要求した権限は Spica では対応していません。許可できる権限がありません。
              </p>
            )}

            {info.unknown.length > 0 && (
              <p className="auth__hint">
                未対応の要求: {info.unknown.join(', ')}（許可されません）
              </p>
            )}
            <p className="auth__hint">
              パスワード・メール・2段階認証・セッション管理・管理画面などは、許可してもアプリからは操作できません。
            </p>

            {error && <p className="auth__error">{error}</p>}

            <button
              className="btn btn--solid auth__submit"
              type="button"
              onClick={() => void approve()}
              disabled={busy || info.scopes.length === 0}
            >
              {busy ? '処理しています…' : '許可する'}
            </button>
            <button
              className="btn btn--text"
              type="button"
              onClick={() => void deny()}
              disabled={busy}
              style={{ marginTop: 10 }}
            >
              拒否する
            </button>
          </>
        )}
      </div>
    </div>
  );
}
