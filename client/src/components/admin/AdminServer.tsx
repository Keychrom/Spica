/**
 * 管理パネル ④サーバーの設定（名前・説明・ルール・リンク・登録の受け入れ方）。
 */
import { useEffect, useState } from 'react';
import { loadInstanceSettings, saveInstanceSettings, type InstanceSettings } from '../../lib/admin';

const MODES = [
  { value: 'open', label: '誰でも登録できる' },
  { value: 'invite', label: '招待コードが要る' },
  { value: 'approval', label: '承認制' },
  { value: 'closed', label: '停止中' },
];

export default function AdminServer() {
  const [settings, setSettings] = useState<InstanceSettings | null>(null);
  const [rules, setRules] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => {
    void (async () => {
      const loaded = await loadInstanceSettings();
      setSettings(loaded);
      setRules((loaded?.server_rules || []).join('\n'));
    })();
  }, []);

  function set<K extends keyof InstanceSettings>(key: K, value: InstanceSettings[K]) {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
    setOk('');
    setErr('');
  }

  async function save() {
    if (!settings) return;
    setBusy(true);
    setErr('');
    setOk('');
    const problem = await saveInstanceSettings({
      name: settings.name,
      description: settings.description,
      icon_url: settings.icon_url,
      banner_url: settings.banner_url,
      tos_url: settings.tos_url,
      privacy_policy_url: settings.privacy_policy_url,
      contact_url: settings.contact_url,
      repository_url: settings.repository_url,
      operator_url: settings.operator_url,
      require_rules_agreement: Boolean(settings.require_rules_agreement),
      server_rules: rules
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      registration_mode: settings.registration_mode,
      dm_enabled: Boolean(settings.dm_enabled),
    });
    setBusy(false);
    if (problem) {
      setErr(problem);
      return;
    }
    setOk('保存しました。');
  }

  if (!settings) return <div className="feed__state">読み込んでいます…</div>;

  return (
    <>
      <div className="set__group">
        <h3>サーバーの見た目</h3>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">名前</span>
          <div className="set__form">
            <input className="field" value={settings.name || ''} onChange={(e) => set('name', e.target.value)} />
          </div>
        </div>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">説明</span>
          <div className="set__form">
            <textarea
              className="field"
              rows={3}
              value={settings.description || ''}
              onChange={(e) => set('description', e.target.value)}
            />
          </div>
        </div>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">アイコンの URL</span>
          <div className="set__form">
            <input
              className="field"
              value={settings.icon_url || ''}
              placeholder="/logo.jpg または https://…"
              onChange={(e) => set('icon_url', e.target.value)}
            />
          </div>
        </div>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">バナーの URL</span>
          <div className="set__form">
            <input className="field" value={settings.banner_url || ''} onChange={(e) => set('banner_url', e.target.value)} />
          </div>
        </div>
      </div>

      <div className="set__group">
        <h3>新しく来る人へ</h3>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">登録の受け入れ方</span>
        </div>
        <div className="set__control">
          <div className="seg seg--wrap">
            {MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                className={'seg__t' + (settings.registration_mode === mode.value ? ' seg__t--on' : '')}
                onClick={() => set('registration_mode', mode.value)}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">サーバーのルール（1 行に 1 つ）</span>
          <p className="set__hint">登録の画面にそのまま出ます。</p>
          <div className="set__form" style={{ maxWidth: 'none' }}>
            <textarea className="field" rows={5} value={rules} onChange={(e) => setRules(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">ルールへの同意を必須にする</span>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (settings.require_rules_agreement ? ' sw--on' : '')}
            role="switch"
            aria-checked={Boolean(settings.require_rules_agreement)}
            aria-label="ルールへの同意を必須にする"
            onClick={() => set('require_rules_agreement', !settings.require_rules_agreement)}
          />
        </div>
      </div>

      <div className="set__group">
        <h3>リンク</h3>
      </div>
      {(
        [
          ['tos_url', '利用規約の URL'],
          ['privacy_policy_url', 'プライバシーポリシーの URL'],
          ['contact_url', '連絡先の URL'],
          ['repository_url', 'ソースコードの URL'],
          ['operator_url', '運営者の URL'],
        ] as [keyof InstanceSettings, string][]
      ).map(([key, label]) => (
        <div className="set" key={String(key)}>
          <div className="set__body">
            <span className="set__label">{label}</span>
            <div className="set__form">
              <input
                className="field"
                value={String(settings[key] ?? '')}
                onChange={(event) => set(key, event.target.value)}
              />
            </div>
          </div>
        </div>
      ))}

      <div className="set">
        <div className="set__body">
          <span className="set__label">メッセージ（DM）を使う</span>
          <p className="set__hint">
            1対1のメッセージをこのサーバーで扱います。切ると、メッセージの画面ごと無い扱いになります。
          </p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (settings.dm_enabled ? ' sw--on' : '')}
            role="switch"
            aria-checked={Boolean(settings.dm_enabled)}
            aria-label="メッセージ（DM）を使う"
            onClick={() => set('dm_enabled', !settings.dm_enabled)}
          />
        </div>
      </div>

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}

      <div className="set">
        <div className="set__body" />
        <div className="set__control">
          <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => void save()}>
            {busy ? '保存しています…' : '保存する'}
          </button>
        </div>
      </div>
    </>
  );
}
