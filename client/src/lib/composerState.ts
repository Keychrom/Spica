/**
 * コンポーザの「送れるか」「何を送るか」と、下書きから開くときの引き継ぎ。
 *
 * 画面（Composer）と下書き一覧（DraftsView）の両方から使うので、純粋な関数だけを置く。
 */
import type { Attachment } from './media';
import type { DraftInput, DraftPoll, DraftedPost, PollPayload, ScheduledInput } from './drafts';

/**
 * 公開範囲の UI 名をサーバーの正規値に寄せる。
 * 古い下書き・設定に残る 'unlisted' は 'local'（ひかえめ）として扱う。
 */
export function normalizeComposerVisibility(value: string | null | undefined): string {
  const raw = String(value || 'public');
  return raw === 'unlisted' ? 'local' : raw;
}

/** 下書きから開くとき、コンポーザに渡す内容 */
export interface ComposerTarget {
  /** 返信先・引用元は id と（あれば）表示名だけ使う */
  replyTo?: { id: string; author_name?: string } | null;
  quoteOf?: { id: string; author_name?: string } | null;
  content?: string;
  cw?: string;
  visibility?: string;
  media?: Attachment[];
  poll?: DraftPoll | null;
  draftId?: string;
}

/**
 * 下書きの行から、コンポーザに渡す内容へ。
 * 下書きが覚えているのは返信先・引用元の id だけなので、表示用の相手は最小限の形で渡す
 */
export function composerTargetFromDraft(draft: DraftedPost): ComposerTarget {
  return {
    content: draft.content,
    cw: draft.cw,
    draftId: draft.id,
    visibility: draft.visibility,
    media: draft.media_attachments ?? [],
    poll: draft.poll ?? null,
    replyTo: draft.in_reply_to ? { id: draft.in_reply_to } : null,
    quoteOf: draft.quote_id ? { id: draft.quote_id } : null,
  };
}

/** 編集中のアンケートを API の形にする（空の選択肢を落として、2 つ以上あるときだけ） */
export function pollPayload(poll: DraftPoll | null): PollPayload | undefined {
  if (!poll) return undefined;
  const choices = poll.choices.map((choice) => choice.trim()).filter(Boolean);
  if (choices.length < 2) return undefined;
  return {
    choices,
    multiple: poll.multiple,
    // 送信するキーは API に合わせて expires_in（スネークケース）。
    // expiresIn で送るとサーバーが読まないため、期限が付かない
    ...(poll.expiresIn > 0 ? { expires_in: poll.expiresIn } : {}),
  };
}

/** 投稿できるか（本文・添付・アンケート・引用のどれかがあればよい） */
export function canSubmit(input: {
  content: string;
  attachments: Attachment[];
  poll: DraftPoll | null;
  quote: boolean;
}): boolean {
  return (
    Boolean(input.content.trim()) ||
    input.attachments.length > 0 ||
    Boolean(pollPayload(input.poll)) ||
    input.quote
  );
}

/** 下書き・予約として残せるか（編集中のアンケートは選択肢 1 つでも残す） */
export function canSave(input: {
  content: string;
  attachments: Attachment[];
  poll: DraftPoll | null;
  quote: boolean;
  reply: boolean;
}): boolean {
  return (
    Boolean(input.content.trim()) ||
    input.attachments.length > 0 ||
    Boolean(input.poll) ||
    input.quote ||
    input.reply
  );
}

/** 下書きに保存する内容（編集中のアンケートは空の選択肢も含めてそのまま残す） */
export function draftInput(input: {
  content: string;
  cw: string;
  visibility: string;
  attachments: Attachment[];
  poll: DraftPoll | null;
  replyToId?: string;
  quoteOfId?: string;
}): DraftInput {
  return {
    content: input.content.trim(),
    cw: input.cw,
    visibility: input.visibility,
    in_reply_to: input.replyToId,
    quote_id: input.quoteOfId,
    attachments: input.attachments,
    poll: input.poll,
  };
}

/**
 * 予約する内容。
 * 公開時はそのまま投稿になるので、アンケートは `/api/posts` と同じ形（expires_in）にしておく
 */
export function scheduledInput(input: {
  content: string;
  cw: string;
  visibility: string;
  attachments: Attachment[];
  poll: DraftPoll | null;
  replyToId?: string;
  quoteOfId?: string;
  scheduledAt: string;
}): ScheduledInput & { scheduled_at: string } {
  return {
    content: input.content.trim(),
    cw: input.cw,
    visibility: input.visibility,
    in_reply_to: input.replyToId,
    quote_id: input.quoteOfId,
    attachments: input.attachments,
    poll: pollPayload(input.poll) ?? null,
    scheduled_at: input.scheduledAt,
  };
}
