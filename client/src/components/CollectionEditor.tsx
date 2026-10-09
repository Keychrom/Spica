/**
 * リスト・アンテナ・チャンネルの作成と編集（1 つの画面で兼ねる）。
 * 画面の種類（kind）で入力する欄を変える。作る・直す・消すをここでやる。
 */
import { useEffect, useState } from 'react';
import ListMembers from './ListMembers';
import { api, messageOf } from '../lib/api';
import type { CollectionKind } from '../views/CollectionView';

export interface EditableItem {
  id?: string;
  /** リストのメンバー（サーバーが返す） */
  members?: { id: string; member: string; display_name?: string }[];
  name?: string;
  description?: string;
  keywords?: string | string[];
  exclude_keywords?: string | string[];
  src?: string;
  notify?: boolean;
  with_file?: boolean;
  color?: string;
  category?: string;
  is_following?: boolean;
}

interface Props {
  kind: CollectionKind;
  /** 編集するもの（新規なら undefined） */
  item?: EditableItem;
  onClose: () => void;
  /** 保存・削除のあと、一覧を読み直してもらう */
  onSaved: () => void;
}

const KIND_LABEL: Record<CollectionKind, string> = {
  bookmarks: 'ブックマーク',
  lists: 'リスト',
  antennas: 'アンテナ',
  channels: 'チャンネル',
};

const SRC = [
  { value: 'all', label: '連合（すべて）' },
  { value: 'home', label: 'ホーム' },
  { value: 'users', label: '指定した人' },
];

function asText(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(', ');
  return value || '';
}

export default function CollectionEditor({ kind, item, onClose, onSaved }: Props) {
  const [name, setName] = useState(item?.name || '');
  const [description, setDescription] = useState(item?.description || '');
  const [keywords, setKeywords] = useState(asText(item?.keywords));
  const [exclude, setExclude] = useState(asText(item?.exclude_keywords));
  const [src, setSrc] = useState(item?.src || 'all');
  const [notify, setNotify] = useState(Boolean(item?.notify));
  const [withFile, setWithFile] = useState(Boolean(item?.with_file));
  const [color, setColor] = useState(item?.color || '#6d5ae6');
  const [category, setCategory] = useState(item?.category || 'general');
  const [follow, setFollow] = useState(Boolean(item?.is_following));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    void loadFollowState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** チャンネルだけ「フォローしているか」を持っている */
  async function loadFollowState() {
    if (kind !== 'channels') return;
    const res = await api.get('/api/channels');
    if (res.ok && Array.isArray(res.data) && item?.id) {
      const found = (res.data as EditableItem[]).find((row) => row.id === item.id);
      if (found) setFollow(Boolean(found.is_following));
    }
  }

  async function save() {
    if (!name.trim()) {
      setErr('名前を入力してください。');
      return;
    }
    setBusy(true);
    setErr('');
    const body =
      kind === 'lists'
        ? { name: name.trim() }
        : kind === 'antennas'
          ? {
              name: name.trim(),
              src,
              keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean).join(','),
              exclude_keywords: exclude.split(',').map((k) => k.trim()).filter(Boolean).join(','),
              notify,
              with_file: withFile,
            }
          : { name: name.trim(), description: description.trim(), color, category: category.trim() || 'general' };

    const res = item?.id
      ? await api.put('/api/' + kind + '/' + encodeURIComponent(item.id), body)
      : await api.post('/api/' + kind, body);
    setBusy(false);
    if (!res.ok) {
      setErr(messageOf(res.data, '保存できませんでした。'));
      return;
    }
    onSaved();
    onClose();
  }

  async function remove() {
    if (!item?.id) return;
    if (!window.confirm(`「${item.name || KIND_LABEL[kind]}」を削除しますか？`)) return;
    setBusy(true);
    const res = await api.del('/api/' + kind + '/' + encodeURIComponent(item.id));
    setBusy(false);
    if (!res.ok) {
      setErr(messageOf(res.data, '削除できませんでした。'));
      return;
    }
    onSaved();
    onClose();
  }

  async function toggleFollow() {
    if (!item?.id) return;
    setBusy(true);
    const res = await api.post('/api/channels/' + encodeURIComponent(item.id) + '/follow');
    setBusy(false);
    if (!res.ok) {
      setErr(messageOf(res.data, 'フォローを変えられませんでした。'));
      return;
    }
    setFollow((current) => !current);
    setNotice('フォローを切り替えました。');
    onSaved();
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet__head">
          <b>
            {item?.id ? `${KIND_LABEL[kind]}を編集` : `${KIND_LABEL[kind]}を作る`}
          </b>
          <button type="button" className="btn btn--text" onClick={onClose}>
            閉じる
          </button>
        </div>

        <div className="sheet__body">
          <div className="set__form" style={{ maxWidth: 'none' }}>
            <input
              className="field"
              value={name}
              placeholder={kind === 'lists' ? 'リスト名' : kind === 'antennas' ? 'アンテナ名' : 'チャンネル名'}
              onChange={(event) => setName(event.target.value)}
            />

            {kind === 'channels' && (
              <>
                <input
                  className="field"
                  value={description}
                  placeholder="説明（任意）"
                  onChange={(event) => setDescription(event.target.value)}
                />
                <label className="extra__check">
                  色
                  <input
                    type="color"
                    value={color}
                    onChange={(event) => setColor(event.target.value)}
                    style={{ width: 44, height: 32, border: '1px solid var(--line)', borderRadius: 8 }}
                  />
                </label>
              </>
            )}

            {kind === 'antennas' && (
              <>
                <label className="extra__check">
                  拾う範囲
                  <select className="field" value={src} onChange={(event) => setSrc(event.target.value)}>
                    {SRC.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <input
                  className="field"
                  value={keywords}
                  placeholder="含む言葉（カンマ区切り。例: イラスト, 写真）"
                  onChange={(event) => setKeywords(event.target.value)}
                />
                <input
                  className="field"
                  value={exclude}
                  placeholder="除く言葉（カンマ区切り）"
                  onChange={(event) => setExclude(event.target.value)}
                />
                <label className="extra__check">
                  <input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} />
                  新着を通知する
                </label>
                <label className="extra__check">
                  <input type="checkbox" checked={withFile} onChange={(event) => setWithFile(event.target.checked)} />
                  メディア付きだけ拾う
                </label>
              </>
            )}
          </div>

          {kind === 'lists' && item?.id && <ListMembers listId={item.id} onChanged={onSaved} />}

          {err && <p className="set__err">{err}</p>}
          {notice && <p className="set__ok">{notice}</p>}
        </div>

        <div className="sheet__foot">
          <span className="sheet__count">
            {item?.id && kind !== 'bookmarks' && (
              <button type="button" className="btn btn--text" disabled={busy} onClick={() => void remove()}>
                削除
              </button>
            )}
          </span>
          {kind === 'channels' && item?.id && (
            <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => void toggleFollow()}>
              {follow ? 'フォロー中' : 'フォローする'}
            </button>
          )}
          <button type="button" className="btn btn--quiet" disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy ? '保存しています…' : '保存する'}
          </button>
        </div>
      </div>
    </div>
  );
}
