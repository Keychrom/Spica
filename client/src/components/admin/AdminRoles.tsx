/**
 * 管理パネル ⑩ロール（権限のまとまり）。
 * 作れるのは「モデレーター（通報対応）」「お知らせの投稿」「管理者」の組み合わせ。
 */
import { useEffect, useState } from 'react';
import {
  createRole,
  deleteRole,
  loadRoles,
  permissionsOf,
  updateRole,
  type AdminRole,
  type PermissionOption,
} from '../../lib/adminRoles';

export default function AdminRoles() {
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [options, setOptions] = useState<PermissionOption[]>([]);
  const [editing, setEditing] = useState<AdminRole | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#6366f1');
  const [perms, setPerms] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  async function load() {
    const next = await loadRoles();
    setRoles(next.roles);
    setOptions(next.permissions);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  function reset() {
    setEditing(null);
    setName('');
    setColor('#6366f1');
    setPerms([]);
  }

  function startEdit(role: AdminRole) {
    setEditing(role);
    setName(role.name);
    setColor(role.color || '#6366f1');
    setPerms(permissionsOf(role));
    setErr('');
    setOk('');
  }

  function labelOf(key: string): string {
    return options.find((option) => option.key === key)?.label ?? key;
  }

  async function submit() {
    setBusy(true);
    setErr('');
    setOk('');
    const problem = editing
      ? await updateRole(editing.id, name.trim(), color, perms)
      : await createRole(name.trim(), color, perms);
    setBusy(false);
    if (problem) {
      setErr(problem);
      return;
    }
    setOk(editing ? 'ロールを更新しました。' : 'ロールを作成しました。');
    reset();
    await load();
  }

  if (loading) return <div className="feed__state">読み込んでいます…</div>;

  return (
    <>
      <div className="set__hint">ロールを配ると、その人ができることをまとめて決められます。</div>

      {roles.length === 0 && <div className="feed__state">まだロールはありません。</div>}

      {roles.map((role) => (
        <div className="set" key={role.id}>
          <div className="set__body">
            <span className="set__label">
              <span className="roledot" style={{ background: role.color || '#6366f1' }} />
              {role.name}
              {role.is_system ? '（組み込み）' : ''}
            </span>
            <p className="set__hint">
              {permissionsOf(role).map(labelOf).join(' ・ ') || '権限なし'} ・ {role.member_count ?? 0} 人が所持
            </p>
          </div>
          <div className="set__control">
            <button type="button" className="btn btn--text" onClick={() => startEdit(role)}>
              編集
            </button>
            {!role.is_system && (
              <button
                type="button"
                className="btn btn--text"
                onClick={() => {
                  if (!window.confirm('このロールを消しますか？（持っている人からも外れます）')) return;
                  void (async () => {
                    if (await deleteRole(role.id)) {
                      setOk('ロールを削除しました。');
                      if (editing?.id === role.id) reset();
                      await load();
                    } else {
                      setErr('削除できませんでした。');
                    }
                  })();
                }}
              >
                削除
              </button>
            )}
          </div>
        </div>
      ))}

      <div className="set__group">
        <h3>{editing ? `「${editing.name}」を編集` : 'ロールを作る'}</h3>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">名前</span>
          <div className="set__form">
            <input className="field" value={name} placeholder="例: モデレーター" onChange={(event) => setName(event.target.value)} />
          </div>
        </div>
        <div className="set__control">
          <span className="set__value">色</span>
          <input
            className="field roledot__pick"
            type="color"
            value={color}
            aria-label="色"
            onChange={(event) => setColor(event.target.value)}
          />
        </div>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">できること</span>
          {options.map((option) => (
            <label className="checkline" key={option.key}>
              <input
                type="checkbox"
                checked={perms.includes(option.key)}
                onChange={(event) =>
                  setPerms((current) =>
                    event.target.checked ? [...current, option.key] : current.filter((key) => key !== option.key),
                  )
                }
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="set">
        <div className="set__body" />
        <div className="set__control set__actions">
          <button
            type="button"
            className="btn btn--quiet"
            disabled={busy || !name.trim() || perms.length === 0}
            onClick={() => void submit()}
          >
            {busy ? '保存しています…' : editing ? '更新する' : '作成する'}
          </button>
          {editing && (
            <button type="button" className="btn btn--text" onClick={reset}>
              やめる
            </button>
          )}
        </div>
      </div>

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}
    </>
  );
}
