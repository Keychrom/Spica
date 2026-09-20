import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { db, RelayRow, BlockedDomainRow, extractDomain, isDomainBlocked, purgeDomainData, getInstanceInfo, saveInstanceInfo, CustomEmojiRow, InvitationCodeRow, RegistrationMode } from '../db.js';
import { requireAdmin } from '../auth.js';
import { config } from '../config.js';
import { assertFetchableRemoteUrl } from '../remoteFetchGuard.js';
import { listReports, resolveReport, countOpenReports } from '../reportService.js';
import { getStorageConfig, saveStorageConfig, isS3Configured, testStorageConnection, uploadMediaFile } from '../storage.js';
import {
  buildFollowActivity,
  buildUndoFollowActivity,
  deliverActivity,
} from '../activitypub.js';
import { deleteUserAccount } from '../accountService.js';

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

// すべてのエンドポイントに requireAdmin を適用
adminRouter.use(requireAdmin);

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
  `).all();

  res.json(users);
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
    const blocks = db.prepare('SELECT domain, reason, created_at, created_by FROM blocked_domains ORDER BY created_at DESC').all() as unknown as BlockedDomainRow[];
    res.json(blocks);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 新規ドメインのブロック登録（および過去データのパージ）
adminRouter.post('/blocks', (req: Request, res: Response) => {
  try {
    const { domain, reason, purgeData } = req.body;
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

    db.prepare(`
      INSERT INTO blocked_domains (domain, reason, created_at, created_by)
      VALUES (?, ?, ?, ?)
    `).run(cleanDomain, cleanReason, now, adminId);

    // 過去の外部投稿・アクターキャッシュ・フォロー関係のパージ（デフォルト: 有効）
    let purgeStats = null;
    if (purgeData !== false) {
      purgeStats = purgeDomainData(cleanDomain);
    }

    console.log(`[Admin] 🚫 Domain "${cleanDomain}" blocked by @${adminId}. Reason: "${cleanReason}". Purged:`, purgeStats);

    res.status(201).json({
      success: true,
      domain: cleanDomain,
      reason: cleanReason,
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
// 🚩 通報（モデレーションキュー）
// ==========================================

// 通報一覧（?status=open|resolved|rejected|all）
adminRouter.get('/reports', (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || 'all';
    const reports = listReports(status === 'all' ? undefined : status);
    res.json({
      reports,
      counts: {
        open: countOpenReports(),
        total: (db.prepare('SELECT COUNT(*) AS c FROM reports').get() as { c: number }).c,
      },
    });
  } catch (err: any) {
    console.error('[Admin Reports Error]:', err);
    res.status(500).json({ error: '通報一覧の取得に失敗しました。' });
  }
});

// 未対応の通報件数（バッジ用）
adminRouter.get('/reports/count', (_req: Request, res: Response) => {
  try {
    res.json({ open: countOpenReports() });
  } catch (err: any) {
    res.status(500).json({ error: '通報件数の取得に失敗しました。' });
  }
});

// 通報への対応（action: resolve=対応済み / reject=却下 / reopen=再オープン）
adminRouter.post('/reports/:id/resolve', (req: Request, res: Response) => {
  const { action, note } = req.body;
  if (!['resolve', 'reject', 'reopen'].includes(String(action))) {
    return res.status(400).json({ error: 'action は resolve / reject / reopen のいずれかを指定してください。' });
  }

  try {
    const updated = resolveReport(String(req.params.id), action, req.user!.id, typeof note === 'string' ? note : undefined);
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


