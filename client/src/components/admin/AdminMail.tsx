/**
 * 管理パネル ⑫メール（SMTP）。パスワードは空欄なら「変えない」。
 */
import { useEffect, useState } from 'react';
import { loadMailSettings, saveMailSettings, testMailSettings, type MailDraft, type MailSettings } from '../../lib/adminMail';

const EMPTY: MailDraft = { host: '', port: '587', secure: false, user: '', pass: '', from: '' };

/** 文字で打ち込む欄（真偽値の secure は別に出す） */
type TextField = 'host' | 'port' | 'user' | 'pass' | 'from';

export default function AdminMail() {
  const [state, setState] = useState<MailSettings | null>(null);
  const [draft, setDraft] = useState<MailDraft>(EMPTY);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => {
    void (async () => {
      const loaded = await loadMailSettings();
      setState(loaded);
      if (loaded) {
        setDraft({
          host: loaded.host || '',
          port: String(loaded.port ?? 587),
          secure: Boolean(loaded.secure),
          user: loaded.user || '',
          pass: '',
          from: loaded.from || '',
        });
      }
    })();
  }, []);

  function set<K extends keyof MailDraft>(key: K, value: MailDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function run(kind: 'save' | 'test') {
    setBusy(kind);
    setErr('');
    setOk('');
    const problem = kind === 'save' ? await saveMailSettings(draft) : await testMailSettings(draft);
    setBusy('');
    if (problem) {
      setErr(problem);
      return;
    }
    setOk(kind === 'save' ? 'メール設定を保存しました。' : 'SMTP に接続できました。');
    if (kind === 'save') {
      setDraft((current) => ({ ...current, pass: '' }));
      setState(await loadMailSettings());
    }
  }

  if (!state) return <div className="feed__state">読み込んでいます…</div>;

  const rows: [TextField, string, string][] = [
    ['host', 'SMTP サーバー', 'smtp.example.com'],
    ['port', 'ポート', '587'],
    ['user', 'ユーザー名', ''],
    ['pass', 'パスワード', state.hasPassword ? '変えるときだけ入力' : ''],
    ['from', '差出人', 'Spica <no-reply@example.com>'],
  ];

  return (
    <>
      <div className="set__hint">
        {state.configured
          ? 'メールを送れる状態です。'
          : 'まだ設定されていません。パスワードの再設定やメール通知には、ここでの設定が要ります。'}
      </div>

      {rows.map(([key, label, placeholder]) => (
        <div className="set" key={key}>
          <div className="set__body">
            <span className="set__label">{label}</span>
            <div className="set__form">
              <input
                className="field"
                type={key === 'pass' ? 'password' : 'text'}
                value={draft[key]}
                placeholder={placeholder}
                onChange={(event) => set(key, event.target.value)}
              />
            </div>
          </div>
        </div>
      ))}

      <div className="set">
        <div className="set__body">
          <span className="set__label">暗号化（STARTTLS / TLS）</span>
          <p className="set__hint">ふつうは入れます。ポート 465 のときは必須です。</p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (draft.secure ? ' sw--on' : '')}
            role="switch"
            aria-checked={draft.secure}
            aria-label="暗号化"
            onClick={() => set('secure', !draft.secure)}
          />
        </div>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">いまの扱い</span>
          <p className="set__hint">
            認証方式: {state.authMode === 'password' ? 'メールとパスワード' : 'マスターキー'} ・ メールでの新規登録:{' '}
            {state.allowEmailRegistration ? '受け付ける' : '受け付けない'}
          </p>
        </div>
      </div>

      <div className="set">
        <div className="set__body" />
        <div className="set__control set__actions">
          <button type="button" className="btn btn--quiet" disabled={Boolean(busy)} onClick={() => void run('save')}>
            {busy === 'save' ? '保存しています…' : '保存する'}
          </button>
          <button type="button" className="btn btn--text" disabled={Boolean(busy) || !draft.host.trim()} onClick={() => void run('test')}>
            {busy === 'test' ? '試しています…' : '接続を試す'}
          </button>
        </div>
      </div>

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}
    </>
  );
}
