/**
 * 初回設定 5/7: 公開の設定（だれに見つかってよいか）。
 */
import { useState } from 'react';
import WizFoot from './WizFoot';
import { saveProfile, type ProfileDraft } from '../../lib/settings';

interface Props {
  draft: ProfileDraft;
  onChange: (draft: ProfileDraft) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function StepPrivacy({ draft, onChange, onNext, onBack }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setBusy(true);
    setErr('');
    const message = await saveProfile(draft);
    setBusy(false);
    if (message) {
      setErr(message);
      return;
    }
    onNext();
  }

  return (
    <>
      <div className="wiz__step">
        <h2>だれに見つかってよいか</h2>
        <p className="wiz__lead">あとから 設定 → プロフィール で変えられます。迷ったら、このままで大丈夫です。</p>

        <div className="set">
          <div className="set__body">
            <span className="set__label">おすすめに出る</span>
            <p className="set__hint">右カラムの「おすすめ」などに載ります。オフにすると、自分から見つけてもらう機会が減ります。</p>
          </div>
          <div className="set__control">
            <button
              type="button"
              className={'sw' + (draft.discoverable ? ' sw--on' : '')}
              role="switch"
              aria-checked={draft.discoverable}
              aria-label="おすすめに出る"
              onClick={() => onChange({ ...draft, discoverable: !draft.discoverable })}
            />
          </div>
        </div>

        <div className="set">
          <div className="set__body">
            <span className="set__label">検索エンジンに載せない</span>
            <p className="set__hint">Google などに拾われないようにします（noindex）。</p>
          </div>
          <div className="set__control">
            <button
              type="button"
              className={'sw' + (draft.noindex ? ' sw--on' : '')}
              role="switch"
              aria-checked={draft.noindex}
              aria-label="検索エンジンに載せない"
              onClick={() => onChange({ ...draft, noindex: !draft.noindex })}
            />
          </div>
        </div>

        <div className="set">
          <div className="set__body">
            <span className="set__label">AI の学習に使わせない</span>
            <p className="set__hint">ノートを機械学習の材料にしないよう、意思表示します。</p>
          </div>
          <div className="set__control">
            <button
              type="button"
              className={'sw' + (draft.no_ai_training ? ' sw--on' : '')}
              role="switch"
              aria-checked={draft.no_ai_training}
              aria-label="AI の学習に使わせない"
              onClick={() => onChange({ ...draft, no_ai_training: !draft.no_ai_training })}
            />
          </div>
        </div>

        <div className="set">
          <div className="set__body">
            <span className="set__label">承認制にする</span>
            <p className="set__hint">リモートからのフォローを承認制にします（同じサーバーの人はそのまま）。</p>
          </div>
          <div className="set__control">
            <button
              type="button"
              className={'sw' + (draft.is_locked ? ' sw--on' : '')}
              role="switch"
              aria-checked={draft.is_locked}
              aria-label="承認制にする"
              onClick={() => onChange({ ...draft, is_locked: !draft.is_locked })}
            />
          </div>
        </div>

        {err && <p className="set__err">{err}</p>}
      </div>
      <WizFoot onBack={onBack} onNext={() => void save()} busy={busy} />
    </>
  );
}
