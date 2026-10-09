/**
 * 初回設定 2/7: 見た目と通知。
 * ・テーマはこの端末の設定（既存の theme.ts）
 * ・文字の大きさと通知のまとめ方はアカウントに保存する
 */
import { useState } from 'react';
import WizFoot from './WizFoot';
import { savePrefs, type Prefs } from '../../lib/settings';
import type { ThemeChoice } from '../../lib/theme';

interface Props {
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  prefs: Prefs;
  onPrefsChange: (prefs: Prefs) => void;
  onNext: () => void;
  onBack: () => void;
}

const THEMES: { value: ThemeChoice; label: string; note: string }[] = [
  { value: 'light', label: 'ライト', note: '明るい背景' },
  { value: 'dark', label: 'ダーク', note: '暗い背景' },
  { value: 'system', label: '端末に合わせる', note: 'OS の設定に追従' },
];

const SIZES: { value: 'small' | 'normal' | 'large'; label: string; note: string }[] = [
  { value: 'small', label: '小さめ', note: 'たくさん読みたい' },
  { value: 'normal', label: '標準', note: '既定' },
  { value: 'large', label: '大きめ', note: 'ゆったり読みたい' },
];

export default function StepLook({ theme, onTheme, prefs, onPrefsChange, onNext, onBack }: Props) {
  const [size, setSize] = useState<Prefs['fontSize']>(prefs.fontSize || 'normal');
  const [grouping, setGrouping] = useState<Prefs['notificationGrouping']>(prefs.notificationGrouping || 'group');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const saved = await savePrefs({ fontSize: size, notificationGrouping: grouping });
    setBusy(false);
    if (saved) onPrefsChange(saved);
    onNext();
  }

  return (
    <>
      <div className="wiz__step">
        <h2>見た目と通知</h2>
        <p className="wiz__lead">読みやすさは人それぞれです。あとから設定 → 表示 で変えられます。</p>

        <div className="set__group">
          <h3>テーマ</h3>
        </div>
        <div className="picks">
          {THEMES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={'pick' + (theme === item.value ? ' pick--on' : '')}
              onClick={() => onTheme(item.value)}
            >
              <b>{item.label}</b>
              <span>{item.note}</span>
            </button>
          ))}
        </div>

        <div className="set__group">
          <h3>文字の大きさ</h3>
        </div>
        <div className="picks">
          {SIZES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={'pick' + (size === item.value ? ' pick--on' : '')}
              onClick={() => setSize(item.value)}
            >
              <b>{item.label}</b>
              <span>{item.note}</span>
            </button>
          ))}
        </div>

        <div className="set__group">
          <h3>通知のまとめ方</h3>
        </div>
        <div className="picks">
          <button
            type="button"
            className={'pick' + (grouping !== 'individual' ? ' pick--on' : '')}
            onClick={() => setGrouping('group')}
          >
            <b>まとめる</b>
            <span>同じ種類は 1 件に</span>
          </button>
          <button
            type="button"
            className={'pick' + (grouping === 'individual' ? ' pick--on' : '')}
            onClick={() => setGrouping('individual')}
          >
            <b>1 件ずつ</b>
            <span>すべて別々に</span>
          </button>
        </div>
      </div>
      <WizFoot onBack={onBack} onNext={() => void save()} busy={busy} />
    </>
  );
}
