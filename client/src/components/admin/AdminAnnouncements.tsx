/**
 * 管理パネル ⑭お知らせ（ログイン中の人の画面の上に出る案内）。
 */
import { useEffect, useState } from 'react';
import { deleteAnnouncement, loadAnnouncements, saveAnnouncement, type Announcement } from '../../lib/adminOps';
import { relativeTime } from '../../lib/format';

export default function AdminAnnouncements() {
  const [rows, setRows] = useState<Announcement[]>([]);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  async function load() {
    setRows(await loadAnnouncements());
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  function reset() {
    setEditing(null);
    setTitle('');
    setContent('');
    setIsActive(true);
  }

  function startEdit(row: Announcement) {
    setEditing(row);
    setTitle(row.title);
    setContent(row.content);
    setIsActive(Boolean(row.is_active));
    setErr('');
    setOk('');
  }

  async function submit() {
    setBusy(true);
    setErr('');
    setOk('');
    const problem = await saveAnnouncement({ id: editing?.id, title: title.trim(), content: content.trim(), isActive });
    setBusy(false);
    if (problem) {
      setErr(problem);
      return;
    }
    setOk(editing ? 'お知らせを更新しました。' : 'お知らせを出しました。');
    reset();
    await load();
  }

  async function toggle(row: Announcement) {
    setErr('');
    setOk('');
    const problem = await saveAnnouncement({
      id: row.id,
      title: row.title,
      content: row.content,
      isActive: !row.is_active,
    });
    if (problem) {
      setErr(problem);
      return;
    }
    setOk('切り替えました。');
    await load();
  }

  if (loading) return <div className="feed__state">読み込んでいます…</div>;

  return (
    <>
      <div className="set__hint">出しているあいだ、ログイン中の人の画面のいちばん上に表示されます。</div>

      {rows.length === 0 && <div className="feed__state">お知らせはまだありません。</div>}

      {rows.map((row) => (
        <div className="set" key={row.id}>
          <div className="set__body">
            <span className="set__label">{row.title}</span>
            <p className="set__hint">
              {row.content.length > 60 ? row.content.slice(0, 60) + '…' : row.content}
              {row.created_at ? ` ・ ${relativeTime(row.created_at)}` : ''}
            </p>
          </div>
          <div className="set__control">
            <button
              type="button"
              className={'sw' + (row.is_active ? ' sw--on' : '')}
              role="switch"
              aria-checked={Boolean(row.is_active)}
              aria-label={row.title + ' を出す'}
              onClick={() => void toggle(row)}
            />
            <button type="button" className="btn btn--text" onClick={() => startEdit(row)}>
              編集
            </button>
            <button
              type="button"
              className="btn btn--text"
              onClick={() => {
                if (!window.confirm('このお知らせを消しますか？')) return;
                void (async () => {
                  if (await deleteAnnouncement(row.id)) {
                    setOk('削除しました。');
                    if (editing?.id === row.id) reset();
                    await load();
                  } else {
                    setErr('削除できませんでした。');
                  }
                })();
              }}
            >
              削除
            </button>
          </div>
        </div>
      ))}

      <div className="set__group">
        <h3>{editing ? 'お知らせを編集' : 'お知らせを出す'}</h3>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">見出し</span>
          <div className="set__form">
            <input className="field" value={title} placeholder="例: メンテナンスのお知らせ" onChange={(e) => setTitle(e.target.value)} />
            <textarea
              className="field"
              rows={4}
              value={content}
              placeholder="本文"
              onChange={(e) => setContent(e.target.value)}
            />
          </div>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (isActive ? ' sw--on' : '')}
            role="switch"
            aria-checked={isActive}
            aria-label="出す"
            onClick={() => setIsActive(!isActive)}
          />
        </div>
      </div>
      <div className="set">
        <div className="set__body" />
        <div className="set__control set__actions">
          <button
            type="button"
            className="btn btn--quiet"
            disabled={busy || !title.trim() || !content.trim()}
            onClick={() => void submit()}
          >
            {busy ? '保存しています…' : editing ? '更新する' : '出す'}
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
