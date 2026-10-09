/**
 * 初回設定 3/7: プロフィール（表示名・ひとこと・アイコン）。
 */
import { useRef, useState } from 'react';
import WizFoot from './WizFoot';
import { saveProfile, uploadImage, type ProfileDraft } from '../../lib/settings';

interface Props {
  draft: ProfileDraft;
  onChange: (draft: ProfileDraft) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function StepProfile({ draft, onChange, onNext, onBack }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setErr('');
    const url = await uploadImage(file);
    if (url) onChange({ ...draft, icon_url: url });
    else setErr('画像をアップロードできませんでした。');
    setBusy(false);
  }

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
        <h2>あなたのこと</h2>
        <p className="wiz__lead">
          はじめての人に、あなただと分かってもらうための最小限です。あとから変えられます。
        </p>

        <div className="set">
          <div className="set__body">
            <span className="set__label">表示名</span>
            <div className="set__form">
              <input
                className="field"
                value={draft.name}
                onChange={(e) => onChange({ ...draft, name: e.target.value })}
              />
            </div>
          </div>
        </div>

        <div className="set">
          <div className="set__body">
            <span className="set__label">アイコン</span>
            <p className="set__hint">正方形の画像を 1 枚。無ければ頭文字が出ます。</p>
          </div>
          <div className="set__control">
            <span className="av av--s">
              {draft.icon_url ? <img src={draft.icon_url} alt="" /> : (draft.name || '？').slice(0, 1)}
            </span>
            <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => fileRef.current?.click()}>
              選ぶ
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => void pick(e.target.files?.[0])}
            />
          </div>
        </div>

        <div className="set">
          <div className="set__body">
            <span className="set__label">ひとこと</span>
            <p className="set__hint">好きなこと、書いていること、など。</p>
            <div className="set__form">
              <textarea
                className="field"
                rows={3}
                value={draft.summary}
                onChange={(e) => onChange({ ...draft, summary: e.target.value })}
              />
            </div>
          </div>
        </div>

        {err && <p className="set__err">{err}</p>}
      </div>
      <WizFoot onBack={onBack} onNext={() => void save()} busy={busy} />
    </>
  );
}
