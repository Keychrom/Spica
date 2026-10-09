/**
 * 投稿カレンダー（自分のプロフィールに出す）。
 * 月ごとの件数だけを出す。押せばその月のノートが見られる、という作りにはまだしていない。
 */
import { useEffect, useState } from 'react';
import { loadPostCalendar, type CalendarDay } from '../lib/me';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];

function monthLabel(month: string): string {
  const [year, mon] = month.split('-');
  return `${year}年${Number(mon)}月`;
}

function shiftMonth(month: string, diff: number): string {
  const [year, mon] = month.split('-').map((part) => Number(part));
  const date = new Date(year, mon - 1 + diff, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export default function PostCalendar() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [days, setDays] = useState<CalendarDay[]>([]);

  useEffect(() => {
    void (async () => {
      setDays(await loadPostCalendar(month));
    })();
  }, [month]);

  const [year, mon] = month.split('-').map((part) => Number(part));
  const firstDow = new Date(year, mon - 1, 1).getDay();
  const lastDay = new Date(year, mon, 0).getDate();
  const counts = new Map(days.map((row) => [row.day.slice(-2), row.count]));
  const total = days.reduce((sum, row) => sum + (row.count || 0), 0);
  const today = new Date().toISOString().slice(0, 10);

  const cells: { key: string; day?: number }[] = [];
  for (let i = 0; i < firstDow; i += 1) cells.push({ key: 'blank-' + i });
  for (let day = 1; day <= lastDay; day += 1) cells.push({ key: 'day-' + day, day });

  return (
    <div className="cal">
      <div className="cal__head">
        <button type="button" className="cal__nav" aria-label="前の月" onClick={() => setMonth(shiftMonth(month, -1))}>
          ‹
        </button>
        <span className="cal__month">{monthLabel(month)}</span>
        <button type="button" className="cal__nav" aria-label="次の月" onClick={() => setMonth(shiftMonth(month, 1))}>
          ›
        </button>
        <span className="cal__sum">この月 {total} 件</span>
      </div>
      <div className="cal__dow">
        {DOW.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="cal__grid">
        {cells.map((cell) => {
          if (!cell.day) return <span className="cal__cell cal__cell--blank" key={cell.key} />;
          const key = String(cell.day).padStart(2, '0');
          const count = counts.get(key) || 0;
          const date = `${month}-${key}`;
          const className =
            'cal__cell' +
            (count > 0 ? ' cal__cell--on' : '') +
            (count >= 3 ? ' cal__cell--hot' : '') +
            (date === today ? ' cal__cell--today' : '');
          return (
            <span className={className} key={cell.key} title={count ? `${date} ・ ${count} 件` : date}>
              {cell.day}
              {count > 0 && <b className="cal__n">{count}</b>}
            </span>
          );
        })}
      </div>
    </div>
  );
}
