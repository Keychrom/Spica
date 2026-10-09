/**
 * 設定 → プロフィール（表示名・自己紹介・アイコン・バナー・項目・公開の設定）。
 */
import { useEffect, useRef, useState } from 'react';
import { loadProfileDraft, saveProfile, uploadImage, type ProfileDraft } from '../../lib/settings';

interface Props {
  myId: string;
}

const EMPTY: ProfileDraft = {
  name: '',
  summary: '',
  icon_url: '',
  banner_url: '',
  is_locked: false,
  discoverable: true,
  noindex: false,
  no_ai_training: false,
  fields: [],
};

export default function ProfileSection({ myId }: Props) {
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState('');
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const bannerRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void (async () => {
      const loaded = await loadProfileDraft(myId);
      if (loaded) setDraft(loaded);
      setLoading(false);
    })();
  }, [myId]);

  function set<K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setOk('');
    setErr('');
  }

  async function onFile(file: File | undefined, key: 'icon_url' | 'banner_url') {
    if (!file) return;
    setBusy(true);
    setErr('');
    const url = await uploadImage(file);
    if (url) set(key, url);
    else setErr('画像をアップロードできませんでした。');
    setBusy(false);
  }

  async function submit() {
    setBusy(true);
    setOk('');
    setErr('');
    const message = await saveProfile(draft);
    if (message) setErr(message);
    else setOk('保存しました。');
    setBusy(false);
  }

  function setField(index: number, part: 'name' | 'value', value: string) {
    const next = draft.fields.map((field, i) => (i === index ? { ...field, [part]: value } : field));
    set('fields', next);
  }

  if (loading) return <div className="feed__state">読み込んでいます…</div>;

  return (
    <>
      <div className="set__group">
        <h3>見た目</h3>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">表示名</span>
          <div className="set__form">
            <input className="field" value={draft.name} onChange={(e) => set('name', e.target.value)} />
          </div>
        </div>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">自己紹介</span>
          <p className="set__hint">改行もそのまま出ます。長さはほどほどに。</p>
          <div className="set__form">
            <textarea
              className="field"
              rows={4}
              value={draft.summary}
              onChange={(e) => set('summary', e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">アイコン</span>
          <p className="set__hint">正方形の画像を選ぶと収まりが良いです。</p>
          <div className="set__form">
            <input
              className="field"
              value={draft.icon_url}
              placeholder="https://… （URL を直接入れてもよい）"
              onChange={(e) => set('icon_url', e.target.value)}
            />
          </div>
        </div>
        <div className="set__control">
          <span className="av av--s">
            {draft.icon_url ? <img src={draft.icon_url} alt="" /> : '？'}
          </span>
          <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => fileRef.current?.click()}>
            選ぶ
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => void onFile(e.target.files?.[0], 'icon_url')}
          />
        </div>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">バナー</span>
          <p className="set__hint">横長（3:1 くらい）の画像。</p>
          <div className="set__form">
            <input
              className="field"
              value={draft.banner_url}
              placeholder="https://…"
              onChange={(e) => set('banner_url', e.target.value)}
            />
          </div>
        </div>
        <div className="set__control">
          <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => bannerRef.current?.click()}>
            選ぶ
          </button>
          <input
            ref={bannerRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => void onFile(e.target.files?.[0], 'banner_url')}
          />
        </div>
      </div>

      <div className="set__group">
        <h3>プロフィール項目（最大 4 つ）</h3>
        <p className="set__hint">趣味・サイト・連絡先など。名前は 40 字、中身は 200 字まで。</p>
      </div>
      {draft.fields.map((field, index) => (
        <div className="set" key={'field-' + index}>
          <div className="set__body">
            <div className="set__form" style={{ maxWidth: 'none' }}>
              <input
                className="field"
                value={field.name}
                placeholder="名前（例: サイト）"
                onChange={(e) => setField(index, 'name', e.target.value)}
              />
              <input
                className="field"
                value={field.value}
                placeholder="中身（例: https://example.com）"
                onChange={(e) => setField(index, 'value', e.target.value)}
              />
            </div>
          </div>
          <div className="set__control">
            <button
              type="button"
              className="btn btn--text"
              onClick={() => set('fields', draft.fields.filter((_, i) => i !== index))}
            >
              削除
            </button>
          </div>
        </div>
      ))}
      {draft.fields.length < 4 && (
        <div className="set">
          <div className="set__body">
            <button
              type="button"
              className="btn btn--text"
              onClick={() => set('fields', [...draft.fields, { name: '', value: '' }])}
            >
              ＋ 項目を足す
            </button>
          </div>
        </div>
      )}

      <div className="set__group">
        <h3>公開の設定</h3>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">承認制にする</span>
          <p className="set__hint">
            オンにすると、リモートからのフォローは承認が必要になります（同じサーバーの人からはそのまま）。
          </p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (draft.is_locked ? ' sw--on' : '')}
            role="switch"
            aria-checked={draft.is_locked}
            aria-label="承認制にする"
            onClick={() => set('is_locked', !draft.is_locked)}
          />
        </div>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">おすすめに出る</span>
          <p className="set__hint">右カラムの「おすすめ」などに載るかどうか。</p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (draft.discoverable ? ' sw--on' : '')}
            role="switch"
            aria-checked={draft.discoverable}
            aria-label="おすすめに出る"
            onClick={() => set('discoverable', !draft.discoverable)}
          />
        </div>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">検索エンジンに載せない</span>
          <p className="set__hint">プロフィールを noindex にします。</p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (draft.noindex ? ' sw--on' : '')}
            role="switch"
            aria-checked={draft.noindex}
            aria-label="検索エンジンに載せない"
            onClick={() => set('noindex', !draft.noindex)}
          />
        </div>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">AI の学習に使わせない</span>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (draft.no_ai_training ? ' sw--on' : '')}
            role="switch"
            aria-checked={draft.no_ai_training}
            aria-label="AI の学習に使わせない"
            onClick={() => set('no_ai_training', !draft.no_ai_training)}
          />
        </div>
      </div>

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}

      <div className="set">
        <div className="set__body" />
        <div className="set__control">
          <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => void submit()}>
            {busy ? '保存しています…' : '保存する'}
          </button>
        </div>
      </div>
    </>
  );
}
