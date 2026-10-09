/**
 * プロフィールの見出し（バナー・顔・名前・数・フォローのボタン）。
 * 高さと余白は案K のまま（カードにせず、罫線で下と区切る）。
 */
import { useState } from 'react';
import { relativeTime } from '../lib/format';
import { initialOf, type Profile } from '../lib/profile';

interface ProfileHeaderProps {
  profile: Profile;
  /** 自分のプロフィールか */
  isMe: boolean;
  signedIn: boolean;
  busy: boolean;
  onFollow: () => void;
  onRelation: (action: 'mute' | 'unmute' | 'block' | 'unblock') => void;
  onOpenPeople: (kind: 'followers' | 'following') => void;
  onMessage?: () => void;
  onEdit: () => void;
}

export default function ProfileHeader({
  profile,
  isMe,
  signedIn,
  busy,
  onFollow,
  onRelation,
  onOpenPeople,
  onMessage,
  onEdit,
}: ProfileHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const fields = (profile.fields || []).filter((field) => field && field.name);

  return (
    <div className="prof">
      <div className="prof__banner">{profile.banner_url && <img src={profile.banner_url} alt="" />}</div>

      <div className="prof__top">
        <span className="prof__av">
          {profile.icon_url ? <img src={profile.icon_url} alt="" /> : initialOf(profile.name)}
        </span>
        <div className="prof__act">
          {isMe ? (
            <button type="button" className="btn btn--quiet" onClick={onEdit}>
              プロフィールを編集
            </button>
          ) : (
            signedIn && (
              <>
                {onMessage && (
                  <button type="button" className="btn btn--quiet" onClick={onMessage}>
                    メッセージ
                  </button>
                )}
                <button
                  type="button"
                  className="iconbtn"
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-label="その他"
                  aria-expanded={menuOpen}
                  title="ミュート・ブロック"
                >
                  ⋯
                </button>
                <button
                  type="button"
                  className={profile.is_following ? 'btn btn--quiet' : 'btn btn--outline'}
                  disabled={busy}
                  onClick={onFollow}
                >
                  {profile.is_following ? 'フォロー解除' : profile.is_locked ? 'フォローをリクエスト' : 'フォロー'}
                </button>
              </>
            )
          )}
        </div>
      </div>

      <h1 className="prof__name">{profile.name}</h1>
      <p className="prof__handle">{profile.handle}</p>

      <div className="prof__badges">
        {profile.is_locked && <span className="prof__badge prof__badge--lock">承認制</span>}
        {profile.is_local === false && <span className="prof__badge">連合</span>}
        {(profile.roles || []).map((role) => (
          <span className="prof__badge" key={role.id || role.name}>
            {role.name}
          </span>
        ))}
        {profile.created_at && <span className="prof__badge">{relativeTime(profile.created_at)} に参加</span>}
      </div>

      {profile.summary && <p className="prof__note">{profile.summary}</p>}

      {fields.length > 0 && (
        <div className="prof__meta">
          {fields.map((field) => (
            <span className="prof__meta-item" key={field.name + field.value}>
              <b>{field.name}</b>
              {field.value}
            </span>
          ))}
        </div>
      )}

      <div className="prof__counts">
        <span className="prof__count">
          <b>{profile.post_count ?? 0}</b>ノート
        </span>
        <button type="button" className="prof__count" onClick={() => onOpenPeople('following')}>
          <b>{profile.following_count ?? 0}</b>フォロー
        </button>
        <button type="button" className="prof__count" onClick={() => onOpenPeople('followers')}>
          <b>{profile.follower_count ?? 0}</b>フォロワー
        </button>
      </div>

      {menuOpen && !isMe && (
        <div className="menu">
          <button
            type="button"
            className="menu__i"
            onClick={() => {
              setMenuOpen(false);
              onRelation(profile.is_muted ? 'unmute' : 'mute');
            }}
          >
            {profile.is_muted ? 'ミュートを解除' : 'ミュートする'}
          </button>
          <button
            type="button"
            className="menu__i menu__i--danger"
            onClick={() => {
              setMenuOpen(false);
              onRelation(profile.is_blocked ? 'unblock' : 'block');
            }}
          >
            {profile.is_blocked ? 'ブロックを解除' : 'ブロックする'}
          </button>
        </div>
      )}
    </div>
  );
}
