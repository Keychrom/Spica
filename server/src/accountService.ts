import fs from 'node:fs';
import path from 'node:path';
import { db, UserRow } from './db.js';
import { config } from './config.js';
import { broadcastDeletePost } from './streaming.js';
import { buildDeleteActorActivity, deliverActivity } from './activitypub.js';
import { registerJobHandler, enqueueJob } from './jobs.js';
import { deleteAllMediaForUser } from './mediaService.js';

export interface DeleteUserAccountResult {
  success: boolean;
  error?: string;
}

/**
 * ユーザーアカウントの完全消去
 * ユーザーの全投稿、添付メディア、リアクション、フォロー、通知、セッションをカスケード削除し、
 * ActivityPub フォロワー/リレーに Delete Actor を非同期配信。
 */
export async function deleteUserAccount(userId: string): Promise<DeleteUserAccountResult> {
  const cleanId = userId.trim();
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(cleanId) as UserRow | undefined;
  if (!user) {
    return { success: false, error: 'ユーザーが見つかりません。' };
  }

  // 最後の管理者を削除しない保護
  if (user.role === 'admin') {
    const adminCount = (await db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get() as any).c;
    if (adminCount <= 1) {
      return {
        success: false,
        error: 'サーバーに存在する最後の管理者を削除することはできません。別のユーザーを管理者に任命してから実行してください。',
      };
    }
  }

  const actorUrl = `${config.origin}/users/${user.id}`;

  // 1. ActivityPub 連合先フォロワーおよびリレーサーバーへの Delete(Actor) 配信準備
  try {
    const followerInboxes = (await db.prepare(`
      SELECT DISTINCT inbox_url FROM follows
      WHERE following_url = ? AND inbox_url IS NOT NULL AND inbox_url != ''
    `).all(actorUrl) as { inbox_url: string }[]).map((f) => f.inbox_url);

    // 有効なリレーサーバーの inbox も追加
    const relayInboxes = (await db.prepare(`
      SELECT DISTINCT inbox_url FROM relays WHERE status = 'accepted'
    `).all() as { inbox_url: string }[]).map((r) => r.inbox_url);

    const allInboxes = Array.from(new Set([...followerInboxes, ...relayInboxes]));

    if (allInboxes.length > 0) {
      const deleteActivity = buildDeleteActorActivity({ actorUrl });
      console.log(`[Account Delete] 📡 Delivering Delete(Actor) for @${user.id} to ${allInboxes.length} inboxes...`);
      // バックグラウンド非同期配信（失敗してもDB削除は進める）
      Promise.allSettled(
        allInboxes.map((inboxUrl) =>
          deliverActivity({
            inboxUrl,
            activity: deleteActivity,
            senderUser: user,
          })
        )
      ).catch((err) => {
        console.error('[Account Delete] Error in delivery Promise.allSettled:', err);
      });
    }
  } catch (deliveryErr) {
    console.warn('[Account Delete] Failed to deliver Delete(Actor):', deliveryErr);
  }

  // 2. 投稿のリアルタイム削除通知 & ローカル添付ファイルの削除
  try {
    const userPosts = await db.prepare('SELECT id, media_attachments FROM posts WHERE user_id = ?').all(cleanId) as {
      id: string;
      media_attachments: string;
    }[];

    for (const p of userPosts) {
      try {
        broadcastDeletePost(p.id);
      } catch {}

      try {
        const attachments = JSON.parse(p.media_attachments || '[]');
        if (Array.isArray(attachments)) {
          for (const att of attachments) {
            if (att.url && typeof att.url === 'string' && att.url.startsWith('/uploads/')) {
              const localFilePath = path.join(process.cwd(), 'server', att.url.replace(/^\//, ''));
              if (fs.existsSync(localFilePath)) {
                fs.unlinkSync(localFilePath);
              }
            }
          }
        }
      } catch {}
    }
  } catch (postCleanErr) {
    console.warn('[Account Delete] Error cleaning up post attachments:', postCleanErr);
  }

  // 3. ユーザーのアイコン・ヘッダー画像のローカル削除
  for (const imgUrl of [user.icon_url, user.banner_url]) {
    if (imgUrl && typeof imgUrl === 'string' && imgUrl.startsWith('/uploads/')) {
      try {
        const localFilePath = path.join(process.cwd(), 'server', imgUrl.replace(/^\//, ''));
        if (fs.existsSync(localFilePath)) {
          fs.unlinkSync(localFilePath);
        }
      } catch {}
    }
  }

  // 4. データベースの全関連テーブルからの完全クリーンアップ
  try {
    // ユーザーの投稿に対するリアクション、リノート、ブックマーク、固定投稿、アンケート
    await db.prepare('DELETE FROM reactions WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)').run(cleanId);
    await db.prepare('DELETE FROM announces WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)').run(cleanId);
    await db.prepare('DELETE FROM bookmarks WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)').run(cleanId);
    await db.prepare('DELETE FROM pinned_posts WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)').run(cleanId);
    await db.prepare('DELETE FROM polls WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)').run(cleanId);

    // ユーザー自身が行ったアクション
    await db.prepare('DELETE FROM reactions WHERE user_id = ?').run(cleanId);
    await db.prepare('DELETE FROM announces WHERE user_id = ?').run(cleanId);
    await db.prepare('DELETE FROM bookmarks WHERE user_id = ?').run(cleanId);
    await db.prepare('DELETE FROM pinned_posts WHERE user_id = ?').run(cleanId);
    await db.prepare('DELETE FROM poll_votes WHERE user_id = ?').run(cleanId);
    await db.prepare('DELETE FROM user_blocks WHERE user_id = ? OR target_user_id = ?').run(cleanId, cleanId);
    await db.prepare('DELETE FROM user_mutes WHERE user_id = ? OR target_user_id = ?').run(cleanId, cleanId);

    // フォロー・フォロワー
    await db.prepare('DELETE FROM follows WHERE follower_url = ? OR following_url = ?').run(actorUrl, actorUrl);

    // 通知
    await db.prepare('DELETE FROM notifications WHERE user_id = ? OR actor_id = ?').run(cleanId, actorUrl);

    // 投稿本体
    await db.prepare('DELETE FROM posts WHERE user_id = ?').run(cleanId);

    // ドライブ（アップロード済みメディア）を台帳とストレージから削除
    const deletedMedia = await deleteAllMediaForUser(cleanId);
    if (deletedMedia > 0) {
      console.log(`[Account Delete] 🗂️ ${deletedMedia} 件のドライブのメディアを削除しました (@${cleanId})`);
    }

    // セッション
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(cleanId);

    // 招待コードのメモ更新（管理者が作成した招待コードの参照を保護）
    await db.prepare("UPDATE invitation_codes SET memo = memo || ' (作成者退会)' WHERE created_by = ?").run(cleanId);

    // ユーザー本体
    await db.prepare('DELETE FROM users WHERE id = ?').run(cleanId);

    console.log(`[Account Delete] ✅ User @${cleanId} (${user.name}) and all records deleted successfully.`);
    return { success: true };
  } catch (dbErr: any) {
    console.error('[Account Delete] DB deletion error:', dbErr);
    return { success: false, error: dbErr.message || 'データベース削除中にエラーが発生しました。' };
  }
}

// ---------------------------------------------------------------------------
// 退会の非同期化
//
// アカウント削除は「フォロワー全員への Delete 配信（ネットワーク）」と「メディアの削除（ファイル）」
// を含むため、大きなアカウントでは**リクエストの中で待たせると終わらない**（タイムアウトすると
// 中途半端な状態で残る）。そこで:
//
//   1. 受け付けたら**すぐ凍結してセッションを消す**（＝その場でログインできなくなる。失敗しても安全側）
//   2. 実際の削除はジョブキューで実行する（再試行つき。進み具合は管理画面と /health で見える）
// ---------------------------------------------------------------------------

/** 退会を受け付ける（凍結 + セッション削除 + ジョブ投入） */
export async function beginUserDeletion(userId: string): Promise<{ success: boolean; jobId?: string; error?: string }> {
  const cleanId = userId.trim();
  const user = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(cleanId) as { id: string; role: string } | undefined;
  if (!user) return { success: false, error: 'ユーザーが見つかりません。' };

  // 最後の管理者を消さない保護（ここで止める）
  if (user.role === 'admin') {
    const adminCount = (await db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get() as any).c;
    if (adminCount <= 1) {
      return { success: false, error: 'サーバーに存在する最後の管理者を削除することはできません。別のユーザーを管理者に任命してから実行してください。' };
    }
  }

  // 1. 先に凍結してログインできなくする（削除が失敗しても「入れない」状態で止まる＝安全側）
  await db.prepare('UPDATE users SET is_frozen = 1 WHERE id = ?').run(cleanId);
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(cleanId);

  // 2. 実作業はジョブで（同じ人の退会が二重に走らないよう dedupe）
  const jobId = await enqueueJob('user_delete', { userId: cleanId }, { dedupeKey: `user_delete:${cleanId}`, maxAttempts: 5 });
  if (!jobId) {
    return { success: false, error: '退会処理を受け付けられませんでした。しばらくしてからお試しください。' };
  }
  console.log(`[Account Delete] 🗑️ @${cleanId} の退会を受け付けました（ジョブ ${jobId}）`);
  return { success: true, jobId };
}

// ジョブの処理（登録はモジュール読み込み時）
registerJobHandler('user_delete', async (payload: { userId?: string }) => {
  const userId = String(payload?.userId || '');
  if (!userId) throw new Error('userId がありません');
  const result = await deleteUserAccount(userId);
  if (!result.success) {
    // 失敗は例外にして再試行に回す（「見つかりません」は消えている＝成功扱い）
    if (result.error === 'ユーザーが見つかりません。') {
      console.log(`[Account Delete] ℹ️ ${userId} は既に削除済みです`);
      return;
    }
    throw new Error(result.error || 'アカウントの削除に失敗しました');
  }
  console.log(`[Account Delete] ✅ ${userId} の削除が完了しました`);
});
