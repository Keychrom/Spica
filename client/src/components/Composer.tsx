/**
 * ノートを作成（モーダル）。
 * 送るのは本文・公開範囲・CW・センシティブ・返信先・引用元・添付・アンケート・予約。
 */
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api, messageOf } from '../lib/api';
import { deleteDraft, saveDraft, schedulePost } from '../lib/drafts';
import ComposerExtras, { type PollDraft } from './ComposerExtras';
import ComposerOptions from './ComposerOptions';
import { getPrefs } from '../lib/prefs';
import { loadCustomEmojis, type Attachment, type CustomEmoji } from '../lib/media';
import type { Post, SessionUser } from '../lib/format';

const MAX_LENGTH = 3000;

interface ComposerProps {
  user: SessionUser;
  replyTo?: Post | null;
  quoteOf?: Post | null;
  /** 下書きの続きから開くとき */
  initialContent?: string;
  initialCw?: string;
  draftId?: string;
  onClose: () => void;
  onPosted: () => void;
}

export default function Composer({
  user,
  replyTo,
  quoteOf,
  initialContent = '',
  initialCw = '',
  draftId,
  onClose,
  onPosted,
}: ComposerProps) {
  // 設定の「投稿の既定」から始める（返信・引用・下書きから開いたときは、その内容を優先）
  const start = getPrefs();
  const startCw = initialCw || (!replyTo && !quoteOf ? String(start.defaultCwText || '') : '');
  const [content, setContent] = useState(initialContent);
  const [cw, setCw] = useState(startCw);
  const [cwOn, setCwOn] = useState(Boolean(startCw));
  const [sensitive, setSensitive] = useState(Boolean(start.defaultSensitive));
  const [when, setWhen] = useState('');
  const [media, setMedia] = useState<Attachment[]>([]);
  const [poll, setPoll] = useState<PollDraft | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojis, setEmojis] = useState<CustomEmoji[]>([]);

  useEffect(() => {
    if (!emojiOpen || emojis.length > 0) return;
    void (async () => setEmojis(await loadCustomEmojis()))();
  }, [emojiOpen, emojis.length]);

  /** カーソルの位置に :name: を差し込む */
  function insertEmoji(name: string) {
    const area = areaRef.current;
    const token = `:${name}: `;
    if (!area) {
      setContent((current) => current + token);
      return;
    }
    const start = area.selectionStart ?? content.length;
    const end = area.selectionEnd ?? start;
    const next = content.slice(0, start) + token + content.slice(end);
    setContent(next);
    setEmojiOpen(false);
    window.requestAnimationFrame(() => {
      area.focus();
      const at = start + token.length;
      area.setSelectionRange(at, at);
    });
  }
  const [visibility, setVisibility] = useState(String(start.defaultVisibility || 'public'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    areaRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, cw, cwOn, visibility]);

  /** アンケートは空の選択肢を落として、2 つ以上あるときだけ送る */
  function pollPayload() {
    if (!poll) return undefined;
    const choices = poll.choices.map((choice) => choice.trim()).filter(Boolean);
    if (choices.length < 2) return undefined;
    return {
      choices,
      multiple: poll.multiple,
      ...(poll.expiresIn > 0 ? { expiresIn: poll.expiresIn } : {}),
    };
  }

  async function submit() {
    const text = content.trim();
    if ((!text && media.length === 0) || busy) return;
    setBusy(true);
    setError('');
    const res = await api.post('/api/posts', {
      content: text,
      visibility,
      cw: cwOn && cw.trim() ? cw.trim() : undefined,
      is_sensitive: sensitive,
      in_reply_to: replyTo?.id,
      quote_id: quoteOf?.id,
      ...(media.length > 0 ? { attachments: media } : {}),
      ...(pollPayload() ? { poll: pollPayload() } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(messageOf(res.data, '投稿できませんでした。'));
      return;
    }
    // 下書きから出したときは、下書きを片付ける
    if (draftId) await deleteDraft(draftId);
    onPosted();
    onClose();
  }

  async function keepDraft() {
    const text = content.trim();
    if (!text) return;
    setBusy(true);
    setError('');
    const problem = await saveDraft({ content: text, cw: cwOn && cw.trim() ? cw.trim() : '' });
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    if (draftId) await deleteDraft(draftId);
    onPosted();
    onClose();
  }

  async function reserve() {
    const text = content.trim();
    if (!text || !when) return;
    const at = new Date(when);
    if (Number.isNaN(at.getTime())) {
      setError('日時を選んでください。');
      return;
    }
    setBusy(true);
    setError('');
    const problem = await schedulePost({
      content: text,
      cw: cwOn && cw.trim() ? cw.trim() : '',
      scheduled_at: at.toISOString(),
    });
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    if (draftId) await deleteDraft(draftId);
    onPosted();
    onClose();
  }

  const remaining = MAX_LENGTH - content.length;
  const title = replyTo ? '返信' : quoteOf ? '引用ノート' : 'ノートを作成';

  return (
    <div className="modal" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet__head">
          <b>{title}</b>
          {/* 閉じるボタン。スマホ・タブレットには Esc が無く、全画面のシートは外側も叩けない */}
          <button type="button" className="sheet__close" onClick={onClose} aria-label="閉じる" title="閉じる（Esc）">
            <X size={18} strokeWidth={1.7} />
          </button>
        </div>

        {replyTo && (
          <div className="sheet__cw">
            <span style={{ fontSize: 12.5, color: 'var(--text-sub)' }}>
              {replyTo.author_name} さんへの返信
            </span>
          </div>
        )}
        {quoteOf && (
          <div className="sheet__cw">
            <span style={{ fontSize: 12.5, color: 'var(--text-sub)' }}>
              引用：{quoteOf.author_name} のノート
            </span>
          </div>
        )}

        <div className="sheet__body">
          <span className="av av--pearl" style={{ width: 42, height: 42 }}>
            {user.icon_url ? <img src={user.icon_url} alt="" /> : user.name.slice(0, 1)}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            {cwOn && (
              <input
                className="field"
                style={{ marginBottom: 10, fontSize: 13.5 }}
                placeholder="内容を隠す理由（CW）"
                value={cw}
                onChange={(event) => setCw(event.target.value)}
              />
            )}
            <textarea
              ref={areaRef}
              rows={4}
              placeholder="いまどうしてる？  @ユーザー と #タグ が使えます"
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </div>
        </div>

        <ComposerOptions
          cwOn={cwOn}
          onCwToggle={() => setCwOn((on) => !on)}
          visibility={visibility}
          onVisibility={setVisibility}
          sensitive={sensitive}
          onSensitiveToggle={() => setSensitive((on) => !on)}
        />

        <ComposerExtras
          onInsertEmoji={insertEmoji}
          media={media}
          onChangeMedia={setMedia}
          poll={poll}
          onChangePoll={setPoll}
          disabled={busy}
        />

        <div className="sheet__tools">
          <label className="sheet__when">
            <span>予約</span>
            <input
              type="datetime-local"
              className="field"
              value={when}
              onChange={(event) => setWhen(event.target.value)}
            />
          </label>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn--text" disabled={busy || !content.trim()} onClick={() => void keepDraft()}>
            下書きに保存
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            disabled={busy || !content.trim() || !when}
            onClick={() => void reserve()}
          >
            予約する
          </button>
        </div>

        <div className="sheet__foot">
          {error && <span style={{ fontSize: 12.5, color: 'var(--danger)' }}>{error}</span>}
          <span className="sheet__count" style={remaining < 0 ? { color: 'var(--danger)' } : undefined}>
            {content.length} / {MAX_LENGTH}
          </span>
          <button
            type="button"
            className="btn btn--solid"
            disabled={busy || (content.trim().length === 0 && media.length === 0) || remaining < 0}
            onClick={() => void submit()}
          >
            {busy ? '送信中…' : 'ノート'}
          </button>
        </div>
      </div>
    </div>
  );
}
