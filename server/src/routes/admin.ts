import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { db, RelayRow, BlockedDomainRow, extractDomain, isDomainBlocked, purgeDomainData, getInstanceInfo, saveInstanceInfo, CustomEmojiRow, InvitationCodeRow, RegistrationMode, getServerSetting, setServerSetting } from '../db.js';
import { requireAdmin, hasPermission, getUserPermissions } from '../auth.js';
import { config } from '../config.js';
import { assertFetchableRemoteUrl } from '../remoteFetchGuard.js';
import { listReports, resolveReport, countOpenReports } from '../reportService.js';
import { getMailConfig, saveMailConfig, isMailConfigured, verifyMailConnection } from '../mailService.js';
import { getFtsIndexScope, setFtsIndexScope, getRemoteAnnouncePolicy, setRemoteAnnouncePolicy } from '../searchPolicy.js';
import { getMaintenanceStats, runScheduledMaintenance, setAutoMaintenanceEnabled } from '../maintenanceService.js';
import { formatBytes } from '../dbMaintenance.js';
import { auditMiddleware, listAdminActions, pruneAdminActions, listActionKinds, recordAdminAction } from '../auditLog.js';
import {
  getProxyStats,
  pruneProxyCache,
  clearProxyCache,
  setImageProxyEnabled,
} from '../imageProxy.js';
import { getStorageConfig, saveStorageConfig, isS3Configured, testStorageConnection, uploadMediaFile } from '../storage.js';
import {
  buildFollowActivity,
  buildUndoFollowActivity,
  deliverActivity,
} from '../activitypub.js';
import { deleteUserAccount } from '../accountService.js';
import {
  getDeliveryQueueStats,
  releasePendingDeliveries,
  clearFailedDeliveries,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_DELAYS_MS,
} from '../deliveryQueue.js';
import { processDeliveryQueue } from '../scheduler.js';

const uploadImageFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('画像ファイル（PNG, JPEG, WebP, GIF, SVG等）のみアップロード可能です。'));
    }
  },
});


export const adminRouter = Router();

// 管理 API のガード:
//   - 管理者権限（users.role='admin' または 'admin' 権限のロール）は全許可
//   - モデレーター権限（'moderate'）は通報・凍結・ドメインブロックのみ許可
const MODERATOR_ALLOWED_PATHS = [
  /^\/reports(\/|$)/,
  /^\/users\/[^/]+\/freeze$/,
  /^\/blocks(\/|$)/,
];

adminRouter.use((req: Request, res: Response, next) => {
  if (hasPermission(req.user, 'admin')) {
    return next();
  }
  if (hasPermission(req.user, 'moderate') && MODERATOR_ALLOWED_PATHS.some((pattern) => pattern.test(req.path))) {
    return next();
  }
  return res.status(403).json({ error: 'この操作には管理者権限が必要です。' });
});

// 権限チェックを通過した変更操作を監査ログに記録する（拒否された操作は記録しない）
adminRouter.use(auditMiddleware());

// 管理操作の監査ログ（管理者のみ。モデレーターには開放しない）
adminRouter.get('/audit', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(String(req.query.limit ?? '50'), 10);
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const action = typeof req.query.action === 'string' && req.query.action ? req.query.action : undefined;
    const actorId = typeof req.query.actorId === 'string' && req.query.actorId ? req.query.actorId : undefined;
    const targetId = typeof req.query.targetId === 'string' && req.query.targetId ? req.query.targetId : undefined;

    const result = await listAdminActions({ limit, before, action, actorId, targetId });
    res.json({
      actions: result.actions,
      nextCursor: result.nextCursor,
      total: result.total,
      kinds: await listActionKinds(),
    });
  } catch (err: any) {
    console.error('[Admin Audit Error]:', err);
    res.status(500).json({ error: err.message || '監査ログの取得に失敗しました。' });
  }
});

// 監査ログの削除（指定日数より古いもの）
adminRouter.post('/audit/prune', async (req: Request, res: Response) => {
  try {
    const days = parseInt(String(req.body?.days ?? '180'), 10);
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return res.status(400).json({ error: '保持日数は 1〜3650 で指定してください。' });
    }
    const removed = await pruneAdminActions(days);
    const actorId = String((req.rawUser || req.user)!.id);
    console.log(`[Admin] 🧾 監査ログを削除: ${removed} 件（${days} 日より前） by @${actorId}`);
    await recordAdminAction({
      actorId,
      action: 'audit_prune',
      method: 'POST',
      path: '/audit/prune',
      targetType: 'server',
      detail: `監査ログの削除（${days} 日より前） | ${JSON.stringify({ days, removed })}`,
    });
    res.json({ success: true, removed, message: `${removed} 件の監査ログを削除しました。` });
  } catch (err: any) {
    console.error('[Admin Audit Prune Error]:', err);
    res.status(400).json({ error: err.message || '監査ログの削除に失敗しました。' });
  }
});

// サーバー全体統計
adminRouter.get('/stats', (req: Request, res: Response) => {
  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c;
  const adminCount = (db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get() as any).c;
  const postCount = (db.prepare('SELECT COUNT(*) as c FROM posts WHERE is_local = 1').get() as any).c;
  const federatedPostCount = (db.prepare('SELECT COUNT(*) as c FROM posts WHERE is_local = 0').get() as any).c;
  const remoteActorCount = (db.prepare('SELECT COUNT(*) as c FROM remote_actors').get() as any).c;
  const followCount = (db.prepare('SELECT COUNT(*) as c FROM follows').get() as any).c;

  // 連携先ドメイン数
  const domains = db.prepare('SELECT DISTINCT domain FROM remote_actors').all() as { domain: string }[];
  const instanceInfo = getInstanceInfo();

  res.json({
    system: {
      name: instanceInfo.name,
      icon_url: instanceInfo.icon_url,
      description: instanceInfo.description,
      domain: config.domain,
      origin: config.origin,
      protocol: config.protocol,
      port: config.port,
    },
    stats: {
      users: userCount,
      admins: adminCount,
      localPosts: postCount,
      federatedPosts: federatedPostCount,
      totalPosts: postCount + federatedPostCount,
      remoteActors: remoteActorCount,
      federatedDomains: domains.length,
      follows: followCount,
    },
  });
});

// ユーザー管理一覧
adminRouter.get('/users', (req: Request, res: Response) => {
  const users = db.prepare(`
    SELECT
      u.id,
      u.name,
      u.summary,
      u.role,
      u.is_frozen,
      u.created_at,
      (SELECT COUNT(*) FROM posts WHERE user_id = u.id) as post_count,
      (SELECT COUNT(*) FROM follows WHERE following_url = '${config.origin}/users/' || u.id) as follower_count
    FROM users u
    ORDER BY u.created_at ASC
  `).all() as any[];

  // 各ユーザーに付与されているロールも返す（ロール管理UIで使用）
  const enriched = users.map((user) => ({
    ...user,
    roles: db.prepare(`
      SELECT r.id, r.name, r.color FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = ?
      ORDER BY r.created_at ASC
    `).all(user.id),
  }));

  res.json(enriched);
});

// ユーザーのロール変更 (admin / user)
adminRouter.post('/users/:id/role', (req: Request, res: Response) => {
  const targetId = req.params.id as string;
  const { role } = req.body;

  if (role !== 'admin' && role !== 'user') {
    return res.status(400).json({ error: '無効なロールです。admin または user を指定してください。' });
  }

  // 自分自身の管理者権限を誤って剥奪しないように保護（最後の管理者の場合）
  if (targetId === req.user?.id && role !== 'admin') {
    const adminCount = (db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get() as any).c;
    if (adminCount <= 1) {
      return res.status(400).json({ error: '唯一の管理者自身から管理者権限を剥奪することはできません。' });
    }
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
  res.json({ success: true, userId: targetId, role });
});

// ユーザーの凍結・解除
adminRouter.post('/users/:id/freeze', (req: Request, res: Response) => {
  const targetId = req.params.id as string;
  const { isFrozen } = req.body;

  if (targetId === req.user?.id) {
    return res.status(400).json({ error: '自分自身のアカウントを凍結することはできません。' });
  }

  const frozenVal = isFrozen ? 1 : 0;
  db.prepare('UPDATE users SET is_frozen = ? WHERE id = ?').run(frozenVal, targetId);

  // 凍結された場合はアクティブなセッションをすべて破棄
  if (frozenVal === 1) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
  }

  res.json({ success: true, userId: targetId, isFrozen: frozenVal === 1 });
});

// ユーザーアカウントの完全削除 (管理者モデレーション操作)
adminRouter.delete('/users/:id', async (req: Request, res: Response) => {
  const targetId = req.params.id as string;

  if (targetId === req.user?.id) {
    return res.status(400).json({
      error: '自分自身のアカウントを管理画面から削除することはできません。設定画面のアカウント削除機能をご利用ください。',
    });
  }

  const result = await deleteUserAccount(targetId);
  if (!result.success) {
    return res.status(400).json({ error: result.error || 'アカウントの削除に失敗しました。' });
  }

  res.json({ success: true, userId: targetId, message: `ユーザー @${targetId} を完全に削除しました。` });
});

// 連携先インスタンス（リモートActor）一覧
adminRouter.get('/federation', (req: Request, res: Response) => {
  const actors = db.prepare(`
    SELECT id, username, domain, name, summary, inbox_url, updated_at
    FROM remote_actors
    ORDER BY updated_at DESC
    LIMIT 100
  `).all();

  const domainStats = db.prepare(`
    SELECT domain, COUNT(*) as actor_count
    FROM remote_actors
    GROUP BY domain
    ORDER BY actor_count DESC
  `).all();

  res.json({
    actors,
    domainStats,
  });
});

// ==========================================
// リレーサーバー管理 API
// ==========================================

// 登録リレー一覧
adminRouter.get('/relays', (req: Request, res: Response) => {
  const relays = db.prepare('SELECT * FROM relays ORDER BY created_at DESC').all() as unknown as RelayRow[];
  res.json(relays);
});

// リレーサーバーへの接続（Follow 送信）
adminRouter.post('/relays', async (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'リレーの URL（Inbox または Actor URL）を入力してください。' });
  }

  const cleanUrl = url.trim();
  const adminUser = req.rawUser!;
  const myActorUrl = `${config.origin}/users/${adminUser.id}`;

  try {
    let inboxUrl = cleanUrl;
    let actorUrl = cleanUrl;

    // リレーの Actor URL と Inbox URL を特定
    let candidateActorUrl = cleanUrl;
    if (cleanUrl.endsWith('/inbox')) {
      candidateActorUrl = cleanUrl.replace(/\/inbox\/?$/, '/actor');
    }

    try {
      // SSRF 対策: 内部アドレス等への取得を拒否する。
      // candidateActorUrl と cleanUrl は同一ホストのため、この検証でフォールバック取得も防げる。
      const relaySafety = await assertFetchableRemoteUrl(candidateActorUrl);
      if (!relaySafety.safe) {
        throw new Error(`安全でないリレー URL のため Actor 取得をスキップ: ${relaySafety.reason}`);
      }
      console.log(`[Relay] Fetching relay actor: ${candidateActorUrl}`);
      const fetchRes = await fetch(candidateActorUrl, {
        headers: {
          Accept: 'application/activity+json, application/ld+json',
          'User-Agent': `Spica/1.0.0 (+${config.origin})`,
        },
      });
      if (fetchRes.ok) {
        const actorJson = (await fetchRes.json()) as any;
        actorUrl = actorJson.id || candidateActorUrl;
        inboxUrl = actorJson.inbox || (cleanUrl.endsWith('/inbox') ? cleanUrl : `${cleanUrl}/inbox`);
      } else if (cleanUrl !== candidateActorUrl) {
        const fallbackRes = await fetch(cleanUrl, {
          headers: {
            Accept: 'application/activity+json, application/ld+json',
            'User-Agent': `Spica/1.0.0 (+${config.origin})`,
          },
        });
        if (fallbackRes.ok) {
          const actorJson = (await fallbackRes.json()) as any;
          actorUrl = actorJson.id || cleanUrl;
          inboxUrl = actorJson.inbox || cleanUrl;
        } else {
          actorUrl = candidateActorUrl;
        }
      } else {
        actorUrl = candidateActorUrl;
      }
    } catch (err: any) {
      console.warn('[Relay Warning] Could not fetch relay actor JSON directly, using resolved URLs:', err.message);
      actorUrl = candidateActorUrl;
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO relays (inbox_url, actor_url, status, created_at)
      VALUES (?, ?, 'pending', ?)
      ON CONFLICT(inbox_url) DO UPDATE SET
        actor_url = excluded.actor_url,
        status = 'pending',
        created_at = excluded.created_at
    `).run(inboxUrl, actorUrl, now);

    // リレーへ Follow Activity を送信（インスタンス Actor から送信）
    // Fediverse リレー標準規格 (Mastodon / Activity-Relay / Misskey):
    // Follow の object は https://www.w3.org/ns/activitystreams#Public
    const instanceActorUrl = `${config.origin}/actor`;
    const followActivity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${config.origin}/activities/follow/${crypto.randomUUID()}`,
      type: 'Follow',
      actor: instanceActorUrl,
      object: 'https://www.w3.org/ns/activitystreams#Public',
      to: [
        'https://www.w3.org/ns/activitystreams#Public',
        actorUrl,
      ],
    };

    console.log(`[Relay] Delivering Follow Activity from Instance Actor to relay inbox: ${inboxUrl}`);
    const delivered = await deliverActivity({
      inboxUrl,
      activity: followActivity,
      useInstanceActor: true,
    });

    res.status(201).json({
      success: true,
      inboxUrl,
      actorUrl,
      status: 'pending',
      delivered,
      message: 'リレーサーバーに購読リクエスト (Follow) を送信しました。承認されると自動的に連合データが流れ込みます。',
    });
  } catch (err: any) {
    console.error('[Relay Connect Error]:', err);
    res.status(500).json({ error: err.message || 'リレーサーバーへの接続に失敗しました。' });
  }
});

// リレーサーバーの購読解除 (Undo Follow 送信)
adminRouter.delete('/relays', async (req: Request, res: Response) => {
  const { inboxUrl } = req.body;
  if (!inboxUrl) {
    return res.status(400).json({ error: 'inboxUrl が必要です。' });
  }

  const relay = db.prepare('SELECT * FROM relays WHERE inbox_url = ?').get(inboxUrl) as unknown as RelayRow | undefined;
  if (!relay) {
    return res.status(404).json({ error: '指定されたリレーが見つかりません。' });
  }

  const instanceActorUrl = `${config.origin}/actor`;

  try {
    const undoActivity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${config.origin}/activities/undo/${crypto.randomUUID()}`,
      type: 'Undo',
      actor: instanceActorUrl,
      object: {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${config.origin}/activities/follow/${encodeURIComponent(relay.actor_url)}`,
        type: 'Follow',
        actor: instanceActorUrl,
        object: 'https://www.w3.org/ns/activitystreams#Public',
      },
      to: [
        'https://www.w3.org/ns/activitystreams#Public',
        relay.actor_url,
      ],
    };

    deliverActivity({
      inboxUrl: relay.inbox_url,
      activity: undoActivity,
      useInstanceActor: true,
    }).catch(() => {});

    db.prepare('DELETE FROM relays WHERE inbox_url = ?').run(inboxUrl);

    res.json({ success: true, message: 'リレーの購読を解除しました。' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 登録されているリレーへの Follow Activity 再送 (個別または一括)
adminRouter.post('/relays/resend', async (req: Request, res: Response) => {
  const { inboxUrl } = req.body;
  const instanceActorUrl = `${config.origin}/actor`;

  try {
    const targetRelays = inboxUrl
      ? (db.prepare('SELECT * FROM relays WHERE inbox_url = ?').all(inboxUrl) as unknown as RelayRow[])
      : (db.prepare('SELECT * FROM relays').all() as unknown as RelayRow[]);

    if (targetRelays.length === 0) {
      return res.status(404).json({ error: '対象のリレーが見つかりません。' });
    }

    const results = [];
    for (const relay of targetRelays) {
      let actorUrl = relay.actor_url;
      if (!actorUrl || actorUrl.endsWith('/inbox')) {
        actorUrl = relay.inbox_url.replace(/\/inbox\/?$/, '/actor');
        db.prepare('UPDATE relays SET actor_url = ? WHERE inbox_url = ?').run(actorUrl, relay.inbox_url);
      }

      const followActivity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${config.origin}/activities/follow/${crypto.randomUUID()}`,
        type: 'Follow',
        actor: instanceActorUrl,
        object: 'https://www.w3.org/ns/activitystreams#Public',
        to: [
          'https://www.w3.org/ns/activitystreams#Public',
          actorUrl,
        ],
      };

      const delivered = await deliverActivity({
        inboxUrl: relay.inbox_url,
        activity: followActivity,
        useInstanceActor: true,
      });

      results.push({
        inboxUrl: relay.inbox_url,
        actorUrl,
        delivered,
      });
    }

    res.json({
      success: true,
      message: `${results.length} 件のリレーに Follow Activity を再送しました。`,
      results,
    });
  } catch (err: any) {
    console.error('[Relay Resend Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

// リレーの承認ステータス手動切替
adminRouter.post('/relays/toggle-status', (req: Request, res: Response) => {
  const { inboxUrl, status } = req.body;
  if (!inboxUrl) {
    return res.status(400).json({ error: 'inboxUrl が必要です。' });
  }

  const newStatus = status === 'accepted' ? 'accepted' : 'pending';
  db.prepare('UPDATE relays SET status = ? WHERE inbox_url = ?').run(newStatus, inboxUrl);

  res.json({ success: true, inboxUrl, status: newStatus });
});

// 提携先ドメイン・リモートキャッシュ全消去
adminRouter.post('/cache/clear', (req: Request, res: Response) => {
  try {
    const { clearPosts } = req.body;
    db.prepare('DELETE FROM remote_actors').run();
    if (clearPosts !== false) {
      db.prepare('DELETE FROM posts WHERE is_local = 0').run();
    }
    console.log('[Admin] Remote cache cleared by admin.');
    res.json({ success: true, message: '連携先ドメインキャッシュおよび外部受信投稿を全消去しました。' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ドメイン（サーバー）ブロック管理
// ==========================================

// ブロック中ドメイン一覧の取得
adminRouter.get('/blocks', (req: Request, res: Response) => {
  try {
    const blocks = db.prepare('SELECT domain, reason, created_at, created_by, severity FROM blocked_domains ORDER BY created_at DESC').all() as unknown as BlockedDomainRow[];
    res.json(blocks);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 新規ドメインのブロック登録（および過去データのパージ）
adminRouter.post('/blocks', (req: Request, res: Response) => {
  try {
    const { domain, reason, purgeData, severity } = req.body;
    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'ブロック対象のドメイン名を入力してください。' });
    }

    const cleanDomain = extractDomain(domain);
    if (!cleanDomain || cleanDomain.length < 3 || !cleanDomain.includes('.')) {
      return res.status(400).json({ error: '有効なドメイン名（例: spam.example.com）を入力してください。' });
    }

    // 自サーバーをブロックしようとしていないか検証
    const myDomain = config.domain.toLowerCase();
    const myHost = extractDomain(config.origin);
    if (cleanDomain === myDomain || cleanDomain === myHost) {
      return res.status(400).json({ error: '自サーバー（' + myDomain + '）をブロックすることはできません。' });
    }

    // 既にブロックされているかチェック
    const existing = db.prepare('SELECT domain FROM blocked_domains WHERE domain = ?').get(cleanDomain);
    if (existing) {
      return res.status(409).json({ error: `ドメイン "${cleanDomain}" は既にブロックされています。` });
    }

    const now = new Date().toISOString();
    const adminId = (req.rawUser || req.user)!.id;
    const cleanReason = typeof reason === 'string' ? reason.trim() : '';
    // silence = タイムライン等から隠すだけ（配送・フォローは維持）。既定は suspend（完全遮断）
    const cleanSeverity = severity === 'silence' ? 'silence' : 'suspend';

    db.prepare(`
      INSERT INTO blocked_domains (domain, reason, created_at, created_by, severity)
      VALUES (?, ?, ?, ?, ?)
    `).run(cleanDomain, cleanReason, now, adminId, cleanSeverity);

    // 過去の外部投稿・アクターキャッシュ・フォロー関係のパージ
    // （既定で有効。ただし silence は「隠すだけ」なので、データは残す）
    let purgeStats = null;
    if (purgeData !== false && cleanSeverity === 'suspend') {
      purgeStats = purgeDomainData(cleanDomain);
    }

    console.log(
      `[Admin] ${cleanSeverity === 'silence' ? '🔇' : '🚫'} Domain "${cleanDomain}" ${cleanSeverity === 'silence' ? 'silenced' : 'blocked'} by @${adminId}. Reason: "${cleanReason}". Purged:`,
      purgeStats,
    );

    res.status(201).json({
      success: true,
      domain: cleanDomain,
      reason: cleanReason,
      severity: cleanSeverity,
      createdAt: now,
      createdBy: adminId,
      purgeStats,
      message: `ドメイン "${cleanDomain}" をブロックリストに登録しました。`,
    });
  } catch (err: any) {
    console.error('[Admin Block Domain Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

// ドメインのブロック解除
adminRouter.delete('/blocks/:domain', (req: Request, res: Response) => {
  try {
    const rawDomain = decodeURIComponent(req.params.domain as string);
    const cleanDomain = extractDomain(rawDomain);

    if (!cleanDomain) {
      return res.status(400).json({ error: 'ドメイン名が無効です。' });
    }

    const existing = db.prepare('SELECT domain FROM blocked_domains WHERE domain = ?').get(cleanDomain);
    if (!existing) {
      return res.status(404).json({ error: `ドメイン "${cleanDomain}" はブロックリストに存在しません。` });
    }

    db.prepare('DELETE FROM blocked_domains WHERE domain = ?').run(cleanDomain);

    console.log(`[Admin] ✅ Domain "${cleanDomain}" unblocked by @${(req.rawUser || req.user)?.id}`);

    res.json({
      success: true,
      domain: cleanDomain,
      message: `ドメイン "${cleanDomain}" のブロックを解除しました。`,
    });
  } catch (err: any) {
    console.error('[Admin Unblock Domain Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// メディアストレージ設定 (Cloudflare R2 / S3互換)
// ==========================================

// ストレージ設定の取得
adminRouter.get('/storage', (req: Request, res: Response) => {
  const cfg = getStorageConfig();
  const configured = isS3Configured(cfg);

  res.json({
    configured,
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey ? '********' : '',
    hasSecretAccessKey: Boolean(cfg.secretAccessKey),
    publicUrl: cfg.publicUrl,
    region: cfg.region,
  });
});

// ストレージ設定の保存
adminRouter.post('/storage', (req: Request, res: Response) => {
  const { endpoint, bucket, accessKeyId, secretAccessKey, publicUrl, region } = req.body;

  const currentCfg = getStorageConfig();
  const newSecret = (secretAccessKey && secretAccessKey !== '********') ? secretAccessKey : currentCfg.secretAccessKey;

  saveStorageConfig({
    endpoint: endpoint ?? currentCfg.endpoint,
    bucket: bucket ?? currentCfg.bucket,
    accessKeyId: accessKeyId ?? currentCfg.accessKeyId,
    secretAccessKey: newSecret,
    publicUrl: publicUrl ?? currentCfg.publicUrl,
    region: region ?? currentCfg.region,
  });

  const updatedCfg = getStorageConfig();
  console.log(`[Admin] ⚙️ Storage settings updated by @${(req.rawUser || req.user)?.id}`);

  res.json({
    success: true,
    message: 'メディアストレージ設定を保存しました。',
    configured: isS3Configured(updatedCfg),
  });
});

// ストレージ接続テスト
adminRouter.post('/storage/test', async (req: Request, res: Response) => {
  const { endpoint, bucket, accessKeyId, secretAccessKey, publicUrl, region } = req.body;

  const currentCfg = getStorageConfig();
  const testCfg = {
    endpoint: endpoint !== undefined ? endpoint : currentCfg.endpoint,
    bucket: bucket !== undefined ? bucket : currentCfg.bucket,
    accessKeyId: accessKeyId !== undefined ? accessKeyId : currentCfg.accessKeyId,
    secretAccessKey: (secretAccessKey && secretAccessKey !== '********') ? secretAccessKey : currentCfg.secretAccessKey,
    publicUrl: publicUrl !== undefined ? publicUrl : currentCfg.publicUrl,
    region: region !== undefined ? region : currentCfg.region,
    forcePathStyle: true,
  };

  const result = await testStorageConnection(testCfg);
  if (result.success) {
    res.json({ success: true, message: result.message });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

// ==========================================
// サーバー基本設定 (サーバー名・説明・アイコン)
// ==========================================

// サーバー基本設定の取得
adminRouter.get('/server-settings', (req: Request, res: Response) => {
  const info = getInstanceInfo();
  res.json({
    name: info.name,
    description: info.description,
    icon_url: info.icon_url,
    banner_url: info.banner_url,
    registration_mode: info.registration_mode,
    tos_url: info.tos_url,
    privacy_policy_url: info.privacy_policy_url,
    contact_url: info.contact_url,
    repository_url: info.repository_url,
    operator_url: info.operator_url,
    server_rules: info.server_rules,
    require_rules_agreement: info.require_rules_agreement,
    // リモートコンテンツの保存・索引ポリシー
    fts_index_scope: getFtsIndexScope(),
    remote_announce_policy: getRemoteAnnouncePolicy(),
  });
});

// サーバー基本設定の更新
adminRouter.post('/server-settings', (req: Request, res: Response) => {
  const {
    name,
    description,
    icon_url,
    banner_url,
    tos_url,
    privacy_policy_url,
    contact_url,
    repository_url,
    operator_url,
    server_rules,
    require_rules_agreement,
  } = req.body;

  if (name !== undefined && (!name || !name.trim())) {
    return res.status(400).json({ error: 'サーバー名は空にできません。' });
  }

  saveInstanceInfo({
    name,
    description,
    icon_url,
    banner_url,
    tos_url,
    privacy_policy_url,
    contact_url,
    repository_url,
    operator_url,
    server_rules,
    require_rules_agreement,
  });

  const updated = getInstanceInfo();
  console.log(`[Admin] ⚙️ Instance settings updated by @${(req.rawUser || req.user)?.id}: name="${updated.name}"`);

  res.json({
    success: true,
    message: 'サーバー設定を保存しました。',
    settings: updated,
  });
});

// 容量・件数・メンテナンス状況（管理ダッシュボード用）
adminRouter.get('/maintenance', async (req: Request, res: Response) => {
  try {
    res.json(await getMaintenanceStats());
  } catch (err: any) {
    console.error('[Admin Maintenance Stats Error]:', err);
    res.status(500).json({ error: err.message || 'メンテナンス情報の取得に失敗しました。' });
  }
});

// 自動整理の ON/OFF と実行時刻
adminRouter.post('/maintenance/settings', async (req: Request, res: Response) => {
  try {
    const { autoMaintenance, hour, imageProxy, imageProxyMaxMb } = req.body || {};
    if (typeof autoMaintenance === 'boolean') setAutoMaintenanceEnabled(autoMaintenance);
    if (hour !== undefined) {
      const parsed = parseInt(String(hour), 10);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 23) {
        return res.status(400).json({ error: '実行時刻は 0〜23 の整数で指定してください。' });
      }
      setServerSetting('auto_maintenance_hour', String(parsed));
    }
    if (typeof imageProxy === 'boolean') setImageProxyEnabled(imageProxy);
    if (imageProxyMaxMb !== undefined) {
      const parsed = parseInt(String(imageProxyMaxMb), 10);
      if (!Number.isFinite(parsed) || parsed < 16 || parsed > 10240) {
        return res.status(400).json({ error: '画像プロキシの上限は 16〜10240 MB で指定してください。' });
      }
      setServerSetting('image_proxy_max_mb', String(parsed));
    }
    console.log(`[Admin] 🧹 自動メンテナンス設定を更新 by @${(req.rawUser || req.user)?.id}`);
    res.json({ success: true, message: '自動メンテナンスの設定を保存しました。', stats: getMaintenanceStats() });
  } catch (err: any) {
    console.error('[Admin Maintenance Settings Error]:', err);
    res.status(400).json({ error: err.message || '設定の保存に失敗しました。' });
  }
});

// 画像プロキシのキャッシュ整理（期限切れ + 容量超過分。clear=true で全削除）
adminRouter.post('/image-proxy/cache', async (req: Request, res: Response) => {
  try {
    const clear = req.body?.clear === true;
    const result = clear ? await clearProxyCache() : await pruneProxyCache();
    console.log(
      `[Admin] 🖼️ 画像プロキシのキャッシュを${clear ? '全削除' : '整理'}しました: ${result.removed} 件 by @${(req.rawUser || req.user)?.id}`,
    );
    res.json({
      success: true,
      message: `${result.removed} 件（${formatBytes(result.freedBytes)}）を削除しました。`,
      result,
      stats: await getProxyStats(),
    });
  } catch (err: any) {
    console.error('[Admin Image Proxy Cache Error]:', err);
    res.status(400).json({ error: err.message || 'キャッシュの整理に失敗しました。' });
  }
});

// いますぐ自動整理を実行する（バックアップ＋方針適用＋保持期間削除。VACUUM は行いません）
adminRouter.post('/maintenance/run', async (req: Request, res: Response) => {
  try {
    const result = await runScheduledMaintenance();
    res.json({
      success: true,
      message: `定期メンテナンスを実行しました（リモート投稿 ${result.removedPosts} 件を削除）。`,
      result,
      stats: await getMaintenanceStats(),
    });
  } catch (err: any) {
    console.error('[Admin Maintenance Run Error]:', err);
    res.status(500).json({ error: err.message || 'メンテナンスの実行に失敗しました。' });
  }
});

// リモートコンテンツの保存・索引ポリシーの更新
adminRouter.post('/content-policy', (req: Request, res: Response) => {
  try {
    const { ftsIndexScope, remoteAnnouncePolicy } = req.body || {};
    const updated: Record<string, string> = {};
    if (ftsIndexScope !== undefined) updated.fts_index_scope = setFtsIndexScope(ftsIndexScope);
    if (remoteAnnouncePolicy !== undefined) updated.remote_announce_policy = setRemoteAnnouncePolicy(remoteAnnouncePolicy);
    if (Object.keys(updated).length === 0) {
      return res.status(400).json({ error: '変更する項目が指定されていません。' });
    }
    console.log(`[Admin] 🔎 Content policy updated by @${(req.rawUser || req.user)?.id}: ${JSON.stringify(updated)}`);
    res.json({
      success: true,
      message:
        '設定を保存しました。既存の投稿・ブーストへ遡って適用するには `npm run db:maintenance -- --apply` を実行してください。',
      fts_index_scope: getFtsIndexScope(),
      remote_announce_policy: getRemoteAnnouncePolicy(),
    });
  } catch (err: any) {
    console.error('[Admin Content Policy Error]:', err);
    res.status(500).json({ error: err.message || '設定の保存に失敗しました。' });
  }
});

// サーバーアイコンのアップロード
adminRouter.post('/server-icon', uploadImageFile.single('icon'), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: '画像ファイルが指定されていません。' });
  }

  try {
    const uploaded = await uploadMediaFile({
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      userId: 'system',
    });

    saveInstanceInfo({ icon_url: uploaded.url });
    console.log(`[Admin] 🖼️ Instance icon updated by @${(req.rawUser || req.user)?.id}: ${uploaded.url}`);

    res.json({
      success: true,
      message: 'サーバーアイコンを更新しました。',
      icon_url: uploaded.url,
    });
  } catch (err: any) {
    console.error('[Admin Server Icon Upload Error]:', err);
    res.status(500).json({ error: err.message || 'アイコンのアップロードに失敗しました。' });
  }
});

// サーバーバナー画像のアップロード
adminRouter.post('/server-banner', uploadImageFile.single('banner'), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'バナー画像ファイルが指定されていません。' });
  }

  try {
    const uploaded = await uploadMediaFile({
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      userId: 'system',
    });

    saveInstanceInfo({ banner_url: uploaded.url });
    console.log(`[Admin] 🌄 Instance banner updated by @${(req.rawUser || req.user)?.id}: ${uploaded.url}`);

    res.json({
      success: true,
      message: 'サーバーバナー画像を更新しました。',
      banner_url: uploaded.url,
    });
  } catch (err: any) {
    console.error('[Admin Server Banner Upload Error]:', err);
    res.status(500).json({ error: err.message || 'バナー画像のアップロードに失敗しました。' });
  }
});

// ==========================================
// 🎨 カスタム絵文字管理 API
// ==========================================

// カスタム絵文字一覧取得
adminRouter.get('/emojis', (req: Request, res: Response) => {
  try {
    const emojis = db.prepare(`
      SELECT * FROM custom_emojis ORDER BY category ASC, name ASC
    `).all() as unknown as CustomEmojiRow[];
    res.json(emojis);
  } catch (err: any) {
    console.error('[Admin Emojis Error]:', err);
    res.status(500).json({ error: 'カスタム絵文字一覧の取得に失敗しました。' });
  }
});

// カスタム絵文字の登録 (ファイルアップロード or URL)
adminRouter.post('/emojis', uploadImageFile.single('file'), async (req: Request, res: Response) => {
  try {
    let { name, category, url } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: '絵文字のショートコード名 (例: spica, blobcat) を入力してください。' });
    }

    // 前後のコロンを除去して正規化
    const cleanName = name.trim().replace(/^:+|:+$/g, '').toLowerCase();
    if (!/^[a-z0-9_]{2,30}$/.test(cleanName)) {
      return res.status(400).json({ error: '絵文字名は2〜30文字の小文字英数字およびアンダースコア（_）のみ使用できます。' });
    }

    // 重複チェック
    const existing = db.prepare('SELECT id FROM custom_emojis WHERE name = ?').get(cleanName);
    if (existing) {
      return res.status(409).json({ error: `ショートコード :${cleanName}: は既に登録されています。` });
    }

    let emojiUrl = (url && typeof url === 'string') ? url.trim() : '';

    // ファイルがアップロードされている場合はストレージに保存
    if (req.file) {
      const uploaded = await uploadMediaFile({
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        userId: 'system',
      });
      emojiUrl = uploaded.url;
    }

    if (!emojiUrl) {
      return res.status(400).json({ error: '絵文字画像ファイルを選択するか、画像URLを入力してください。' });
    }

    const emojiId = crypto.randomUUID();
    const cleanCategory = (category && typeof category === 'string' && category.trim()) ? category.trim() : '一般';
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO custom_emojis (id, name, url, category, aliases, created_at)
      VALUES (?, ?, ?, ?, '[]', ?)
    `).run(emojiId, cleanName, emojiUrl, cleanCategory, now);

    console.log(`[Admin] 🎨 Custom emoji registered: :${cleanName}: by @${(req.rawUser || req.user)?.id}`);

    res.status(201).json({
      success: true,
      message: `カスタム絵文字 :${cleanName}: を登録しました。`,
      emoji: {
        id: emojiId,
        name: cleanName,
        url: emojiUrl,
        category: cleanCategory,
        aliases: '[]',
        created_at: now,
      },
    });
  } catch (err: any) {
    console.error('[Admin Custom Emoji Register Error]:', err);
    res.status(500).json({ error: err.message || 'カスタム絵文字の登録に失敗しました。' });
  }
});

// カスタム絵文字の削除
adminRouter.delete('/emojis/:id', (req: Request, res: Response) => {
  try {
    const emojiId = String(req.params.id);
    const existing = db.prepare('SELECT * FROM custom_emojis WHERE id = ?').get(emojiId) as CustomEmojiRow | undefined;
    if (!existing) {
      return res.status(404).json({ error: '該当のカスタム絵文字が見つかりません。' });
    }

    db.prepare('DELETE FROM custom_emojis WHERE id = ?').run(emojiId);
    console.log(`[Admin] 🗑️ Custom emoji deleted: :${existing.name}: by @${(req.rawUser || req.user)?.id}`);

    res.json({
      success: true,
      message: `カスタム絵文字 :${existing.name}: を削除しました。`,
    });
  } catch (err: any) {
    console.error('[Admin Custom Emoji Delete Error]:', err);
    res.status(500).json({ error: 'カスタム絵文字の削除に失敗しました。' });
  }
});

// ==========================================
// 🎟 招待コード管理 API
// ==========================================

// 招待コード一覧取得
adminRouter.get('/invitations', (req: Request, res: Response) => {
  try {
    const invitations = db.prepare(`
      SELECT * FROM invitation_codes ORDER BY created_at DESC
    `).all() as unknown as InvitationCodeRow[];
    res.json(invitations);
  } catch (err: any) {
    console.error('[Admin Invitations Error]:', err);
    res.status(500).json({ error: '招待コード一覧の取得に失敗しました。' });
  }
});

// 招待コードの新規発行
adminRouter.post('/invitations', (req: Request, res: Response) => {
  try {
    const user = (req.rawUser || req.user)!;
    const { maxUses = 1, expiresInDays = null, memo = '' } = req.body;

    const parsedMaxUses = Math.max(1, parseInt(String(maxUses), 10) || 1);
    let expiresAt: string | null = null;
    if (expiresInDays && Number(expiresInDays) > 0) {
      expiresAt = new Date(Date.now() + Number(expiresInDays) * 86400000).toISOString();
    }

    // ユニークな招待コード生成 (例: spica-inv-a1b2c3d4)
    const randomSuffix = crypto.randomBytes(4).toString('hex');
    const code = `spica-inv-${randomSuffix}`;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO invitation_codes (code, created_by, max_uses, used_count, expires_at, memo, created_at)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(code, user.id, parsedMaxUses, expiresAt, String(memo || '').trim(), now);

    console.log(`[Admin] 🎟️ Invitation code generated: ${code} (max: ${parsedMaxUses}) by @${user.id}`);

    res.status(201).json({
      success: true,
      message: '招待コードを発行しました。',
      invitation: {
        code,
        created_by: user.id,
        max_uses: parsedMaxUses,
        used_count: 0,
        expires_at: expiresAt,
        memo: String(memo || '').trim(),
        created_at: now,
      },
    });
  } catch (err: any) {
    console.error('[Admin Invitation Create Error]:', err);
    res.status(500).json({ error: '招待コードの発行に失敗しました。' });
  }
});

// 招待コードの削除 / 無効化
adminRouter.delete('/invitations/:code', (req: Request, res: Response) => {
  try {
    const code = String(req.params.code);
    const existing = db.prepare('SELECT * FROM invitation_codes WHERE code = ?').get(code) as InvitationCodeRow | undefined;
    if (!existing) {
      return res.status(404).json({ error: '該当の招待コードが見つかりません。' });
    }

    db.prepare('DELETE FROM invitation_codes WHERE code = ?').run(code);
    console.log(`[Admin] 🗑️ Invitation code revoked: ${code} by @${(req.rawUser || req.user)?.id}`);

    res.json({
      success: true,
      message: `招待コード ${code} を削除・無効化しました。`,
    });
  } catch (err: any) {
    console.error('[Admin Invitation Delete Error]:', err);
    res.status(500).json({ error: '招待コードの削除に失敗しました。' });
  }
});

// サーバー登録モード変更 (open / invite / closed)
adminRouter.post('/registration-mode', (req: Request, res: Response) => {
  try {
    const { mode } = req.body;
    if (mode !== 'open' && mode !== 'invite' && mode !== 'closed') {
      return res.status(400).json({ error: '無効な登録モードです (open, invite, closed のいずれかを指定してください)。' });
    }

    saveInstanceInfo({ registration_mode: mode as RegistrationMode });
    console.log(`[Admin] 🔒 Registration mode changed to "${mode}" by @${(req.rawUser || req.user)?.id}`);

    res.json({
      success: true,
      message: `登録モードを「${mode === 'open' ? '自由登録 (誰でも参加可能)' : mode === 'invite' ? '招待制 (コード必須)' : '新規登録一時停止'}」に更新しました。`,
      registration_mode: mode,
    });
  } catch (err: any) {
    console.error('[Admin Registration Mode Error]:', err);
    res.status(500).json({ error: '登録モードの変更に失敗しました。' });
  }
});

// ==========================================
// 📢 お知らせ（サーバーからの一斉告知）
// ==========================================

// お知らせ一覧（無効なものも含む）
adminRouter.get('/announcements', (_req: Request, res: Response) => {
  try {
    const rows = db.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 200').all();
    res.json(rows);
  } catch (err: any) {
    console.error('[Admin Announcements Error]:', err);
    res.status(500).json({ error: 'お知らせの取得に失敗しました。' });
  }
});

// お知らせの作成
adminRouter.post('/announcements', (req: Request, res: Response) => {
  const { title, content, isActive } = req.body;
  const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 120) : '';
  const cleanContent = typeof content === 'string' ? content.trim().slice(0, 5000) : '';

  if (!cleanTitle || !cleanContent) {
    return res.status(400).json({ error: 'タイトルと本文は必須です。' });
  }

  try {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO announcements (id, title, content, is_active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, cleanTitle, cleanContent, isActive === false ? 0 : 1, req.user!.id, now, now);

    console.log(`[Admin Announcement] 📢 作成: ${cleanTitle} (@${req.user!.id})`);
    res.status(201).json({ success: true, id, announcement: db.prepare('SELECT * FROM announcements WHERE id = ?').get(id) });
  } catch (err: any) {
    console.error('[Admin Announcement Create Error]:', err);
    res.status(500).json({ error: 'お知らせの作成に失敗しました。' });
  }
});

// お知らせの更新（タイトル / 本文 / 有効・無効）
adminRouter.put('/announcements/:id', (req: Request, res: Response) => {
  const { title, content, isActive } = req.body;
  const id = String(req.params.id);

  try {
    const existing = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id) as any;
    if (!existing) {
      return res.status(404).json({ error: 'お知らせが見つかりません。' });
    }

    const nextTitle = typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : existing.title;
    const nextContent = typeof content === 'string' && content.trim() ? content.trim().slice(0, 5000) : existing.content;
    const nextActive = typeof isActive === 'boolean' ? (isActive ? 1 : 0) : existing.is_active;

    db.prepare('UPDATE announcements SET title = ?, content = ?, is_active = ?, updated_at = ? WHERE id = ?')
      .run(nextTitle, nextContent, nextActive, new Date().toISOString(), id);

    res.json({ success: true, announcement: db.prepare('SELECT * FROM announcements WHERE id = ?').get(id) });
  } catch (err: any) {
    console.error('[Admin Announcement Update Error]:', err);
    res.status(500).json({ error: 'お知らせの更新に失敗しました。' });
  }
});

// お知らせの削除
adminRouter.delete('/announcements/:id', (req: Request, res: Response) => {
  try {
    const result = db.prepare('DELETE FROM announcements WHERE id = ?').run(String(req.params.id));
    if (result.changes === 0) {
      return res.status(404).json({ error: 'お知らせが見つかりません。' });
    }
    res.json({ success: true });
  } catch (err: any) {
    console.error('[Admin Announcement Delete Error]:', err);
    res.status(500).json({ error: 'お知らせの削除に失敗しました。' });
  }
});

// ==========================================
// 📧 メール送信（SMTP）と認証方式の設定
// ==========================================

// 現在の設定を取得（パスワードは伏せる）
adminRouter.get('/mail-settings', (_req: Request, res: Response) => {
  try {
    const cfg = getMailConfig();
    const info = getInstanceInfo();
    res.json({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      user: cfg.user,
      hasPassword: Boolean(cfg.pass),
      from: cfg.from,
      configured: isMailConfigured(cfg),
      allowEmailRegistration: String(getServerSetting('allow_email_registration', 'false')).toLowerCase() === 'true',
      authMode: String(getServerSetting('auth_mode', 'master_key')).toLowerCase() === 'password' ? 'password' : 'master_key',
      registrationMode: info.registration_mode,
    });
  } catch (err: any) {
    console.error('[Admin Mail Settings Error]:', err);
    res.status(500).json({ error: 'メール設定の取得に失敗しました。' });
  }
});

// SMTP 設定の保存
adminRouter.post('/mail-settings', (req: Request, res: Response) => {
  try {
    const { host, port, secure, user, pass, from } = req.body;
    const patch: Record<string, unknown> = {};
    if (typeof host === 'string') patch.host = host.trim();
    if (port !== undefined) patch.port = parseInt(String(port), 10) || 587;
    if (typeof secure === 'boolean') patch.secure = secure;
    if (typeof user === 'string') patch.user = user.trim();
    if (typeof pass === 'string' && pass) patch.pass = pass; // 空欄なら既存を維持
    if (typeof from === 'string') patch.from = from.trim();

    saveMailConfig(patch as any);
    console.log(`[Admin Mail] 📧 SMTP 設定を更新 by @${req.user!.id}`);
    res.json({ success: true, message: 'SMTP 設定を保存しました。' });
  } catch (err: any) {
    console.error('[Admin Mail Save Error]:', err);
    res.status(500).json({ error: 'SMTP 設定の保存に失敗しました。' });
  }
});

// 接続テスト（指定があればその場の値で試す）
adminRouter.post('/mail-settings/test', async (req: Request, res: Response) => {
  try {
    const cfg = getMailConfig();
    const candidate = {
      ...cfg,
      host: typeof req.body?.host === 'string' && req.body.host.trim() ? req.body.host.trim() : cfg.host,
      port: req.body?.port ? parseInt(String(req.body.port), 10) : cfg.port,
      user: typeof req.body?.user === 'string' ? req.body.user.trim() : cfg.user,
      pass: typeof req.body?.pass === 'string' && req.body.pass ? req.body.pass : cfg.pass,
      from: typeof req.body?.from === 'string' && req.body.from.trim() ? req.body.from.trim() : cfg.from,
    };

    const result = await verifyMailConnection(candidate as any);
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'SMTP への接続に失敗しました。' });
    }
    res.json({ success: true, message: 'SMTP に接続できました。' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '接続テストに失敗しました。' });
  }
});

// 認証方式・メール登録可否の設定
adminRouter.post('/auth-settings', (req: Request, res: Response) => {
  try {
    const { authMode, allowEmailRegistration } = req.body;

    if (authMode !== undefined) {
      if (authMode !== 'master_key' && authMode !== 'password') {
        return res.status(400).json({ error: 'authMode は master_key または password を指定してください。' });
      }
      setServerSetting('auth_mode', authMode);
    }
    if (allowEmailRegistration !== undefined) {
      setServerSetting('allow_email_registration', allowEmailRegistration ? 'true' : 'false');
    }

    console.log(`[Admin Auth] 🔐 認証設定を更新 (authMode=${authMode ?? '変更なし'}, email登録=${allowEmailRegistration ?? '変更なし'}) by @${req.user!.id}`);
    res.json({ success: true, message: '認証設定を保存しました。' });
  } catch (err: any) {
    console.error('[Admin Auth Settings Error]:', err);
    res.status(500).json({ error: '認証設定の保存に失敗しました。' });
  }
});

// ==========================================
// 🎭 ロール（権限）管理
// ==========================================

// 利用可能な権限の一覧（クライアントのチェックボックスと揃える）
const AVAILABLE_PERMISSIONS = [
  { key: 'moderate', label: 'モデレーター（通報対応・凍結・ドメインブロック）' },
  { key: 'announce', label: 'お知らせの投稿' },
  { key: 'admin', label: '管理者（管理画面のすべての操作）' },
];

function normalizePermissions(raw: unknown): string {
  const list = Array.isArray(raw)
    ? raw
    : String(raw ?? '').split(',');
  const valid = new Set(AVAILABLE_PERMISSIONS.map((p) => p.key));
  return Array.from(new Set(list.map((p) => String(p).trim()).filter((p) => valid.has(p)))).join(',');
}

adminRouter.get('/roles', (_req: Request, res: Response) => {
  try {
    const roles = db.prepare('SELECT * FROM roles ORDER BY created_at ASC').all() as any[];
    const withCounts = roles.map((role) => ({
      ...role,
      member_count: (db.prepare('SELECT COUNT(*) AS c FROM user_roles WHERE role_id = ?').get(role.id) as { c: number }).c,
    }));
    res.json({ roles: withCounts, availablePermissions: AVAILABLE_PERMISSIONS });
  } catch (err: any) {
    console.error('[Admin Roles Error]:', err);
    res.status(500).json({ error: 'ロール一覧の取得に失敗しました。' });
  }
});

adminRouter.post('/roles', (req: Request, res: Response) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 40) : '';
  const color = typeof req.body?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : '#6366f1';
  const permissions = normalizePermissions(req.body?.permissions);

  if (!name) {
    return res.status(400).json({ error: 'ロール名を入力してください。' });
  }
  if (!permissions) {
    return res.status(400).json({ error: '権限を1つ以上選択してください。' });
  }
  const count = (db.prepare('SELECT COUNT(*) AS c FROM roles').get() as { c: number }).c;
  if (count >= 30) {
    return res.status(400).json({ error: '作成できるロールは 30 件までです。' });
  }
  if (db.prepare('SELECT id FROM roles WHERE name = ?').get(name)) {
    return res.status(409).json({ error: '同じ名前のロールが既に存在します。' });
  }

  try {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO roles (id, name, color, permissions, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run(id, name, color, permissions, now, now);
    console.log(`[Role] 🎭 ロール「${name}」を作成 (${permissions}) by @${req.user!.id}`);
    res.status(201).json({ success: true, id, name, color, permissions });
  } catch (err: any) {
    console.error('[Admin Role Create Error]:', err);
    res.status(500).json({ error: 'ロールの作成に失敗しました。' });
  }
});

adminRouter.put('/roles/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const existing = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as any;
    if (!existing) {
      return res.status(404).json({ error: 'ロールが見つかりません。' });
    }

    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 40) : existing.name;
    const color = typeof req.body?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : existing.color;
    const permissions = req.body?.permissions !== undefined ? normalizePermissions(req.body.permissions) : existing.permissions;

    if (!permissions) {
      return res.status(400).json({ error: '権限を1つ以上選択してください。' });
    }
    const duplicated = db.prepare('SELECT id FROM roles WHERE name = ? AND id != ?').get(name, id);
    if (duplicated) {
      return res.status(409).json({ error: '同じ名前のロールが既に存在します。' });
    }

    db.prepare('UPDATE roles SET name = ?, color = ?, permissions = ?, updated_at = ? WHERE id = ?')
      .run(name, color, permissions, new Date().toISOString(), id);
    console.log(`[Role] 🎭 ロール「${name}」を更新 (${permissions}) by @${req.user!.id}`);
    res.json({ success: true, role: db.prepare('SELECT * FROM roles WHERE id = ?').get(id) });
  } catch (err: any) {
    console.error('[Admin Role Update Error]:', err);
    res.status(500).json({ error: 'ロールの更新に失敗しました。' });
  }
});

adminRouter.delete('/roles/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as any;
    if (!role) {
      return res.status(404).json({ error: 'ロールが見つかりません。' });
    }
    db.prepare('DELETE FROM user_roles WHERE role_id = ?').run(id);
    db.prepare('DELETE FROM roles WHERE id = ?').run(id);
    console.log(`[Role] 🗑️ ロール「${role.name}」を削除 by @${req.user!.id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[Admin Role Delete Error]:', err);
    res.status(500).json({ error: 'ロールの削除に失敗しました。' });
  }
});

// ユーザーへのロール付与（roleIds を渡して置き換える / 空配列で全部外す）
adminRouter.post('/users/:id/roles', (req: Request, res: Response) => {
  const targetUserId = String(req.params.id);
  const roleIds = Array.isArray(req.body?.roleIds) ? req.body.roleIds.map((r: unknown) => String(r)) : null;

  if (!roleIds) {
    return res.status(400).json({ error: 'roleIds（配列）が必要です。' });
  }
  const targetUser = db.prepare('SELECT id, role FROM users WHERE id = ?').get(targetUserId) as { id: string; role: string } | undefined;
  if (!targetUser) {
    return res.status(404).json({ error: 'ユーザーが見つかりません。' });
  }

  // 管理者（users.role = 'admin'）から管理権限を外す操作は禁止（締め出し防止）
  const assignsAdminPermission = roleIds.some((roleId: string) => {
    const role = db.prepare('SELECT permissions FROM roles WHERE id = ?').get(roleId) as { permissions: string } | undefined;
    return String(role?.permissions || '').split(',').map((p) => p.trim()).includes('admin');
  });
  if (targetUser.role === 'admin' && !assignsAdminPermission) {
    const adminCount = (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get() as { c: number }).c;
    if (adminCount <= 1) {
      return res.status(400).json({ error: '最後の管理者から管理権限を外すことはできません。' });
    }
  }

  try {
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(targetUserId);
    const now = new Date().toISOString();
    const insert = db.prepare('INSERT INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)');
    let applied = 0;
    for (const roleId of roleIds) {
      const exists = db.prepare('SELECT id FROM roles WHERE id = ?').get(roleId);
      if (!exists) continue;
      insert.run(targetUserId, roleId, now);
      applied++;
    }
    console.log(`[Role] 🎭 @${targetUserId} に ${applied} 件のロールを付与 by @${req.user!.id}`);
    res.json({ success: true, applied });
  } catch (err: any) {
    console.error('[Admin User Roles Error]:', err);
    res.status(500).json({ error: 'ロールの付与に失敗しました。' });
  }
});

// ==========================================
// 🚩 通報（モデレーションキュー）
// ==========================================

// 通報一覧（?status=open|resolved|rejected|all）
adminRouter.get('/reports', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || 'all';
    const reports = await listReports(status === 'all' ? undefined : status);
    res.json({
      reports,
      counts: {
        open: await countOpenReports(),
        total: (db.prepare('SELECT COUNT(*) AS c FROM reports').get() as { c: number }).c,
      },
    });
  } catch (err: any) {
    console.error('[Admin Reports Error]:', err);
    res.status(500).json({ error: '通報一覧の取得に失敗しました。' });
  }
});

// 未対応の通報件数（バッジ用）
adminRouter.get('/reports/count', async (_req: Request, res: Response) => {
  try {
    res.json({ open: await countOpenReports() });
  } catch (err: any) {
    res.status(500).json({ error: '通報件数の取得に失敗しました。' });
  }
});

// 通報への対応（action: resolve=対応済み / reject=却下 / reopen=再オープン）
adminRouter.post('/reports/:id/resolve', async (req: Request, res: Response) => {
  const { action, note } = req.body;
  if (!['resolve', 'reject', 'reopen'].includes(String(action))) {
    return res.status(400).json({ error: 'action は resolve / reject / reopen のいずれかを指定してください。' });
  }

  try {
    const updated = await resolveReport(String(req.params.id), action, req.user!.id, typeof note === 'string' ? note : undefined);
    if (!updated) {
      return res.status(404).json({ error: '通報が見つかりません。' });
    }
    console.log(`[Admin Report] ✅ ${updated.id} を ${updated.status} にしました (@${req.user!.id})`);
    res.json({ success: true, report: updated });
  } catch (err: any) {
    console.error('[Admin Report Resolve Error]:', err);
    res.status(500).json({ error: '通報の更新に失敗しました。' });
  }
});

// ==========================================
// 📮 配送再送キュー（ActivityPub の配送リトライ）
// ==========================================

// 再送キューの状況（待機中・直近の失敗・バックオフ設定）
adminRouter.get('/delivery-queue', async (_req: Request, res: Response) => {
  try {
    const stats = await getDeliveryQueueStats();
    const pending = db.prepare(`
      SELECT id, activity_id, activity_type, inbox_url, attempts, next_attempt_at, last_status, last_error, created_at
      FROM outbox_deliveries
      WHERE status = 'pending'
      ORDER BY next_attempt_at ASC
      LIMIT 20
    `).all();
    const recentFailures = db.prepare(`
      SELECT id, activity_id, activity_type, inbox_url, attempts, last_status, last_error, updated_at
      FROM outbox_deliveries
      WHERE status = 'failed'
      ORDER BY updated_at DESC
      LIMIT 20
    `).all();

    res.json({
      stats,
      pending,
      recentFailures,
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
      retryDelaysMs: RETRY_DELAYS_MS,
    });
  } catch (err: any) {
    console.error('[Admin Delivery Queue Error]:', err);
    res.status(500).json({ error: '配送キューの取得に失敗しました。' });
  }
});

// 待機中の再送を今すぐ前倒しして実行する
adminRouter.post('/delivery-queue/retry', async (req: Request, res: Response) => {
  try {
    const released = await releasePendingDeliveries();
    console.log(`[Admin Delivery] 🔁 再送を前倒し (${released}件) by @${req.user!.id}`);
    if (released > 0) {
      // ワーカーを即時起動する（応答は待たない。1件ずつの配送は時間がかかるため）
      processDeliveryQueue().catch((err) => console.error('[Admin Delivery] 再送ワーカーの起動に失敗:', err));
    }
    res.json({
      success: true,
      released,
      message: released > 0 ? `${released} 件の再送を開始しました。` : '再送待ちの配送はありません。',
    });
  } catch (err: any) {
    console.error('[Admin Delivery Retry Error]:', err);
    res.status(500).json({ error: '再送の実行に失敗しました。' });
  }
});

// 失敗が確定した配送をまとめて削除する
adminRouter.post('/delivery-queue/clear-failed', async (req: Request, res: Response) => {
  try {
    const removed = await clearFailedDeliveries();
    console.log(`[Admin Delivery] 🧹 失敗した配送を削除 (${removed}件) by @${req.user!.id}`);
    res.json({ success: true, removed, message: `失敗した配送 ${removed} 件を削除しました。` });
  } catch (err: any) {
    console.error('[Admin Delivery Clear Error]:', err);
    res.status(500).json({ error: '失敗した配送の削除に失敗しました。' });
  }
});


