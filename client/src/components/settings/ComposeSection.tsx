/**
 * 設定 → 投稿（ノートを作成したときの既定）。
 * ここで決めた値が、投稿フォームの最初の状態になります。
 */
import { useEffect, useState } from 'react';
import { loadPrefs, type Prefs } from '../../lib/settings';
import { getPrefs, updatePrefs } from '../../lib/prefs';

const VISIBILITY = [
  { value: 'public', label: '連合' },
  { value: 'unlisted', label: 'ひかえめ' },
  { value: 'followers', label: 'フォロワー' },
];

/** リアクションの既定に出す候補（元の UI と同じ並び） */
const REACTIONS = ['👍', '❤️', '🚀', '🎉', '✨', '🔥', '🥺', '😂', '👀', '💯'];

export default function ComposeSection() {
  const [prefs, setPrefs] = useState<Prefs>({});
  const [loading, setLoading] = useState(true);
  const [ok, setOk] = useState('');
  const [cw, setCw] = useState('');

  useEffect(() => {
    void (async () => {
      const loaded = await loadPrefs();
      if (loaded) {
        setPrefs(loaded);
        setCw(String(loaded.defaultCwText || ''));
      }
      setLoading(false);
    })();
  }, []);

  async function update(patch: Prefs) {
    setPrefs((current) => ({ ...current, ...patch }));
    // 保存と同時にアプリ全体へ配る（ショートカットなどはすぐ効いてほしい）
    await updatePrefs(patch);
    setPrefs(getPrefs());
    setOk('保存しました。');
  }

  if (loading) return <div className="feed__state">読み込んでいます…</div>;

  return (
    <>
      <div className="set__group">
        <h3>投稿フォームの最初の状態</h3>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">公開範囲</span>
        </div>
        <div className="set__control">
          <div className="seg">
            {VISIBILITY.map((item) => (
              <button
                key={item.value}
                type="button"
                className={'seg__t' + ((prefs.defaultVisibility || 'public') === item.value ? ' seg__t--on' : '')}
                onClick={() => void update({ defaultVisibility: item.value as Prefs['defaultVisibility'] })}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">センシティブにする</span>
          <p className="set__hint">最初からセンシティブの印をつけておきます。</p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (prefs.defaultSensitive ? ' sw--on' : '')}
            role="switch"
            aria-checked={Boolean(prefs.defaultSensitive)}
            aria-label="センシティブにする"
            onClick={() => void update({ defaultSensitive: !prefs.defaultSensitive })}
          />
        </div>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">CW に入れておく文言</span>
          <p className="set__hint">空なら、CW は閉じた状態で開きます。</p>
          <div className="set__form">
            <input
              className="field"
              value={cw}
              placeholder="例: ネタバレ注意"
              onChange={(event) => setCw(event.target.value)}
            />
            <button
              type="button"
              className="btn btn--quiet"
              disabled={cw === String(prefs.defaultCwText || '')}
              onClick={() => void update({ defaultCwText: cw })}
            >
              保存する
            </button>
          </div>
        </div>
      </div>

      <div className="set__group">
        <h3>添付とリアクション</h3>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">画像を自動で軽くする</span>
          <p className="set__hint">上げる前に、長辺 2048px の WebP に縮めます。</p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (prefs.autoCompressImages !== false ? ' sw--on' : '')}
            role="switch"
            aria-checked={prefs.autoCompressImages !== false}
            aria-label="画像を自動で軽くする"
            onClick={() => void update({ autoCompressImages: prefs.autoCompressImages === false })}
          />
        </div>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">よく使うリアクションの先頭に出すもの</span>
          <p className="set__hint">
            {prefs.recentReactions?.length
              ? `最近: ${prefs.recentReactions.slice(0, 6).join(' ')}`
              : 'まだ履歴はありません（付けると自動でたまります）。'}
          </p>
          <div className="seg seg--wrap" style={{ marginTop: 10 }}>
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className={'seg__t' + (prefs.defaultReaction === emoji ? ' seg__t--on' : '')}
                onClick={() => void update({ defaultReaction: emoji })}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="set__group">
        <h3>操作</h3>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">キーボードショートカットを使う</span>
          <p className="set__hint">n で投稿・/ で検索・? で一覧・g h / g l / g f でタブ切替・j k でノート移動。</p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (prefs.keyboardShortcuts ? ' sw--on' : '')}
            role="switch"
            aria-checked={Boolean(prefs.keyboardShortcuts)}
            aria-label="キーボードショートカットを使う"
            onClick={() => void update({ keyboardShortcuts: !prefs.keyboardShortcuts })}
          />
        </div>
      </div>

      {ok && <p className="set__ok">{ok}</p>}
    </>
  );
}
