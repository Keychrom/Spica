/**
 * 欄外（右カラム）に出すデータ: サーバー情報・話題のタグ・おすすめ。
 * 起動時に 3 本まとめて取りに行くだけ（ログインで「おすすめ」から自分を外す）。
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import type { DirectoryUser, ServerInfo, TagCount } from './format';

export interface AsideData {
  server: ServerInfo | null;
  tags: TagCount[];
  directory: DirectoryUser[];
}

export function useAsideData(myId: string | undefined): AsideData {
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);

  useEffect(() => {
    void (async () => {
      const res = await api.get('/api/server-info', { auth: false });
      if (res.ok && res.data) setServer(res.data as ServerInfo);
    })();
    void (async () => {
      const res = await api.get('/api/tags/popular', { auth: false });
      if (res.ok && Array.isArray(res.data)) setTags(res.data as TagCount[]);
    })();
    void (async () => {
      // ログイン中はトークンも送る（サーバーが「自分」と「フォロー中」を外してくれる）
      const res = await api.get('/api/directory');
      if (res.ok && res.data && typeof res.data === 'object') {
        const data = res.data as { users?: DirectoryUser[] };
        // 画面側でもフォロー済みを除くので、多めに持っておく
        setDirectory((data.users ?? []).filter((item) => item.id !== myId).slice(0, 12));
      }
    })();
  }, [myId]);

  return { server, tags, directory };
}
