/**
 * リストに入れる人の管理（設定ではなくリストの編集画面で使う）。
 * 追加は @user / @user@host のどちらでもよい。
 */
import { useEffect, useState } from 'react';
import { api, messageOf } from '../lib/api';

interface Member {
  id: string;
  member: string;
  display_name?: string;
}

interface Props {
  listId: string;
  /** 変わったら一覧を読み直してもらう */
  onChanged: () => void;
}

export default function ListMembers({ listId, onChanged }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    const res = await api.get('/api/lists');
    if (!res.ok || !Array.isArray(res.data)) return;
    const found = (res.data as { id: string; members?: Member[] }[]).find((row) => row.id === listId);
    setMembers(found?.members || []);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId]);

  async function add() {
    const raw = input.trim();
    if (!raw) return;
    setBusy(true);
    setErr('');
    const res = await api.post('/api/lists/' + encodeURIComponent(listId) + '/members', { member: raw });
    setBusy(false);
    if (!res.ok) {
      setErr(messageOf(res.data, '追加できませんでした。'));
      return;
    }
    setInput('');
    await load();
    onChanged();
  }

  async function remove(memberId: string) {
    setBusy(true);
    const res = await api.del('/api/lists/' + encodeURIComponent(listId) + '/members/' + encodeURIComponent(memberId));
    setBusy(false);
    if (!res.ok) {
      setErr(messageOf(res.data, '外せませんでした。'));
      return;
    }
    setMembers((current) => current.filter((row) => row.id !== memberId));
    onChanged();
  }

  return (
    <div style={{ marginTop: 4 }}>
      <span className="set__label">入れる人（{members.length}）</span>
      <p className="set__hint">@suiren のように書いて足せます。リストにはこの人のノートが並びます。</p>

      {members.map((row) => (
        <div className="people" key={row.id}>
          <div className="people__body">
            <b>{row.display_name || row.member}</b>
            <span>@{row.member}</span>
          </div>
          <button type="button" className="btn btn--text" disabled={busy} onClick={() => void remove(row.id)}>
            外す
          </button>
        </div>
      ))}

      <div className="extra__choice" style={{ marginTop: 10 }}>
        <input
          className="field"
          value={input}
          placeholder="@suiren"
          onChange={(event) => setInput(event.target.value)}
        />
        <button type="button" className="btn btn--quiet" disabled={busy || !input.trim()} onClick={() => void add()}>
          足す
        </button>
      </div>
      {err && <p className="set__err">{err}</p>}
    </div>
  );
}
