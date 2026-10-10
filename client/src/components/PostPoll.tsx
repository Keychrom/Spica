/**
 * アンケート（投票と結果）。
 * ・1 つだけ / 複数選択、締め切り、投票済みの表示に対応
 * ・開いているときだけ押せる（締め切り後・投票済みは結果だけ）
 */
import { useState } from 'react';
import { votePoll } from '../lib/postActions';
import { formatCount, relativeTime, type Post } from '../lib/format';

export default function PostPoll({ post, canVote }: { post: Post; canVote: boolean }) {
  const poll = post.poll;
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  if (!poll?.choices?.length) return null;
  // ここから下は中身が確定している（関数の中でも使えるように別名をつける）
  const data = poll;
  // サーバーは votes_count で返す（古い形の votes も受ける）
  const countOf = (choice: { votes_count?: number; votes?: number }) => choice.votes_count ?? choice.votes ?? 0;
  const total = data.total_votes ?? data.choices.reduce((sum, c) => sum + countOf(c), 0);
  const open = canVote && !data.my_voted && !data.is_expired;

  function tap(index: number) {
    if (!open) return;
    if (data.multiple) {
      setPicked((current) =>
        current.includes(index) ? current.filter((i) => i !== index) : [...current, index],
      );
      return;
    }
    void send([index]);
  }

  async function send(choices: number[]) {
    if (choices.length === 0 || busy) return;
    setBusy(true);
    await votePoll(post, choices);
    setBusy(false);
    setPicked([]);
  }

  return (
    <div className="poll">
      {data.choices.map((choice, index) => {
        const pct = total > 0 ? Math.round((countOf(choice) / total) * 100) : 0;
        const on = picked.includes(index) || choice.me;
        const inner = (
          <>
            <span className="poll__fill" style={{ width: `${pct}%` }} />
            <span className="poll__row">
              <span>
                {(open || data.multiple) && <span className={`poll__mark${on ? ' poll__mark--on' : ''}`} />}
                {choice.text}
              </span>
              <span className="poll__pct">{pct}%</span>
            </span>
          </>
        );
        return open ? (
          <button type="button" className="poll__opt poll__opt--tap" key={index} onClick={() => tap(index)}>
            {inner}
          </button>
        ) : (
          <div className="poll__opt" key={index}>
            {inner}
          </div>
        );
      })}
      <div className="poll__foot">
        {formatCount(total)}票{poll.expires_at ? ` ・ ${relativeTime(poll.expires_at)}まで` : ''}
        {data.multiple && open && (
          <button
            type="button"
            className="btn btn--text"
            style={{ marginLeft: 10 }}
            disabled={busy || picked.length === 0}
            onClick={() => void send(picked)}
          >
            投票する
          </button>
        )}
      </div>
    </div>
  );
}
