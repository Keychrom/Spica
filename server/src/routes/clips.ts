/**
 * 📁 クリップ（ブックマークのフォルダ / Misskey の clips）エンドポイント
 *
 * 1 つのノートを複数のクリップに入れられる（Misskey と同じ）。ブックマークとは独立だが、
 * 画面ではブックマーク一覧から「フォルダに入れる」形で使う。
 */
import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { collectVisiblePage, cursorPredicate, parsePageQuery } from '../pagination.js';
import { canViewPost } from '../postVisibility.js';
import { requireAuth } from '../auth.js';
import { enrichAndFilterPosts } from '../postEnrichment.js';
import { invalidateTimelineCache } from '../timelineCache.js';

const router = Router();

interface ClipRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  is_public: number;
  created_at: string;
  updated_at: string;
  notes_count?: number;
}

const MAX_CLIPS = 100;

function clipJson(row: ClipRow, contains?: boolean) {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    description: row.description || '',
    is_public: Number(row.is_public) === 1,
    notes_count: Number(row.notes_count ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(contains === undefined ? {} : { contains }),
  };
}

/** 自分のクリップだけを引く（他人のクリップは操作できない） */
async function findOwnClip(id: string, userId: string): Promise<ClipRow | undefined> {
  return (await db
    .prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM clip_notes cn WHERE cn.clip_id = c.id) AS notes_count
      FROM clips c WHERE c.id = ? AND c.user_id = ?
    `)
    .get(id, userId)) as ClipRow | undefined;
}

/** 表示用のクリップ（公開クリップは他人も読める） */
async function findVisibleClip(id: string, userId: string): Promise<ClipRow | undefined> {
  const row = (await db
    .prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM clip_notes cn WHERE cn.clip_id = c.id) AS notes_count
      FROM clips c WHERE c.id = ?
    `)
    .get(id)) as ClipRow | undefined;
  if (!row) return undefined;
  if (row.user_id !== userId && Number(row.is_public) !== 1) return undefined;
  return row;
}

/** 投稿 ID（URL エンコード・%）を posts の行に解決する */
async function resolvePost(rawId: string) {
  let id = rawId.trim();
  let post = await db
    .prepare('SELECT id, author_url, visibility, recipients FROM posts WHERE id = ?')
    .get(id);
  if (!post && id.includes('%')) {
    try {
      const decoded = decodeURIComponent(id);
      post = await db.prepare('SELECT id, author_url, visibility, recipients FROM posts WHERE id = ?').get(decoded);
      if (post) id = decoded;
    } catch {}
  }
  return post ? { id, post } : null;
}

// ---------------------------------------------------------------------------
// 一覧・作成・更新・削除
// ---------------------------------------------------------------------------

/** 自分のクリップ一覧。?postId= を付けると、そのノートが入っているか（contains）も返す */
export const handleListClips = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const postId = String(req.query.postId || '').trim();
  const rows = (await db
    .prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM clip_notes cn WHERE cn.clip_id = c.id) AS notes_count
      FROM clips c WHERE c.user_id = ? ORDER BY c.created_at DESC
    `)
    .all(user.id)) as ClipRow[];

  let contains = new Set<string>();
  if (postId) {
    const found = (await db
      .prepare(`
        SELECT cn.clip_id FROM clip_notes cn
        JOIN clips c ON c.id = cn.clip_id
        WHERE cn.post_id = ? AND c.user_id = ?
      `)
      .all(postId, user.id)) as { clip_id: string }[];
    contains = new Set(found.map((row) => row.clip_id));
  }

  res.json(rows.map((row) => clipJson(row, postId ? contains.has(row.id) : undefined)));
});
router.get('/clips', requireAuth, handleListClips);

export const handleCreateClip = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 60) : '';
  if (!name) {
    return res.status(400).json({ error: 'クリップ名を入力してください。' });
  }
  const description = typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, 200) : '';
  const isPublic = req.body?.is_public === true || req.body?.isPublic === true ? 1 : 0;

  const count = ((await db.prepare('SELECT COUNT(*) AS c FROM clips WHERE user_id = ?').get(user.id)) as { c: number }).c;
  if (count >= MAX_CLIPS) {
    return res.status(400).json({ error: `クリップは ${MAX_CLIPS} 件までです。` });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO clips (id, user_id, name, description, is_public, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, user.id, name, description, isPublic, now, now);

  res.status(201).json(clipJson({
    id,
    user_id: user.id,
    name,
    description,
    is_public: isPublic,
    created_at: now,
    updated_at: now,
    notes_count: 0,
  }));
});
router.post('/clips', requireAuth, handleCreateClip);

/** クリップ単体（公開クリップは他人も読める） */
export const handleShowClip = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const clip = await findVisibleClip(String(req.params.id), user.id);
  if (!clip) {
    return res.status(404).json({ error: 'クリップが見つかりません。' });
  }
  res.json(clipJson(clip));
});
router.get('/clips/:id', requireAuth, handleShowClip);

export const handleUpdateClip = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const clip = await findOwnClip(String(req.params.id), user.id);
  if (!clip) {
    return res.status(404).json({ error: 'クリップが見つかりません。' });
  }

  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 60) : clip.name;
  if (!name) {
    return res.status(400).json({ error: 'クリップ名を入力してください。' });
  }
  const description = req.body?.description !== undefined
    ? String(req.body.description).trim().slice(0, 200)
    : (clip.description || '');
  const isPublic = req.body?.is_public !== undefined || req.body?.isPublic !== undefined
    ? (req.body.is_public === true || req.body.isPublic === true ? 1 : 0)
    : Number(clip.is_public);
  const now = new Date().toISOString();

  await db.prepare('UPDATE clips SET name = ?, description = ?, is_public = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(name, description, isPublic, now, clip.id, user.id);

  res.json(clipJson({ ...clip, name, description, is_public: isPublic, updated_at: now }));
});
router.put('/clips/:id', requireAuth, handleUpdateClip);

export const handleDeleteClip = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const clip = await findOwnClip(String(req.params.id), user.id);
  if (!clip) {
    return res.status(404).json({ error: 'クリップが見つかりません。' });
  }
  // 外部キーのカスケードに頼らず、明示的に中身から消す（既存 DB の設定差を吸収）
  await db.prepare('DELETE FROM clip_notes WHERE clip_id = ?').run(clip.id);
  await db.prepare('DELETE FROM clips WHERE id = ? AND user_id = ?').run(clip.id, user.id);
  res.json({ success: true });
});
router.delete('/clips/:id', requireAuth, handleDeleteClip);

// ---------------------------------------------------------------------------
// ノートの追加・削除
// ---------------------------------------------------------------------------

export const handleAddClipNote = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const clip = await findOwnClip(String(req.params.id), user.id);
  if (!clip) {
    return res.status(404).json({ error: 'クリップが見つかりません。' });
  }
  const rawPostId = String(req.body?.postId || '').trim();
  if (!rawPostId) {
    return res.status(400).json({ error: 'postId は必須です。' });
  }
  const found = await resolvePost(rawPostId);
  if (!found) {
    return res.status(404).json({ error: '投稿が見つかりません。' });
  }
  // ブックマークと同じく、閲覧できない投稿は入れられない
  if (!(await canViewPost(found.post, `${config.origin}/users/${user.id}`))) {
    return res.status(403).json({ error: 'この投稿はクリップに追加できません。' });
  }

  const existing = await db
    .prepare('SELECT 1 FROM clip_notes WHERE clip_id = ? AND post_id = ?')
    .get(clip.id, found.id);
  if (!existing) {
    await db
      .prepare('INSERT OR IGNORE INTO clip_notes (clip_id, post_id, created_at) VALUES (?, ?, ?)')
      .run(clip.id, found.id, new Date().toISOString());
    await invalidateTimelineCache();
  }
  res.json({ success: true, added: !existing, postId: found.id });
});
router.post('/clips/:id/notes', requireAuth, handleAddClipNote);

export const handleRemoveClipNote = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const clip = await findOwnClip(String(req.params.id), user.id);
  if (!clip) {
    return res.status(404).json({ error: 'クリップが見つかりません。' });
  }
  const rawPostId = String(req.params.postId || '');
  let postId = rawPostId;
  try {
    postId = decodeURIComponent(rawPostId);
  } catch {}
  await db.prepare('DELETE FROM clip_notes WHERE clip_id = ? AND post_id = ?').run(clip.id, postId);
  await invalidateTimelineCache();
  res.json({ success: true });
});
router.delete('/clips/:id/notes/:postId', requireAuth, handleRemoveClipNote);

// ---------------------------------------------------------------------------
// タイムライン
// ---------------------------------------------------------------------------

export const handleClipTimeline = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const clip = await findVisibleClip(String(req.params.id), user.id);
  if (!clip) {
    return res.status(404).json({ error: 'クリップが見つかりません。' });
  }

  const page = parsePageQuery(req, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }

  const viewerActor = `${config.origin}/users/${user.id}`;
  const { items, nextCursor } = await collectVisiblePage({
    limit: page.limit,
    cursor: page.cursor,
    fetchRows: async (cursor, n) => {
      const cursorCond = cursor ? ` AND ${cursorPredicate('cn.created_at', 'p.id')}` : '';
      const cursorParams = cursor ? [cursor.at, cursor.at, cursor.id] : [];
      return (await db
        .prepare(`
          SELECT
            p.*,
            p.id AS post_id,
            COALESCE(NULLIF(p.author_icon, ''), NULLIF(u.icon_url, ''), NULLIF(ra.icon_url, ''), '') AS author_icon,
            cn.created_at AS timeline_at
          FROM clip_notes cn
          JOIN posts p ON cn.post_id = p.id
          LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
          LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
          WHERE cn.clip_id = ? AND COALESCE(p.visibility, 'public') != 'direct'${cursorCond}
          ORDER BY cn.created_at DESC, p.id DESC
          LIMIT ?
        `)
        .all(clip.id, ...cursorParams, n)) as any[];
    },
    filterRows: (rows) => enrichAndFilterPosts(rows, viewerActor, user.id),
    sortKey: 'timeline_at',
    idKey: 'post_id',
  });

  if (nextCursor) {
    res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
    res.setHeader('X-Next-Cursor', nextCursor);
  }
  res.json({ clip: clipJson(clip), posts: items });
});
router.get('/clips/:id/timeline', requireAuth, handleClipTimeline);

export default router;
