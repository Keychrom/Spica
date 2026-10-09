/**
 * 設定 → 安全（2段階認証・引っ越し・アカウントの削除）。
 * 取り返しがつきにくい操作なので、確認を挟んでから実行する。
 */
import { useEffect, useState } from 'react';
import TotpSection from './TotpSection';
import ReportHistory from './ReportHistory';
import PasskeySection from './PasskeySection';
import { api, messageOf } from '../../lib/api';
import { loadAuthMode, verifyPassword } from '../../lib/settings';

interface MigrationState {
  actorUrl?: string;
  movedTo?: string;
  alsoKnownAs?: string;
  followers?: number;
}

interface Props {
  myId: string;
  /** パスワードを設定しているか（従来型の入口で本人確認できるか） */
  hasPassword: boolean;
  onLogout: () => void;
}

export default function SecuritySection({ myId, hasPassword, onLogout }: Props) {
  /**
   * 削除のときの本人確認。
   * ・従来型（メール＋パスワード）のサーバー → パスワードで確認する（マスターキーは使わない）
   * ・マスターキー方式のサーバー → これまでどおりマスターキー（他の方法が無いため）
   */
  const [authMode, setAuthMode] = useState<'master_key' | 'password' | null>(null);
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [migration, setMigration] = useState<MigrationState | null>(null);
  const [alias, setAlias] = useState('');
  const [moveTo, setMoveTo] = useState('');
  const [deleteKey, setDeleteKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  async function loadMigration() {
    const res = await api.get('/api/user/migration');
    if (res.ok && res.data && typeof res.data === 'object') setMigration(res.data as MigrationState);
  }

  useEffect(() => {
    void loadMigration();
    void (async () => setAuthMode(await loadAuthMode()))();
  }, []);

  const byPassword = authMode === 'password' && hasPassword;

  function flash(message: string) {
    setOk(message);
    setErr('');
  }

  async function saveAlias() {
    setBusy(true);
    setErr('');
    const res = await api.post('/api/user/migration/alias', { alsoKnownAs: alias.trim() });
    setBusy(false);
    if (!res.ok) {
      setErr(messageOf(res.data, '保存できませんでした。'));
      return;
    }
    setAlias('');
    await loadMigration();
    flash('引っ越し先の候補を登録しました。');
  }

  async function move() {
    setBusy(true);
    setErr('');
    const res = await api.post('/api/user/migration/move', { movedTo: moveTo.trim() });
    setBusy(false);
    if (!res.ok) {
      setErr(messageOf(res.data, '引っ越せませんでした。'));
      return;
    }
    setMoveTo('');
    await loadMigration();
    flash('引っ越しを記録しました。このあと新しいサーバーで同じ人として投稿できます。');
  }

  async function deleteMe() {
    if (!window.confirm('アカウントを削除します。元には戻せません。よろしいですか？')) return;
    setBusy(true);
    setErr('');

    if (byPassword) {
      // パスワードで本人確認してから削除する（マスターキーは使わない）。
      // 2 段階認証を有効にしているときは、そのコードも一緒に確かめる。
      const problem = await verifyPassword(myId, password, totp.trim() || undefined);
      if (problem === 'TOTP_REQUIRED') {
        setNeedTotp(true);
        setBusy(false);
        setErr('2段階認証コードを入力してください。');
        return;
      }
      if (problem) {
        setBusy(false);
        setErr(problem);
        return;
      }
    }

    const res = await api.post('/api/user/delete-me', {
      confirmUserId: myId,
      ...(byPassword ? {} : { masterKey: deleteKey.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(messageOf(res.data, '削除できませんでした。'));
      return;
    }
    onLogout();
  }

  return (
    <>
      <TotpSection />

      <div className="set__group">
        <h3>引っ越し（別のサーバーへ）</h3>
        <p className="set__hint">
          引っ越すと、フォロワーの人たちに新しい居場所が伝わります。いまのフォロワー: {migration?.followers ?? 0} 人
          {migration?.movedTo ? `（引っ越し先: ${migration.movedTo}）` : ''}
        </p>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">引っ越し先を先に登録しておく</span>
          <div className="extra__choice" style={{ marginTop: 8 }}>
            <input
              className="field"
              value={alias}
              placeholder="@you@new.example.com"
              onChange={(event) => setAlias(event.target.value)}
            />
            <button type="button" className="btn btn--quiet" disabled={busy || !alias.trim()} onClick={() => void saveAlias()}>
              登録
            </button>
          </div>
        </div>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">引っ越しを実行</span>
          <p className="set__hint">先に引っ越し先のサーバーで同じアカウントを作ってから実行してください。</p>
          <div className="extra__choice" style={{ marginTop: 8 }}>
            <input
              className="field"
              value={moveTo}
              placeholder="@you@new.example.com"
              onChange={(event) => setMoveTo(event.target.value)}
            />
            <button type="button" className="btn btn--quiet" disabled={busy || !moveTo.trim()} onClick={() => void move()}>
              引っ越す
            </button>
          </div>
        </div>
      </div>

      <div className="set__group">
        <h3>アカウントの削除</h3>
        <p className="set__hint">
          ノートもフォローも消えます（元には戻せません）。残したいときは「データ」の節で持ち出してからにしてください。
          {byPassword ? '削除の確認はパスワードで行います（マスターキーは使いません）。' : ''}
        </p>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">{byPassword ? 'パスワードを入れて削除' : 'マスターキーを入れて削除'}</span>
          <div className="extra__choice" style={{ marginTop: 8 }}>
            {byPassword ? (
              <>
                <input
                  className="field"
                  type="password"
                  value={password}
                  placeholder="パスワード"
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                />
                {needTotp && (
                  <input
                    className="field"
                    value={totp}
                    placeholder="2段階認証コード"
                    inputMode="numeric"
                    onChange={(event) => setTotp(event.target.value)}
                  />
                )}
              </>
            ) : (
              <input
                className="field"
                value={deleteKey}
                placeholder="spica_sk_..."
                onChange={(event) => setDeleteKey(event.target.value)}
              />
            )}
            <button
              type="button"
              className="btn btn--text"
              disabled={busy || (byPassword ? !password : !deleteKey.trim())}
              onClick={() => void deleteMe()}
            >
              削除する
            </button>
          </div>
        </div>
      </div>

      <PasskeySection />

      <ReportHistory />

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}
    </>
  );
}
