/**
 * ブックマークしたノートをクリップ（フォルダ）へ入れる画面。
 * クリップは Misskey の clips と同じで、1 つのノートを複数のフォルダに入れられる。
 */
import { useEffect, useState } from 'react';
import { api, messageOf } from '../lib/api';
import type { Post } from '../lib/format';

interface ClipRow {
  id: string;
  name: string;
  notes_count?: number;
  contains?: boolean;
}

interface Props {
  post: Post;
  onClose: () => void;
}

export default function ClipPicker({ post, onClose }: Props) {
  const [clips, setClips] = useState<ClipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');

  // 自分のクリップ（このノートが入っているか contains 付き）
  useEffect(() => {
    void (async () => {
      const res = await api.get('/api/clips?postId=' + encodeURIComponent(post.id));
      if (res.ok && Array.isArray(res.data)) setClips(res.data as ClipRow[]);
      setLoading(false);
    })();
  }, [post.id]);

  async function toggle(clip: ClipRow) {
    setBusy(clip.id);
    setErr('');
    const base = '/api/clips/' + encodeURIComponent(clip.id) + '/notes';
    const res = clip.contains
      ? await api.del(base + '/' + encodeURIComponent(post.id))
      : await api.post(base, { postId: post.id });
    setBusy('');
    if (!res.ok) {
      setErr(messageOf(res.data, 'フォルダを変更できませんでした。'));
      return;
    }
    setClips((current) =>
      current.map((row) =>
        row.id === clip.id
          ? {
              ...row,
              contains: !clip.contains,
              notes_count: Math.max(0, Number(row.notes_count || 0) + (clip.contains ? -1 : 1)),
            }
          : row,
      ),
    );
  }

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setErr('');
    const res = await api.post('/api/clips', { name: trimmed });
    if (!res.ok) {
      setCreating(false);
      setErr(messageOf(res.data, 'フォルダを作成できませんでした。'));
      return;
    }
    const created = res.data as ClipRow;
    // 作ったフォルダに、いま開いているノートをそのまま入れる
    const added = await api.post('/api/clips/' + encodeURIComponent(created.id) + '/notes', {
      postId: post.id,
    });
    setCreating(false);
    if (!added.ok) {
      setErr(messageOf(added.data, 'フォルダは作りましたが、ノートを追加できませんでした。'));
    }
    setName('');
    setClips((current) => [
      { ...created, contains: added.ok, notes_count: added.ok ? 1 : 0 },
      ...current,
    ]);
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet__head">
          <b>フォルダ（クリップ）に入れる</b>
          <button type="button" className="btn btn--text" onClick={onClose}>
            閉じる
          </button>
        </div>

        <div className="sheet__body">
          <p className="set__hint">
            「{(post.content || '').slice(0, 40) || '（本文なし）'}」を入れるフォルダを選んでください。
          </p>

          {loading && <p className="set__hint">読み込んでいます…</p>}
          {!loading && clips.length === 0 && (
            <p className="set__hint">フォルダはまだありません。下で作れます。</p>
          )}
          {clips.map((clip) => (
            <label key={clip.id} className="extra__check">
              <input
                type="checkbox"
                checked={Boolean(clip.contains)}
                disabled={busy === clip.id}
                onChange={() => void toggle(clip)}
              />
              {clip.name}
              <span className="set__hint">（{clip.notes_count || 0}件）</span>
            </label>
          ))}

          <div style={{ display: 'flex', gap: 8, paddingTop: 8 }}>
            <input
              className="field"
              value={name}
              maxLength={60}
              placeholder="新しいフォルダ名"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void create();
                }
              }}
            />
            <button
              type="button"
              className="btn btn--quiet"
              disabled={creating || !name.trim()}
              onClick={() => void create()}
            >
              {creating ? '作成中…' : '作る'}
            </button>
          </div>

          {err && <p className="set__err">{err}</p>}
        </div>
      </div>
    </div>
  );
}
