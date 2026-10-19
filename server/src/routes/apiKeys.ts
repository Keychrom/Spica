/**
 * 設定画面から発行する API キー（Misskey 互換クライアント用）。
 *
 * MiAuth と同じ `sessions` の仕組み（app_name / scopes）を使うので、権限の強制・失効は
 * 既存の `appScopeGuard` とセッション解除がそのまま効く。ここで作ったキーだけを
 * `user_agent = spica-api-key` の目印で一覧する（MiAuth で承認したアプリは
 * 「ログインしている端末」にだけ出す）。
 */
import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response } from 'express';
import {
  API_KEY_USER_AGENT,
  createApiKeySession,
  destroySessionById,
  listUserSessions,
  requireAuth,
  sessionPublicId,
} from '../auth.js';
import { APP_SCOPES, type AppScope } from '../appScopes.js';

const router = Router();

/** 一覧用の形（トークンは返さない） */
function toApiKey(session: { id: string; app_name: string; scopes: string[]; created_at: string; expires_at: string }) {
  return {
    id: session.id,
    name: session.app_name,
    scopes: session.scopes,
    created_at: session.created_at,
    expires_at: session.expires_at,
  };
}

router.get('/api-keys', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const sessions = await listUserSessions(req.user!.id);
  const keys = sessions
    .filter((s) => s.kind === 'app' && s.user_agent === API_KEY_USER_AGENT)
    .map(toApiKey);
  res.json({ keys });
}));

router.post('/api-keys', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 60) {
    return res.status(400).json({ error: 'キーの名前は1〜60文字で入力してください。' });
  }

  const rawScopes: unknown[] = Array.isArray(req.body?.scopes) ? req.body.scopes : [];
  const scopes: string[] = [...new Set(rawScopes.map((scope) => String(scope)))];
  const invalid = scopes.filter((scope) => !(APP_SCOPES as readonly string[]).includes(scope));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `対応していない権限が含まれています: ${invalid.join(', ')}` });
  }
  if (scopes.length === 0) {
    return res.status(400).json({ error: '権限を1つ以上選んでください。' });
  }

  const { token, expiresAt } = await createApiKeySession(req.user!.id, name, scopes as AppScope[]);
  console.log(`[API Key] 🔑 @${req.user!.id} が「${name}」を発行しました (${scopes.join(', ')})`);
  res.status(201).json({
    token,
    expires_at: expiresAt,
    key: {
      id: sessionPublicId(token),
      name,
      scopes,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    },
  });
}));

router.delete('/api-keys/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id || '');
  const sessions = await listUserSessions(req.user!.id);
  const target = sessions.find(
    (s) => s.id === id && s.kind === 'app' && s.user_agent === API_KEY_USER_AGENT,
  );
  if (!target) {
    return res.status(404).json({ error: 'API キーが見つかりません。' });
  }
  await destroySessionById(req.user!.id, id);
  res.json({ success: true });
}));

export default router;
