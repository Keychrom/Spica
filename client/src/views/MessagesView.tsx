/**
 * メッセージ（/messages）。
 * サーバーで有効なときだけ使える（無効なら理由を出す）。
 * 左に会話の一覧、選んだ会話を下に開く（1 画面で完結させる）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import ScreenHead from '../components/ScreenHead';
import { navigate } from '../lib/router';
import { relativeTime } from '../lib/format';
import { initialOf } from '../lib/profile';
import {
  loadConversations,
  loadThread,
  markRead,
  sendMessage,
  type DmConversation,
  type DmMessage,
} from '../lib/dm';

interface MessagesViewProps {
  menuButton: ReactNode;
  signedIn: boolean;
  /** サーバーで DM が有効か（/api/server-info の features.dm） */
  dmEnabled: boolean;
  /** サーバー情報が読めたか */
  loaded: boolean;
  /** /messages?to=… （プロフィールの「メッセージ」から） */
  to?: string;
}

export default function MessagesView({ menuButton, signedIn, dmEnabled, loaded, to }: MessagesViewProps) {
  const [conversations, setConversations] = useState<DmConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [partner, setPartner] = useState<DmConversation['partner'] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** やりとりを開いたら、最後の 1 通（書き込み欄）まで送る */
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    if (!signedIn || !dmEnabled) return;
    const list = await loadConversations();
    setConversations(list);
    return list;
  }, [signedIn, dmEnabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useCallback(async (id: string) => {
    setActiveId(id);
    setErr('');
    const thread = await loadThread(id);
    if (!thread) {
      setErr('この会話を開けませんでした。');
      return;
    }
    // 古い順に並べ、読んだことを伝える
    setMessages([...thread.messages].sort((a, b) => a.published_at.localeCompare(b.published_at)));
    setPartner(thread.conversation?.partner ?? null);
    if ((thread.conversation?.unread_count ?? 0) > 0) {
      await markRead(id);
      setConversations((current) => current.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)));
    }
  }, []);

  // 開いた直後は、いちばん新しい 1 通へ（スマホでも書き込み欄が近い）
  useEffect(() => {
    if (!activeId || messages.length === 0) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [activeId, messages.length]);

  // ?to=… で来たら、その相手の会話を探して開く（無ければ「新しく書きはじめる」状態にする）
  useEffect(() => {
    if (!to || !dmEnabled) return;
    void (async () => {
      const list = (await refresh()) ?? [];
      const target = to.replace(/^@/, '').toLowerCase();
      const found = list.find((conversation) => {
        const handle = (conversation.partner.handle || '').replace(/^@/, '').toLowerCase();
        const id = (conversation.partner.user_id || '').toLowerCase();
        return handle === target || id === target;
      });
      if (found) void open(found.id);
      else setPartner({ actor_url: '', user_id: null, handle: to });
    })();
  }, [to, dmEnabled, refresh, open]);

  async function submit() {
    const content = draft.trim();
    if (!content || busy) return;
    const target = partner?.handle || to;
    if (!target) {
      setErr('宛先が分かりません。プロフィールの「メッセージ」から開いてください。');
      return;
    }
    setBusy(true);
    setErr('');
    const problem = await sendMessage(target, content);
    setBusy(false);
    if (problem) {
      setErr(problem);
      return;
    }
    setDraft('');
    if (activeId) void open(activeId);
    else void refresh();
  }

  if (!signedIn) {
    return (
      <>
        <ScreenHead title="メッセージ" menuButton={menuButton} />
        <div className="divider" />
        <div className="feed">
          <div className="feed__state">
            メッセージを見るにはログインしてください。
            <br />
            <button type="button" className="btn btn--text" onClick={() => navigate('/login')}>
              ログイン / 新規登録
            </button>
          </div>
        </div>
      </>
    );
  }

  if (loaded && !dmEnabled) {
    return (
      <>
        <ScreenHead title="メッセージ" menuButton={menuButton} />
        <div className="divider" />
        <div className="feed">
          <div className="feed__state">
            このサーバーでは、いまメッセージ（DM）は使えません。
            <br />
            運営が有効にすると、ここでやりとりできるようになります。
          </div>
        </div>
      </>
    );
  }

  const active = conversations.find((conversation) => conversation.id === activeId);

  return (
    <>
      <ScreenHead
        title="メッセージ"
        sub={to || activeId ? 'やりとり' : conversations.length > 0 ? `${conversations.length}件の会話` : undefined}
        menuButton={menuButton}
        onReload={() => void refresh()}
      />
      <div className="divider" />

      <div className="dm">
        {conversations.length === 0 && !to && (
          <div className="feed__state">
            まだ会話はありません。
            <br />
            相手のプロフィールの「メッセージ」から始められます。
          </div>
        )}

        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            className="dm__list"
            onClick={() => void open(conversation.id)}
          >
            <span className="dm__row">
              <span className="av av--s">
                {conversation.partner.icon_url ? (
                  <img src={conversation.partner.icon_url} alt="" />
                ) : (
                  initialOf(conversation.partner.name)
                )}
              </span>
              <span className="dm__row-body">
                <span className="dm__name">{conversation.partner.name || conversation.partner.handle}</span>
                <span className="dm__last">
                  {conversation.last_message?.is_mine ? '自分: ' : ''}
                  {conversation.last_message?.content || '（メディア）'}
                </span>
              </span>
              <span className="dm__time">
                {conversation.last_message?.published_at
                  ? relativeTime(conversation.last_message.published_at)
                  : ''}
              </span>
              {(conversation.unread_count ?? 0) > 0 && <span className="dm__dot" />}
            </span>
          </button>
        ))}

        {(activeId || to) && (
          <>
            <div className="divider" />
            <div className="dm__thread">
              {messages.map((message) => (
                <div className={`dm__msg${message.is_mine ? ' dm__msg--mine' : ''}`} key={message.id}>
                  <span className="dm__msg-head">
                    <b>{message.is_mine ? '自分' : message.author?.name || partner?.name || '相手'}</b>
                    {relativeTime(message.published_at)}
                  </span>
                  <p className="dm__msg-text">{message.content}</p>
                </div>
              ))}
              {messages.length === 0 && (
                <p className="set__hint">
                  {partner?.accepts_dm === false
                    ? 'この相手はメッセージを受け取らない設定にしています。'
                    : 'ここに書いた内容がそのまま届きます。'}
                </p>
              )}
            </div>

            {err && <p className="set__err">{err}</p>}
            <div ref={bottomRef} />
            <div className="dm__compose">
              <textarea
                className="field"
                value={draft}
                placeholder="メッセージを書く"
                onChange={(event) => setDraft(event.target.value)}
              />
              <button type="button" className="btn btn--quiet" disabled={busy || !draft.trim()} onClick={() => void submit()}>
                {busy ? '送信中…' : '送る'}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
