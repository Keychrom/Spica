import { useState } from 'react';
import type { ThemeChoice } from '../../lib/theme';
/**
 * 設定 → 表示 の残り（時刻の書式・絵文字の見せ方・メディアの扱い）。
 * 保存は DisplaySection と同じ道を通す（onUpdate を渡してもらう）。
 */
import { applyAccent, ACCENTS } from '../../lib/theme';
import { isStandalone, promptInstall, useInstallAvailable } from '../../lib/pwa';
import type { Prefs } from '../../lib/settings';

const TIME = [
  { value: 'absolute', label: '日時' },
  { value: 'relative', label: '〜前' },
];

interface Props {
  prefs: Prefs;
  onUpdate: (patch: Prefs) => void;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
}

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
  { value: 'system', label: '端末に合わせる' },
];

export default function DisplayExtras({ prefs, onUpdate, theme, onTheme }: Props) {
  const time = prefs.timeFormat === 'relative' ? 'relative' : 'absolute';
  const accent = ACCENTS.some((item) => item.value === prefs.accentColor) ? String(prefs.accentColor) : 'indigo';
  const installAvailable = useInstallAvailable();
  const [installNote, setInstallNote] = useState('');

  async function pickAccent(value: string) {
    applyAccent(value);
    onUpdate({ accentColor: value });
  }

  function install() {
    void (async () => {
      const accepted = await promptInstall();
      setInstallNote(accepted ? '追加しました。' : 'やめました。');
    })();
  }

  return (
    <>
      <div className="set__group">
        <h3>見た目</h3>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">テーマ</span>
          <p className="set__hint">端末をまたいで同じになります（左ナビの下の切り替えと同じ）。</p>
        </div>
        <div className="set__control">
          <div className="seg seg--wrap">
            {THEMES.map((item) => (
              <button
                key={item.value}
                type="button"
                className={'seg__t' + (theme === item.value ? ' seg__t--on' : '')}
                onClick={() => void onTheme(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="set__group">
        <h3>時刻の出し方</h3>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">ノートの時刻</span>
          <p className="set__hint">
            いまは「{time === 'relative' ? '3時間前' : '2026/10/9 18:30'}」の形で出ます。
          </p>
        </div>
        <div className="set__control">
          <div className="seg">
            {TIME.map((item) => (
              <button
                key={item.value}
                type="button"
                className={'seg__t' + (time === item.value ? ' seg__t--on' : '')}
                onClick={() => onUpdate({ timeFormat: item.value as Prefs['timeFormat'] })}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="set__group">
        <h3>ノートの見え方</h3>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">カスタム絵文字を画像で出す</span>
          <p className="set__hint">切ると、:name: の文字のまま出ます（軽くなります）。</p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (prefs.showCustomEmojiImages !== false ? ' sw--on' : '')}
            role="switch"
            aria-checked={prefs.showCustomEmojiImages !== false}
            aria-label="カスタム絵文字を画像で出す"
            onClick={() => onUpdate({ showCustomEmojiImages: prefs.showCustomEmojiImages === false })}
          />
        </div>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">センシティブな添付はいつも隠す</span>
          <p className="set__hint">押すまで画像・動画を出しません。</p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (prefs.alwaysHideSensitive ? ' sw--on' : '')}
            role="switch"
            aria-checked={Boolean(prefs.alwaysHideSensitive)}
            aria-label="センシティブな添付はいつも隠す"
            onClick={() => onUpdate({ alwaysHideSensitive: !prefs.alwaysHideSensitive })}
          />
        </div>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">動画を自動で再生する</span>
          <p className="set__hint">切ってあると、押すまで再生しません。</p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (prefs.autoPlayMedia ? ' sw--on' : '')}
            role="switch"
            aria-checked={Boolean(prefs.autoPlayMedia)}
            aria-label="動画を自動で再生する"
            onClick={() => onUpdate({ autoPlayMedia: !prefs.autoPlayMedia })}
          />
        </div>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">動画はミュートで始める</span>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (prefs.muteMediaByDefault !== false ? ' sw--on' : '')}
            role="switch"
            aria-checked={prefs.muteMediaByDefault !== false}
            aria-label="動画はミュートで始める"
            onClick={() => onUpdate({ muteMediaByDefault: prefs.muteMediaByDefault === false })}
          />
        </div>
      </div>

      <div className="set__group">
        <h3>色</h3>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">アクセントカラー</span>
          <p className="set__hint">ボタンやリンクの色が変わります。</p>
          <div className="seg seg--wrap" style={{ marginTop: 10 }}>
            {ACCENTS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={'seg__t' + (accent === item.value ? ' seg__t--on' : '')}
                onClick={() => void pickAccent(item.value)}
              >
                <span className="roledot" style={{ background: item.color, width: 10, height: 10 }} />
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="set__group">
        <h3>アプリ</h3>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">ホーム画面に追加</span>
          <p className="set__hint">
            {isStandalone()
              ? 'アプリとして開いています。'
              : installAvailable
                ? 'ホーム画面に追加すると、通知やアイコンのバッジが使えます。'
                : 'お使いのブラウザのメニューから「アプリをインストール」を選べます。'}
          </p>
          {installNote && <p className="set__ok">{installNote}</p>}
        </div>
        <div className="set__control">
          {installAvailable && !isStandalone() && (
            <button type="button" className="btn btn--quiet" onClick={install}>
              追加する
            </button>
          )}
        </div>
      </div>
    </>
  );
}
