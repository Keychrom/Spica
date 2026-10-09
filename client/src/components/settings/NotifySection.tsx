/**
 * 設定 → 通知（種類ごとの ON/OFF とメール通知）。
 */
import { useEffect, useState } from 'react';
import { pushStatus, subscribePush, testPush, unsubscribePush } from '../../lib/push';
import {
  loadNotificationSettings,
  saveNotificationPrefs,
  setEmailNotify,
  type NotificationSettings,
} from '../../lib/settings';

export default function NotifySection() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [push, setPush] = useState(false);
  const [pushMsg, setPushMsg] = useState('');

  useEffect(() => {
    void (async () => {
      setSettings(await loadNotificationSettings());
      setPush(await pushStatus());
      setLoading(false);
    })();
  }, []);

  async function toggle(type: string, value: boolean) {
    if (!settings) return;
    const next = { ...settings.prefs, [type]: value };
    setSettings({ ...settings, prefs: next });
    const saved = await saveNotificationPrefs(next);
    if (saved) setSettings({ ...settings, prefs: saved });
  }

  async function toggleEmail(value: boolean) {
    setErr('');
    const email = await setEmailNotify(value);
    if (!email) {
      setErr('メール通知を切り替えられませんでした（サーバーのメール設定が必要です）。');
      return;
    }
    setSettings((current) => (current ? { ...current, email } : current));
  }

  if (loading) return <div className="feed__state">読み込んでいます…</div>;
  if (!settings) return <div className="feed__state">通知の設定を読み込めませんでした。</div>;

  return (
    <>
      <div className="set__group">
        <h3>受け取る通知</h3>
      </div>
      {settings.types.map((item) => (
        <div className="set" key={item.type}>
          <div className="set__body">
            <span className="set__label">{item.label}</span>
          </div>
          <div className="set__control">
            <button
              type="button"
              className={'sw' + (settings.prefs[item.type] !== false ? ' sw--on' : '')}
              role="switch"
              aria-checked={settings.prefs[item.type] !== false}
              aria-label={item.label}
              onClick={() => void toggle(item.type, settings.prefs[item.type] === false)}
            />
          </div>
        </div>
      ))}

      <div className="set__group">
        <h3>端末への通知（プッシュ）</h3>
        <p className="set__hint">
          アプリを閉じていても、スマホやパソコンに通知が出ます（サーバー側でプッシュの設定が必要です）。
        </p>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">{push ? 'この端末に届きます' : 'この端末には届きません'}</span>
          {pushMsg && <p className="set__hint">{pushMsg}</p>}
        </div>
        <div className="set__control">
          {push && (
            <button
              type="button"
              className="btn btn--text"
              onClick={() =>
                void (async () => {
                  const problem = await testPush();
                  setPushMsg(problem || 'テスト通知を送りました。');
                })()
              }
            >
              テスト送信
            </button>
          )}
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() =>
              void (async () => {
                setPushMsg('');
                const problem = push ? await unsubscribePush() : await subscribePush();
                if (problem) {
                  setPushMsg(problem);
                  return;
                }
                setPush(!push);
                setPushMsg(push ? '通知を止めました。' : '通知を受け取るようにしました。');
              })()
            }
          >
            {push ? '止める' : '受け取る'}
          </button>
        </div>
      </div>

      <div className="set__group">
        <h3>メール</h3>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">メールでも受け取る</span>
          <p className="set__hint">
            {settings.email.available
              ? settings.email.email
                ? `${settings.email.email}（${settings.email.verified ? '確認済み' : '未確認'}）宛に送ります。`
                : 'メールアドレスが未設定です。下の「アカウント」で設定してください。'
              : 'このサーバーではメール送信が設定されていません。'}
          </p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (settings.email.enabled ? ' sw--on' : '')}
            role="switch"
            aria-checked={settings.email.enabled}
            aria-label="メールでも受け取る"
            disabled={!settings.email.available}
            onClick={() => void toggleEmail(!settings.email.enabled)}
          />
        </div>
      </div>
      {err && <p className="set__err">{err}</p>}
      <p className="set__hint">未読の通知は左ナビの「通知」に数字で出ます。</p>
    </>
  );
}
