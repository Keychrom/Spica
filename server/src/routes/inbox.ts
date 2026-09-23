import { Router, Request, Response } from 'express';
import { adb, UserRow, PostRow, RelayRow, FollowRow, isDomainBlocked, createNotification, addRemoteBlock, removeRemoteBlock } from '../db.js';
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
import { shouldIndexRemotePost, shouldStoreRemoteAnnounce } from '../searchPolicy.js';
import { isPublicPost } from '../postVisibility.js';
import { ingestRemoteFlag, logNewReport } from '../reportService.js';
import { broadcastNote, broadcastReaction, broadcastAnnounce, broadcastPoll } from '../streaming.js';
import { getPollDataForPost } from './api.js';
import { checkAntennaMatchesAndNotify } from '../postService.js';

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
  return Boolean(id && await adb.prepare('SELECT id FROM users WHERE id = ?').get(id));
}

/**
 * 共通の Activity 受信ハンドラ (User Inbox & Shared Inbox)
 */
async function handleActivity(req: Request, res: Response, targetUsername?: string) {
  const activity = req.body;
  if (!activity || !activity.type) {
    return res.status(400).json({ error: '無効な Activity 形式です。' });
  }

  console.log(`[Inbox] 📥 Received Activity: type=${activity.type}, id=${activity.id || '(no-id)'}, actor=${typeof activity.actor === 'string' ? activity.actor : activity.actor?.id}`);

  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
  if (!actorUrl) {
    return res.status(400).json({ error: 'Activity actor が指定されていません。' });
  }

  // ドメインブロック判定: 送信元 Actor のドメインがブロックされている場合は 403 で拒絶
  if (isDomainBlocked(actorUrl)) {
    console.log(`[Inbox Blocked] 🚫 Rejected activity (${activity.type}) from blocked domain actor: ${actorUrl}`);
    return res.status(403).json({ error: 'This domain is blocked by server policy.' });
  }

  // HTTP Signature 検証: 失敗した Activity は受け付けない（なりすまし・改ざん防止）
  const auth = await verifyInboxSignature(req, actorUrl);
  if (!auth.verified) {
    if (config.inboxSignatureMode === 'strict') {
      console.log(`[Inbox Rejected] 🔒 ${activity.type} from ${actorUrl} (keyId: ${auth.keyActorUrl || 'unknown'}) - ${auth.error || 'verification failed'}`);
      return res.status(401).json({ error: 'HTTP Signature verification failed.', reason: auth.error });
    }
    console.log(`[Inbox Auth Warn] ⚠️ Signature check failed but INBOX_SIGNATURE_MODE=log, processing anyway: ${activity.type} from ${actorUrl} - ${auth.error}`);
  }

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
          targetUser = await adb.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId) as unknown as UserRow | undefined;
        }

        // 見つからない場合は最初の管理者ユーザーにフォールバック
        if (!targetUser) {
          targetUser = await adb.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get() as unknown as UserRow | undefined;
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

        await adb.prepare(`
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
            const result = await adb.prepare('UPDATE follows SET status = ? WHERE following_url = ? AND follower_url = ?')
              .run('accepted', targetUrl, followerActor);
            if (result.changes === 0) {
              // 個人Inbox宛でもフォロー元が一致しない場合に備え、自ノード発のフォローに限定して更新する
              await adb.prepare("UPDATE follows SET status = 'accepted' WHERE following_url = ? AND is_local = 1").run(targetUrl);
            }
          } else {
            // 共有Inbox: 自ノードのユーザーが行ったフォローに限定する
            await adb.prepare("UPDATE follows SET status = 'accepted' WHERE following_url = ? AND is_local = 1").run(targetUrl);
          }
        }

        // 2. リレーサーバーのステータス自動更新 (ドメイン・URL柔軟照合)
        try {
          const parsedActorUrl = new URL(actorUrl);
          const actorHost = parsedActorUrl.host;

          // 登録されている全リレーを走査してホスト名が一致するリレーを特定
          const allRelays = await adb.prepare('SELECT * FROM relays').all() as unknown as RelayRow[];
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
            await adb.prepare(`
              UPDATE relays SET status = 'accepted', actor_url = ? WHERE inbox_url = ?
            `).run(actorUrl, matchedRelay.inbox_url);
            console.log(`[Inbox Accept] ✅ Relay automatically accepted: ${matchedRelay.inbox_url} (Actor: ${actorUrl})`);
          } else {
            // フォールバック: 完全一致で更新
            await adb.prepare(`
              UPDATE relays SET status = 'accepted' WHERE actor_url = ? OR inbox_url = ?
            `).run(actorUrl, actorUrl);
          }
        } catch (err: any) {
          console.warn('[Inbox Accept Warning] Error during relay status match:', err.message);
        }

        return res.status(200).json({ status: 'Accept processed' });
      }

      case 'Create': {
        // 投稿 (Note / Question) の受信 (フォロワーまたはリレー経由)
        const note = activity.object;
        if (!note || (note.type !== 'Note' && note.type !== 'Question')) {
          return res.status(200).json({ status: 'Ignored non-Note/Question object' });
        }

        const noteAuthor = typeof note.attributedTo === 'string' ? note.attributedTo : (note.attributedTo?.id || actorUrl);
        if (isDomainBlocked(noteAuthor) || (note.id && isDomainBlocked(note.id))) {
          console.log(`[Inbox Blocked] 🚫 Ignored Note from blocked domain author: ${noteAuthor}`);
          return res.status(200).json({ status: 'Ignored blocked domain author' });
        }

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

        const noteId = note.id || `${actorUrl}/posts/${Date.now()}`;
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
          let parentPost = await adb.prepare('SELECT * FROM posts WHERE id = ?').get(inReplyTo) as PostRow | undefined;
          if (!parentPost) {
            const cleanUrl = inReplyTo.replace(/\/$/, '');
            parentPost = await adb.prepare('SELECT * FROM posts WHERE id = ? OR id = ?').get(cleanUrl, `${cleanUrl}/`) as PostRow | undefined;
          }

          if (parentPost) {
            const poll = await adb.prepare('SELECT * FROM polls WHERE post_id = ?').get(parentPost.id) as any;
            if (poll) {
              const choices = await adb.prepare('SELECT choice_index, text, votes_count FROM poll_choices WHERE poll_id = ? ORDER BY choice_index ASC').all(poll.id) as any[];

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
                const existingChoiceVote = await adb.prepare('SELECT id FROM poll_votes WHERE poll_id = ? AND user_id = ? AND choice_index = ?').get(poll.id, actorUrl, matchedChoice.choice_index);
                if (existingChoiceVote) {
                  console.log(`[Inbox Poll Vote] ⚠️ User already voted for this choice: ${actorUrl}`);
                  return res.status(200).json({ status: 'Choice already voted' });
                }

                if (!poll.multiple) {
                  const anyVote = await adb.prepare('SELECT id FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(poll.id, actorUrl);
                  if (anyVote) {
                    console.log(`[Inbox Poll Vote] ⚠️ User already voted on single-choice poll: ${actorUrl}`);
                    return res.status(200).json({ status: 'Already voted' });
                  }
                }

                // データベースに投票を記録
                const voteId = crypto.randomUUID();
                await adb.prepare(`
                  INSERT INTO poll_votes (id, poll_id, choice_index, user_id, created_at)
                  VALUES (?, ?, ?, ?, ?)
                `).run(voteId, poll.id, matchedChoice.choice_index, actorUrl, now);

                await adb.prepare(`
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

        // 🚫 DM（1対1のメッセージ）は方針として扱わない。
        //    Public もフォロワーコレクションも含まず、特定の相手だけが宛先の
        //    ノートは DM とみなして保存しない（フォロワー限定として保存すると、
        //    送信者が意図していない相手にも見えてしまうため）。
        //    詳細は README「DM（1対1のメッセージ機能）を実装しない方針」を参照。
        const isDirectMessage =
          hasAddressing &&
          !noteIsPublic &&
          !addressing.some((target: any) => typeof target === 'string' && /\/followers\/?$/.test(target));
        if (isDirectMessage) {
          console.log(`[Inbox] 🚫 DM（1対1メッセージ）のため保存しません: ${noteId} from ${actorUrl}`);
          return res.status(202).json({ status: 'ignored', reason: 'direct messages are not supported by this instance' });
        }

        // 検索索引に入れるかは方針で決める（既定はローカル投稿のみ＝Mastodon / Misskey 相当）
        const noteFtsIndexed = await shouldIndexRemotePost({ authorUrl: actorUrl, inReplyTo: inReplyTo || null }) ? 1 : 0;

        await adb.prepare(`
          INSERT INTO posts (id, user_id, author_name, author_url, author_handle, author_icon, content, is_local, visibility, emojis, cw, in_reply_to, quote_id, is_sensitive, media_attachments, published_at, fts_indexed)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            content = excluded.content,
            author_icon = CASE WHEN excluded.author_icon != '' THEN excluded.author_icon ELSE posts.author_icon END,
            visibility = excluded.visibility,
            emojis = excluded.emojis,
            cw = excluded.cw,
            quote_id = excluded.quote_id,
            is_sensitive = excluded.is_sensitive,
            media_attachments = excluded.media_attachments,
            published_at = excluded.published_at
        `).run(
          noteId,
          actorUrl,
          remoteActor.name || remoteActor.username,
          actorUrl,
          authorHandle,
          authorIcon,
          content,
          noteVisibility,
          emojisJson,
          cw,
          inReplyTo,
          quoteId,
          isSensitive,
          attachmentsJson,
          publishedAt,
          noteFtsIndexed
        );

        // 📊 アンケート (Poll / Question: oneOf / anyOf) の抽出と保存
        let pollData: any = null;
        const rawChoices = note.oneOf || note.anyOf;
        if (Array.isArray(rawChoices) && rawChoices.length > 0) {
          try {
            const pollId = `poll_${crypto.randomUUID()}`;
            const isMultiple = Boolean(note.anyOf);
            const expiresAt = note.endTime || note.closed || null;
            const now = new Date().toISOString();

            await adb.prepare(`
              INSERT INTO polls (id, post_id, multiple, expires_at, created_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(post_id) DO UPDATE SET
                multiple = excluded.multiple,
                expires_at = excluded.expires_at
            `).run(pollId, noteId, isMultiple ? 1 : 0, expiresAt, now);

            // 既存選択肢を更新または作成
            const existingPoll = await adb.prepare('SELECT id FROM polls WHERE post_id = ?').get(noteId) as { id: string };
            const effectivePollId = existingPoll ? existingPoll.id : pollId;

            const choicesList: any[] = [];
            // DB へ 1 件ずつ書くので、非同期にできるよう forEach ではなく for-of で回す
            for (const [idx, choice] of rawChoices.entries()) {
              const choiceText = typeof choice === 'string' ? choice : (choice.name || `選択肢 ${idx + 1}`);
              const votesCount = choice.replies?.totalItems || 0;
              const choiceId = `choice_${crypto.randomUUID()}`;

              await adb.prepare(`
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

        // 返信の場合、親投稿の作成者（ローカルユーザー）へ通知を送信
        if (inReplyTo) {
          try {
            const parentPost = await adb.prepare('SELECT * FROM posts WHERE id = ?').get(inReplyTo) as any;
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
          const qRow = await adb.prepare('SELECT id, user_id, author_name, author_url, author_handle, author_icon, content, cw, emojis, media_attachments, is_sensitive, published_at FROM posts WHERE id = ?').get(quoteId) as any;
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

        console.log(`[Inbox Note] 📝 Saved Note from ${authorHandle}: ${content.slice(0, 40)}...`);
        return res.status(201).json({ status: 'Note created' });
      }

      case 'Announce': {
        // リレーサーバーや他サーバーからのブースト（リレー配信された投稿）
        const object = activity.object;
        if (object && typeof object === 'object' && object.type === 'Note') {
          const note = object;
          const noteAuthorUrl = typeof note.attributedTo === 'string' ? note.attributedTo : actorUrl;
          if (isDomainBlocked(noteAuthorUrl) || (note.id && isDomainBlocked(note.id))) {
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

          const noteId = note.id || `${noteAuthorUrl}/posts/${Date.now()}`;
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
          const cachedActor = await adb.prepare('SELECT icon_url FROM remote_actors WHERE id = ?').get(noteAuthorUrl) as { icon_url?: string } | undefined;
          if (cachedActor?.icon_url) {
            authorIcon = cachedActor.icon_url;
          }

          const relayAttachments = extractAttachments(note);
          const relayAttachmentsJson = JSON.stringify(relayAttachments);
          const relayIsSensitive = Boolean(note.sensitive || cw) ? 1 : 0;
          const relayQuoteId = typeof note._misskey_quote === 'string' ? note._misskey_quote : (typeof note.quoteUrl === 'string' ? note.quoteUrl : null);

          // リレー経由の投稿は既定では索引しない（索引の肥大化を防ぐ）
          const relayFtsIndexed = await shouldIndexRemotePost({ authorUrl: noteAuthorUrl, inReplyTo: inReplyTo || null }) ? 1 : 0;

          await adb.prepare(`
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

            const announceId = activity.id || `${actorUrl}/announces/${Date.now()}`;
            await adb.prepare(`
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
            console.log(`[Inbox Boost] 🔁 Recorded boost on ${boostedPostId} by @${boosterActor.username}@${boosterActor.domain}`);

            // 📡 リアルタイム SSE リノート更新（公開投稿のみ）
            if (await isPublicPost(boostedPostId)) {
              const announceCountRow = await adb.prepare('SELECT count(*) as c FROM announces WHERE post_id = ?').get(boostedPostId) as any;
              broadcastAnnounce({
                postId: boostedPostId,
                count: announceCountRow ? announceCountRow.c : 1,
              });
            }

            // ローカル投稿がブーストされた場合、投稿者にリノート通知を送信
            try {
              const boostedPost = await adb.prepare('SELECT * FROM posts WHERE id = ?').get(boostedPostId) as any;
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
        const reactionId = activity.id || `${actorUrl}/reactions/${Date.now()}`;

        try {
          let remoteActor;
          try {
            remoteActor = await fetchRemoteActor(actorUrl);
          } catch {
            const u = new URL(actorUrl);
            remoteActor = { name: u.pathname.split('/').pop() || 'user', icon_url: '' };
          }

          await adb.prepare(`
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
          const countRow = await adb.prepare('SELECT count(*) as c FROM reactions WHERE post_id = ? AND reaction = ?').get(targetPostId, reaction) as any;
          broadcastReaction({
            postId: targetPostId,
            reaction,
            count: countRow ? countRow.c : 1,
            user_id: actorUrl,
            action: 'add',
          });

          // ローカル投稿へのリアクションの場合、投稿者に通知を送信
          try {
            const targetPost = await adb.prepare('SELECT * FROM posts WHERE id = ?').get(targetPostId) as any;
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
        const reactionId = activity.id || `${actorUrl}/likes/${Date.now()}`;

        try {
          let remoteActor;
          try {
            remoteActor = await fetchRemoteActor(actorUrl);
          } catch {
            const u = new URL(actorUrl);
            remoteActor = { name: u.pathname.split('/').pop() || 'user', icon_url: '' };
          }

          await adb.prepare(`
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
          const countRow = await adb.prepare('SELECT count(*) as c FROM reactions WHERE post_id = ? AND reaction = ?').get(targetPostId, reaction) as any;
          broadcastReaction({
            postId: targetPostId,
            reaction,
            count: countRow ? countRow.c : 1,
            user_id: actorUrl,
            action: 'add',
          });

          // ローカル投稿への Like の場合、投稿者に通知を送信
          try {
            const targetPost = await adb.prepare('SELECT * FROM posts WHERE id = ?').get(targetPostId) as any;
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

      case 'Undo': {
        const innerObject = activity.object;
        if (!innerObject) return res.status(200).json({ status: 'Undo ignored (no object)' });

        const innerType = typeof innerObject === 'object' ? innerObject.type : null;
        const targetObjId = typeof innerObject === 'string' ? innerObject : (typeof innerObject.object === 'string' ? innerObject.object : innerObject.object?.id);

        if (innerType === 'Follow') {
          const targetActorUrl = typeof innerObject.object === 'string' ? innerObject.object : innerObject.object?.id;
          await adb.prepare('DELETE FROM follows WHERE follower_url = ? AND following_url = ?').run(actorUrl, targetActorUrl);
          console.log(`[Inbox Undo] ❌ Follow removed: ${actorUrl} unfollowed ${targetActorUrl}`);
        } else if (innerType === 'Like' || innerType === 'EmojiReact' || !innerType) {
          // リアクション / いいね取り消し
          if (targetObjId) {
            await adb.prepare('DELETE FROM reactions WHERE user_id = ? AND post_id = ?').run(actorUrl, targetObjId);
            console.log(`[Inbox Undo] ❌ Reaction removed: ${actorUrl} on ${targetObjId}`);
          }
        } else if (innerType === 'Announce') {
          // ブースト取り消し
          if (targetObjId) {
            await adb.prepare('DELETE FROM announces WHERE user_id = ? AND post_id = ?').run(actorUrl, targetObjId);
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
            await adb.prepare(`
              UPDATE remote_actors SET name = COALESCE(?, name), summary = COALESCE(?, summary), updated_at = ?
              WHERE id = ?
            `).run(name, summary, new Date().toISOString(), object.id);
            console.log(`[Inbox Update] 🔄 Profile updated for ${object.id}`);
          } else if (object.type === 'Note' && object.id) {
            const content = object.content || '';
            await adb.prepare(`
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
          await adb.prepare('DELETE FROM posts WHERE id = ?').run(targetId);
          await adb.prepare('DELETE FROM reactions WHERE post_id = ?').run(targetId);
          await adb.prepare('DELETE FROM announces WHERE post_id = ?').run(targetId);
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
        if (localUserId && await adb.prepare('SELECT id FROM users WHERE id = ?').get(localUserId)) {
          await adb.prepare('UPDATE users SET moved_to = ? WHERE id = ?').run(newActorUrl, localUserId);
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
        const oldActor = await adb.prepare('SELECT * FROM remote_actors WHERE id = ?').get(oldActorUrl) as any;
        if (!oldActor) {
          console.log(`[Inbox Move] ℹ️ 未知のアクターの Move のため無視: ${oldActorUrl}`);
          return res.status(200).json({ status: 'Move ignored (unknown actor)' });
        }

        await adb.prepare('UPDATE remote_actors SET moved_to = ?, updated_at = ? WHERE id = ?').run(
          newActorUrl,
          new Date().toISOString(),
          oldActorUrl,
        );

        const newActor = await fetchRemoteActor(newActorUrl).catch(() => null);
        const followRows = await adb.prepare('SELECT * FROM follows WHERE following_url = ?').all(oldActorUrl) as unknown as FollowRow[];
        let migrated = 0;

        for (const row of followRows) {
          await adb.prepare("UPDATE follows SET following_url = ?, inbox_url = ?, status = 'pending' WHERE id = ?").run(
            newActorUrl,
            newActor?.inbox_url || row.inbox_url,
            row.id,
          );
          migrated++;

          const followerId = localUsernameFromActorUrl(row.follower_url);
          if (!followerId) continue;
          const follower = await adb.prepare('SELECT * FROM users WHERE id = ?').get(followerId) as UserRow | undefined;
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

// ユーザー専用 Inbox: POST /users/:username/inbox
inboxRouter.post('/users/:username/inbox', async (req: Request, res: Response) => {
  await handleActivity(req, res, req.params.username as string);
});

// 共有 Inbox: POST /inbox (Misskey, Mastodon, リレーサーバーからの受信用)
inboxRouter.post('/inbox', async (req: Request, res: Response) => {
  await handleActivity(req, res);
});

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
