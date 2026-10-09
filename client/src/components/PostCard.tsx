/**
 * 投稿カード（1 部品）。通知・検索・プロフィール・ブックマークでも同じものを使う。
 * 見た目は親から渡されたデータだけで決まる（状態を持たない）。
 */
import { useEffect, useState } from 'react';
import { Bookmark, CornerUpLeft, Quote, Repeat2, Share2 } from 'lucide-react';
import PostMenu from './PostMenu';
import { votePoll } from '../lib/postActions';
import PostMedia from './PostMedia';
import { loadCustomEmojis } from '../lib/media';
import { usePrefs } from '../lib/prefs';
import { postPath } from '../lib/permalink';
import {
  formatContent,
  formatCount,
  isBlankContent,
  relativeTime,
  visibilityLabel,
  type Post,
} from '../lib/format';

export const QUICK_REACTIONS = ['⭐', '❤️', '👍', '🎉', '🤔', '😂'];

interface PostCardProps {
  post: Post;
  onReact: (post: Post, reaction: string) => void;
  onBookmark: (post: Post) => void;
  onRenote: (post: Post) => void;
  onReply: (post: Post) => void;
  onQuote: (post: Post) => void;
  onShare: (post: Post) => void;
  /** リアクションの選択肢を追加で渡す（カスタム絵文字など） */
  extraReactions?: string[];
  /** ログイン中のユーザー ID（自分のノートだけ編集・削除を出す） */
  myId?: string;
  /** 管理できる人か（運営として削除） */
  canModerate?: boolean;
  /** ログインしているか（していなければ投票できない） */
  signedIn?: boolean;
}

function QuoteCard({ post }: { post: Post }) {
  if (!post.quote) return null;
  return (
    <div className="quote">
      <div className="quote__head">
        {post.quote.author_name} <span>{post.quote.author_handle}</span>
      </div>
      <p dangerouslySetInnerHTML={{ __html: formatContent(post.quote.content) }} />
    </div>
  );
}

function Poll({ post, canVote }: { post: Post; canVote: boolean }) {
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

export default function PostCard(props: PostCardProps) {
  const { post, extraReactions = [] } = props;
  const shown = post.renote ?? post;
  const renotedBy = post.renote ? post.author_name : null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cwOpen, setCwOpen] = useState(false);
  const blank = isBlankContent(shown.content);

  const reactions = shown.reactions ?? [];
  const [customEmojis, setCustomEmojis] = useState<string[]>([]);

  // 選択肢を開いたときに、このサーバーのカスタム絵文字（:name:）を足す
  useEffect(() => {
    if (!pickerOpen || customEmojis.length > 0) return;
    void (async () => {
      const list = await loadCustomEmojis();
      setCustomEmojis(list.slice(0, 12).map((item) => `:${item.name}:`));
    })();
  }, [pickerOpen, customEmojis.length]);

  const prefs = usePrefs();
  // 並び: 最近使ったもの → 既定 → 定型 → サーバーのおすすめ → このサーバーの絵文字
  const quick = Array.from(
    new Set(
      [
        ...(prefs.recentReactions || []),
        prefs.defaultReaction || '',
        ...QUICK_REACTIONS,
        ...extraReactions,
        ...customEmojis,
      ].filter(Boolean),
    ),
  ).slice(0, 16);

  return (
    <article className="post">
      <a className="av" href={`/users/${shown.user_id}`} aria-label={shown.author_name}>
        {shown.author_icon ? <img src={shown.author_icon} alt="" /> : shown.author_name.slice(0, 1)}
      </a>

      <div className="post__col">
        {renotedBy && (
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
            <Repeat2 size={13} strokeWidth={1.6} />
            {renotedBy} がリノート
          </div>
        )}

        <div className="meta">
          <a className="meta__name" href={`/users/${shown.user_id}`}>
            {shown.author_name}
          </a>
          <span className="meta__handle">{shown.author_handle}</span>
          <span className="meta__dot">·</span>
          {/* 時刻はそのノートの画面への入口（ローカルは `/users/…`、リモートは `/?post=…`） */}
          <a className="meta__time" href={postPath(shown)} title="このノートを開く">
            {relativeTime(shown.published_at)}
          </a>
          {visibilityLabel(shown.visibility) && (
            <span className="meta__vis">{visibilityLabel(shown.visibility)}</span>
          )}
        </div>

        {shown.cw && !cwOpen ? (
          <button type="button" className="cw" onClick={() => setCwOpen(true)}>
            <b>CW</b>
            <span>{shown.cw}</span>
            <em>開く</em>
          </button>
        ) : (
          <>
            {!blank && (
              <div
                className="body"
                dangerouslySetInnerHTML={{ __html: formatContent(shown.content) }}
              />
            )}
            <PostMedia post={shown} />
            <QuoteCard post={shown} />
            <Poll post={shown} canVote={Boolean(props.signedIn)} />
          </>
        )}

        <div className="rx">
          {reactions.map((r) => (
            <button
              key={r.reaction}
              type="button"
              className={`rx__item${r.me ? ' rx__item--mine' : ''}`}
              onClick={() => props.onReact(shown, r.reaction)}
              title={r.me ? 'リアクションを取り消す' : 'リアクションする'}
            >
              <span>{r.reaction}</span>
              {r.count > 0 && formatCount(r.count)}
            </button>
          ))}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="rx__item rx__add"
              onClick={() => setPickerOpen((open) => !open)}
              aria-label="リアクションを選ぶ"
            >
              ＋
            </button>
            {pickerOpen && (
              <div className="popover" style={{ position: 'absolute', bottom: '120%', left: 0, zIndex: 20 }}>
                {quick.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="rx__item"
                    style={{ border: 0, fontSize: 17, padding: '2px 6px' }}
                    onClick={() => {
                      setPickerOpen(false);
                      props.onReact(shown, emoji);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="acts">
          <button type="button" className="acts__a" onClick={() => props.onReply(shown)}>
            <CornerUpLeft size={16} strokeWidth={1.5} />
            {shown.reply_count ? formatCount(shown.reply_count) : ''}
          </button>
          <button
            type="button"
            className={`acts__a${shown.my_announced ? ' acts__a--on' : ''}`}
            onClick={() => props.onRenote(shown)}
          >
            <Repeat2 size={16} strokeWidth={1.5} />
            {shown.announce_count ? formatCount(shown.announce_count) : ''}
          </button>
          <button type="button" className="acts__a" onClick={() => props.onQuote(shown)}>
            <Quote size={16} strokeWidth={1.5} />
          </button>
          <button type="button" className="acts__a" onClick={() => props.onShare(shown)}>
            <Share2 size={16} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className={`acts__a acts__a--save${shown.bookmarked ? ' acts__a--on' : ''}`}
            onClick={() => props.onBookmark(shown)}
            aria-label="ブックマーク"
          >
            <Bookmark size={16} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <PostMenu
        post={shown}
        signedIn={Boolean(props.signedIn)}
        isMine={Boolean(props.myId) && shown.user_id === props.myId}
        canModerate={props.canModerate}
      />
    </article>
  );
}
