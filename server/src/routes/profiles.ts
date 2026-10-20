/**
 * プロフィール・フォロー・引っ越し・エクスポート/インポート・フォローリクエスト。
 *
 * api.ts から切り出したルーター。マウント位置（api.ts）は元の登録順と同じ。
 */
import { asyncHandler } from '../asyncHandler.js';
import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { db, FollowRow, RemoteActorRow, isDomainBlocked, createNotification } from '../db.js';
import { config } from '../config.js';
import { collectVisiblePage, cursorPredicate, parsePageQuery } from '../pagination.js';
import { invalidateMutedWords } from '../wordFilter.js';
import { parseArchive, importNotes, buildSpicaBundle, buildSpicaBundleFromZip, importSpicaArchive, buildImportMessage } from '../importService.js';
import { isZipBuffer, readZipEntries } from '../zipReader.js';
import { parseProfileFields } from '../activitypub.js';
import { isApprovedUser } from '../registration.js';
import { hashMasterKey, requireAuth, verifyPassword } from '../auth.js';
import { verifyTotpCode } from '../totp.js';
import { consumeRecoveryCode } from '../totpService.js';
import { beginUserDeletion } from '../accountService.js';
import { enqueueJob, getJob } from '../jobs.js';
import { invalidateTimelineCache } from '../timelineCache.js';
import {
  buildFollowActivity,
  buildAcceptActivity,
  buildRejectActivity,
  deliverActivity,
  resolveWebFinger,
  fetchRemoteActor,
  fetchActorAliases,
  buildMoveActivity,
} from '../activitypub.js';
import { enrichAndFilterPosts } from '../postEnrichment.js';

const router = Router();

// リモートまたはローカルユーザーのフォロー（認証必須）
/** フォロー。Misskey 互換 API（`following/create`）からも同じ関数を呼ぶ */
export const handleFollow = asyncHandler(async (req: Request, res: Response) => {
  const { targetHandle } = req.body;
  if (!targetHandle) {
    return res.status(400).json({ error: 'targetHandle が必要です。例: "@user@mastodon.social"' });
  }

  const user = req.rawUser!;
  const myActorUrl = `${config.origin}/users/${user.id}`;

  if (await isDomainBlocked(targetHandle)) {
    return res.status(400).json({ error: 'このサーバーはブロックされているためフォローできません。' });
  }

  try {
    let targetActorUrl: string;
    let isTargetLocal = false;
    let localTargetUser: any = null;

    if (targetHandle.startsWith('http://') || targetHandle.startsWith('https://')) {
      targetActorUrl = targetHandle;
      if (targetActorUrl.startsWith(config.origin)) {
        isTargetLocal = true;
        const uid = targetActorUrl.split('/').pop()!;
        localTargetUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      }
    } else if (targetHandle.includes(`@${config.domain}`) || !targetHandle.includes('@')) {
      const cleanId = targetHandle.replace(/^@/, '').replace(`@${config.domain}`, '');
      localTargetUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(cleanId);
      if (localTargetUser) {
        isTargetLocal = true;
        targetActorUrl = `${config.origin}/users/${localTargetUser.id}`;
      } else {
        targetActorUrl = await resolveWebFinger(targetHandle);
      }
    } else {
      targetActorUrl = await resolveWebFinger(targetHandle);
    }

    if (targetActorUrl === myActorUrl) {
      return res.status(400).json({ error: '自分自身をフォローすることはできません。' });
    }

    const followId = `${myActorUrl} -> ${targetActorUrl}`;
    const now = new Date().toISOString();

    if (isTargetLocal && localTargetUser) {
      // ローカルユーザー同士のフォロー: 外部配送なしで即時承認
      await db.prepare(`
        INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
        VALUES (?, ?, ?, ?, 1, 'accepted', ?)
        ON CONFLICT(follower_url, following_url) DO UPDATE SET
          status = 'accepted'
      `).run(followId, myActorUrl, targetActorUrl, `${targetActorUrl}/inbox`, now);
      // 新しいフォロー相手の投稿が、キャッシュ済みのホームにも出るようにする
      await invalidateTimelineCache();

      try {
        await createNotification({
          userId: localTargetUser.id,
          type: 'follow',
          actorId: user.id,
          actorName: user.name,
          actorHandle: `@${user.id}@${config.domain}`,
          actorIcon: user.icon_url || '',
        });
      } catch (e) {
        console.error('[Notification Error] Follow notification failed:', e);
      }

      return res.json({
        status: 'Followed',
        targetActor: targetActorUrl,
        delivered: true,
        target: {
          username: localTargetUser.id,
          name: localTargetUser.name,
          domain: config.domain,
        },
      });
    }

    // 相手のリモート Actor 情報を取得
    const remoteActor = await fetchRemoteActor(targetActorUrl);

    // Follow Activity を構築
    const followActivity = buildFollowActivity({
      actorUrl: myActorUrl,
      targetActorUrl,
    });

    // follows テーブルに登録
    await db.prepare(`
      INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
      VALUES (?, ?, ?, ?, 1, 'pending', ?)
      ON CONFLICT(follower_url, following_url) DO UPDATE SET
        status = 'pending',
        inbox_url = excluded.inbox_url
    `).run(followId, myActorUrl, targetActorUrl, remoteActor.inbox_url, now);
    // 承認後に相手の投稿が出るので、いまのうちに捨てておく（承認は別のプロセスで起き得る）
    await invalidateTimelineCache();

    // 相手の Inbox へ署名付き Follow Activity を配送
    const delivered = await deliverActivity({
      inboxUrl: remoteActor.inbox_url,
      activity: followActivity,
      senderUser: user,
    });

    res.json({
      status: 'Follow request sent',
      targetActor: targetActorUrl,
      delivered,
      target: {
        username: remoteActor.username,
        name: remoteActor.name,
        domain: remoteActor.domain,
      },
    });
  } catch (err: any) {
    console.error('[Follow Error]:', err);
    res.status(500).json({ error: err.message || 'フォローに失敗しました。' });
  }
});
router.post('/follow', requireAuth, handleFollow);

// フォロー解除
export const handleUnfollow = asyncHandler(async (req: Request, res: Response) => {
  const { targetHandle, targetActorUrl: explicitTargetUrl } = req.body;
  const user = req.rawUser!;
  const myActorUrl = `${config.origin}/users/${user.id}`;

  try {
    let targetActorUrl = explicitTargetUrl;
    if (!targetActorUrl && targetHandle) {
      if (targetHandle.startsWith('http://') || targetHandle.startsWith('https://')) {
        targetActorUrl = targetHandle;
      } else if (targetHandle.includes(`@${config.domain}`) || !targetHandle.includes('@')) {
        const cleanId = targetHandle.replace(/^@/, '').replace(`@${config.domain}`, '');
        targetActorUrl = `${config.origin}/users/${cleanId}`;
      } else {
        targetActorUrl = await resolveWebFinger(targetHandle);
      }
    }

    if (!targetActorUrl) {
      return res.status(400).json({ error: '解除対象のユーザーが指定されていません。' });
    }

    const followRow = await db.prepare('SELECT * FROM follows WHERE follower_url = ? AND following_url = ?').get(myActorUrl, targetActorUrl) as FollowRow | undefined;
    if (!followRow) {
      return res.status(400).json({ error: 'このユーザーをフォローしていません。' });
    }

    // follows テーブルから削除
    await db.prepare('DELETE FROM follows WHERE follower_url = ? AND following_url = ?').run(myActorUrl, targetActorUrl);
    await invalidateTimelineCache();

    // リモートユーザーなら Undo(Follow) を配送
    if (!targetActorUrl.startsWith(config.origin) && followRow.inbox_url) {
      try {
        const undoActivity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${myActorUrl}/activities/undo-follow/${Date.now()}`,
          type: 'Undo',
          actor: myActorUrl,
          object: {
            id: followRow.id,
            type: 'Follow',
            actor: myActorUrl,
            object: targetActorUrl,
          },
        };
        await deliverActivity({
          inboxUrl: followRow.inbox_url,
          activity: undoActivity,
          senderUser: user,
        });
      } catch (err: any) {
        console.warn('[Unfollow Warning] Failed to deliver Undo activity:', err.message);
      }
    }

    res.json({ success: true, targetActorUrl });
  } catch (err: any) {
    console.error('[Unfollow Error]:', err);
    res.status(500).json({ error: err.message || 'フォロー解除に失敗しました。' });
  }
});
router.post('/unfollow', requireAuth, handleUnfollow);

// 自プロフィール更新 (名前, bio, アイコンURL, ヘッダーURL, 鍵アカウント設定)
// Misskey 互換の `i/update` からも呼ぶ（中身は Misskey の項目名へ読み替えて渡す）
export const handleUpdateProfile = asyncHandler(async (req: Request, res: Response) => {
  const { name, summary, icon_url, banner_url, is_locked, fields, discoverable, noindex, no_ai_training } = req.body;
  const user = req.rawUser!;

  const newName = typeof name === 'string' && name.trim() ? name.trim() : user.name;
  const newSummary = typeof summary === 'string' ? summary.trim() : (user.summary || '');
  const newIconUrl = typeof icon_url === 'string' ? icon_url.trim() : (user.icon_url || '');
  const newBannerUrl = typeof banner_url === 'string' ? banner_url.trim() : (user.banner_url || '');
  // 鍵アカウント（フォロー承認制）の切り替え。未指定なら現状維持
  const newIsLocked = typeof is_locked === 'boolean' ? (is_locked ? 1 : 0) : (user.is_locked ?? 0);
  // ディレクトリ掲載の可否
  const newDiscoverable = typeof discoverable === 'boolean' ? (discoverable ? 1 : 0) : ((user as any).discoverable ?? 1);
  // 検索エンジンによるインデックスの拒否 / 生成AIによる学習の拒否（プロフィール HTML の robots に出る）
  const newNoindex = typeof noindex === 'boolean' ? (noindex ? 1 : 0) : ((user as any).noindex ?? 0);
  const newNoAiTraining = typeof no_ai_training === 'boolean' ? (no_ai_training ? 1 : 0) : ((user as any).no_ai_training ?? 0);
  // プロフィール項目（最大4件・各40/200文字まで）
  const newFields = Array.isArray(fields)
    ? fields
        .filter((f: any) => f && typeof f.name === 'string' && typeof f.value === 'string')
        .slice(0, 4)
        .map((f: any) => ({ name: f.name.trim().slice(0, 40), value: f.value.trim().slice(0, 200) }))
        .filter((f: any) => f.name && f.value)
    : (() => {
        try { return JSON.parse((user as any).fields || '[]'); } catch { return []; }
      })();

  await db.prepare(`
    UPDATE users SET
      name = ?,
      summary = ?,
      icon_url = ?,
      banner_url = ?,
      is_locked = ?,
      fields = ?,
      discoverable = ?,
      noindex = ?,
      no_ai_training = ?
    WHERE id = ?
  `).run(newName, newSummary, newIconUrl, newBannerUrl, newIsLocked, JSON.stringify(newFields), newDiscoverable, newNoindex, newNoAiTraining, user.id);

  // 自身の過去投稿の author_name / author_icon も更新
  await db.prepare(`UPDATE posts SET author_name = ?, author_icon = ? WHERE is_local = 1 AND user_id = ?`).run(newName, newIconUrl, user.id);

  const updatedUser = await db.prepare('SELECT id, name, summary, icon_url, banner_url, role, is_frozen, is_locked, fields, discoverable, noindex, no_ai_training, onboarding_completed, created_at FROM users WHERE id = ?').get(user.id) as any;
  const myActorUrl = `${config.origin}/users/${user.id}`;
  const followerCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_url = ? AND status = ?').get(myActorUrl, 'accepted') as any).c;
  const followingCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower_url = ? AND status = ?').get(myActorUrl, 'accepted') as any).c;
  // 自分の投稿数に DM は数えない（DM はタイムラインに出ない投稿なので別扱い）
  const postCount = (await db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND COALESCE(visibility, 'public') != 'direct'").get(user.id) as any).c;

  res.json({
    ...updatedUser,
    handle: `@${user.id}@${config.domain}`,
    actorUrl: myActorUrl,
    followerCount,
    followingCount,
    postCount,
  });
});
router.put('/user/profile', requireAuth, handleUpdateProfile);

// ==========================================
// 📦 アカウントの引っ越し（Move / alsoKnownAs）
// ==========================================

// 引っ越しの状況（移行元・移行先・フォロワー数）
router.get('/user/migration', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const myActorUrl = `${config.origin}/users/${user.id}`;
  const followers = (
    await db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_url = ? AND follower_url != ?').get(myActorUrl, myActorUrl) as any
  ).c;

  res.json({
    actorUrl: myActorUrl,
    movedTo: (user as any).moved_to || '',
    alsoKnownAs: (user as any).also_known_as || '',
    followers,
  });
}));

// 引っ越し元アカウント（alsoKnownAs）の登録 — 他のサーバーからここへ引っ越す場合に必要
router.post('/user/migration/alias', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const input = typeof req.body?.alias === 'string' ? req.body.alias.trim() : '';
  const myActorUrl = `${config.origin}/users/${user.id}`;

  // 空文字で解除
  if (!input) {
    await db.prepare("UPDATE users SET also_known_as = '' WHERE id = ?").run(user.id);
    console.log(`[Migration] 📦 @${user.id} の引っ越し元を解除`);
    return res.json({ success: true, alsoKnownAs: '', message: '引っ越し元アカウントを解除しました。' });
  }

  try {
    // ハンドル (@user@host) でも Actor URL でも受け付ける
    let actorUrl = input;
    if (!/^https?:\/\//i.test(input)) {
      const handle = input.startsWith('@') ? input.slice(1) : input;
      if (!handle.includes('@')) {
        return res.status(400).json({ error: '@ユーザー名@サーバー の形式で入力してください。' });
      }
      const resolved = await resolveWebFinger(handle);
      if (!resolved) {
        return res.status(404).json({ error: '引っ越し元アカウントが見つかりませんでした。' });
      }
      actorUrl = resolved;
    }

    if (actorUrl === myActorUrl) {
      return res.status(400).json({ error: '自分自身は引っ越し元に指定できません。' });
    }

    await db.prepare('UPDATE users SET also_known_as = ? WHERE id = ?').run(actorUrl, user.id);
    console.log(`[Migration] 📦 @${user.id} の引っ越し元を登録: ${actorUrl}`);
    res.json({ success: true, alsoKnownAs: actorUrl, message: `引っ越し元アカウントを登録しました。Actor 文書の alsoKnownAs として公開されます。` });
  } catch (err: any) {
    console.error('[Migration] ❌ 引っ越し元の登録に失敗:', err);
    res.status(500).json({ error: err.message || '引っ越し元の登録に失敗しました。' });
  }
}));

// フォロワーへ Move を配送して引っ越す
router.post('/user/migration/move', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const target = typeof req.body?.target === 'string' ? req.body.target.trim() : '';
  if (!target) {
    return res.status(400).json({ error: '引っ越し先アカウント（@ユーザー名@サーバー または URL）を指定してください。' });
  }

  const myActorUrl = `${config.origin}/users/${user.id}`;

  try {
    // 1. 引っ越し先アカウントを解決する
    let targetActorUrl = target;
    if (!/^https?:\/\//i.test(target)) {
      const handle = target.startsWith('@') ? target.slice(1) : target;
      if (!handle.includes('@')) {
        return res.status(400).json({ error: '@ユーザー名@サーバー の形式で入力してください。' });
      }
      const resolved = await resolveWebFinger(handle);
      if (!resolved) {
        return res.status(404).json({ error: '引っ越し先アカウントが見つかりませんでした。' });
      }
      targetActorUrl = resolved;
    }

    if (targetActorUrl === myActorUrl) {
      return res.status(400).json({ error: '自分自身へは引っ越せません。' });
    }
    if (await isDomainBlocked(targetActorUrl)) {
      return res.status(400).json({ error: 'このサーバーはブロック対象のため引っ越せません。' });
    }

    // 2. 引っ越し先が alsoKnownAs にこのアカウントを宣言しているか検証する
    //    （連合先も同じ検証をするため、宣言が無いと Move は受理されない）
    const aliases = await fetchActorAliases(targetActorUrl);
    if (!aliases.includes(myActorUrl)) {
      return res.status(400).json({
        error: `引っ越し先（${targetActorUrl}）の alsoKnownAs にこのアカウント（${myActorUrl}）が含まれていません。先に引っ越し先アカウントで旧アカウントとして設定してください。`,
      });
    }

    // 3. フォロワー全員へ Move を配送する
    const followerRows = await db.prepare('SELECT * FROM follows WHERE following_url = ? AND follower_url != ?').all(
      myActorUrl,
      myActorUrl,
    ) as unknown as FollowRow[];
    const moveActivity = buildMoveActivity({ actorUrl: myActorUrl, targetActorUrl });

    let delivered = 0;
    let failed = 0;
    for (const row of followerRows) {
      const ok = await deliverActivity({ inboxUrl: row.inbox_url, activity: moveActivity, senderUser: user });
      if (ok) delivered++;
      else failed++;
    }

    // 4. 移行先を記録する（Actor 文書の movedTo として公開される）
    await db.prepare('UPDATE users SET moved_to = ? WHERE id = ?').run(targetActorUrl, user.id);

    console.log(
      `[Migration] 📦 @${user.id} が ${targetActorUrl} へ引っ越し（フォロワー ${followerRows.length}件 / 成功 ${delivered} / 失敗 ${failed}）`,
    );
    res.json({
      success: true,
      targetActorUrl,
      followers: followerRows.length,
      delivered,
      failed,
      message: `引っ越しを実行しました。フォロワー ${followerRows.length} 件へ通知（成功 ${delivered} / 失敗 ${failed}）しました。`,
    });
  } catch (err: any) {
    console.error('[Migration] ❌ 引っ越しに失敗:', err);
    res.status(500).json({ error: err.message || '引っ越しに失敗しました。' });
  }
}));

// 引っ越し先の記録を解除する（配送済みの Move は取り消せない）
router.post('/user/migration/cancel', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  await db.prepare("UPDATE users SET moved_to = '' WHERE id = ?").run(user.id);
  console.log(`[Migration] 📦 @${user.id} の引っ越し先を解除`);
  res.json({ success: true, message: '引っ越し先の記録を解除しました（連合先へ配送済みの Move は取り消せません）。' });
}));
// 📦 データエクスポート（非同期）
//
// 大きなアカウントでは ZIP の生成に時間がかかるので、**リクエストの中で待たせない**。
// 受け付けたらジョブを積み、`GET /api/user/export/:jobId` で状態を見て、
// 出来上がったら `GET /api/user/export/:jobId/file` でダウンロードする。
router.post('/user/export', requireAuth, async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const format = String(req.body?.format || req.query.format || 'json').toLowerCase() === 'zip' ? 'zip' : 'json';

  try {
    // 同じ人のエクスポートが走っている間は積まない（連打対策）
    const jobId = await enqueueJob('user_export', { userId: user.id, format }, { dedupeKey: `user_export:${user.id}`, maxAttempts: 2 });
    if (!jobId) {
      return res.status(503).json({ error: 'エクスポートを受け付けられませんでした。しばらくしてからお試しください。' });
    }
    res.status(202).json({ jobId, status: 'pending', format });
  } catch (err: any) {
    console.error(`[Export Error] Failed to enqueue export for @${user.id}:`, err);
    res.status(500).json({ error: 'データのエクスポートを開始できませんでした。' });
  }
});

/** エクスポートの状態（自分のジョブだけ見られる） */
router.get('/user/export/:jobId', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const job = await getJob(String(req.params.jobId));
  if (!job || job.kind !== 'user_export') {
    return res.status(404).json({ error: 'エクスポートが見つかりません。' });
  }
  const payload = JSON.parse(job.payload || '{}') as { userId?: string };
  if (payload.userId !== user.id) {
    return res.status(404).json({ error: 'エクスポートが見つかりません。' });
  }
  const result = job.result ? (JSON.parse(job.result) as { filename?: string; bytes?: number }) : null;
  res.json({
    status: job.status,
    error: job.status === 'failed' ? job.last_error || 'エクスポートに失敗しました。' : '',
    filename: result?.filename || '',
    bytes: result?.bytes || 0,
    downloadUrl: job.status === 'done' ? `/api/user/export/${job.id}/file` : '',
  });
}));

/** 出来上がったファイルを返す（返したら消す＝置き場を溜めない） */
router.get('/user/export/:jobId/file', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const job = await getJob(String(req.params.jobId));
  if (!job || job.kind !== 'user_export' || job.status !== 'done' || !job.result) {
    return res.status(404).json({ error: 'エクスポートが見つかりません。' });
  }
  const payload = JSON.parse(job.payload || '{}') as { userId?: string };
  if (payload.userId !== user.id) {
    return res.status(404).json({ error: 'エクスポートが見つかりません。' });
  }
  const result = JSON.parse(job.result) as { filePath?: string; filename?: string };
  if (!result.filePath || !fs.existsSync(result.filePath)) {
    // 期限切れ（1 時間で掃除される）や、別プロセスが作った場合
    return res.status(410).json({ error: 'エクスポートのファイルはもうありません。もう一度お試しください。' });
  }

  res.setHeader('Content-Type', result.filename?.endsWith('.zip') ? 'application/zip' : 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename || 'spica-export'}"`);
  res.sendFile(path.resolve(result.filePath), (err) => {
    // 送り終わったら消す（失敗しても消す。1 時間の掃除でも拾われる）
    try {
      fs.unlinkSync(result.filePath as string);
    } catch {
      // すでに無ければ何もしない
    }
    if (err && !res.headersSent) res.status(500).end();
  });
}));

// ユーザー自身によるアカウント削除（退会・データ完全抹消）
router.post('/user/delete-me', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const { confirmUserId, masterKey, password, totpCode } = req.body;

  // 1. 誤操作防止の確認用ユーザーID検証
  if (!confirmUserId || String(confirmUserId).trim().toLowerCase() !== user.id.toLowerCase()) {
    return res.status(400).json({
      error: `確認用ユーザーIDが一致しません。「${user.id}」と正確に入力してください。`,
    });
  }

  // 2. 本人確認。**マスターキーかパスワードのどちらかを必ず要求する**
  //    （以前は masterKey が送られたときだけ照合していたため、何も送らなければ退会できた）
  const providedMasterKey = typeof masterKey === 'string' ? masterKey.trim() : '';
  const providedPassword = typeof password === 'string' ? password : '';
  if (!providedMasterKey && !providedPassword) {
    return res.status(401).json({
      error: '退会にはマスターキーまたはパスワードが必要です。',
      credential_required: true,
    });
  }

  let credentialOk = false;
  if (providedPassword) {
    credentialOk = verifyPassword(providedPassword, (user as any).password_hash);
  }
  if (!credentialOk && providedMasterKey) {
    credentialOk = hashMasterKey(providedMasterKey) === user.master_key_hash;
  }
  if (!credentialOk) {
    return res.status(401).json({
      error: 'マスターキーまたはパスワードが正しくありません。',
      credential_required: true,
    });
  }

  // 3. 2段階認証が有効なら、資格情報が正しくてもコード（またはリカバリーコード）を要求する。
  //    資格情報の検証後に見るので、間違ったキーでリカバリーコードを消費しない。
  if (Number((user as any).totp_enabled) === 1) {
    const code = typeof totpCode === 'string' ? totpCode.trim() : '';
    if (!code) {
      return res.status(401).json({
        error: '2段階認証コードを入力してください。',
        totp_required: true,
      });
    }
    const okByCode = verifyTotpCode(String((user as any).totp_secret || ''), code);
    const okByRecovery = okByCode ? false : await consumeRecoveryCode(user.id, code);
    if (!okByCode && !okByRecovery) {
      return res.status(401).json({
        error: '2段階認証コードが正しくありません。',
        totp_required: true,
      });
    }
  }

  // 4. 最後の管理者を削除しない保護
  if (user.role === 'admin') {
    const adminCount = (await db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get() as any).c;
    if (adminCount <= 1) {
      return res.status(400).json({
        error: 'あなたはサーバーで唯一の管理者です。退会する前に別のユーザーを管理者に任命してください。',
      });
    }
  }

  // 5. 退会を受け付ける（その場で凍結 + セッション削除。実作業はジョブで。
  //    フォロワー全員への Delete 配信とメディア削除は時間がかかるため、リクエスト内で待たせない）
  const result = await beginUserDeletion(user.id);
  if (!result.success) {
    return res.status(400).json({ error: result.error || 'アカウントの削除に失敗しました。' });
  }

  res.json({
    success: true,
    jobId: result.jobId,
    message: '退会を受け付けました。アカウントと関連データを削除しています。ご利用ありがとうございました。',
  });
}));

/**
 * プロフィールの識別子から、リモートアクターの URL を決める。
 *
 * - URL はそのまま使う
 * - **裸のユーザー名**（例: "suiren"）は WebFinger では解決できないので、
 *   キャッシュ済みのリモートアクターから引く（フォロー一覧などが名前だけを渡してくるため）。
 *   同名のアクターが複数いるときは、誤った相手を開くより 404 の方が安全なので解決しない
 * - それ以外（`@user@domain` など）は WebFinger
 */
async function resolveRemoteActorUrl(identifier: string): Promise<string> {
  if (identifier.startsWith('http://') || identifier.startsWith('https://')) return identifier;

  const bare = identifier.replace(/^@/, '');
  if (!bare.includes('@') && /^[A-Za-z0-9_.-]+$/.test(bare)) {
    const rows = (await db.prepare('SELECT id FROM remote_actors WHERE username = ? LIMIT 2').all(bare)) as {
      id: string;
    }[];
    if (rows.length === 1) return rows[0].id;
  }

  return resolveWebFinger(identifier);
}

// ユーザー詳細プロフィール取得（ローカルまたはリモート）
router.get('/users/:identifier', asyncHandler(async (req: Request, res: Response) => {
  const rawIdentifier = decodeURIComponent(req.params.identifier as string);
  const myActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;

  // 1. ローカルユーザーの照合 (@id, id, @id@domain 等)
  let cleanId = rawIdentifier.replace(/^@/, '');
  if (cleanId.includes(`@${config.domain}`)) {
    cleanId = cleanId.replace(`@${config.domain}`, '');
  }

  const localUser = await db.prepare('SELECT id, name, summary, icon_url, banner_url, role, is_frozen, is_locked, fields, discoverable, created_at, approval_status FROM users WHERE id = ?').get(cleanId) as any;
  if (localUser && !isApprovedUser(localUser)) {
    // 承認待ち・却下の申請はプロフィールとして存在しない扱い（本人にも見せない）
    return res.status(404).json({ error: 'ユーザーが見つかりません。' });
  }
  if (localUser) {
    const actorUrl = `${config.origin}/users/${localUser.id}`;
    const followerCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_url = ? AND status = ?').get(actorUrl, 'accepted') as any).c;
    const followingCount = (await db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower_url = ? AND status = ?').get(actorUrl, 'accepted') as any).c;
    const postCount = (await db.prepare("SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND COALESCE(visibility, 'public') != 'direct'").get(localUser.id) as any).c;

    let isFollowing = false;
    let isBlocked = false;
    let isMuted = false;
    let isBlockingMe = false;
    if (req.user && req.user.id !== localUser.id) {
      if (myActorUrl) {
        const f = await db.prepare('SELECT id FROM follows WHERE follower_url = ? AND following_url = ?').get(myActorUrl, actorUrl);
        isFollowing = !!f;
      }
      isBlocked = !!await db.prepare('SELECT 1 FROM user_blocks WHERE user_id = ? AND target_user_id = ?').get(req.user.id, localUser.id);
      isMuted = !!await db.prepare('SELECT 1 FROM user_mutes WHERE user_id = ? AND target_user_id = ?').get(req.user.id, localUser.id);
      isBlockingMe = !!await db.prepare('SELECT 1 FROM user_blocks WHERE user_id = ? AND target_user_id = ?').get(localUser.id, req.user.id);
    }

    // 📌 ピン留めノートの取得
    const pinnedRows = await db.prepare(`
      SELECT 
        p.*,
        p.id AS post_id,
        p.published_at AS timeline_at,
        COALESCE(
          NULLIF(p.author_icon, ''),
          NULLIF(u.icon_url, ''),
          ''
        ) AS author_icon
      FROM pinned_posts pp
      JOIN posts p ON pp.post_id = p.id
      LEFT JOIN users u ON p.user_id = u.id
      WHERE pp.user_id = ?
      ORDER BY pp.created_at DESC
    `).all(localUser.id) as any[];
    const pinnedPosts = await enrichAndFilterPosts(pinnedRows, myActorUrl, req.user?.id);

    return res.json({
      id: localUser.id,
      name: localUser.name,
      summary: localUser.summary || '',
      icon_url: localUser.icon_url || '',
      banner_url: localUser.banner_url || '',
      handle: `@${localUser.id}@${config.domain}`,
      actor_url: actorUrl,
      domain: config.domain,
      is_local: true,
      is_locked: Number((localUser as any).is_locked ?? 0) === 1,
      discoverable: Number((localUser as any).discoverable ?? 1) === 1,
      // 🏅 プロフィール項目とバッジ（付与ロール）
      fields: parseProfileFields((localUser as any).fields).map((f) => ({ name: f.name, value: f.value })),
      roles: await db.prepare(`
        SELECT r.id, r.name, r.color FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = ?
        ORDER BY r.created_at ASC
      `).all(localUser.id),
      created_at: localUser.created_at,
      follower_count: followerCount,
      following_count: followingCount,
      post_count: postCount,
      is_following: isFollowing,
      is_blocked: isBlocked,
      is_muted: isMuted,
      is_blocking_me: isBlockingMe,
      pinned_posts: pinnedPosts,
    });
  }

  // 2. リモートユーザーの照合
  try {
    const targetActorUrl = await resolveRemoteActorUrl(rawIdentifier);

    // キャッシュを検索、未取得または画像未取得なら最新化
    let remoteActor: RemoteActorRow;
    const existing = await db.prepare('SELECT * FROM remote_actors WHERE id = ?').get(targetActorUrl) as RemoteActorRow | undefined;
    if (existing && existing.icon_url) {
      remoteActor = existing;
    } else {
      remoteActor = await fetchRemoteActor(targetActorUrl, true);
    }

    const postCount = (await db.prepare("SELECT COUNT(*) as c FROM posts WHERE is_local = 0 AND (author_url = ? OR user_id = ?) AND COALESCE(visibility, 'public') != 'direct'").get(targetActorUrl, targetActorUrl) as any).c;

    // フォロー/フォロワーの数は、こちらが把握している関係（follows テーブル）から数える。
    // リモートの相手でも、自分や自分のノードの利用者との関係はここに入っている
    const followerCount = (await db.prepare("SELECT COUNT(*) as c FROM follows WHERE following_url = ? AND status = 'accepted'").get(targetActorUrl) as any).c;
    const followingCount = (await db.prepare("SELECT COUNT(*) as c FROM follows WHERE follower_url = ? AND status = 'accepted'").get(targetActorUrl) as any).c;

    let isFollowing = false;
    let isBlocked = false;
    let isMuted = false;
    if (req.user) {
      if (myActorUrl) {
        const f = await db.prepare('SELECT id FROM follows WHERE follower_url = ? AND following_url = ?').get(myActorUrl, targetActorUrl);
        isFollowing = !!f;
      }
      isBlocked = !!await db.prepare('SELECT 1 FROM user_blocks WHERE user_id = ? AND target_user_id = ?').get(req.user.id, targetActorUrl);
      isMuted = !!await db.prepare('SELECT 1 FROM user_mutes WHERE user_id = ? AND target_user_id = ?').get(req.user.id, targetActorUrl);
    }

    return res.json({
      id: remoteActor.id,
      name: remoteActor.name || remoteActor.username,
      summary: remoteActor.summary || '',
      icon_url: remoteActor.icon_url || '',
      banner_url: remoteActor.banner_url || '',
      handle: `@${remoteActor.username}@${remoteActor.domain}`,
      actor_url: remoteActor.id,
      domain: remoteActor.domain,
      is_local: false,
      created_at: remoteActor.updated_at,
      follower_count: followerCount,
      following_count: followingCount,
      post_count: postCount,
      is_following: isFollowing,
      is_blocked: isBlocked,
      is_muted: isMuted,
      is_blocking_me: false,
      pinned_posts: [],
    });
  } catch (err: any) {
    console.error(`[User Profile Error] Failed to resolve user ${rawIdentifier}:`, err.message);
    return res.status(404).json({ error: 'ユーザーが見つかりませんでした。' });
  }
}));

// ユーザー投稿一覧取得
router.get('/users/:identifier/posts', asyncHandler(async (req: Request, res: Response) => {
  const rawIdentifier = decodeURIComponent(req.params.identifier as string);
  const page = parsePageQuery(req, 50);
  if (page.error) {
    return res.status(400).json({ error: page.error });
  }

  let cleanId = rawIdentifier.replace(/^@/, '');
  if (cleanId.includes(`@${config.domain}`)) {
    cleanId = cleanId.replace(`@${config.domain}`, '');
  }

  const localUser = await db.prepare('SELECT id FROM users WHERE id = ?').get(cleanId);

  const baseSelect = `
    SELECT 
      p.*,
      p.id AS post_id,
      p.published_at AS timeline_at,
      COALESCE(
        NULLIF(p.author_icon, ''),
        NULLIF(u.icon_url, ''),
        NULLIF(ra.icon_url, ''),
        ''
      ) AS author_icon
    FROM posts p
    LEFT JOIN users u ON p.is_local = 1 AND p.user_id = u.id
    LEFT JOIN remote_actors ra ON p.is_local = 0 AND (p.author_url = ra.id OR p.user_id = ra.id)
  `;

  // リモートは actor URL に正規化してから引く（裸のユーザー名でも投稿を出せるように）。
  // 読み足しのたびに解決し直さないよう、ここで 1 回だけ決める
  let targetActorUrl = '';
  const handleFromActorUrl = (url: string): string => {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/^\/users\/([^/]+)/);
      return match ? `@${decodeURIComponent(match[1])}@${parsed.host}` : '';
    } catch {
      return '';
    }
  };
  if (!localUser) {
    targetActorUrl = await resolveRemoteActorUrl(rawIdentifier).catch(() => rawIdentifier);
  }

  const currentActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
  const { items: enriched, nextCursor } = await collectVisiblePage({
    limit: page.limit,
    cursor: page.cursor,
    fetchRows: async (cursor, n) => {
      const cursorCond = cursor ? ` AND ${cursorPredicate('p.published_at', 'p.id')}` : '';
      const cursorParams = cursor ? [cursor.at, cursor.at, cursor.id] : [];
      if (localUser) {
        return await db.prepare(`
          ${baseSelect}
          WHERE p.user_id = ? AND COALESCE(p.visibility, 'public') != 'direct'${cursorCond}
          ORDER BY p.published_at DESC, p.id DESC
          LIMIT ?
        `).all(cleanId, ...cursorParams, n) as any[];
      }
      return await db.prepare(`
        ${baseSelect}
        WHERE (p.author_url = ? OR p.user_id = ? OR p.author_handle = ?)
          AND COALESCE(p.visibility, 'public') != 'direct'${cursorCond}
        ORDER BY p.published_at DESC, p.id DESC
        LIMIT ?
      `).all(targetActorUrl, targetActorUrl, handleFromActorUrl(targetActorUrl), ...cursorParams, n) as any[];
    },
    filterRows: (rows) => enrichAndFilterPosts(rows, currentActorUrl, req.user?.id),
    sortKey: 'published_at',
    idKey: 'id',
  });
  if (nextCursor) {
    res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
    res.setHeader('X-Next-Cursor', nextCursor);
  }
  res.json(enriched);
}));


// 自分の投稿カレンダー（日付ごとの件数）
router.get('/me/post-calendar', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const monthParam = String(req.query.month || '');
  const month = /^[0-9]{4}-[0-9]{2}$/.test(monthParam) ? monthParam : new Date().toISOString().slice(0, 7);
  const [yearStr, monthStr] = month.split('-');
  const start = `${month}-01`;
  const nextYear = Number(monthStr) === 12 ? Number(yearStr) + 1 : Number(yearStr);
  const nextMonth = Number(monthStr) === 12 ? '01' : String(Number(monthStr) + 1).padStart(2, '0');
  const end = `${nextYear}-${nextMonth}-01`;
  try {
    const rows = await db.prepare(`
      SELECT substr(published_at, 1, 10) AS day, count(*) AS count
      FROM posts
      WHERE user_id = ? AND published_at >= ? AND published_at < ?
        AND COALESCE(visibility, 'public') != 'direct'
      GROUP BY day
      ORDER BY day
    `).all(user.id, start, end);
    res.json({ month, days: rows });
  } catch (err: any) {
    console.error('[API Post Calendar Error]:', err);
    res.status(500).json({ error: 'カレンダーの取得に失敗しました。' });
  }
}));

// フォロー中リスト
router.get('/following', asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.query.userId as string) || req.user?.id;
  if (!userId) {
    return res.status(400).json({ error: 'userId が必要です。' });
  }

  // userId はローカルの ID のほか、リモートのプロフィールから渡される actor URL も受け付ける
  const myActorUrl = userId.startsWith('http') ? userId : `${config.origin}/users/${userId}`;
  // ローカルの相手は users 側にしか名前・アイコンが無いので、両方を引いて埋める
  // （リモートは remote_actors、ローカルは users。`? || u.id` で actor URL を組み立てる）
  // どちら側かは follows.is_local（ローカル=1 / リモート=0）をそのまま使う。
  const following = await db.prepare(`
    SELECT f.*,
      COALESCE(NULLIF(r.name, ''), u.name, '') AS name,
      COALESCE(NULLIF(r.username, ''), u.id, '') AS username,
      COALESCE(NULLIF(r.domain, ''), ?) AS domain,
      COALESCE(NULLIF(r.icon_url, ''), NULLIF(u.icon_url, ''), '') AS icon_url,
      ('@' || COALESCE(NULLIF(r.username, ''), u.id, '') || '@' || COALESCE(NULLIF(r.domain, ''), ?)) AS handle
    FROM follows f
    LEFT JOIN remote_actors r ON f.following_url = r.id
    LEFT JOIN users u ON f.following_url = ? || u.id
    WHERE f.follower_url = ? AND f.status = 'accepted'
    ORDER BY f.created_at DESC
  `).all(config.domain, config.domain, `${config.origin}/users/`, myActorUrl);

  res.json(following);
}));

// フォロワーリスト
router.get('/followers', asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.query.userId as string) || req.user?.id;
  if (!userId) {
    return res.status(400).json({ error: 'userId が必要です。' });
  }

  // userId はローカルの ID のほか、リモートのプロフィールから渡される actor URL も受け付ける
  const myActorUrl = userId.startsWith('http') ? userId : `${config.origin}/users/${userId}`;
  // 承認済みのフォロワーのみ（鍵アカウントの承認待ちは含めない）。表示用に相手の名前とアイコンも埋める
  const followers = await db.prepare(`
    SELECT f.*,
      COALESCE(NULLIF(r.name, ''), u.name, '') AS name,
      COALESCE(NULLIF(r.username, ''), u.id, '') AS username,
      COALESCE(NULLIF(r.domain, ''), ?) AS domain,
      COALESCE(NULLIF(r.icon_url, ''), NULLIF(u.icon_url, ''), '') AS icon_url
    FROM follows f
    LEFT JOIN remote_actors r ON f.follower_url = r.id
    LEFT JOIN users u ON f.follower_url = ? || u.id
    WHERE f.following_url = ? AND f.status = 'accepted'
    ORDER BY f.created_at DESC
  `).all(config.domain, `${config.origin}/users/`, myActorUrl);

  res.json(followers);
}));


router.get('/directory', asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
  const q = String(req.query.q || '').trim();
  // ログイン中は「自分」と「もうフォローしている人」を外す（「おすすめ」欄がフォロー済みで
  // 埋まらないように）。外すぶん多めに引いてから詰める。未ログインの公開一覧はそのまま
  const viewerActorUrl = req.user ? `${config.origin}/users/${req.user.id}` : null;
  const fetchLimit = viewerActorUrl && !q ? Math.min(limit * 2, 100) : limit;

  try {
    const initialRows = await db.prepare(`
      SELECT id, name, summary, icon_url, banner_url, created_at, fields, discoverable
      FROM users
      WHERE is_frozen = 0 AND approval_status = 'approved' AND COALESCE(discoverable, 1) = 1
        AND (? = '' OR id LIKE ? OR name LIKE ?)
      ORDER BY created_at ASC
      LIMIT ?
    `).all(q, `%${q}%`, `%${q}%`, fetchLimit) as any[];

    // フォロー中（承認済み）の actor URL を 1 本で引いて落とす
    let rows = initialRows;
    if (viewerActorUrl) {
      const followedRows = (await db
        .prepare("SELECT following_url FROM follows WHERE follower_url = ? AND status = 'accepted'")
        .all(viewerActorUrl)) as { following_url: string }[];
      const followed = new Set(followedRows.map((row) => row.following_url));
      rows = initialRows
        .filter((user) => user.id !== req.user!.id && !followed.has(`${config.origin}/users/${user.id}`))
        .slice(0, limit);
    }

    // 利用者ごとに 3 本ずつ撃つと 50 人で 150 クエリになる。しかも投稿数の
    // `COUNT(*) FROM posts WHERE user_id = ?` は user_id に索引が無く全件走査（実測 116ms/人）。
    // **IN でまとめて 3 本**にし、数え上げは索引の効く author_url で行う（実測 6.2ms/人 → まとめると実質 0）。
    const actorUrls = rows.map((user) => `${config.origin}/users/${user.id}`);
    const userIds = rows.map((user) => user.id);
    const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

    const [postCountRows, followerCountRows, roleRows] = rows.length === 0
      ? [[], [], []]
      : await Promise.all([
          db.prepare(`SELECT author_url AS k, COUNT(*) AS c FROM posts WHERE author_url IN (${marks(actorUrls.length)}) GROUP BY author_url`)
            .all(...actorUrls) as Promise<{ k: string; c: number }[]>,
          db.prepare(`SELECT following_url AS k, COUNT(*) AS c FROM follows WHERE following_url IN (${marks(actorUrls.length)}) AND status = 'accepted' GROUP BY following_url`)
            .all(...actorUrls) as Promise<{ k: string; c: number }[]>,
          db.prepare(`
            SELECT ur.user_id AS k, r.id, r.name, r.color FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id IN (${marks(userIds.length)})
            ORDER BY ur.user_id ASC, r.created_at ASC
          `).all(...userIds) as Promise<{ k: string; id: string; name: string; color: string }[]>,
        ]);

    const postCounts = new Map(postCountRows.map((row) => [row.k, Number(row.c)]));
    const followerCounts = new Map(followerCountRows.map((row) => [row.k, Number(row.c)]));
    const rolesByUser = new Map<string, { id: string; name: string; color: string }[]>();
    for (const row of roleRows) {
      const list = rolesByUser.get(row.k) ?? [];
      list.push({ id: row.id, name: row.name, color: row.color });
      rolesByUser.set(row.k, list);
    }

    const users = rows.map((user) => {
      const actorUrl = `${config.origin}/users/${user.id}`;
      return {
        id: user.id,
        name: user.name,
        summary: user.summary || '',
        icon_url: user.icon_url || '',
        banner_url: user.banner_url || '',
        handle: `@${user.id}@${config.domain}`,
        actor_url: actorUrl,
        created_at: user.created_at,
        post_count: postCounts.get(actorUrl) ?? 0,
        follower_count: followerCounts.get(actorUrl) ?? 0,
        fields: parseProfileFields((user as any).fields).map((f) => ({ name: f.name, value: f.value })),
        roles: rolesByUser.get(user.id) ?? [],
      };
    });

    res.json({ users, total: users.length });
  } catch (err: any) {
    console.error('[Directory Error]:', err);
    res.status(500).json({ error: 'ユーザーディレクトリの取得に失敗しました。' });
  }
}));

// 🔇 ワードフィルター（ミュートワード）管理

router.get('/muted-words', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const words = await db.prepare(
    'SELECT id, keyword, case_sensitive, whole_word, created_at FROM muted_words WHERE user_id = ? ORDER BY created_at DESC',
  ).all(user.id);
  res.json(words);
}));

router.post('/muted-words', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const { keyword, caseSensitive, wholeWord } = req.body;
  const value = typeof keyword === 'string' ? keyword.trim().slice(0, 100) : '';
  if (!value) {
    return res.status(400).json({ error: 'キーワードを入力してください。' });
  }

  const existing = await db.prepare('SELECT id FROM muted_words WHERE user_id = ? AND keyword = ?').get(user.id, value);
  if (existing) {
    return res.status(409).json({ error: '同じキーワードが既に登録されています。' });
  }

  const count = (await db.prepare('SELECT COUNT(*) AS c FROM muted_words WHERE user_id = ?').get(user.id) as { c: number }).c;
  if (count >= 200) {
    return res.status(400).json({ error: '登録できるキーワードは 200 件までです。' });
  }

  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO muted_words (id, user_id, keyword, case_sensitive, whole_word, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, user.id, value, caseSensitive ? 1 : 0, wholeWord ? 1 : 0, new Date().toISOString());
  // ミュートワードは自分の画面の絞り込みなので、設定した瞬間に効かせる
  invalidateMutedWords(user.id);
  await invalidateTimelineCache();

  console.log(`[WordFilter] 🔇 @${user.id} が「${value}」をミュートワードに追加しました`);
  res.status(201).json({ success: true, id, keyword: value });
}));

router.delete('/muted-words/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const result = await db.prepare('DELETE FROM muted_words WHERE id = ? AND user_id = ?').run(String(req.params.id), user.id);
  invalidateMutedWords(user.id);
  await invalidateTimelineCache();
  if (result.changes === 0) {
    return res.status(404).json({ error: 'キーワードが見つかりません。' });
  }
  res.json({ success: true });
}));

// 🔒 フォローリクエスト（鍵アカウントの承認待ち）
export const handleListFollowRequests = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const myActorUrl = `${config.origin}/users/${user.id}`;
  const rows = await db.prepare(`
    SELECT id, follower_url, inbox_url, created_at FROM follows
    WHERE following_url = ? AND status = 'pending'
    ORDER BY created_at DESC LIMIT 200
  `).all(myActorUrl) as { id: string; follower_url: string; inbox_url: string; created_at: string }[];

  const enriched = await Promise.all(rows.map(async (row) => {
    const remote = await db.prepare('SELECT username, domain, name, icon_url FROM remote_actors WHERE id = ?').get(row.follower_url) as
      | { username: string; domain: string; name: string | null; icon_url: string | null }
      | undefined;
    return {
      id: row.id,
      actor_url: row.follower_url,
      handle: remote ? `@${remote.username}@${remote.domain}` : row.follower_url,
      name: remote?.name || remote?.username || row.follower_url,
      icon_url: remote?.icon_url || '',
      created_at: row.created_at,
    };
  }));

  res.json(enriched);
});
router.get('/follow-requests', requireAuth, handleListFollowRequests);

// フォローリクエストの承認 / 拒否
export const handleRespondFollowRequest = asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const actorUrl = typeof req.body?.actorUrl === 'string' ? req.body.actorUrl.trim() : '';
  const action = req.body?.action === 'accept' ? 'accept' : req.body?.action === 'reject' ? 'reject' : null;

  if (!actorUrl || !action) {
    return res.status(400).json({ error: 'actorUrl と action (accept / reject) が必要です。' });
  }

  const myActorUrl = `${config.origin}/users/${user.id}`;
  const row = await db.prepare('SELECT * FROM follows WHERE follower_url = ? AND following_url = ?').get(actorUrl, myActorUrl) as
    | { id: string; follower_url: string; following_url: string; inbox_url: string; status: string }
    | undefined;

  if (!row) {
    return res.status(404).json({ error: 'フォローリクエストが見つかりません。' });
  }

  // 承認・拒否の対象となる Follow Activity を組み立てる
  const followActivity = {
    '@context': ['https://www.w3.org/ns/activitystreams'],
    id: `${row.id}#follow`,
    type: 'Follow',
    actor: row.follower_url,
    object: myActorUrl,
  };

  if (action === 'accept') {
    await db.prepare("UPDATE follows SET status = 'accepted' WHERE follower_url = ? AND following_url = ?").run(actorUrl, myActorUrl);
    console.log(`[FollowRequest] ✅ @${user.id} が ${actorUrl} のフォローを承認しました`);
    if (row.inbox_url) {
      deliverActivity({
        inboxUrl: row.inbox_url,
        activity: buildAcceptActivity({ actorUrl: myActorUrl, followActivity }),
        senderUser: user,
      }).catch(() => {});
    }
  } else {
    await db.prepare('DELETE FROM follows WHERE follower_url = ? AND following_url = ?').run(actorUrl, myActorUrl);
    console.log(`[FollowRequest] 🚫 @${user.id} が ${actorUrl} のフォローを拒否しました`);
    if (row.inbox_url) {
      deliverActivity({
        inboxUrl: row.inbox_url,
        activity: buildRejectActivity({ actorUrl: myActorUrl, followActivity }),
        senderUser: user,
      }).catch(() => {});
    }
  }

  res.json({ success: true, action, actorUrl });
});
router.post('/follow-requests/respond', requireAuth, handleRespondFollowRequest);


// 📥 アカウント移行インポート
//    - Spica 自身のエクスポート（ZIP / JSON）: 投稿に加えてメディア・フォロー・フォロワー・
//      ブックマーク・リアクションまで取り込む（メディアは ZIP に同梱された実ファイルを使う）
//    - Mastodon の outbox.json / Misskey の notes.json: 本文（CW・公開範囲・投稿日時つき）
const MAX_IMPORT_ARCHIVE_BYTES = 50 * 1024 * 1024;

const archiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_ARCHIVE_BYTES },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    if (file.mimetype.includes('json') || file.mimetype.includes('zip') || name.endsWith('.json') || name.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('インポートするファイル（Spica のエクスポート ZIP / JSON、Mastodon の outbox.json、Misskey の notes.json）を選択してください。'));
    }
  },
});

/** multer のエラー（サイズ超過・形式違い）を 400 で返す */
const archiveUploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  archiveUpload.single('archive')(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: `アーカイブのサイズが大きすぎます（上限 ${Math.floor(MAX_IMPORT_ARCHIVE_BYTES / (1024 * 1024))}MB）。`,
        });
      }
      return res.status(400).json({ error: err.message || 'アーカイブの受け取りに失敗しました。' });
    }
    next();
  });
};

router.post('/import/archive', requireAuth, archiveUploadMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const user = req.rawUser!;
  const file = (req as Request & { file?: { buffer: Buffer } }).file;
  if (!file) {
    return res.status(400).json({ error: 'アーカイブファイル（ZIP / JSON）が必要です。' });
  }

  // 1. ZIP（Spica のエクスポート）: 中の JSON とメディアの実ファイルを読む
  //    パス検証（zip-slip 対策）と件数・サイズの上限はリーダー側で掛ける
  if (isZipBuffer(file.buffer)) {
    let entries: Map<string, Buffer>;
    try {
      const zip = readZipEntries(file.buffer);
      entries = zip.entries;
      if (zip.skipped.length > 0) {
        console.warn(
          `[Import] ⚠️ @${user.id} の ZIP で読み飛ばしたファイル: ${zip.skipped.slice(0, 5).join(', ')}` +
          (zip.skipped.length > 5 ? ` ほか ${zip.skipped.length - 5} 件` : ''),
        );
      }
    } catch (err: any) {
      return res.status(400).json({ error: `ZIP を読み込めませんでした: ${err?.message || err}` });
    }

    try {
      const bundle = buildSpicaBundleFromZip(entries);
      if (bundle.posts.length === 0 && bundle.media.length === 0) {
        return res.status(400).json({ error: '取り込めるデータが見つかりませんでした（Spica のエクスポート ZIP を選択してください）。' });
      }

      const result = await importSpicaArchive(user, bundle);
      console.log(
        `[Import] 📥 @${user.id} が Spica のエクスポート（ZIP）を取り込み: 投稿=${result.imported} メディア=${result.media.imported} ` +
        `フォロー=${result.following.imported} フォロワー=${result.followers.imported} ブックマーク=${result.bookmarks.imported} リアクション=${result.reactions.imported}`,
      );

      return res.json({ success: true, ...result, message: buildImportMessage(result) });
    } catch (err: any) {
      console.error('[Import Error]:', err);
      return res.status(500).json({ error: err.message || 'インポートに失敗しました。' });
    }
  }

  // 2. JSON（Spica のエクスポート / Mastodon / Misskey）: 形式を判定して取り込む
  let data: any;
  try {
    data = JSON.parse(file.buffer.toString('utf8'));
  } catch {
    return res.status(400).json({
      error: 'JSON の解析に失敗しました。Spica のエクスポート、Mastodon の outbox.json、Misskey の notes.json のいずれかを選択してください。',
    });
  }

  try {
    const { format, notes } = parseArchive(data);

    // Spica 自身のエクスポート（JSON 単体。メディアの実ファイルは無いのでスキップされる）
    if (format === 'spica') {
      const bundle = buildSpicaBundle(data);
      if (bundle.posts.length === 0) {
        return res.status(400).json({ error: '取り込める投稿が見つかりませんでした（ファイル形式をご確認ください）。', format });
      }

      const result = await importSpicaArchive(user, bundle);
      console.log(
        `[Import] 📥 @${user.id} が Spica のエクスポート（JSON）を取り込み: 投稿=${result.imported} メディア=${result.media.imported} ` +
        `フォロー=${result.following.imported} フォロワー=${result.followers.imported} ブックマーク=${result.bookmarks.imported} リアクション=${result.reactions.imported}`,
      );

      return res.json({ success: true, ...result, message: buildImportMessage(result) });
    }

    if (notes.length === 0) {
      return res.status(400).json({ error: '取り込める投稿が見つかりませんでした（ファイル形式をご確認ください）。', format });
    }

    const result = await importNotes(user, notes);
    console.log(
      `[Import] 📥 @${user.id} が投稿を取り込み: imported=${result.imported} skipped=${result.skipped} failed=${result.failed} (format=${format})`,
    );

    res.json({
      success: true,
      format,
      ...result,
      message: buildImportMessage(result),
    });
  } catch (err: any) {
    console.error('[Import Error]:', err);
    res.status(500).json({ error: err.message || 'インポートに失敗しました。' });
  }
}));


export default router;
