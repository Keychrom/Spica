/**
 * 新規登録（/register）。
 * サーバーの設定で変わる部分（招待コード・承認制・規約・メール確認）に素直に合わせる。
 *  ・authMode が password のときだけメールとパスワードを聞く
 *  ・SMTP があればメール確認コードを先に送る
 */
import { useEffect, useState, type FormEvent } from 'react';
import AuthShell from '../components/AuthShell';
import KeyBox from '../components/KeyBox';
import { api, messageOf, setToken } from '../lib/api';
import { navigate } from '../lib/router';
import type { ServerInfo, SessionUser } from '../lib/format';
import { MASTER_KEY_HINT } from './OnboardingView';

interface RecoveryStatus {
  authMode?: 'master_key' | 'password';
  allowEmailRegistration?: boolean;
  mailConfigured?: boolean;
}

interface RegisterViewProps {
  server: ServerInfo | null;
  onSignedIn: (user: SessionUser) => void;
}

export default function RegisterView({ server, onSignedIn }: RegisterViewProps) {
  const [status, setStatus] = useState<RecoveryStatus>({});
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [requestMessage, setRequestMessage] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [doneKey, setDoneKey] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await api.get('/api/auth/recovery/status', { auth: false });
      if (res.ok && res.data && typeof res.data === 'object') setStatus(res.data as RecoveryStatus);
    })();
  }, []);

  const mode = server?.registration_mode || 'open';
  const rules = server?.server_rules || [];
  const needRules = Boolean(server?.require_rules_agreement) && (rules.length > 0 || Boolean(server));
  const needInvite = mode === 'invite';
  const needApproval = mode === 'approval';
  const needMail = status.authMode === 'password';
  const needCode = needMail && Boolean(status.mailConfigured);

  async function sendCode() {
    setError('');
    const res = await api.post('/api/auth/register/email-code', { email: email.trim() }, { auth: false });
    if (res.ok) setCodeSent(true);
    else setError(messageOf(res.data, '確認コードを送れませんでした。'));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const res = await api.post(
      '/api/auth/register',
      {
        id: id.trim().toLowerCase(),
        name: name.trim(),
        summary,
        ...(needInvite || inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
        ...(needApproval ? { requestMessage } : {}),
        ...(needMail ? { email: email.trim(), password } : {}),
        ...(needCode ? { emailCode: emailCode.trim() } : {}),
        agreedToRules: agreed,
      },
      { auth: false },
    );
    setBusy(false);

    const data = res.data as
      | {
          user?: SessionUser;
          masterKey?: string;
          sessionToken?: string;
          pending?: boolean;
          message?: string;
          error?: string;
        }
      | null;

    if (!res.ok) {
      setError(messageOf(res.data, '登録できませんでした。'));
      return;
    }

    if (data?.pending) {
      setDone(data.message || '申請を受け付けました。管理者の承認をお待ちください。');
      return;
    }

    if (data?.sessionToken && data.user) {
      setToken(data.sessionToken);
      onSignedIn(data.user);
      // マスターキーはここでしか出ない。初回設定の画面へ預けて、そこで控えてもらう
      if (data.masterKey) window.sessionStorage.setItem(MASTER_KEY_HINT, data.masterKey);
      setDoneKey(data.masterKey || '');
      return;
    }
  }

  if (doneKey) {
    return (
      <AuthShell
        lead="登録できました。マスターキーは、あなたのアカウントを開ける唯一の鍵です。"
        foot={
          <button type="button" className="btn btn--text" onClick={() => navigate('/onboarding')}>
            はじめる
          </button>
        }
      >
        <div style={{ marginTop: 14 }}>
          <KeyBox value={doneKey} />
        </div>
        <p className="auth__note">
          コピーして、安全な場所に控えてください（この画面を離れると、二度と表示できません）。
          次に進むと、続けて初期設定をします。
        </p>
      </AuthShell>
    );
  }

  if (mode === 'closed') {
    return (
      <AuthShell
        lead="このサーバーは、いま新規登録を一時停止しています。"
        foot={
          <button type="button" className="btn btn--text" onClick={() => navigate('/login')}>
            ログインへ
          </button>
        }
      />
    );
  }

  return (
    <AuthShell
      lead={
        needApproval
          ? 'このサーバーは承認制です。登録すると、運営が承認した時点で使えるようになります。'
          : 'アカウントを作ります。ユーザー ID は @ のあとに付く名前です（あとから変えられません）。'
      }
      foot={
        <button type="button" className="btn btn--text" onClick={() => navigate('/login')}>
          すでにアカウントがある（ログイン）
        </button>
      }
    >
      <form onSubmit={submit} className="auth__form">
          <label className="auth__label" htmlFor="reg-id">
            ユーザー ID（英数字・-・_）
          </label>
          <input
            id="reg-id"
            className="field"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="suiren"
            autoComplete="off"
          />

          <label className="auth__label" htmlFor="reg-name">
            表示名
          </label>
          <input
            id="reg-name"
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="すいれん"
          />

          <label className="auth__label" htmlFor="reg-summary">
            ひとこと（あとから変えられます）
          </label>
          <input
            id="reg-summary"
            className="field"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="よろしくおねがいします"
          />

          {needInvite && (
            <>
              <label className="auth__label" htmlFor="reg-invite">
                招待コード
              </label>
              <input
                id="reg-invite"
                className="field"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
              />
            </>
          )}

          {needApproval && (
            <>
              <label className="auth__label" htmlFor="reg-message">
                運営へのひとこと（任意）
              </label>
              <input
                id="reg-message"
                className="field"
                value={requestMessage}
                onChange={(e) => setRequestMessage(e.target.value)}
                placeholder="参加したい理由など"
              />
            </>
          )}

          {needMail && (
            <>
              <label className="auth__label" htmlFor="reg-email">
                メールアドレス
              </label>
              <input
                id="reg-email"
                className="field"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
              <label className="auth__label" htmlFor="reg-password">
                パスワード（8 文字以上）
              </label>
              <input
                id="reg-password"
                className="field"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              {needCode && (
                <>
                  <label className="auth__label" htmlFor="reg-code">
                    確認コード
                  </label>
                  <div className="set__compose">
                    <input
                      id="reg-code"
                      className="field"
                      value={emailCode}
                      onChange={(e) => setEmailCode(e.target.value)}
                      placeholder="メールに届いた数字"
                    />
                    <button type="button" className="btn btn--quiet" onClick={() => void sendCode()}>
                      {codeSent ? 'もう一度送る' : 'コードを送る'}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {rules.length > 0 && (
            <div className="auth__rules">
              <b>このサーバーのルール</b>
              <ul>
                {rules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </div>
          )}
          {(needRules || rules.length > 0) && (
            <label className="auth__check">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              ルールと利用規約に同意します
            </label>
          )}

          {error && <p className="auth__error">{error}</p>}

          <button className="btn btn--solid auth__submit" type="submit" disabled={busy}>
            {busy ? '作成しています…' : 'アカウントを作る'}
          </button>
      </form>
    </AuthShell>
  );
}
