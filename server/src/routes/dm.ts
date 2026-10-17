/**
 * DM（1対1のメッセージ）。
 *
 * api.ts から切り出したルーター。マウント位置（api.ts）は元の登録順と同じ。
 */
import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response, NextFunction } from 'express';
import { parsePageQuery } from '../pagination.js';
import { requireAuth } from '../auth.js';
import {
  isDmEnabled,
  listDmConversations,
  getDmConversationMessages,
  markDmConversationRead,
  sendDmMessage,
} from '../dm.js';

const router = Router();

// ==========================================
// ✉️ DM（1対1のメッセージ）エンドポイント
//
//   - サーバー管理者の設定 `dm_enabled` が off のときは 404（「物理的に無い」扱い。docs/DM.md）
//   - 認可は既存の投稿と同じく requireAuth。本文・添付の扱いも既存の投稿作成に倣う
//   - 会話は専用テーブルを持たず、`in_reply_to` の連鎖で表現する（最初の 1 通が会話の頭）
// ==========================================

// off のときは「物理的に無い」。403 だと「機能はあるが禁止」と分かってしまうため 404 にする
router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!isDmEnabled()) {
    return res.status(404).json({ error: 'Not Found' });
  }
  next();
});

// 会話一覧（相手・最終メッセージ・未読数）
router.get('/conversations', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  res.json(await listDmConversations(user.id));
}));

// 会話の本文（時系列）。`cursor` を付けると、その位置より古い方を返す
router.get('/conversations/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const page = parsePageQuery(req, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }
  const result = await getDmConversationMessages(user.id, String(req.params.id), page);
  if (!result) {
    return res.status(404).json({ error: '会話が見つかりません。' });
  }
  // 続きの読み込みは既存の一覧と同じく X-Next-Cursor でも返す（本文の next_cursor と同値）
  if (result.nextCursor) {
    res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
    res.setHeader('X-Next-Cursor', result.nextCursor);
  }
  res.json({
    conversation: result.conversation,
    messages: result.messages,
    next_cursor: result.nextCursor,
  });
}));

// 既読にする
router.post('/conversations/:id/read', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const result = await markDmConversationRead(user.id, String(req.params.id));
  if (!result) {
    return res.status(404).json({ error: '会話が見つかりません。' });
  }
  res.json({ success: true, updated: result.updated });
}));

// 送信（`to` はハンドル。`media` はアップロード済みメディアの配列）
router.post('/messages', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const result = await sendDmMessage({
    user,
    to: body.to,
    content: body.content,
    cw: body.cw,
    attachments: body.media !== undefined ? body.media : body.attachments,
    in_reply_to: body.in_reply_to,
  });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  res.status(result.status).json({
    message: result.message,
    delivered: result.delivered,
    ...(result.reason ? { reason: result.reason } : {}),
    federatedTo: result.federatedTo,
  });
}));

export default router;
