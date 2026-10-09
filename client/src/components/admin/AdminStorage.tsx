/**
 * 管理パネル ⑬メディアストレージ（S3 互換。未設定ならこのサーバーの中に保存する）。
 */
import { useEffect, useState } from 'react';
import { loadStorage, saveStorage, testStorage, type StorageDraft } from '../../lib/adminMail';

const EMPTY: StorageDraft = {
  endpoint: '',
  bucket: '',
  accessKeyId: '',
  secretAccessKey: '',
  publicUrl: '',
  region: '',
};

export default function AdminStorage() {
  const [configured, setConfigured] = useState(false);
  const [draft, setDraft] = useState<StorageDraft>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => {
    void (async () => {
      const state = await loadStorage();
      if (state) {
        setConfigured(Boolean(state.configured));
        setDraft({
          endpoint: state.endpoint || '',
          bucket: state.bucket || '',
          accessKeyId: state.accessKeyId || '',
          secretAccessKey: '',
          publicUrl: state.publicUrl || '',
          region: state.region || '',
        });
      }
      setLoaded(true);
    })();
  }, []);

  function set<K extends keyof StorageDraft>(key: K, value: StorageDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function run(kind: 'save' | 'test') {
    setBusy(kind);
    setErr('');
    setOk('');
    const problem = kind === 'save' ? await saveStorage(draft) : await testStorage(draft);
    setBusy('');
    if (problem) {
      setErr(problem);
      return;
    }
    setOk(kind === 'save' ? 'ストレージ設定を保存しました。' : '接続できました。');
    if (kind === 'save') {
      const state = await loadStorage();
      setConfigured(Boolean(state?.configured));
      setDraft((current) => ({ ...current, secretAccessKey: '' }));
    }
  }

  if (!loaded) return <div className="feed__state">読み込んでいます…</div>;

  const rows: [keyof StorageDraft, string, string][] = [
    ['endpoint', 'エンドポイント', 'https://s3.example.com'],
    ['bucket', 'バケット', 'spica-media'],
    ['region', 'リージョン', 'us-east-1'],
    ['accessKeyId', 'アクセスキー', ''],
    ['secretAccessKey', 'シークレットキー', '変えるときだけ入力'],
    ['publicUrl', '公開URL（任意）', 'https://media.example.com'],
  ];

  return (
    <>
      <div className="set__hint">
        {configured
          ? 'メディア（画像・動画）は、この設定のストレージに保存します。'
          : '未設定です。メディアはこのサーバーの中（data フォルダ）に保存します。'}
      </div>

      {rows.map(([key, label, placeholder]) => (
        <div className="set" key={key}>
          <div className="set__body">
            <span className="set__label">{label}</span>
            <div className="set__form">
              <input
                className="field"
                type={key === 'secretAccessKey' ? 'password' : 'text'}
                value={draft[key]}
                placeholder={placeholder}
                onChange={(event) => set(key, event.target.value)}
              />
            </div>
          </div>
        </div>
      ))}

      <div className="set">
        <div className="set__body" />
        <div className="set__control set__actions">
          <button type="button" className="btn btn--quiet" disabled={Boolean(busy)} onClick={() => void run('save')}>
            {busy === 'save' ? '保存しています…' : '保存する'}
          </button>
          <button type="button" className="btn btn--text" disabled={Boolean(busy) || !draft.bucket.trim()} onClick={() => void run('test')}>
            {busy === 'test' ? '試しています…' : '接続を試す'}
          </button>
        </div>
      </div>

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}
    </>
  );
}
