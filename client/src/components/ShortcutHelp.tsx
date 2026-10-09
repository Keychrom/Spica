/**
 * キーボードショートカットの一覧（? で開閉）。
 */
const KEYS: [string, string][] = [
  ['n', 'ノートを作成'],
  ['/', '検索へ'],
  ['j / k', '次のノート / 前のノート'],
  ['g → h', 'ホーム'],
  ['g → l', 'ローカル'],
  ['g → f', '連合'],
  ['?', 'この一覧を閉じる'],
];

interface ShortcutHelpProps {
  open: boolean;
  onClose: () => void;
}

export default function ShortcutHelp({ open, onClose }: ShortcutHelpProps) {
  if (!open) return null;
  return (
    <div className="help" onClick={onClose} role="presentation">
      <div className="help__card" onClick={(event) => event.stopPropagation()}>
        <h2 className="help__title">キーボードショートカット</h2>
        {KEYS.map(([key, label]) => (
          <div className="help__row" key={key}>
            <kbd>{key}</kbd>
            <span>{label}</span>
          </div>
        ))}
        <p className="set__hint">設定 → 投稿 で入切できます。</p>
      </div>
    </div>
  );
}
