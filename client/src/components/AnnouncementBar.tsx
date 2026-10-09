/**
 * お知らせの帯（管理パネルで出したもの）。
 * 出ているあいだ、どの画面でも本文の上に出る。閉じるとその回のあいだは出さない
 * （サーバー側で消えるか、新しいお知らせが出れば、また出る）。
 * 画面を移るたびに出ていないか見に行く（サーバーは軽い問い合わせ 1 本）。
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Announcement {
  id: string;
  title: string;
  content: string;
}

const SEEN_KEY = 'spica_annc_seen';

function readSeen(): string[] {
  try {
    return (sessionStorage.getItem(SEEN_KEY) || '').split(',').filter(Boolean);
  } catch {
    return [];
  }
}

interface AnnouncementBarProps {
  /** 画面が変わったら出ていないか見に行く（出してすぐ気づけるように） */
  path: string;
}

export default function AnnouncementBar({ path }: AnnouncementBarProps) {
  const [rows, setRows] = useState<Announcement[]>([]);
  const [seen, setSeen] = useState<string[]>(readSeen);

  useEffect(() => {
    void (async () => {
      const res = await api.get('/api/announcements');
      if (!res.ok || !Array.isArray(res.data)) return;
      setRows(res.data as Announcement[]);
    })();
  }, [path]);

  const open = rows.filter((row) => !seen.includes(row.id));
  if (open.length === 0) return null;

  function dismiss() {
    const next = Array.from(new Set([...seen, ...rows.map((row) => row.id)]));
    setSeen(next);
    try {
      sessionStorage.setItem(SEEN_KEY, next.join(','));
    } catch {
      /* 保存できない環境ではそのまま（次に開くとまた出る） */
    }
  }

  return (
    <div className="annc">
      {open.map((row) => (
        <div className="annc__item" key={row.id}>
          <b className="annc__title">{row.title}</b>
          <p className="annc__body">{row.content}</p>
        </div>
      ))}
      <button type="button" className="annc__close" onClick={dismiss} aria-label="お知らせを閉じる">
        閉じる
      </button>
    </div>
  );
}
