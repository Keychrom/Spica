/**
 * 設定 → 表示（文字の大きさ・密度・タイムラインの既定・並びの好み）。
 * アカウントに保存して、次に開いたときも効くようにする（端末をまたいで同じ）。
 */
import { useEffect, useState } from 'react';
import { loadPrefs, savePrefs, type Prefs } from '../../lib/settings';
import type { ThemeChoice } from '../../lib/theme';
import DisplayExtras from './DisplayExtras';

const SIZE = [
  { value: 'small', label: '小さめ' },
  { value: 'normal', label: '標準' },
  { value: 'large', label: '大きめ' },
];

const DENSITY = [
  { value: 'comfortable', label: 'ゆったり' },
  { value: 'compact', label: 'つめて' },
];

const TIMELINE = [
  { value: 'home', label: 'ホーム' },
  { value: 'local', label: 'ローカル' },
  { value: 'all', label: '連合' },
];

interface Props {
  /** 保存できたら、アプリ全体に効かせる（文字の大きさ・密度） */
  onApply: (prefs: Prefs) => void;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
}

export default function DisplaySection({ onApply, theme, onTheme }: Props) {
  const [prefs, setPrefs] = useState<Prefs>({});
  const [loading, setLoading] = useState(true);
  const [ok, setOk] = useState('');

  useEffect(() => {
    void (async () => {
      const loaded = await loadPrefs();
      if (loaded) setPrefs(loaded);
      setLoading(false);
    })();
  }, []);

  async function update(patch: Prefs) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    setOk('');
    const saved = await savePrefs(patch);
    if (saved) {
      setPrefs(saved);
      onApply(saved);
      setOk('保存しました。');
    } else {
      setOk('');
    }
  }

  if (loading) return <div className="feed__state">読み込んでいます…</div>;

  return (
    <>
      <div className="set__group">
        <h3>読みやすさ</h3>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">文字の大きさ</span>
          <p className="set__hint">本文と見出しの大きさが変わります。</p>
        </div>
        <div className="set__control">
          <div className="seg">
            {SIZE.map((item) => (
              <button
                key={item.value}
                type="button"
                className={'seg__t' + (prefs.fontSize === item.value ? ' seg__t--on' : '')}
                onClick={() => void update({ fontSize: item.value as Prefs['fontSize'] })}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">行のつめ方</span>
        </div>
        <div className="set__control">
          <div className="seg">
            {DENSITY.map((item) => (
              <button
                key={item.value}
                type="button"
                className={'seg__t' + (prefs.density === item.value ? ' seg__t--on' : '')}
                onClick={() => void update({ density: item.value as Prefs['density'] })}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">タイムラインの既定</span>
          <p className="set__hint">ホームを開いたときに最初に出すタブ。</p>
        </div>
        <div className="set__control">
          <div className="seg">
            {TIMELINE.map((item) => (
              <button
                key={item.value}
                type="button"
                className={'seg__t' + (prefs.defaultTimeline === item.value ? ' seg__t--on' : '')}
                onClick={() => void update({ defaultTimeline: item.value as Prefs['defaultTimeline'] })}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="set__group">
        <h3>タイムラインの中身</h3>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">返信を隠す</span>
          <p className="set__hint">ホームで、誰かへの返信を出さない。</p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (prefs.hideRepliesInHome ? ' sw--on' : '')}
            role="switch"
            aria-checked={Boolean(prefs.hideRepliesInHome)}
            aria-label="返信を隠す"
            onClick={() => void update({ hideRepliesInHome: !prefs.hideRepliesInHome })}
          />
        </div>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">リノートを隠す</span>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (prefs.hideBoostsInHome ? ' sw--on' : '')}
            role="switch"
            aria-checked={Boolean(prefs.hideBoostsInHome)}
            aria-label="リノートを隠す"
            onClick={() => void update({ hideBoostsInHome: !prefs.hideBoostsInHome })}
          />
        </div>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">既読のまとめ方</span>
          <p className="set__hint">通知をまとめて出すか、1 件ずつ出すか。</p>
        </div>
        <div className="set__control">
          <div className="seg">
            <button
              type="button"
              className={'seg__t' + (prefs.notificationGrouping !== 'individual' ? ' seg__t--on' : '')}
              onClick={() => void update({ notificationGrouping: 'group' })}
            >
              まとめる
            </button>
            <button
              type="button"
              className={'seg__t' + (prefs.notificationGrouping === 'individual' ? ' seg__t--on' : '')}
              onClick={() => void update({ notificationGrouping: 'individual' })}
            >
              1 件ずつ
            </button>
          </div>
        </div>
      </div>

      {ok && <p className="set__ok">{ok}</p>}
      <p className="set__hint">※ テーマとアクセントカラーは、下の「見た目」「色」で変えられます（モバイルのドロワーにもあります）。</p>
      <DisplayExtras
        prefs={prefs}
        onUpdate={(patch) => void update(patch)}
        theme={theme}
        onTheme={(choice) => {
          onTheme(choice);
          setPrefs((current) => ({ ...current, themeMode: choice }));
        }}
      />
    </>
  );
}
