/**
 * 設定 → 通知 の中の「通知音」。
 * ・新着ノート（ホームや連合に届いたとき）と、自分が投稿したときの 2 つ
 * ・選べるのは `client/public/sounds/` の 8 つ（`SOUNDS`）＋「鳴らさない」
 * ・試聴ボタンでその場で確かめられる（音を選ぶときに毎回投稿するのは嫌なので）
 */
import { SOUNDS, SOUND_OFF, DEFAULT_SOUND_ON_NOTE, DEFAULT_SOUND_ON_POST, playSound } from '../../lib/sounds';
import { updatePrefs, usePrefs } from '../../lib/prefs';

export default function SoundSection() {
  const prefs = usePrefs();
  const onNote = typeof prefs.soundOnNote === 'string' ? prefs.soundOnNote : DEFAULT_SOUND_ON_NOTE;
  const onPost = typeof prefs.soundOnPost === 'string' ? prefs.soundOnPost : DEFAULT_SOUND_ON_POST;

  const rows = [
    {
      key: 'soundOnNote' as const,
      label: '新着ノートが届いたとき',
      hint: 'ホーム・ローカル・連合のタブに新しいノートが届いたときに鳴ります（自分の投稿では鳴りません）。',
      value: onNote,
    },
    {
      key: 'soundOnPost' as const,
      label: '自分が投稿したとき',
      hint: 'ノートを投稿できたときに鳴ります（予約投稿が実行されたときは鳴りません）。',
      value: onPost,
    },
  ];

  return (
    <>
      <div className="set__group">
        <h3>通知音</h3>
        <p className="set__hint">
          「鳴らさない」も選べます。ブラウザの都合で、
          <strong>この画面を開いてから何か操作するまでは鳴りません</strong>。
        </p>
      </div>
      {rows.map((row) => (
        <div className="set" key={row.key}>
          <div className="set__body">
            <span className="set__label">{row.label}</span>
            <p className="set__hint">{row.hint}</p>
          </div>
          <div className="set__control">
            <select
              className="field set__sound"
              aria-label={row.label}
              value={row.value}
              onChange={(event) => void updatePrefs({ [row.key]: event.target.value })}
            >
              <option value={SOUND_OFF}>鳴らさない</option>
              {SOUNDS.map((sound) => (
                <option key={sound.id} value={sound.id}>
                  {sound.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--text"
              disabled={!row.value}
              onClick={() => playSound(row.value)}
            >
              試聴
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
