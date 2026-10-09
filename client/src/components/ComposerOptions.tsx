/**
 * 投稿の下の選択（CW・公開範囲・センシティブ）。
 */
const VISIBILITIES: { value: string; label: string }[] = [
  { value: 'public', label: '連合' },
  { value: 'unlisted', label: 'ひかえめ' },
  { value: 'followers', label: 'フォロワー' },
];

interface ComposerOptionsProps {
  cwOn: boolean;
  onCwToggle: () => void;
  visibility: string;
  onVisibility: (value: string) => void;
  sensitive: boolean;
  onSensitiveToggle: () => void;
}

export default function ComposerOptions({
  cwOn,
  onCwToggle,
  visibility,
  onVisibility,
  sensitive,
  onSensitiveToggle,
}: ComposerOptionsProps) {
  return (
    <div className="sheet__row">
      <button type="button" className={`tg${cwOn ? ' tg--on' : ''}`} onClick={onCwToggle}>
        CW
      </button>
      {VISIBILITIES.map((item) => (
        <button
          key={item.value}
          type="button"
          className={`tg${visibility === item.value ? ' tg--on' : ''}`}
          onClick={() => onVisibility(item.value)}
        >
          {item.label}
        </button>
      ))}
      <button
        type="button"
        className={`tg${sensitive ? ' tg--on' : ''}`}
        title="見る人に「見たくないかもしれない」と伝える（画像を隠した状態で出る）"
        onClick={onSensitiveToggle}
      >
        センシティブ
      </button>
    </div>
  );
}
