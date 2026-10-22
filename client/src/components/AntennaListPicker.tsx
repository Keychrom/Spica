/**
 * アンテナの「リスト」選択（自分のリストを読み込んで選ぶ）。
 * アンテナの src = 'list' のときだけ CollectionEditor から出す。
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Props {
  /** 選択中のリスト id（空なら未選択） */
  value: string;
  onChange: (listId: string) => void;
}

interface ListRow {
  id: string;
  name: string;
  members?: unknown[];
}

export default function AntennaListPicker({ value, onChange }: Props) {
  const [lists, setLists] = useState<ListRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await api.get('/api/lists');
      if (res.ok && Array.isArray(res.data)) setLists(res.data as ListRow[]);
      setLoaded(true);
    })();
  }, []);

  if (!loaded) {
    return <p className="set__hint">リストを読み込んでいます…</p>;
  }
  if (lists.length === 0) {
    return (
      <p className="set__hint">
        リストがありません。先に「リスト」を作って、メンバーを追加してください。
      </p>
    );
  }

  return (
    <select className="field" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">リストを選ぶ</option>
      {lists.map((list) => (
        <option key={list.id} value={list.id}>
          {list.name}（{(list.members || []).length}人）
        </option>
      ))}
    </select>
  );
}
