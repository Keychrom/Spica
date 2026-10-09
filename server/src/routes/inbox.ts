import { Router, Request, Response } from 'express';
import { db, UserRow, PostRow, RelayRow, FollowRow, isDomainBlocked, createNotification, addRemoteBlock, removeRemoteBlock } from '../db.js';
import { config } from '../config.js';
import {
  fetchRemoteActor,
  buildAcceptActivity,
  buildFollowActivity,
  buildMoveActivity,
  fetchActorAliases,
  deliverActivity,
  extractCustomEmojis,
  replaceCustomEmojis,
  federatePollUpdate,
} from '../activitypub.js';
import { verifyInboxSignature } from '../inboxAuth.js';
import { asyncHandler } from '../asyncHandler.js';
import { inboxGate } from '../inboxGate.js';
import { shouldIndexRemotePost, shouldStoreRemoteAnnounce } from '../searchPolicy.js';
import { isPublicPost } from '../postVisibility.js';
import { isDmEnabled, localRecipientUserIds, localUserIdFromActorUrl, isDmReceptionAllowed } from '../dm.js';
import { ingestRemoteFlag, logNewReport } from '../reportService.js';
import { broadcastNote, broadcastReaction, broadcastAnnounce, broadcastPoll, broadcastEvent } from '../streaming.js';
import { getPollDataForPost } from './api.js';
import { checkAntennaMatchesAndNotify } from '../postService.js';
import { invalidateTimelineCache } from '../timelineCache.js';
import {
  enqueueInboxActivity,
  registerInboxProcessor,
  registerInboxJobHandler,
  addDeletedRemotePost,
  isDeletedRemotePost,
} from '../inboxQueue.js';
import { fallbackActivityId } from '../ids.js';

export const inboxRouter = Router();

/** `${config.origin}/users/<id>` 形式のローカルアクター URL からユーザーIDを取り出す */
function localUsernameFromActorUrl(actorUrl: string): string | null {
  if (!actorUrl || !config.origin) return null;
  const prefix = `${config.origin}/users/`;
  if (!actorUrl.startsWith(prefix)) return null;
  const id = actorUrl.slice(prefix.length).split(/[/?#]/)[0];
  return id || null;
}

/** ローカルアクター（ユーザーまたはインスタンスアクター）かどうか */
async function isLocalActorUrl(actorUrl: string): Promise<boolean> {
  if (!actorUrl) return false;
  if (actorUrl === `${config.origin}/actor`) return true;
  const id = localUsernameFromActorUrl(actorUrl);
  return Boolean(id && await db.prepare('SELECT id FROM users WHERE id = ?').get(id));
}

/**
 * 共通の Activity 受信ハンドラ (User Inbox & Shared Inbox)
 */
/**
 * 受理した Activity を処理する（HTTP からもワーカーからも呼ばれる）。
 *
 * 呼ぶ側の違いは `res`（応答の書き先）だけに閉じ込めてある:
 *   - HTTP（同期）… Express の `res` をそのまま渡す（そのまま応答になる）
 *   - ワーカー（非同期）… 状態と本文を記録するだけのオブジェクトを渡す
 * これで、重い処理の中身を 1 か所に保ったまま**実行の場所だけ**を選べる。
 *
 * ※ 形式の検査・署名検証・受け入れゲートは**呼ぶ前に**済ませておくこと（受理の判断は HTTP 側の仕事）。
 */
export interface ActivityResponder {
  status(code: number): { json(body: unknown): void };
}

export async function processActivity(
  activity: any,
  res: ActivityResponder,
  targetUsername?: string,
): Promise<void> {
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;

  try {
    switch (activity.type) {
      case 'Follow': {
        // Misskey, Mastodon 等からのフォローリクエスト
        const targetActorUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;
        console.log(`[Inbox Follow] Follow request target: ${targetActorUrl}`);

        let targetUserId: string | null = targetUsername ? targetUsername.toLowerCase() : null;
        
        if (!targetUserId && targetActorUrl) {
          // targetActorUrl からユーザーIDを柔軟に抽出 (例: https://astrabit.../users/admin)
          const match = targetActorUrl.match(/\/users\/([^/?#]+)/i);
          if (match) {
            targetUserId = decodeURIComponent(match[1]).toLowerCase();
          }
        }

        let targetUser: UserRow | undefined;
        if (targetUserId) {
          targetUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId) as unknown as UserRow | undefined;
        }

        // 見つからない場合は最初の管理者ユーザーにフォールバック
        if (!targetUser) {
          targetUser = await db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get() as unknown as UserRow | undefined;
        }

        if (!targetUser) {
          console.error(`[Inbox Follow Error] Target user not found for: ${targetActorUrl}`);
          return res.status(404).json({ error: 'フォロー対象ユーザーが見つかりません。' });
        }

        const canonicalTargetActorUrl = `${config.origin}/users/${targetUser.id}`;

        // リモートActor情報の取得（Inbox URL等）
        let remoteActor;
        try {
          remoteActor = await fetchRemoteActor(actorUrl);
        } catch (err: any) {
          console.warn(`[Inbox Follow Warning] Could not fetch remote actor (${err.message}), using fallback.`);
          const parsedActor = new URL(actorUrl);
          remoteActor = {
            id: actorUrl,
            username: parsedActor.pathname.split('/').pop() || 'remote_user',
            domain: parsedActor.host,
            name: 'Remote User',
            summary: '',
            inbox_url: actorUrl.replace(/\/users\/[^/]+/, '/inbox'),
            shared_inbox_url: null,
            public_key_id: `${actorUrl}#main-key`,
            public_key_pem: '',
            updated_at: new Date().toISOString(),
          };
        }

        // follows テーブルに登録 (ステータス: accepted)
        const followId = `${actorUrl} -> ${canonicalTargetActorUrl}`;
        const now = new Date().toISOString();

        // 鍵アカウント（フォロー承認制）の場合は承認待ちとして保存し、Accept は返さない
        const isLocked = Number((targetUser as any).is_locked ?? 0) === 1;
        const initialStatus = isLocked ? 'pending' : 'accepted';

        await db.prepare(`
          INSERT INTO follows (id, follower_url, following_url, inbox_url, is_local, status, created_at)
          VALUES (?, ?, ?, ?, 0, ?, ?)
          ON CONFLICT(follower_url, following_url) DO UPDATE SET
            status = CASE
              WHEN follows.status = 'accepted' THEN 'accepted'
              ELSE excluded.status
            END,
            inbox_url = excluded.inbox_url
        `).run(followId, actorUrl, canonicalTargetActorUrl, remoteActor.inbox_url, initialStatus, now);

        try {
          await createNotification({
            userId: targetUser.id,
            type: 'follow',
            actorId: actorUrl,
            actorName: remoteActor.name || remoteActor.username,
            actorHandle: `@${remoteActor.username}@${remoteActor.domain}`,
            actorIcon: remoteActor.icon_url || '',
          });
        } catch (e) {
          console.error('[Notification Error] Inbox follow notification failed:', e);
        }

        if (isLocked) {
          console.log(`[Inbox Follow Pending] ⏳ 鍵アカウントのため承認待ち: ${actorUrl} -> ${canonicalTargetActorUrl}`);
          return res.status(202).json({ status: 'Follow pending approval' });
        }

        console.log(`[Inbox Follow Success] ✅ Registered follower: ${actorUrl} follows ${canonicalTargetActorUrl}`);

        // 自動で Accept Activity を相手の Inbox に返信 (Misskey / Mastodon 必須)
        const acceptActivity = buildAcceptActivity({
          actorUrl: canonicalTargetActorUrl,
          followActivity: activity,
        });

        console.log(`[Inbox Follow] Sending Accept Activity to ${remoteActor.inbox_url}...`);
        deliverActivity({
          inboxUrl: remoteActor.inbox_url,
          activity: acceptActivity,
          senderUser: targetUser,
        }).then((ok) => {
          console.log(`[Inbox Follow] Accept delivery result to ${remoteActor.inbox_url}: ${ok ? 'SUCCESS' : 'FAILED'}`);
        }).catch((err) => {
          console.error('[Inbox Follow] Error delivering Accept:', err);
        });

        return res.status(202).json({ status: 'Follow accepted' });
      }

      case 'Accept': {
        // こちらから送った Follow に対する Accept（相手サーバーまたはリレーサーバーからの承認）
        const followObject = activity.object;
        const targetUrl = typeof followObject === 'string' ? followObject : (followObject?.object || followObject?.id);
        
        console.log(`[Inbox Accept] 🤝 Received Accept from ${actorUrl}, target: ${targetUrl}`);

        // 1. follows テーブルの更新 (個人アカウントのフォロー承認)
        //    ※ 宛先 (following_url) だけでは「同じ相手をフォローしている他のローカルユーザー」
        //      まで承認してしまうため、フォロー元 (follower_url) も必ず特定する
        if (targetUrl) {
          if (targetUsername) {
            const followerActor = `${config.origin}/users/${targetUsername.toLowerCase()}`;
            const result = await db.prepare('UPDATE follows SET status = ? WHERE following_url = ? AND follower_url = ?')
              .run('accepted', targetUrl, followerActor);
            if (result.changes === 0) {
              // 個人Inbox宛でもフォロー元が一致しない場合に備え、自ノード発のフォローに限定して更新する
              await db.prepare("UPDATE follows SET status = 'accepted' WHERE following_url = ? AND is_local = 1").run(targetUrl);
            }
          } else {
            // 共有Inbox: 自ノードのユーザーが行ったフォローに限定する
            await db.prepare("UPDATE follows SET status = 'accepted' WHERE following_url = ? AND is_local = 1").run(targetUrl);
          }
        }

        // 2. リレーサーバーのステータス自動更新 (ドメイン・URL柔軟照合)
        //    承認されたフォローの投稿が、キャッシュ済みのホームにも出るように捨てておく
        await invalidateTimelineCache();
        try {
          const parsedActorUrl = new URL(actorUrl);
          const actorHost = parsedActorUrl.host;

          // 登録されている全リレーを走査してホスト名が一致するリレーを特定
          const allRelays = await db.prepare('SELECT * FROM relays').all() as unknown as RelayRow[];
          let matchedRelay: RelayRow | undefined;

          for (const relay of allRelays) {
            try {
              const inboxHost = new URL(relay.inbox_url).host;
              const relayActorHost = relay.actor_url ? new URL(relay.actor_url).host : null;
              if (inboxHost === actorHost || relayActorHost === actorHost || relay.actor_url === actorUrl || relay.inbox_url === actorUrl) {
                matchedRelay = relay;
                break;
              }
            } catch {}
          }

          if (matchedRelay) {
            await db.prepare(`
              UPDATE relays SET status = 'accepted', actor_url = ? WHERE inbox_url = ?
            `).run(actorUrl, matchedRelay.inbox_url);
            console.log(`[Inbox Accept] ✅ Relay automatically accepted: ${matchedRelay.inbox_url} (Actor: ${actorUrl})`);
          } else {
            // フォールバック: 完全一致で更新
            await db.prepare(`
              UPDATE relays SET status = 'accepted' WHERE actor_url = ? OR inbox_url = ?
            `).run(actorUrl, actorUrl);
          }
        } catch (err: any) {
          console.warn('[Inbox Accept Warning] Error during relay status match:', err.message);
        }

        return res.status(200).json({ status: 'Accept processed' });
      }

      case 'Reject': {
        // こちらから送った Follow が相手に拒否された（鍵アカウントなど）。
        // 保留のままの行を消し、キャッシュも捨てる（見えないはずの投稿が残らないように）。
        const rejected = activity.object;
        const rejectedType = typeof rejected === 'object' ? rejected?.type : null;
        if (rejectedType === 'Follow' || !rejectedType) {
          const targetUrl = typeof rejected?.object === 'string' ? rejected.object : rejected?.object?.id;
          if (targetUrl) {
            const result = await db
              .prepare("DELETE FROM follows WHERE following_url = ? AND is_local = 1 AND status <> 'accepted'")
              .run(targetUrl);
            await invalidateTimelineCache();
            console.log(
              `[Inbox Reject] 🚫 Follow rejected by ${actorUrl} for ${targetUrl}（保留の行を ${Number(result.changes ?? 0)} 件削除）`,
            );
          }
        }
        return res.status(200).json({ status: 'Reject processed' });
      }

      case 'Create': {
        // 投稿 (Note / Question) の受信 (フォロワーまたはリレー経由)
        // どの段で時間を使っているかは `INBOX_PROFILE=true` で 1 行ずつ出る（普段は出さない）
        const profileStart = Date.now();
        const mark = (label: string): void => {
          if (config.inboxProfile) {
            console.log(`[Inbox Profile] ${label}: ${Date.now() - profileStart}ms (${activity.id || '(no-id)'})`);
          }
        };
        const note = activity.object;
        if (!note || (note.type !== 'Note' && note.type !== 'Question')) {
          return res.status(200).json({ status: 'Ignored non-Note/Question object' });
        }

        const noteAuthor = typeof note.attributedTo === 'string' ? note.attributedTo : (note.attributedTo?.id || actorUrl);
        if (await isDomainBlocked(noteAuthor) || (note.id && await isDomainBlocked(note.id))) {
          console.log(`[Inbox Blocked] 🚫 Ignored Note from blocked domain author: ${noteAuthor}`);
          return res.status(200).json({ status: 'Ignored blocked domain author' });
        }
        mark('domain 判定');

        let remoteActor;
        try {
          remoteActor = await fetchRemoteActor(actorUrl);
        } catch {
          const parsed = new URL(actorUrl);
          remoteActor = {
            username: parsed.pathname.split('/').pop() || 'user',
            domain: parsed.host,
            name: note.attributedTo || parsed.host,
          };
        }
        mark('actor 取得');

        const noteId = note.id || fallbackActivityId(actorUrl, 'posts');
        // 墓標が立っている投稿は取り込まない（Delete の後に再送・折り返しで戻ってきたぶん。
        // 非同期で処理しているときは、Delete より後に処理される Create がここで止まる）
        if (await isDeletedRemotePost(noteId)) {
          console.log(`[Inbox Ignored] 🪦 削除済みの投稿なので取り込みません: ${noteId}`);
          return res.status(200).json({ status: 'Ignored deleted post' });
        }
        const rawContent = note.content || '';
        const publishedAt = note.published || new Date().toISOString();
        const inReplyTo = note.inReplyTo || null;
        const authorHandle = `@${remoteActor.username}@${remoteActor.domain}`;
        const cw = typeof note.summary === 'string' && note.summary.trim() ? note.summary.trim() : null;

        // 🗳️ アンケート（Poll / Question）への投票（Vote）受信判定
        // Fediverse 仕様（Misskey, Mastodon 等）:
        // アンケートへの投票は Create(Note) として送信され、inReplyTo に対象 Question の URI、
        // name に投票した選択肢テキストが格納される（Misskey では id に '#votes/' が含まれることもある）
        if (inReplyTo && note.type === 'Note') {
          // 親投稿を検索（完全一致、末尾スラッシュの有無、ID単体）
          let parentPost = await db.prepare('SELECT * FROM posts WHERE id = ?').get(inReplyTo) as PostRow | undefined;
          if (!parentPost) {
            const cleanUrl = inReplyTo.replace(/\/$/, '');
            parentPost = await db.prepare('SELECT * FROM posts WHERE id = ? OR id = ?').get(cleanUrl, `${cleanUrl}/`) as PostRow | undefined;
          }

          if (parentPost) {
            const poll = await db.prepare('SELECT * FROM polls WHERE post_id = ?').get(parentPost.id) as any;
            if (poll) {
              const choices = await db.prepare('SELECT choice_index, text, votes_count FROM poll_choices WHERE poll_id = ? ORDER BY choice_index ASC').all(poll.id) as any[];

              // 投票先選択肢の候補文字列を抽出
              const candidateNames: string[] = [];
              if (typeof note.name === 'string' && note.name.trim()) {
                candidateNames.push(note.name.trim());
              }
              if (Array.isArray(note.name)) {
                candidateNames.push(...note.name.filter((n: any) => typeof n === 'string').map((n: string) => n.trim()));
              }
              if (typeof note.content === 'string' && note.content.trim()) {
                const stripped = note.content.replace(/<[^>]*>/g, '').trim();
                if (stripped) candidateNames.push(stripped);
              }

              // 選択肢テキストと照合
              let matchedChoice = choices.find((c) =>
                candidateNames.some((cn) => cn.toLowerCase() === c.text.trim().toLowerCase())
              );

              // もしテキスト一致で見つからず、インデックス番号（"0", "1"等）の場合
              if (!matchedChoice) {
                for (const cn of candidateNames) {
                  const parsedIdx = parseInt(cn, 10);
                  if (!isNaN(parsedIdx) && parsedIdx >= 0 && parsedIdx < choices.length) {
                    matchedChoice = choices.find((c) => c.choice_index === parsedIdx);
                    if (matchedChoice) break;
                  }
                }
              }

              // Misskey 特有: note.id に '#votes/' が含まれている場合（確実に投票）
              if (!matchedChoice && String(note.id || '').includes('#votes/')) {
                for (const key of Object.keys(note)) {
                  if (typeof note[key] === 'string') {
                    const match = choices.find((c) => c.text.trim().toLowerCase() === note[key].trim().toLowerCase());
                    if (match) {
                      matchedChoice = match;
                      break;
                    }
                  }
                }
                if (!matchedChoice && choices.length > 0) {
                  matchedChoice = choices[0];
                }
              }

              if (matchedChoice) {
                console.log(`[Inbox Poll Vote] 🗳️ Received vote from ${actorUrl} for "${matchedChoice.text}" (idx: ${matchedChoice.choice_index}) on post ${parentPost.id}`);

                // 期限切れ判定
                const now = new Date().toISOString();
                if (poll.expires_at && poll.expires_at < now) {
                  console.log(`[Inbox Poll Vote] ⚠️ Poll expired on ${poll.expires_at}`);
                  return res.status(200).json({ status: 'Poll expired' });
                }

                // 重複投票チェック
                const existingChoiceVote = await db.prepare('SELECT id FROM poll_votes WHERE poll_id = ? AND user_id = ? AND choice_index = ?').get(poll.id, actorUrl, matchedChoice.choice_index);
                if (existingChoiceVote) {
                  console.log(`[Inbox Poll Vote] ⚠️ User already voted for this choice: ${actorUrl}`);
                  return res.status(200).json({ status: 'Choice already voted' });
                }

                if (!poll.multiple) {
                  const anyVote = await db.prepare('SELECT id FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(poll.id, actorUrl);
                  if (anyVote) {
                    console.log(`[Inbox Poll Vote] ⚠️ User already voted on single-choice poll: ${actorUrl}`);
                    return res.status(200).json({ status: 'Already voted' });
                  }
                }

                // データベースに投票を記録
                const voteId = crypto.randomUUID();
                await db.prepare(`
                  INSERT INTO poll_votes (id, poll_id, choice_index, user_id, created_at)
                  VALUES (?, ?, ?, ?, ?)
                `).run(voteId, poll.id, matchedChoice.choice_index, actorUrl, now);

                await db.prepare(`
                  UPDATE poll_choices SET votes_count = votes_count + 1
                  WHERE poll_id = ? AND choice_index = ?
                `).run(poll.id, matchedChoice.choice_index);

                console.log(`[Inbox Poll Vote Success] ✅ Vote successfully recorded: poll ${poll.id}, choice ${matchedChoice.choice_index} (+1)`);

                // 📡 リアルタイム SSE ブロードキャスト（画面上のアンケート表示を即座に更新）
                const updatedPoll = await getPollDataForPost(parentPost.id, null);
                if (updatedPoll) {
                  broadcastPoll({
                    postId: parentPost.id,
                    poll: updatedPoll,
                  });
                }

                // 投稿者がローカルユーザーの場合、通知を作成
                if (parentPost.is_local === 1) {
                  try {
                    await createNotification({
                      userId: parentPost.user_id,
                      type: 'reply',
                      actorId: actorUrl,
                      actorName: remoteActor.name || remoteActor.username,
                      actorHandle: authorHandle,
                      actorIcon: remoteActor.icon_url || '',
                      postId: parentPost.id,
                      postContent: parentPost.content,
                      content: `アンケート「${matchedChoice.text}」に投票しました。`,
                    });
                  } catch (notifErr: any) {
                    console.warn('[Inbox Poll Notification Error]:', notifErr.message);
                  }
                }

                // 🌐 リモート（Misskey / Mastodon）へ最新得票結果を Update(Question) として配信
                federatePollUpdate({
                  postId: parentPost.id,
                  senderVoterActorUrl: actorUrl,
                });

                // 通常の Note 保存処理を行わず、ここで正常終了
                return res.status(200).json({ status: 'Vote registered' });
              }
            }
          }
        }

        // カスタム絵文字の抽出と置換
        const emojis = extractCustomEmojis(note);
        const emojisJson = JSON.stringify(emojis);
        const content = replaceCustomEmojis(rawContent, emojis);
        const authorIcon = remoteActor.icon_url || '';

        // 添付メディア (画像等) の抽出
        const attachments = extractAttachments(note);
        const attachmentsJson = JSON.stringify(attachments);
        const isSensitive = Boolean(note.sensitive || cw) ? 1 : 0;
        const quoteId = typeof note._misskey_quote === 'string' ? note._misskey_quote : (typeof note.quoteUrl === 'string' ? note.quoteUrl : null);

        // 宛先 (to/cc) から公開範囲を判定する。
        // Public コレクションが含まれない場合はフォロワー限定として保存し、
        // リモートの限定公開ノートをローカルで「公開」扱いにしてしまわないようにする。
        const addressing = [
          ...(Array.isArray(note.to) ? note.to : note.to ? [note.to] : []),
          ...(Array.isArray(note.cc) ? note.cc : note.cc ? [note.cc] : []),
        ];
        const hasAddressing = addressing.length > 0;
        const noteIsPublic = !hasAddressing || addressing.includes('https://www.w3.org/ns/activitystreams#Public');
        const noteVisibility = noteIsPublic ? 'public' : 'followers';

        // ✉️ DM（1対1のメッセージ）の判定と受け入れ（docs/DM.md）
        //
        //   Public もフォロワーコレクションも含まず、特定の相手だけが宛先のノートは DM とみなす。
        //   受け入れるのは「宛先に自分（ローカルユーザー）が入っていて、かつ送信者が自分の
        //   許可リスト（userPrefs の dmPolicy / dmAllow）に載っている」ときだけ。
        //   それ以外は保存せず 202（受理だけする）。ブロック・ミュートが許可リストより優先する。
        const isDirectMessage =
          hasAddressing &&
          !noteIsPublic &&
          !addressing.some((target: any) => typeof target === 'string' && /\/followers\/?$/.test(target));
        let dmRecipientIds: string[] = [];

        if (isDirectMessage) {
          if (!isDmEnabled()) {
            // 機能が off のときは「物理的に無い」扱い（現在の DM 拒否と同じ挙動）
            console.log(`[Inbox] 🚫 DM（機能が off）のため保存しません: ${noteId} from ${actorUrl}`);
            return res.status(202).json({ status: 'ignored', reason: 'direct messages are disabled on this instance' });
          }

          const localRecipients = localRecipientUserIds(addressing);
          if (localRecipients.length === 0) {
            // 宛先がローカルに居ないものは保存しない（他人宛の DM を保存しない）
            console.log(`[Inbox] 🚫 DM（宛先がローカルに居ない）のため保存しません: ${noteId} from ${actorUrl}`);
            return res.status(202).json({ status: 'ignored', reason: 'direct message is not addressed to a local user' });
          }

          const senderLocalId = localUserIdFromActorUrl(actorUrl);
          for (const recipientId of localRecipients) {
            if (await isDmReceptionAllowed(recipientId, actorUrl, senderLocalId)) {
              dmRecipientIds.push(recipientId);
            }
          }
          if (dmRecipientIds.length === 0) {
            // 許可リストに無い相手（またはブロック・ミュート中）からの DM は保存しない
            console.log(`[Inbox] 🚫 DM（受信を許可していない相手）のため保存しません: ${noteId} from ${actorUrl}`);
            return res.status(202).json({ status: 'ignored', reason: 'sender is not allowed to send direct messages to this user' });
          }
          console.log(`[Inbox] ✉️ DM を受理しました: ${noteId} from ${actorUrl} → ${dmRecipientIds.join(', ')}`);
        }

        // DM は 'direct' として保存する（宛先以外には本文も存在も見せない）
        const storedVisibility = isDirectMessage ? 'direct' : noteVisibility;
        const storedRecipients = isDirectMessage ? JSON.stringify(addressing.filter((t: any) => typeof t === 'string')) : '[]';

        // 検索索引に入れるかは方針で決める（既定はローカル投稿のみ＝Mastodon / Misskey 相当）。
        // **DM は索引に入れない**（索引経由で本文が漏れないようにする）
        const noteFtsIndexed = isDirectMessage
          ? 0
          : (await shouldIndexRemotePost({ authorUrl: actorUrl, inReplyTo: inReplyTo || null }) ? 1 : 0);
        mark('索引方針の判定');

        const insertStartedAt = Date.now();
        await db.prepare(`
          INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, is_local, visibility, emojis, cw, in_reply_to, quote_id, is_sensitive, media_attachments, published_at, fts_indexed, recipients)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            content = excluded.content,
            author_icon = CASE WHEN excluded.author_icon != '' THEN excluded.author_icon ELSE posts.author_icon END,
            visibility = excluded.visibility,
            emojis = excluded.emojis,
            cw = excluded.cw,
            quote_id = excluded.quote_id,
            is_sensitive = excluded.is_sensitive,
            media_attachments = excluded.media_attachments,
            recipients = excluded.recipients,
            published_at = excluded.published_at
        `).run(
          noteId,
          actorUrl,
          remoteActor.name || remoteActor.username,
          actorUrl,
          authorHandle,
          authorIcon,
          content,
          storedVisibility,
          emojisJson,
          cw,
          inReplyTo,
          quoteId,
          isSensitive,
          attachmentsJson,
          publishedAt,
          noteFtsIndexed,
          storedRecipients
        );
        if (config.inboxProfile) {
          console.log(`[Inbox Profile]   INSERT INTO posts だけ: ${Date.now() - insertStartedAt}ms`);
        }
        // 受信した投稿を、キャッシュ済みのタイムラインにも反映させる
        await invalidateTimelineCache();

        // 📊 アンケート (Poll / Question: oneOf / anyOf) の抽出と保存
        let pollData: any = null;
        const rawChoices = note.oneOf || note.anyOf;
        if (Array.isArray(rawChoices) && rawChoices.length > 0) {
          try {
            const pollId = `poll_${crypto.randomUUID()}`;
            const isMultiple = Boolean(note.anyOf);
            const expiresAt = note.endTime || note.closed || null;
            const now = new Date().toISOString();

            await db.prepare(`
              INSERT INTO polls (id, post_id, multiple, expires_at, created_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(post_id) DO UPDATE SET
                multiple = excluded.multiple,
                expires_at = excluded.expires_at
            `).run(pollId, noteId, isMultiple ? 1 : 0, expiresAt, now);

            // 既存選択肢を更新または作成
            const existingPoll = await db.prepare('SELECT id FROM polls WHERE post_id = ?').get(noteId) as { id: string };
            const effectivePollId = existingPoll ? existingPoll.id : pollId;

            const choicesList: any[] = [];
            // DB へ 1 件ずつ書くので、非同期にできるよう forEach ではなく for-of で回す
            for (const [idx, choice] of rawChoices.entries()) {
              const choiceText = typeof choice === 'string' ? choice : (choice.name || `選択肢 ${idx + 1}`);
              const votesCount = choice.replies?.totalItems || 0;
              const choiceId = `choice_${crypto.randomUUID()}`;

              await db.prepare(`
                INSERT INTO poll_choices (id, poll_id, choice_index, text, votes_count)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(poll_id, choice_index) DO UPDATE SET
                  text = excluded.text,
                  votes_count = CASE WHEN excluded.votes_count > poll_choices.votes_count THEN excluded.votes_count ELSE poll_choices.votes_count END
              `).run(choiceId, effectivePollId, idx, choiceText, votesCount);

              choicesList.push({
                index: idx,
                text: choiceText,
                votes: votesCount,
                is_voted: false,
              });
            }

            pollData = {
              id: effectivePollId,
              multiple: isMultiple,
              expires_at: expiresAt,
              is_expired: expiresAt ? new Date(expiresAt) <= new Date() : false,
              total_votes: choicesList.reduce((acc, c) => acc + c.votes, 0),
              choices: choicesList,
              has_voted: false,
            };
          } catch (pollErr: any) {
            console.warn('[Inbox Poll Warning] Failed to parse remote poll:', pollErr.message);
          }
        }

        // ✉️ DM の場合: 宛先（ローカルユーザー）へ通知する。
        //    **通知本文にはメッセージ本文を入れない**（「メッセージが届きました」まで。docs/DM.md）
        if (isDirectMessage && dmRecipientIds.length > 0) {
          for (const recipientId of dmRecipientIds) {
            try {
              await createNotification({
                userId: recipientId,
                type: 'dm',
                actorId: actorUrl,
                actorName: remoteActor.name || remoteActor.username,
                actorHandle: authorHandle,
                actorIcon: authorIcon,
                postId: noteId,
                content: 'メッセージが届きました',
              });
            } catch (e) {
              console.error('[Notification Error] Inbox dm notification failed:', e);
            }
          }
        }

        // 返信の場合、親投稿の作成者（ローカルユーザー）へ通知を送信
        // （DM は上の dm 通知だけにする。返信通知に本文を載せないため）
        if (inReplyTo && !isDirectMessage) {
          try {
            const parentPost = await db.prepare('SELECT * FROM posts WHERE id = ?').get(inReplyTo) as any;
            if (parentPost && parentPost.is_local === 1) {
              await createNotification({
                userId: parentPost.user_id,
                type: 'reply',
                actorId: actorUrl,
                actorName: remoteActor.name || remoteActor.username,
                actorHandle: authorHandle,
                actorIcon: authorIcon,
                postId: noteId,
                postContent: parentPost.content,
                content,
              });
            }
          } catch (e) {
            console.error('[Notification Error] Inbox reply notification failed:', e);
          }
        }

        // 引用元投稿の解決（あれば）
        let quotePostData: any = null;
        if (quoteId) {
          const qRow = await db.prepare('SELECT id, user_id, author_name, author_url, author_handle, author_icon, content, cw, emojis, media_attachments, is_sensitive, published_at FROM posts WHERE id = ?').get(quoteId) as any;
          if (qRow) {
            quotePostData = {
              ...qRow,
              is_sensitive: Boolean(qRow.is_sensitive),
              media_attachments: (() => {
                try { return typeof qRow.media_attachments === 'string' ? JSON.parse(qRow.media_attachments || '[]') : (qRow.media_attachments || []); }
                catch { return []; }
              })(),
            };
          }
        }

        mark('INSERT posts');
        // 📡 リアルタイム SSE ブロードキャスト（新着ノートをクライアントへプッシュ）
        //    フォロワー限定のノートは全クライアントへ配信すると存在自体が漏れるため配信しない
        if (noteIsPublic) {
          broadcastNote({
            id: noteId,
            feed_id: noteId,
            user_id: actorUrl,
            author_name: remoteActor.name || remoteActor.username,
            author_url: actorUrl,
            author_handle: authorHandle,
            author_icon: authorIcon,
            content,
            cw,
            quote_id: quoteId,
            quote: quotePostData,
            is_sensitive: Boolean(isSensitive),
            is_pinned: false,
            is_local: 0,
            visibility: noteVisibility,
            emojis: emojisJson,
            in_reply_to: inReplyTo,
            media_attachments: attachments,
            published_at: publishedAt,
            timeline_at: publishedAt,
            renote: null,
            reactions: [],
            announce_count: 0,
            my_announced: false,
            reply_count: 0,
            bookmarked: false,
            poll: pollData,
          });
        }

        mark('SSE 配信');
        // 📡 アンテナ条件チェック ＆ 通知
        // 📡 アンテナ条件チェック ＆ 通知（フォロワー限定は通知経由で内容が漏れるため対象外）
        if (noteIsPublic) {
          await checkAntennaMatchesAndNotify({
            id: noteId,
            user_id: actorUrl,
            author_name: remoteActor.name || remoteActor.username,
            author_url: actorUrl,
            author_handle: authorHandle,
            author_icon: authorIcon,
            content,
            cw,
            media_attachments: attachments,
          });
        }

        mark('アンテナ・通知');
        mark('保存・ブロードキャスト・通知');
        console.log(`[Inbox Note] 📝 Saved Note from ${authorHandle}: ${content.slice(0, 40)}...`);
        return res.status(201).json({ status: 'Note created' });
      }

      case 'Announce': {
        // リレーサーバーや他サーバーからのブースト（リレー配信された投稿）
        const object = activity.object;
        if (object && typeof object === 'object' && object.type === 'Note') {
          const note = object;
          const noteAuthorUrl = typeof note.attributedTo === 'string' ? note.attributedTo : actorUrl;
          if (await isDomainBlocked(noteAuthorUrl) || (note.id && await isDomainBlocked(note.id))) {
            console.log(`[Inbox Blocked] 🚫 Ignored relayed Note from blocked domain: ${noteAuthorUrl}`);
            return res.status(200).json({ status: 'Ignored blocked domain note' });
          }

          let authorUsername = 'user';
          let authorDomain = 'relay';
          try {
            const u = new URL(noteAuthorUrl);
            authorDomain = u.host;
            authorUsername = u.pathname.split('/').pop() || 'user';
          } catch {}

          const noteId = note.id || fallbackActivityId(noteAuthorUrl, 'posts');
          const rawContent = note.content || '';
          const publishedAt = note.published || new Date().toISOString();
          const inReplyTo = note.inReplyTo || null;
          const authorHandle = `@${authorUsername}@${authorDomain}`;
          const cw = typeof note.summary === 'string' && note.summary.trim() ? note.summary.trim() : null;

          // カスタム絵文字の抽出と置換
          const emojis = extractCustomEmojis(note);
          const emojisJson = JSON.stringify(emojis);
          const content = replaceCustomEmojis(rawContent, emojis);

          // キャッシュから著者のアイコンを取得（あれば）
          let authorIcon = '';
          const cachedActor = await db.prepare('SELECT icon_url FROM remote_actors WHERE id = ?').get(noteAuthorUrl) as { icon_url?: string } | undefined;
          if (cachedActor?.icon_url) {
            authorIcon = cachedActor.icon_url;
          }

          const relayAttachments = extractAttachments(note);
          const relayAttachmentsJson = JSON.stringify(relayAttachments);
          const relayIsSensitive = Boolean(note.sensitive || cw) ? 1 : 0;
          const relayQuoteId = typeof note._misskey_quote === 'string' ? note._misskey_quote : (typeof note.quoteUrl === 'string' ? note.quoteUrl : null);

          // リレー経由の投稿は既定では索引しない（索引の肥大化を防ぐ）
          const relayFtsIndexed = await shouldIndexRemotePost({ authorUrl: noteAuthorUrl, inReplyTo: inReplyTo || null }) ? 1 : 0;

          await db.prepare(`
            INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, is_local, emojis, cw, in_reply_to, quote_id, is_sensitive, media_attachments, published_at, fts_indexed)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              content = excluded.content,
              author_icon = CASE WHEN excluded.author_icon != '' THEN excluded.author_icon ELSE posts.author_icon END,
              emojis = excluded.emojis,
              cw = excluded.cw,
              quote_id = excluded.quote_id,
              is_sensitive = excluded.is_sensitive,
              media_attachments = excluded.media_attachments,
              published_at = excluded.published_at
          `).run(
            noteId,
            noteAuthorUrl,
            note.name || authorUsername,
            noteAuthorUrl,
            authorHandle,
            authorIcon,
            content,
            emojisJson,
            cw,
            inReplyTo,
            relayQuoteId,
            relayIsSensitive,
            relayAttachmentsJson,
            publishedAt,
            relayFtsIndexed
          );
          await invalidateTimelineCache();

          console.log(`[Inbox Relay Announce] 🚀 Saved relay note from ${authorHandle}: ${content.slice(0, 40)}...`);
        }

        // 一般ユーザーによる RT (ブースト) の記録
        const boostedPostId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
        if (boostedPostId) {
          try {
            let boosterActor;
            try {
              boosterActor = await fetchRemoteActor(actorUrl);
            } catch {
              const u = new URL(actorUrl);
              boosterActor = { username: u.pathname.split('/').pop() || 'user', domain: u.host, name: 'Remote User', icon_url: '' };
            }

            // リモートのブーストは方針で保存可否を決める（既定はフォロー中アクターのみ）
            if (!(await shouldStoreRemoteAnnounce(actorUrl))) {
              console.log(`[Inbox] 🔇 フォロー外のリモートブーストを保存しません: ${actorUrl}`);
              return res.status(202).json({ status: 'ignored', reason: 'remote boost policy' });
            }

            const announceId = activity.id || fallbackActivityId(actorUrl, 'announces');
            await db.prepare(`
              INSERT INTO announces (id, post_id, user_id, user_name, user_handle, user_icon, is_local, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?)
              ON CONFLICT(post_id, user_id) DO UPDATE SET
                user_name = excluded.user_name,
                user_handle = excluded.user_handle,
                user_icon = excluded.user_icon
            `).run(
              announceId,
              boostedPostId,
              actorUrl,
              boosterActor.name || boosterActor.username,
              `@${boosterActor.username}@${boosterActor.domain}`,
              boosterActor.icon_url || '',
              activity.published || new Date().toISOString()
            );
            await invalidateTimelineCache();
            console.log(`[Inbox Boost] 🔁 Recorded boost on ${boostedPostId} by @${boosterActor.username}@${boosterActor.domain}`);

            // 📡 リアルタイム SSE リノート更新（公開投稿のみ）
            if (await isPublicPost(boostedPostId)) {
              const announceCountRow = await db.prepare('SELECT count(*) as c FROM announces WHERE post_id = ?').get(boostedPostId) as any;
              broadcastAnnounce({
                postId: boostedPostId,
                count: announceCountRow ? announceCountRow.c : 1,
              });
            }

            // ローカル投稿がブーストされた場合、投稿者にリノート通知を送信
            try {
              const boostedPost = await db.prepare('SELECT * FROM posts WHERE id = ?').get(boostedPostId) as any;
              if (boostedPost && boostedPost.is_local === 1) {
                await createNotification({
                  userId: boostedPost.user_id,
                  type: 'renote',
                  actorId: actorUrl,
                  actorName: boosterActor.name || boosterActor.username,
                  actorHandle: `@${boosterActor.username}@${boosterActor.domain}`,
                  actorIcon: boosterActor.icon_url || '',
                  postId: boostedPost.id,
                  postContent: boostedPost.content,
                });
              }
            } catch (e) {
              console.error('[Notification Error] Inbox renote notification failed:', e);
            }
          } catch (err: any) {
            console.warn('[Inbox Boost Warning] Failed to record boost:', err.message);
          }
        }

        return res.status(200).json({ status: 'Announce processed' });
      }

      case 'EmojiReact': {
        // Misskey 等からの絵文字リアクション
        const targetPostId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
        if (!targetPostId) return res.status(400).json({ error: 'object is missing' });
        const reaction = activity.content || activity._misskey_reaction || '👍';
        const reactionId = activity.id || fallbackActivityId(actorUrl, 'reactions');

        try {
          let remoteActor;
          try {
            remoteActor = await fetchRemoteActor(actorUrl);
          } catch {
            const u = new URL(actorUrl);
            remoteActor = { name: u.pathname.split('/').pop() || 'user', icon_url: '' };
          }

          await db.prepare(`
            INSERT INTO reactions (id, post_id, user_id, user_name, user_icon, reaction, is_local, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
            ON CONFLICT(post_id, user_id, reaction) DO UPDATE SET
              user_name = excluded.user_name,
              user_icon = excluded.user_icon
          `).run(
            reactionId,
            targetPostId,
            actorUrl,
            remoteActor.name || 'Remote User',
            remoteActor.icon_url || '',
            reaction,
            new Date().toISOString()
          );

          console.log(`[Inbox EmojiReact] 😃 Received reaction "${reaction}" on ${targetPostId} from ${actorUrl}`);

          // 📡 リアルタイム SSE リアクション更新
          const countRow = await db.prepare('SELECT count(*) as c FROM reactions WHERE post_id = ? AND reaction = ?').get(targetPostId, reaction) as any;
          broadcastReaction({
            postId: targetPostId,
            reaction,
            count: countRow ? countRow.c : 1,
            user_id: actorUrl,
            action: 'add',
          });

          // ローカル投稿へのリアクションの場合、投稿者に通知を送信
          try {
            const targetPost = await db.prepare('SELECT * FROM posts WHERE id = ?').get(targetPostId) as any;
            if (targetPost && targetPost.is_local === 1) {
              const u = new URL(actorUrl);
              await createNotification({
                userId: targetPost.user_id,
                type: 'reaction',
                actorId: actorUrl,
                actorName: remoteActor.name || 'Remote User',
                actorHandle: `@${u.pathname.split('/').pop()}@${u.host}`,
                actorIcon: remoteActor.icon_url || '',
                postId: targetPost.id,
                postContent: targetPost.content,
                content: reaction,
              });
            }
          } catch (e) {
            console.error('[Notification Error] Inbox emojiReact notification failed:', e);
          }
        } catch (err: any) {
          console.warn('[Inbox EmojiReact Warning] Failed to save reaction:', err.message);
        }

        return res.status(200).json({ status: 'Reaction processed' });
      }

      case 'Like': {
        // Mastodon (お気に入り) または Misskey からの Like
        const targetPostId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
        if (!targetPostId) return res.status(400).json({ error: 'object is missing' });
        // Misskey からの _misskey_reaction や content があれば優先、なければ '❤️'
        const reaction = activity._misskey_reaction || activity.content || '❤️';
        const reactionId = activity.id || fallbackActivityId(actorUrl, 'likes');

        try {
          let remoteActor;
          try {
            remoteActor = await fetchRemoteActor(actorUrl);
          } catch {
            const u = new URL(actorUrl);
            remoteActor = { name: u.pathname.split('/').pop() || 'user', icon_url: '' };
          }

          await db.prepare(`
            INSERT INTO reactions (id, post_id, user_id, user_name, user_icon, reaction, is_local, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
            ON CONFLICT(post_id, user_id, reaction) DO UPDATE SET
              user_name = excluded.user_name,
              user_icon = excluded.user_icon
          `).run(
            reactionId,
            targetPostId,
            actorUrl,
            remoteActor.name || 'Remote User',
            remoteActor.icon_url || '',
            reaction,
            new Date().toISOString()
          );

          console.log(`[Inbox Like] ❤️ Received like on ${targetPostId} from ${actorUrl}`);

          // 📡 リアルタイム SSE リアクション更新
          const countRow = await db.prepare('SELECT count(*) as c FROM reactions WHERE post_id = ? AND reaction = ?').get(targetPostId, reaction) as any;
          broadcastReaction({
            postId: targetPostId,
            reaction,
            count: countRow ? countRow.c : 1,
            user_id: actorUrl,
            action: 'add',
          });

          // ローカル投稿への Like の場合、投稿者に通知を送信
          try {
            const targetPost = await db.prepare('SELECT * FROM posts WHERE id = ?').get(targetPostId) as any;
            if (targetPost && targetPost.is_local === 1) {
              const u = new URL(actorUrl);
              await createNotification({
                userId: targetPost.user_id,
                type: 'reaction',
                actorId: actorUrl,
                actorName: remoteActor.name || 'Remote User',
                actorHandle: `@${u.pathname.split('/').pop()}@${u.host}`,
                actorIcon: remoteActor.icon_url || '',
                postId: targetPost.id,
                postContent: targetPost.content,
                content: reaction,
              });
            }
          } catch (e) {
            console.error('[Notification Error] Inbox like notification failed:', e);
          }
        } catch (err: any) {
          console.warn('[Inbox Like Warning] Failed to save like:', err.message);
        }

        return res.status(200).json({ status: 'Like processed' });
      }

      // ✏️ 編集の受信: 手元にある同じ ID の投稿を差し替える（無ければ何もしない）。
      //    差し替えるのは本文・CW・センシティブだけ（票や添付は触らない）
      case 'Update': {
        const object = activity.object;
        const objectId = typeof object === 'string' ? object : object?.id;
        if (!objectId || typeof object === 'string') {
          return res.status(200).json({ status: 'Update ignored' });
        }
        const existing = (await db.prepare('SELECT id, user_id, author_url FROM posts WHERE id = ?').get(objectId)) as
          | { id: string; user_id: string; author_url: string }
          | undefined;
        if (!existing) {
          // 手元に無い投稿の編集は追いかけない（Create が来たら素直に取り込む）
          return res.status(200).json({ status: 'Update ignored (unknown object)' });
        }
        // 差し替えてよいのは、その投稿の作者本人からの Update だけ
        const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
        if (!actorUrl || actorUrl !== existing.author_url) {
          console.warn(`[Inbox Update] ⚠️ 作者が一致しない Update を無視しました: ${objectId} (actor=${actorUrl})`);
          return res.status(200).json({ status: 'Update rejected (actor mismatch)' });
        }

        const newContent = typeof object.content === 'string' ? object.content.trim() : null;
        const hasCw = object.summary !== undefined;
        const newCw = hasCw ? (object.summary === null ? null : String(object.summary).trim() || null) : null;
        const newSensitive = typeof object.sensitive === 'boolean' ? (object.sensitive ? 1 : 0) : undefined;
        const newEmojis = Array.isArray(object.tag)
          ? JSON.stringify(
              (object.tag as any[])
                .filter((t) => t?.type === 'Emoji' && typeof t.name === 'string' && typeof t.icon?.url === 'string')
                .map((t) => ({ name: String(t.name).replace(/^:|:$/g, ''), url: t.icon.url })),
            )
          : undefined;
        const editedAt = typeof object.updated === 'string' ? object.updated : new Date().toISOString();

        await db.prepare(`
          UPDATE posts SET
            content = COALESCE(?, content),
            cw = CASE WHEN ? THEN ? ELSE cw END,
            is_sensitive = COALESCE(?, is_sensitive),
            emojis = COALESCE(?, emojis),
            edited_at = ?
          WHERE id = ?
        `).run(newContent, hasCw ? 1 : 0, newCw, newSensitive ?? null, newEmojis ?? null, editedAt, objectId);
        await invalidateTimelineCache();
        console.log(`[Inbox Update] ✏️ @${existing.user_id} の投稿を更新しました: ${objectId}`);

        // 同じ画面を開いている人にも差し替えを知らせる
        // （publishEvent 直呼びは SSE に届かない。リアクション等と同じく broadcastEvent を通す）
        broadcastEvent('post_updated', {
          id: objectId,
          content: newContent,
          cw: hasCw ? newCw : undefined,
          is_sensitive: newSensitive,
          emojis: newEmojis,
          edited_at: editedAt,
        });

        return res.status(200).json({ status: 'Update processed' });
      }

      case 'Undo': {
        const innerObject = activity.object;
        if (!innerObject) return res.status(200).json({ status: 'Undo ignored (no object)' });

        const innerType = typeof innerObject === 'object' ? innerObject.type : null;
        const targetObjId = typeof innerObject === 'string' ? innerObject : (typeof innerObject.object === 'string' ? innerObject.object : innerObject.object?.id);

        if (innerType === 'Follow') {
          const targetActorUrl = typeof innerObject.object === 'string' ? innerObject.object : innerObject.object?.id;
          await db.prepare('DELETE FROM follows WHERE follower_url = ? AND following_url = ?').run(actorUrl, targetActorUrl);
          // フォローが外れると、その相手の**フォロワー限定投稿はもう見えません**。
          // キャッシュを捨てないと最大 TTL ぶん見えたままになる（2026-10-02 に直した）
          await invalidateTimelineCache();
          console.log(`[Inbox Undo] ❌ Follow removed: ${actorUrl} unfollowed ${targetActorUrl}`);
        } else if (innerType === 'Like' || innerType === 'EmojiReact' || !innerType) {
          // リアクション / いいね取り消し。
          // Undo の object は「取り消す活動」を指す（活動 id の文字列か、活動の埋め込み）。
          // 埋め込みなら content / _misskey_reaction に絵文字、object に投稿が入っている。
          // 受け取った活動の id は reactions.id に入れてあるので、まずはその 1 件だけを消す。
          // (人, 投稿) の単位で消すと、切り替え（❤️→💯）の直後に届いた Undo が
          // 新しいリアクションまで巻き込んで消してしまう（2026-10-04 に直した）。
          const undoneId = typeof innerObject === 'string' ? innerObject : innerObject.id;
          const undonePostId = typeof innerObject === 'object'
            ? (typeof innerObject.object === 'string' ? innerObject.object : innerObject.object?.id)
            : null;
          const undoneReaction = typeof innerObject === 'object'
            ? (innerObject._misskey_reaction || innerObject.content || null)
            : null;

          let removedRows: { post_id: string; reaction: string }[] = [];
          if (undoneId) {
            const rows = (await db.prepare(
              'SELECT post_id, reaction FROM reactions WHERE id = ? AND user_id = ?'
            ).all(undoneId, actorUrl)) as any[];
            if (rows.length > 0) {
              await db.prepare('DELETE FROM reactions WHERE id = ? AND user_id = ?').run(undoneId, actorUrl);
              removedRows = rows.map((r) => ({ post_id: r.post_id, reaction: r.reaction }));
            }
          }
          if (removedRows.length === 0 && undonePostId && undoneReaction) {
            const rows = (await db.prepare(
              'SELECT post_id, reaction FROM reactions WHERE user_id = ? AND post_id = ? AND reaction = ?'
            ).all(actorUrl, undonePostId, undoneReaction)) as any[];
            if (rows.length > 0) {
              await db.prepare('DELETE FROM reactions WHERE user_id = ? AND post_id = ? AND reaction = ?')
                .run(actorUrl, undonePostId, undoneReaction);
              removedRows = rows.map((r) => ({ post_id: r.post_id, reaction: r.reaction }));
            }
          }
          if (removedRows.length === 0 && typeof innerObject === 'string') {
            // object が活動 id ではなく投稿 URL の実装もある（古い Misskey など）→ 投稿として消してみる
            const rows = (await db.prepare(
              'SELECT post_id, reaction FROM reactions WHERE user_id = ? AND post_id = ?'
            ).all(actorUrl, innerObject)) as any[];
            if (rows.length > 0) {
              await db.prepare('DELETE FROM reactions WHERE user_id = ? AND post_id = ?').run(actorUrl, innerObject);
              removedRows = rows.map((r) => ({ post_id: r.post_id, reaction: r.reaction }));
            }
          }
          if (removedRows.length === 0 && undonePostId && !undoneId && !undoneReaction) {
            // 活動 id も絵文字も無い（object に投稿しか無い）→ 手がかりが無いので投稿単位でまとめて消す
            const rows = (await db.prepare(
              'SELECT post_id, reaction FROM reactions WHERE user_id = ? AND post_id = ?'
            ).all(actorUrl, undonePostId)) as any[];
            if (rows.length > 0) {
              await db.prepare('DELETE FROM reactions WHERE user_id = ? AND post_id = ?').run(actorUrl, undonePostId);
              removedRows = rows.map((r) => ({ post_id: r.post_id, reaction: r.reaction }));
            }
          }

          if (removedRows.length > 0) {
            // 見ている人のバッジを消す（残数を配る。0 ならクライアント側で消える）
            for (const row of removedRows) {
              const countRow = await db.prepare(
                'SELECT count(*) AS c FROM reactions WHERE post_id = ? AND reaction = ?'
              ).get(row.post_id, row.reaction) as any;
              broadcastReaction({
                postId: row.post_id,
                reaction: row.reaction,
                count: countRow ? countRow.c : 0,
                action: 'remove',
              });
            }
            console.log(
              `[Inbox Undo] ❌ Reaction removed: ${actorUrl} on ${[...new Set(removedRows.map((r) => r.post_id))].join(', ')} (${removedRows.length} 件)`
            );
          } else {
            console.warn(
              `[Inbox Undo] ⚠️ 取り消すリアクションが見つかりません: ${actorUrl} object=${undoneId || JSON.stringify(innerObject).slice(0, 120)}`
            );
          }
        } else if (innerType === 'Announce') {
          // ブースト取り消し
          if (targetObjId) {
            await db.prepare('DELETE FROM announces WHERE user_id = ? AND post_id = ?').run(actorUrl, targetObjId);
            console.log(`[Inbox Undo] ❌ Boost removed: ${actorUrl} on ${targetObjId}`);
          }
        } else if (innerType === 'Block') {
          // ブロックの解除: 配送抑制をやめる
          const blockedUrl = typeof innerObject.object === 'string' ? innerObject.object : innerObject.object?.id;
          if (blockedUrl && (await removeRemoteBlock(actorUrl, blockedUrl))) {
            console.log(`[Inbox Undo] ✅ ブロックを解除: ${actorUrl} -> ${blockedUrl}（配送を再開）`);
          }
        }
        return res.status(200).json({ status: 'Undo processed' });
      }

      case 'Update': {
        const object = activity.object;
        if (object && typeof object === 'object') {
          if (object.type === 'Person' && object.id) {
            const name = object.name || object.preferredUsername;
            const summary = object.summary || '';
            await db.prepare(`
              UPDATE remote_actors SET name = COALESCE(?, name), summary = COALESCE(?, summary), updated_at = ?
              WHERE id = ?
            `).run(name, summary, new Date().toISOString(), object.id);
            console.log(`[Inbox Update] 🔄 Profile updated for ${object.id}`);
          } else if (object.type === 'Note' && object.id) {
            const content = object.content || '';
            await db.prepare(`
              UPDATE posts SET content = ? WHERE id = ?
            `).run(content, object.id);
            console.log(`[Inbox Update] 📝 Note updated: ${object.id}`);
          }
        }
        return res.status(200).json({ status: 'Update processed' });
      }

      case 'Delete': {
        const object = activity.object;
        const targetId = typeof object === 'string' ? object : object?.id;
        if (targetId) {
          await db.prepare('DELETE FROM posts WHERE id = ?').run(targetId);
          await db.prepare('DELETE FROM reactions WHERE post_id = ?').run(targetId);
          await db.prepare('DELETE FROM announces WHERE post_id = ?').run(targetId);
          // DM の既読記録も一緒に消す（孤児を残さない）
          await db.prepare('DELETE FROM dm_reads WHERE post_id = ?').run(targetId).catch(() => undefined);
          // 墓標を立てる。連合では Delete の後に同じ投稿が再送されてくることがあり、
          // 記録が無いと**消したはずの投稿が復活する**（非同期で処理するときは特に）
          await addDeletedRemotePost(targetId);
          console.log(`[Inbox Delete] 🗑️ Note deleted: ${targetId}`);
        }
        return res.status(200).json({ status: 'Delete processed' });
      }

      case 'Block': {
        // 相手がこちら（ローカルユーザー / インスタンスアクター）をブロックした。
        // 記録しておき、以後その相手への配送は行わない（受信した Block を尊重する）
        const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;
        if (!objectUrl) {
          return res.status(200).json({ status: 'Block ignored (no object)' });
        }
        if (!(await isLocalActorUrl(objectUrl))) {
          console.log(`[Inbox Block] ℹ️ ローカルアクター以外への Block のため無視: ${actorUrl} -> ${objectUrl}`);
          return res.status(200).json({ status: 'Block ignored (not a local actor)' });
        }

        // 配送抑制の判定で inbox_url を引けるよう、ブロッカーをキャッシュしておく
        try {
          await fetchRemoteActor(actorUrl);
        } catch (e: any) {
          console.warn(`[Inbox Block] ⚠️ ブロッカーの取得に失敗: ${actorUrl} (${e?.message || e})`);
        }

        await addRemoteBlock(actorUrl, objectUrl);
        console.log(`[Inbox Block] 🚫 受信したブロックを記録: ${actorUrl} が ${objectUrl} をブロック（以後の配送を停止）`);
        return res.status(200).json({ status: 'Block recorded' });
      }

      case 'Move': {
        // 引っ越し: actor = 引っ越し先アカウント / object = 引っ越し元アカウント
        const newActorUrl = actorUrl;
        const oldActorUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;
        const targetUrl = typeof activity.target === 'string' ? activity.target : activity.target?.id;

        if (!oldActorUrl) {
          return res.status(400).json({ error: 'Move の object（引っ越し元）が不正です。' });
        }
        if (targetUrl && targetUrl !== newActorUrl) {
          console.log(`[Inbox Move] ⚠️ Move の target が actor と一致しません: ${targetUrl} != ${newActorUrl}`);
          return res.status(400).json({ error: 'Move の target が不正です。' });
        }

        // なりすまし防止: 引っ越し先が alsoKnownAs に引っ越し元を宣言しているか検証する
        const aliases = await fetchActorAliases(newActorUrl);
        if (!aliases.includes(oldActorUrl)) {
          console.log(`[Inbox Move] ⛔ alsoKnownAs の検証に失敗（引っ越し元の宣言なし）: ${newActorUrl} !-> ${oldActorUrl}`);
          return res.status(400).json({ error: 'Move の検証に失敗しました（alsoKnownAs に引っ越し元が含まれていません）。' });
        }

        // (1) 引っ越し元がローカルユーザー: 移行先を記録する
        //     （フォロワーへの Move 配送は、本人が設定画面から実行したときに行う）
        const localUserId = localUsernameFromActorUrl(oldActorUrl);
        if (localUserId && await db.prepare('SELECT id FROM users WHERE id = ?').get(localUserId)) {
          await db.prepare('UPDATE users SET moved_to = ? WHERE id = ?').run(newActorUrl, localUserId);
          console.log(`[Inbox Move] 📦 ローカルユーザー @${localUserId} の引っ越し先を記録: ${newActorUrl}`);
          try {
            await createNotification({
              userId: localUserId,
              type: 'move',
              actorId: newActorUrl,
              actorName: newActorUrl,
              actorHandle: newActorUrl,
              content: `引っ越し先アカウント（${newActorUrl}）を確認しました。設定画面の「アカウントの引っ越し」からフォロワーの移行を実行できます。`,
            });
          } catch {}
          return res.status(200).json({ status: 'Move recorded for local user' });
        }

        // (2) リモートユーザーが引っ越した: こちらのフォロー関係を新アカウントへ移行する
        const oldActor = await db.prepare('SELECT * FROM remote_actors WHERE id = ?').get(oldActorUrl) as any;
        if (!oldActor) {
          console.log(`[Inbox Move] ℹ️ 未知のアクターの Move のため無視: ${oldActorUrl}`);
          return res.status(200).json({ status: 'Move ignored (unknown actor)' });
        }

        await db.prepare('UPDATE remote_actors SET moved_to = ?, updated_at = ? WHERE id = ?').run(
          newActorUrl,
          new Date().toISOString(),
          oldActorUrl,
        );

        const newActor = await fetchRemoteActor(newActorUrl).catch(() => null);
        const followRows = await db.prepare('SELECT * FROM follows WHERE following_url = ?').all(oldActorUrl) as unknown as FollowRow[];
        let migrated = 0;

        for (const row of followRows) {
          await db.prepare("UPDATE follows SET following_url = ?, inbox_url = ?, status = 'pending' WHERE id = ?").run(
            newActorUrl,
            newActor?.inbox_url || row.inbox_url,
            row.id,
          );
          migrated++;

          const followerId = localUsernameFromActorUrl(row.follower_url);
          if (!followerId) continue;
          const follower = await db.prepare('SELECT * FROM users WHERE id = ?').get(followerId) as UserRow | undefined;
          if (!follower) continue;

          // 新しいアカウントへフォローを送り直す（受理されれば以降の投稿が届く）
          if (newActor?.inbox_url) {
            deliverActivity({
              inboxUrl: newActor.inbox_url,
              activity: buildFollowActivity({ actorUrl: row.follower_url, targetActorUrl: newActorUrl }),
              senderUser: follower,
            }).catch(() => {});
          }

          try {
            const newHandle = newActor ? `@${newActor.username}@${newActor.domain}` : newActorUrl;
            await createNotification({
              userId: follower.id,
              type: 'move',
              actorId: newActorUrl,
              actorName: newActor?.name || newActor?.username || oldActor.name || oldActor.username || newActorUrl,
              actorHandle: newHandle,
              actorIcon: newActor?.icon_url || '',
              content: `${oldActor.name || oldActor.username || oldActorUrl} さんが ${newHandle} へ引っ越しました。フォローを引き継ぎました。`,
            });
          } catch (e) {
            console.warn('[Inbox Move] ⚠️ 通知の作成に失敗:', e);
          }
        }

        console.log(`[Inbox Move] 📦 引っ越しを反映: ${oldActorUrl} -> ${newActorUrl}（フォロー移行 ${migrated}件）`);
        return res.status(200).json({ status: 'Move processed', migrated });
      }

      case 'Flag': {
        // 他サーバーからの通報（Mastodon / Misskey の通報機能）
        const rawObjects = Array.isArray(activity.object) ? activity.object : [activity.object];
        const objects = rawObjects
          .map((o: any) => (typeof o === 'string' ? o : o?.id))
          .filter((o: any): o is string => typeof o === 'string' && o.length > 0);

        if (objects.length === 0) {
          return res.status(400).json({ error: 'Flag の object が不正です。' });
        }

        const report = await ingestRemoteFlag({
          actorUrl,
          objects,
          content: typeof activity.content === 'string' ? activity.content : '',
        });
        if (report) {
          await logNewReport(report);
        }
        return res.status(200).json({ status: 'Flag received' });
      }

      default:
        return res.status(200).json({ status: 'Activity accepted' });
    }
  } catch (err: any) {
    console.error(`[Inbox Error] Failed to process ${activity.type}:`, err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * HTTP の受信（ユーザー Inbox / 共有 Inbox）。
 *
 * ここでやるのは「受理してよいか」の判断だけ: 形式 → 自分宛 → ブロック → **署名検証** → ゲート。
 * どれも軽い（DB を 1〜2 回引く程度）ので、リクエストの中で済ませる。
 *
 * 受理したあとの重い処理（DB と FTS への書き込み・アンテナの照合・通知・配信の積み込み）は:
 *   - `INBOX_ASYNC=false`（既定）… その場で処理して 201 を返す（いままでどおり）
 *   - `INBOX_ASYNC=true` … キューに積んで **202 を返す**（中身は worker が処理する）
 *
 * 非同期にする理由は docs/SCALE.md の「受信の burst」— 重い処理が Web と同じスレッドを
 * 占有すると、**リレーの burst 中は画面が 190ms まで遅くなる**（読み取りキャッシュでは消せない）。
 */
async function handleActivityHttp(req: Request, res: Response, targetUsername?: string) {
  const entryStartedAt = Date.now();
  const entryId = typeof req.body?.id === 'string' ? req.body.id.replace(/^.*\//, '') : '?';
  const entryMark = (label: string): void => {
    if (config.inboxProfile) console.log(`[Inbox Entry] ${label}: ${Date.now() - entryStartedAt}ms [${entryId}]`);
  };
  const activity = req.body;
  if (!activity || !activity.type) {
    return res.status(400).json({ error: '無効な Activity 形式です。' });
  }

  console.log(`[Inbox] 📥 Received Activity: type=${activity.type}, id=${activity.id || '(no-id)'}, actor=${typeof activity.actor === 'string' ? activity.actor : activity.actor?.id}`);

  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
  if (!actorUrl) {
    return res.status(400).json({ error: 'Activity actor が指定されていません。' });
  }

  // 🚫 自分のローカル利用者を名乗る Activity は処理しない。
  //    ローカルの投稿はこちらが正で、外部から届く正当なものは無い。実際に届くのは
  //    **リレーが折り返してくる自分の投稿**（購読中のリレーは投稿を全購読者へ転送するので、
  //    発信元である自分にも戻ってくる）。これを受理すると同じ投稿が「連合受信」＝他人の投稿として
  //    もう 1 行増え、タイムラインに二重に並ぶ（署名が正しくても同じ）。
  //    送信側に再送させないよう 202 を返して静かに落とす。
  if (await isLocalActorUrl(actorUrl)) {
    console.log(`[Inbox Ignored] ↩️ 自分の actor を名乗る Activity を無視: ${activity.type} from ${actorUrl}`);
    return res.status(202).json({ message: 'Ignored: activity from a local actor.' });
  }

  // ドメインブロック判定: 送信元 Actor のドメインがブロックされている場合は 403 で拒絶
  if (await isDomainBlocked(actorUrl)) {
    console.log(`[Inbox Blocked] 🚫 Rejected activity (${activity.type}) from blocked domain actor: ${actorUrl}`);
    return res.status(403).json({ error: 'This domain is blocked by server policy.' });
  }

  entryMark('前段（自分宛・ブロック判定）');
  // HTTP Signature 検証: 失敗した Activity は受け付けない（なりすまし・改ざん防止）
  const auth = await verifyInboxSignature(req, actorUrl);
  entryMark('署名検証');
  if (!auth.verified) {
    if (config.inboxSignatureMode === 'strict') {
      console.log(`[Inbox Rejected] 🔒 ${activity.type} from ${actorUrl} (keyId: ${auth.keyActorUrl || 'unknown'}) - ${auth.error || 'verification failed'}`);
      return res.status(401).json({ error: 'HTTP Signature verification failed.', reason: auth.error });
    }
    console.log(`[Inbox Auth Warn] ⚠️ Signature check failed but INBOX_SIGNATURE_MODE=log, processing anyway: ${activity.type} from ${actorUrl} - ${auth.error}`);
  }

  // 非同期モード: 受理してよいと分かったので、中身はキューに任せて 202 を返す。
  // 署名はここで検証済みなので、ワーカーは検証をやり直さない（CPU を二度使わない）。
  if (config.inboxAsync) {
    const queued = await enqueueInboxActivity(activity, {
      actorUrl,
      targetUsername,
      forwardedBy: auth.forwarded ? auth.keyActorUrl : undefined,
    });
    if (!queued) {
      // 積めなかった（DB が混んでいる等）。送信側に再送してもらう
      res.setHeader('Retry-After', '30');
      return res.status(503).json({ error: 'Busy. Please retry later.' });
    }
    return res.status(202).json({ status: 'Accepted' });
  }

  // 同期モード: ここから先は DB の書き込み・アンテナの照合・配信などの重い処理。
  // リレーの burst で同じ数の処理が同時に走ると画面の応答まで遅くなるので、
  // 同時に処理する数を区切る（溢れたら 503。送信側が指数バックオフで送り直す）。
  const releaseSlot = await inboxGate.acquire();
  if (!releaseSlot) {
    const stats = inboxGate.stats();
    console.warn(
      `[Inbox Busy] 🚦 受信が混み合っているため 503 を返します (処理中 ${stats.active} / 待ち ${stats.waiting} / 溢れ ${stats.shed})`,
    );
    res.setHeader('Retry-After', '30');
    return res.status(503).json({ error: 'Busy. Please retry later.' });
  }
  try {
    await processActivity(activity, res, targetUsername);
  } finally {
    releaseSlot();
  }
}

/**
 * ワーカー側の入口（`INBOX_ASYNC=true` のときに使われる）。
 *
 * HTTP 側で署名検証まで済ませてあるので、ここでは検証をやり直さない。
 * 形式の検査と自分のローカルアクター・ブロックドメインの判定だけは**もう一度**見る
 * （受理してから処理するまでの間に、ブロックされた・設定が変わった可能性がある）。
 * 応答は記録するだけで、実際の HTTP の応答は 202（受理）で既に返っている。
 */
function activityRecorder(): { status: (code: number) => { json: (body: unknown) => void }; getStatus: () => number } {
  let statusCode = 200;
  return {
    status(code: number) {
      statusCode = code;
      return { json: () => undefined };
    },
    getStatus: () => statusCode,
  };
}

registerInboxProcessor(async (activity, options) => {
  const { actorUrl, targetUsername } = options;
  if (!activity || !activity.type || !actorUrl) return 400;

  // 自分のローカルアクター（リレーが折り返してきた自分の投稿）は静かに落とす
  if (await isLocalActorUrl(actorUrl)) return 202;
  if (await isDomainBlocked(actorUrl)) return 403;

  const recorder = activityRecorder();
  await processActivity(activity, recorder, targetUsername);
  return recorder.getStatus();
});
registerInboxJobHandler();

// ユーザー専用 Inbox: POST /users/:username/inbox
// asyncHandler で包む: handleActivity の手前（署名検証・ゲート待ち）で例外が出ても
// 未処理の Promise 拒否にならず Express のエラーハンドラへ流れる（プロセスを落とさない）
inboxRouter.post(
  '/users/:username/inbox',
  asyncHandler(async (req: Request, res: Response) => {
    await handleActivityHttp(req, res, req.params.username as string);
  }),
);

// 共有 Inbox: POST /inbox (Misskey, Mastodon, リレーサーバーからの受信用)
inboxRouter.post(
  '/inbox',
  asyncHandler(async (req: Request, res: Response) => {
    await handleActivityHttp(req, res);
  }),
);

/**
 * Note オブジェクトから attachment (画像など) を抽出
 */
function extractAttachments(note: any): Array<{ url: string; mediaType: string; name?: string; description?: string; width?: number; height?: number }> {
  if (!note || !note.attachment) return [];
  const list = Array.isArray(note.attachment) ? note.attachment : [note.attachment];
  return list
    .filter((a: any) => a && (a.url || a.href))
    .map((a: any) => {
      const url = typeof a.url === 'string' ? a.url : (a.url?.href || a.href || '');
      const mediaType = a.mediaType || a.mimeType || (a.url && typeof a.url === 'object' ? a.url.mediaType : 'image/jpeg');
      const altText = typeof (a.name || a.summary) === 'string' ? String(a.name || a.summary).slice(0, 1500) : '';
      return {
        url,
        mediaType: mediaType || 'image/jpeg',
        name: altText,
        // 代替テキストは description にも入れて、ローカル/連合で同じ項目として扱えるようにする
        description: altText,
        width: a.width,
        height: a.height,
      };
    })
    .filter((a: any) => Boolean(a.url));
}
