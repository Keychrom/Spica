/**
 * 管理パネル ②利用者（凍結・役割・退会）。
 * 自分自身には凍結のボタンを出さない（サーバーも断る）。
 */
import { Fragment, useEffect, useState } from 'react';
import { deleteUser, freezeUser, loadAdminUsers, setUserRole, type AdminUser } from '../../lib/admin';
import { loadRoles, setUserRoles, type AdminRole } from '../../lib/adminRoles';
import { initialOf } from '../../lib/profile';
import { relativeTime } from '../../lib/format';

interface Props {
  myId: string;
}

export default function AdminUsers({ myId }: Props) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [query, setQuery] = useState('');
  /** ロールを配れる一覧（ロール節で作ったもの） */
  const [allRoles, setAllRoles] = useState<AdminRole[]>([]);
  /** いまロールを選んでいる相手 */
  const [pickedFor, setPickedFor] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      setUsers(await loadAdminUsers());
      const roles = await loadRoles();
      setAllRoles(roles.roles);
      setLoading(false);
    })();
  }, []);

  function openRoles(user: AdminUser) {
    setPickedFor(user.id);
    setPicked((user.roles || []).map((role) => role.id));
    setErr('');
    setOk('');
  }

  async function saveRoles(user: AdminUser) {
    setBusy(user.id);
    const problem = await setUserRoles(user.id, picked);
    setBusy('');
    if (problem) {
      setErr(problem);
      return;
    }
    setPickedFor(null);
    flash(`${user.name || user.id} のロールを変えました。`);
    setUsers(await loadAdminUsers());
  }

  function flash(message: string) {
    setOk(message);
    setErr('');
  }

  async function run(id: string, work: () => Promise<string | null>, message: string) {
    setBusy(id);
    const problem = await work();
    setBusy('');
    if (problem) {
      setErr(problem);
      return;
    }
    flash(message);
    setUsers(await loadAdminUsers());
  }

  if (loading) return <div className="feed__state">読み込んでいます…</div>;

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? users.filter((user) => user.id.includes(needle) || (user.name || '').toLowerCase().includes(needle))
    : users;

  return (
    <>
      <div className="set">
        <div className="set__body">
          <div className="set__form" style={{ maxWidth: 320 }}>
            <input
              className="field"
              value={query}
              placeholder="ユーザー ID や名前で絞る"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <div className="set__control">
          <span className="set__value">{shown.length} 人</span>
        </div>
      </div>

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}

      {shown.map((user) => {
        const frozen = Boolean(user.is_frozen);
        const isAdmin = user.role === 'admin';
        const isMe = user.id === myId;
        return (
          <Fragment key={user.id}>
          <div className="people">
            <span className="av av--s">{initialOf(user.name || user.id)}</span>
            <div className="people__body">
              <b>
                {user.name || user.id} {isAdmin && <span className="prof__badge">管理者</span>}
                {(user.roles || []).map((role) => (
                  <span className="prof__badge" key={role.id}>
                    <span className="roledot" style={{ background: role.color || '#6366f1' }} />
                    {role.name}
                  </span>
                ))}
                {frozen && <span className="prof__badge prof__badge--lock">凍結中</span>}
                {user.approval_status === 'pending' && <span className="prof__badge">承認待ち</span>}
              </b>
              <span>
                @{user.id} ・ ノート {user.post_count ?? 0} ・ フォロワー {user.follower_count ?? 0}
                {user.created_at ? ` ・ ${relativeTime(user.created_at)} に参加` : ''}
              </span>
            </div>

            {!isMe && (
              <>
                <button
                  type="button"
                  className="btn btn--quiet"
                  disabled={busy === user.id}
                  onClick={() =>
                    void run(
                      user.id,
                      () => freezeUser(user.id, !frozen),
                      frozen ? `${user.name || user.id} の凍結を解除しました。` : `${user.name || user.id} を凍結しました。`,
                    )
                  }
                >
                  {frozen ? '凍結を解除' : '凍結'}
                </button>
                <button
                  type="button"
                  className="btn btn--text"
                  disabled={busy === user.id}
                  onClick={() =>
                    void run(
                      user.id,
                      () => setUserRole(user.id, isAdmin ? 'user' : 'admin'),
                      isAdmin ? '管理者を外しました。' : '管理者にしました。',
                    )
                  }
                >
                  {isAdmin ? '管理者を外す' : '管理者にする'}
                </button>
            <button type="button" className="btn btn--text" onClick={() => (pickedFor === user.id ? setPickedFor(null) : openRoles(user))}>
              ロール
            </button>
                <button
                  type="button"
                  className="btn btn--text"
                  disabled={busy === user.id}
                  onClick={() => {
                    if (!window.confirm(`${user.name || user.id} のアカウントを削除しますか？（元には戻せません）`)) return;
                    void run(user.id, () => deleteUser(user.id), `${user.name || user.id} を削除しました。`);
                  }}
                >
                  削除
                </button>
              </>
            )}
          </div>

          {pickedFor === user.id && (
            <div className="set">
              <div className="set__body">
                <span className="set__label">ロールを配る</span>
                {allRoles.length === 0 && (
                  <p className="set__hint">まだロールがありません。「ロール」の節で作ってください。</p>
                )}
                {allRoles.map((role) => (
                  <label className="checkline" key={role.id}>
                    <input
                      type="checkbox"
                      checked={picked.includes(role.id)}
                      onChange={(event) =>
                        setPicked((current) =>
                          event.target.checked ? [...current, role.id] : current.filter((id) => id !== role.id),
                        )
                      }
                    />
                    <span>
                      <span className="roledot" style={{ background: role.color || '#6366f1' }} />
                      {role.name}
                    </span>
                  </label>
                ))}
              </div>
              <div className="set__control set__actions">
                <button type="button" className="btn btn--quiet" disabled={busy === user.id} onClick={() => void saveRoles(user)}>
                  保存
                </button>
                <button type="button" className="btn btn--text" onClick={() => setPickedFor(null)}>
                  やめる
                </button>
              </div>
            </div>
          )}
          </Fragment>
        );
      })}
    </>
  );
}
