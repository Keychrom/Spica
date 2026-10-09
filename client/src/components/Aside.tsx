/**
 * 欄外（右）のカード: 話題のタグ / このサーバー / おすすめ。
 * 3 枚だけ。増やすときは「常に要る情報か」を先に考える。
 */
import { formatCount, type DirectoryUser, type ServerInfo, type TagCount } from '../lib/format';

interface AsideProps {
  /** リアルタイム接続（SSE）が生きているか */
  live?: boolean;
  server: ServerInfo | null;
  tags: TagCount[];
  recommended: DirectoryUser[];
  followed: Set<string>;
  signedIn: boolean;
  onFollow: (user: DirectoryUser) => void;
}

export default function Aside({ live, server, tags, recommended, followed, signedIn, onFollow }: AsideProps) {
  const stats = server?.stats;
  return (
    <>
      {tags.length > 0 && (
        <section className="card">
          <h2>話題のタグ</h2>
          {tags.slice(0, 5).map((tag) => (
            <a className="card__row card__row--link" key={tag.tag} href={`/tags/${encodeURIComponent(tag.tag)}`}>
              <span className="card__tag">#{tag.tag}</span>
              <span className="card__num">{formatCount(tag.count)}</span>
            </a>
          ))}
        </section>
      )}

      <section className="card">
        <h2>このサーバー</h2>
        {signedIn && (
          <div className="card__row">
            <span>リアルタイム</span>
            <span className="card__num" style={{ color: live ? 'var(--live)' : 'var(--text-faint)' }}>
              {live ? '接続中' : '待機中'}
            </span>
          </div>
        )}
        <div className="card__row">
          <span>ユーザー</span>
          <span className="card__num">{formatCount(stats?.users)}</span>
        </div>
        <div className="card__row">
          <span>ノート</span>
          <span className="card__num">{formatCount(stats?.totalPosts)}</span>
        </div>
        <div className="card__row">
          <span>連合受信</span>
          <span className="card__num">{formatCount(stats?.federatedPosts)}</span>
        </div>
      </section>

      {recommended.length > 0 && (
        <section className="card">
          <h2>おすすめ</h2>
          {recommended.slice(0, 3).map((user) => (
            <div className="card__who" key={user.id}>
              <span className="av av--s">
                {user.icon_url ? <img src={user.icon_url} alt="" /> : user.name.slice(0, 1)}
              </span>
              <a className="card__who-body" href={`/users/${user.id}`}>
                <b>{user.name}</b>
                <span>{user.handle}</span>
              </a>
              {signedIn && (
                <button
                  type="button"
                  className="btn btn--outline"
                  onClick={() => onFollow(user)}
                  disabled={followed.has(user.handle)}
                >
                  {followed.has(user.handle) ? 'フォロー中' : 'フォロー'}
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </>
  );
}
