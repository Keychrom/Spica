/**
 * 管理パネル ⑥絵文字と招待コード（サーバーで使う小さな台帳を 1 画面に）。
 */
import { useEffect, useState } from 'react';
import {
  addAdminEmoji,
  createInvitation,
  deleteAdminEmoji,
  deleteInvitation,
  loadAdminEmojis,
  loadInvitations,
  type CustomEmojiRow,
  type Invitation,
} from '../../lib/admin';
import { relativeTime } from '../../lib/format';

export default function AdminAssets() {
  const [emojis, setEmojis] = useState<CustomEmojiRow[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const [emojiName, setEmojiName] = useState('');
  const [emojiUrl, setEmojiUrl] = useState('');
  const [emojiCategory, setEmojiCategory] = useState('');
  const [maxUses, setMaxUses] = useState('1');
  const [memo, setMemo] = useState('');

  async function load() {
    const [nextEmojis, nextInvites] = await Promise.all([loadAdminEmojis(), loadInvitations()]);
    setEmojis(nextEmojis);
    setInvites(nextInvites);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function addEmoji() {
    setErr('');
    setOk('');
    const problem = await addAdminEmoji(emojiName.trim(), emojiUrl.trim(), emojiCategory.trim());
    if (problem) {
      setErr(problem);
      return;
    }
    setEmojiName('');
    setEmojiUrl('');
    setEmojiCategory('');
    setOk('絵文字を登録しました。');
    await load();
  }

  async function addInvite() {
    setErr('');
    setOk('');
    const problem = await createInvitation(Number(maxUses) || 1, null, memo.trim());
    if (problem) {
      setErr(problem);
      return;
    }
    setMemo('');
    setOk('招待コードを作りました。');
    await load();
  }

  if (loading) return <div className="feed__state">読み込んでいます…</div>;

  return (
    <>
      <div className="set__group">
        <h3>カスタム絵文字（{emojis.length}）</h3>
        <p className="set__hint">名前は半角（例: spica）。`:spica:` として使えるようになります。</p>
      </div>

      {emojis.length > 0 && (
        <div className="emoji-pop">
          <div className="emoji-pop__list">
            {emojis.map((emoji) => (
              <button
                key={emoji.id}
                type="button"
                className="emoji-pop__item"
                title={`:${emoji.name}: を削除`}
                onClick={() =>
                  void (async () => {
                    if (!window.confirm(`:${emoji.name}: を削除しますか？`)) return;
                    if (await deleteAdminEmoji(emoji.id)) setEmojis(await loadAdminEmojis());
                  })()
                }
              >
                <img src={emoji.url} alt={emoji.name} />
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="set">
        <div className="set__body">
          <span className="set__label">絵文字を足す</span>
          <div className="extra__choice" style={{ marginTop: 8 }}>
            <input className="field" value={emojiName} placeholder="名前（spica）" onChange={(e) => setEmojiName(e.target.value)} />
            <input className="field" value={emojiUrl} placeholder="画像の URL" onChange={(e) => setEmojiUrl(e.target.value)} />
            <input className="field" value={emojiCategory} placeholder="分類（任意）" onChange={(e) => setEmojiCategory(e.target.value)} />
            <button type="button" className="btn btn--quiet" disabled={!emojiName.trim() || !emojiUrl.trim()} onClick={() => void addEmoji()}>
              登録
            </button>
          </div>
        </div>
      </div>

      <div className="set__group">
        <h3>招待コード（{invites.length}）</h3>
        <p className="set__hint">登録が「招待制」のとき、このコードを持っている人だけが登録できます。</p>
      </div>

      {invites.map((invite) => (
        <div className="set" key={invite.code}>
          <div className="set__body">
            <span className="set__label" style={{ fontFamily: 'var(--mono)' }}>{invite.code}</span>
            <p className="set__hint">
              {invite.uses ?? 0} / {invite.max_uses ?? 1} 回使用
              {invite.memo ? ` ・ ${invite.memo}` : ''}
              {invite.created_at ? ` ・ ${relativeTime(invite.created_at)}に作成` : ''}
            </p>
          </div>
          <div className="set__control">
            <button
              type="button"
              className="btn btn--text"
              onClick={() =>
                void (async () => {
                  if (await deleteInvitation(invite.code)) setInvites(await loadInvitations());
                })()
              }
            >
              無効にする
            </button>
          </div>
        </div>
      ))}

      <div className="set">
        <div className="set__body">
          <span className="set__label">招待コードを作る</span>
          <div className="extra__choice" style={{ marginTop: 8 }}>
            <input className="field" value={maxUses} placeholder="使える回数" onChange={(e) => setMaxUses(e.target.value)} />
            <input className="field" value={memo} placeholder="メモ（誰に渡すか等）" onChange={(e) => setMemo(e.target.value)} />
            <button type="button" className="btn btn--quiet" onClick={() => void addInvite()}>
              作る
            </button>
          </div>
        </div>
      </div>

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}
    </>
  );
}
