import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sendNotificationToUser } from './streaming.js';

// データベースディレクトリが存在することを確認
const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new DatabaseSync(config.dbPath);

// WALモード等のPRAGMA設定
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// テーブル初期化＆マイグレーション
export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      summary TEXT DEFAULT '',
      icon_url TEXT DEFAULT '',
      banner_url TEXT DEFAULT '',
      master_key_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      is_frozen INTEGER NOT NULL DEFAULT 0,
      public_key_pem TEXT NOT NULL,
      private_key_pem TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_url TEXT NOT NULL,
      author_handle TEXT NOT NULL,
      author_icon TEXT DEFAULT '',
      content TEXT NOT NULL,
      is_local INTEGER NOT NULL DEFAULT 1,
      visibility TEXT NOT NULL DEFAULT 'public',
      emojis TEXT DEFAULT '[]',
      cw TEXT DEFAULT NULL,
      in_reply_to TEXT,
      quote_id TEXT DEFAULT NULL,
      is_sensitive INTEGER NOT NULL DEFAULT 0,
      media_attachments TEXT DEFAULT '[]',
      published_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS follows (
      id TEXT PRIMARY KEY,
      follower_url TEXT NOT NULL,
      following_url TEXT NOT NULL,
      inbox_url TEXT NOT NULL,
      is_local INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'accepted',
      created_at TEXT NOT NULL,
      UNIQUE(follower_url, following_url)
    );

    CREATE TABLE IF NOT EXISTS remote_actors (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      domain TEXT NOT NULL,
      name TEXT,
      summary TEXT,
      icon_url TEXT DEFAULT '',
      banner_url TEXT DEFAULT '',
      inbox_url TEXT NOT NULL,
      shared_inbox_url TEXT,
      public_key_id TEXT NOT NULL,
      public_key_pem TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relays (
      inbox_url TEXT PRIMARY KEY,
      actor_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_icon TEXT DEFAULT '',
      reaction TEXT NOT NULL,
      is_local INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(post_id, user_id, reaction)
    );

    CREATE TABLE IF NOT EXISTS announces (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_handle TEXT NOT NULL,
      user_icon TEXT DEFAULT '',
      is_local INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS blocked_domains (
      domain TEXT PRIMARY KEY,
      reason TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      actor_handle TEXT NOT NULL,
      actor_icon TEXT DEFAULT '',
      post_id TEXT,
      post_content TEXT DEFAULT '',
      content TEXT DEFAULT '',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS server_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, post_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_blocks (
      user_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      target_handle TEXT DEFAULT '',
      target_name TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, target_user_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_mutes (
      user_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      target_handle TEXT DEFAULT '',
      target_name TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, target_user_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pinned_posts (
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, post_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL UNIQUE,
      multiple INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS poll_choices (
      id TEXT PRIMARY KEY,
      poll_id TEXT NOT NULL,
      choice_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      votes_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      UNIQUE(poll_id, choice_index)
    );

    CREATE TABLE IF NOT EXISTS poll_votes (
      id TEXT PRIMARY KEY,
      poll_id TEXT NOT NULL,
      choice_index INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      UNIQUE(poll_id, user_id, choice_index)
    );

    CREATE TABLE IF NOT EXISTS custom_emojis (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '一般',
      aliases TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invitation_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT DEFAULT NULL,
      memo TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS antennas (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      src TEXT NOT NULL DEFAULT 'all',
      user_list TEXT DEFAULT '',
      keywords TEXT NOT NULL,
      exclude_keywords TEXT DEFAULT '',
      case_sensitive INTEGER NOT NULL DEFAULT 0,
      with_file INTEGER NOT NULL DEFAULT 0,
      notify INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_antennas_user ON antennas(user_id);

    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      cw TEXT DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'public',
      media_attachments TEXT DEFAULT '[]',
      poll TEXT DEFAULT '',
      in_reply_to TEXT DEFAULT '',
      quote_id TEXT DEFAULT '',
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts(user_id);

    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      cw TEXT DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'public',
      media_attachments TEXT DEFAULT '[]',
      poll TEXT DEFAULT '',
      in_reply_to TEXT DEFAULT '',
      quote_id TEXT DEFAULT '',
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT DEFAULT '',
      published_post_id TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status ON scheduled_posts(status, scheduled_at);

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      banner_url TEXT DEFAULT '',
      color TEXT DEFAULT '#6366f1',
      category TEXT DEFAULT 'general',
      is_archived INTEGER NOT NULL DEFAULT 0,
      posts_count INTEGER NOT NULL DEFAULT 0,
      followers_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);
    CREATE INDEX IF NOT EXISTS idx_channels_created_at ON channels(created_at DESC);

    CREATE TABLE IF NOT EXISTS channel_follows (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(channel_id, user_id),
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_channel_follows_user ON channel_follows(user_id);

    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      device_name TEXT NOT NULL DEFAULT '',
      transports TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      last_used_at TEXT DEFAULT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      challenge TEXT PRIMARY KEY,
      user_id TEXT,
      type TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
      post_id UNINDEXED,
      content,
      tokenize = 'trigram'
    );

    CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
      INSERT INTO posts_fts(post_id, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
      DELETE FROM posts_fts WHERE post_id = old.id;
      INSERT INTO posts_fts(post_id, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
      DELETE FROM posts_fts WHERE post_id = old.id;
    END;

    CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_in_reply_to ON posts(in_reply_to);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_url);
    CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_url);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id);
    CREATE INDEX IF NOT EXISTS idx_reactions_user ON reactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_announces_post ON announces(post_id);
    CREATE INDEX IF NOT EXISTS idx_announces_user ON announces(user_id);
    CREATE INDEX IF NOT EXISTS idx_blocked_domains_domain ON blocked_domains(domain);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_blocks_user ON user_blocks(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_mutes_user ON user_mutes(user_id);
    CREATE INDEX IF NOT EXISTS idx_pinned_posts_user ON pinned_posts(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_polls_post ON polls(post_id);
    CREATE INDEX IF NOT EXISTS idx_poll_choices_poll ON poll_choices(poll_id, choice_index);
    CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_user ON poll_votes(poll_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_custom_emojis_name ON custom_emojis(name);
    CREATE INDEX IF NOT EXISTS idx_invitation_codes_created_by ON invitation_codes(created_by);
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
  `);

  // 既存DBへのマイグレーション: visibility / emojis / icon / banner / media_attachments / cw / quote_id / is_sensitive カラムの追加
  const migrations = [
    "ALTER TABLE posts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';",
    "ALTER TABLE posts ADD COLUMN emojis TEXT DEFAULT '[]';",
    "ALTER TABLE posts ADD COLUMN author_icon TEXT DEFAULT '';",
    "ALTER TABLE posts ADD COLUMN media_attachments TEXT DEFAULT '[]';",
    "ALTER TABLE posts ADD COLUMN cw TEXT DEFAULT NULL;",
    "ALTER TABLE posts ADD COLUMN quote_id TEXT DEFAULT NULL;",
    "ALTER TABLE posts ADD COLUMN is_sensitive INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE users ADD COLUMN icon_url TEXT DEFAULT '';",
    "ALTER TABLE users ADD COLUMN banner_url TEXT DEFAULT '';",
    "ALTER TABLE remote_actors ADD COLUMN icon_url TEXT DEFAULT '';",
    "ALTER TABLE remote_actors ADD COLUMN banner_url TEXT DEFAULT '';",
    "CREATE INDEX IF NOT EXISTS idx_posts_quote_id ON posts(quote_id);",
    `CREATE TABLE IF NOT EXISTS custom_emojis (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '一般',
      aliases TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS invitation_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT DEFAULT NULL,
      memo TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );`,
    "CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);",
    "CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(post_id UNINDEXED, content, tokenize='trigram');",
    `CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
      INSERT INTO posts_fts(post_id, content) VALUES (new.id, new.content);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
      DELETE FROM posts_fts WHERE post_id = old.id;
      INSERT INTO posts_fts(post_id, content) VALUES (new.id, new.content);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
      DELETE FROM posts_fts WHERE post_id = old.id;
    END;`,
    "CREATE INDEX IF NOT EXISTS idx_custom_emojis_name ON custom_emojis(name);",
    "CREATE INDEX IF NOT EXISTS idx_invitation_codes_created_by ON invitation_codes(created_by);",
    "ALTER TABLE posts ADD COLUMN channel_id TEXT DEFAULT NULL;",
    "CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel_id, published_at DESC);",
    `CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      banner_url TEXT DEFAULT '',
      color TEXT DEFAULT '#6366f1',
      category TEXT DEFAULT 'general',
      is_archived INTEGER NOT NULL DEFAULT 0,
      posts_count INTEGER NOT NULL DEFAULT 0,
      followers_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );`,
    "ALTER TABLE channels ADD COLUMN color TEXT DEFAULT '#6366f1';",
    "ALTER TABLE channels ADD COLUMN category TEXT DEFAULT 'general';",
    "ALTER TABLE channels ADD COLUMN followers_count INTEGER NOT NULL DEFAULT 1;",
    "CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);",
    "CREATE INDEX IF NOT EXISTS idx_channels_created_at ON channels(created_at DESC);",
    `CREATE TABLE IF NOT EXISTS channel_follows (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(channel_id, user_id),
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );`,
    "CREATE INDEX IF NOT EXISTS idx_channel_follows_user ON channel_follows(user_id);",
    `CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      device_name TEXT NOT NULL DEFAULT '',
      transports TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      last_used_at TEXT DEFAULT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );`,
    "CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);",
    `CREATE TABLE IF NOT EXISTS webauthn_challenges (
      challenge TEXT PRIMARY KEY,
      user_id TEXT,
      type TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );`,
    // 通報（モデレーションキュー）
    `CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_actor_url TEXT NOT NULL,
      reporter_user_id TEXT,
      reporter_handle TEXT DEFAULT '',
      target_actor_url TEXT NOT NULL,
      target_user_id TEXT,
      target_handle TEXT DEFAULT '',
      target_post_id TEXT,
      target_post_content TEXT,
      is_remote INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT 'other',
      comment TEXT DEFAULT '',
      forwarded INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      resolved_by TEXT,
      resolved_at TEXT,
      resolution_note TEXT,
      created_at TEXT NOT NULL
    );`,
    "CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_actor_url);",
    // 鍵アカウント（フォロー承認制）
    "ALTER TABLE users ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0;",
    // ワードフィルター（ミュートワード）
    `CREATE TABLE IF NOT EXISTS muted_words (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      case_sensitive INTEGER NOT NULL DEFAULT 0,
      whole_word INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );`,
    "CREATE INDEX IF NOT EXISTS idx_muted_words_user ON muted_words(user_id);",
    // お知らせ（サーバーからの一斉告知）
    `CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
    "CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, created_at DESC);",
    // リンクプレビュー（OGP/oEmbed）キャッシュ
    `CREATE TABLE IF NOT EXISTS link_previews (
      url TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      image_url TEXT,
      site_name TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      fetched_at TEXT NOT NULL
    );`,
    // リスト（ユーザーを束ねた専用タイムライン）
    `CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS list_members (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      member TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(list_id, member)
    );`,
    "CREATE INDEX IF NOT EXISTS idx_lists_user ON lists(user_id);",
    "CREATE INDEX IF NOT EXISTS idx_list_members_list ON list_members(list_id);",
  ];

  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // すでにカラムやインデックスが存在する場合は無視
    }
  }

  // FTS5 既存投稿データの同期（未同期の過去ノートを一括インデックス化）
  try {
    const ftsCount = (db.prepare('SELECT COUNT(*) as c FROM posts_fts').get() as any).c;
    const postsCount = (db.prepare('SELECT COUNT(*) as c FROM posts').get() as any).c;
    if (ftsCount < postsCount) {
      console.log(`[FTS5] 🔄 Syncing existing posts to posts_fts (${ftsCount} -> ${postsCount})...`);
      db.prepare(`
        INSERT INTO posts_fts(post_id, content)
        SELECT id, content FROM posts
        WHERE id NOT IN (SELECT post_id FROM posts_fts)
      `).run();
      console.log('[FTS5] ✅ Posts FTS initial sync completed.');
    }
  } catch (ftsSyncErr) {
    console.warn('[FTS5 Sync Warning]:', ftsSyncErr);
  }
}

export interface ChannelRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  banner_url: string;
  color?: string;
  category?: string;
  is_archived: number;
  posts_count: number;
  followers_count: number;
  created_at: string;
}

export interface WebAuthnCredentialRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  device_name: string;
  transports: string;
  created_at: string;
  last_used_at: string | null;
}

export interface PushSubscriptionRow {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  created_at: string;
}

export interface RelayRow {
  inbox_url: string;
  actor_url: string;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
}

export interface UserRow {
  id: string;
  name: string;
  summary: string;
  icon_url?: string;
  banner_url?: string;
  master_key_hash: string;
  role: 'admin' | 'user';
  is_frozen: number;
  /** 鍵アカウント（フォロー承認制）: 1 なら新規フォローを承認制にする */
  is_locked: number;
  public_key_pem: string;
  private_key_pem: string;
  created_at: string;
}

export interface SessionRow {
  token: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

export interface PostRow {
  id: string;
  user_id: string;
  author_name: string;
  author_url: string;
  author_handle: string;
  author_icon?: string;
  content: string;
  is_local: number;
  visibility: 'public' | 'local' | 'followers';
  emojis?: string;
  cw?: string | null;
  in_reply_to: string | null;
  quote_id?: string | null;
  is_sensitive?: number;
  media_attachments?: string;
  published_at: string;
}

export interface PinnedPostRow {
  user_id: string;
  post_id: string;
  created_at: string;
}

export interface PollRow {
  id: string;
  post_id: string;
  multiple: number;
  expires_at: string | null;
  created_at: string;
}

export interface PollChoiceRow {
  id: string;
  poll_id: string;
  choice_index: number;
  text: string;
  votes_count: number;
}

export interface PollVoteRow {
  id: string;
  poll_id: string;
  choice_index: number;
  user_id: string;
  created_at: string;
}

export interface FollowRow {
  id: string;
  follower_url: string;
  following_url: string;
  inbox_url: string;
  is_local: number;
  status: string;
  created_at: string;
}

export interface RemoteActorRow {
  id: string;
  username: string;
  domain: string;
  name: string | null;
  summary: string | null;
  icon_url?: string | null;
  banner_url?: string | null;
  inbox_url: string;
  shared_inbox_url: string | null;
  public_key_id: string;
  public_key_pem: string;
  updated_at: string;
}

export interface ReactionRow {
  id: string;
  post_id: string;
  user_id: string;
  user_name: string;
  user_icon?: string;
  reaction: string;
  is_local: number;
  created_at: string;
}

export interface AnnounceRow {
  id: string;
  post_id: string;
  user_id: string;
  user_name: string;
  user_handle: string;
  user_icon?: string;
  is_local: number;
  created_at: string;
}

export interface BlockedDomainRow {
  domain: string;
  reason: string;
  created_at: string;
  created_by: string;
}

export interface CustomEmojiRow {
  id: string;
  name: string;
  url: string;
  category: string;
  aliases: string;
  created_at: string;
}

export interface InvitationCodeRow {
  code: string;
  created_by: string;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  memo: string;
  created_at: string;
}

export interface AntennaRow {
  id: string;
  user_id: string;
  name: string;
  src: 'all' | 'home' | 'users';
  user_list: string;
  keywords: string;
  exclude_keywords: string;
  case_sensitive: number;
  with_file: number;
  notify: number;
  created_at: string;
}

export interface DraftRow {
  id: string;
  user_id: string;
  content: string;
  cw: string;
  visibility: string;
  media_attachments: string;
  poll: string;
  in_reply_to: string;
  quote_id: string;
  updated_at: string;
  created_at: string;
}

export interface ScheduledPostRow {
  id: string;
  user_id: string;
  content: string;
  cw: string;
  visibility: string;
  media_attachments: string;
  poll: string;
  in_reply_to: string;
  quote_id: string;
  scheduled_at: string;
  status: 'pending' | 'published' | 'failed';
  error_message: string;
  published_post_id: string;
  created_at: string;
}

/**
 * ホスト名またはURL、ハンドルからドメイン（小文字）を抽出
 */
export function extractDomain(input: string): string {
  if (!input) return '';
  let str = input.trim().toLowerCase();

  // @user@domain.com 形式
  if (str.includes('@')) {
    const parts = str.split('@').filter(Boolean);
    if (parts.length >= 2) {
      str = parts[parts.length - 1];
    }
  }

  // URL 形式
  if (str.startsWith('http://') || str.startsWith('https://')) {
    try {
      return new URL(str).hostname.toLowerCase();
    } catch {}
  }

  // プロトコル prefix、パス、ポートの除去
  str = str.replace(/^[a-z]+:\/\//, '');
  str = str.split('/')[0];
  str = str.split(':')[0];
  return str.trim();
}

/**
 * 指定ドメインまたはURLがブロックリストに登録されているかを判定
 * (完全一致、またはサブドメイン一致: 例 'bad.com' がブロックされていれば 'sub.bad.com' もブロック)
 */
export function isDomainBlocked(domainOrUrl: string): boolean {
  const domain = extractDomain(domainOrUrl);
  if (!domain) return false;

  try {
    const rows = db.prepare('SELECT domain FROM blocked_domains').all() as { domain: string }[];
    for (const row of rows) {
      const blocked = row.domain.toLowerCase();
      if (domain === blocked || domain.endsWith(`.${blocked}`)) {
        return true;
      }
    }
  } catch {
    // テーブル未作成時の安全フォールバック
    return false;
  }
  return false;
}

/**
 * ブロックされたドメインに関するリモート投稿、アクターキャッシュ、フォロー関係を一括パージ（消去）
 */
export function purgeDomainData(domain: string): { posts: number; actors: number; follows: number; relays: number } {
  const cleanDomain = extractDomain(domain);
  if (!cleanDomain) return { posts: 0, actors: 0, follows: 0, relays: 0 };

  const domainPattern = `%${cleanDomain}%`;

  // 1. 該当ドメインの投稿（連合投稿のみ対象。ローカル投稿は絶対に消さない）
  const postsRes = db.prepare(`
    DELETE FROM posts 
    WHERE is_local = 0 AND (
      author_handle LIKE ? OR 
      author_url LIKE ? OR 
      user_id LIKE ?
    )
  `).run(`%@${cleanDomain}`, domainPattern, domainPattern);

  // 2. リモートアクターキャッシュの削除
  const actorsRes = db.prepare(`
    DELETE FROM remote_actors 
    WHERE domain = ? OR domain LIKE ? OR id LIKE ?
  `).run(cleanDomain, `%.${cleanDomain}`, domainPattern);

  // 3. フォロー関係の削除
  const followsRes = db.prepare(`
    DELETE FROM follows 
    WHERE follower_url LIKE ? OR following_url LIKE ?
  `).run(domainPattern, domainPattern);

  // 4. 該当ドメインのリレー削除
  const relaysRes = db.prepare(`
    DELETE FROM relays 
    WHERE inbox_url LIKE ? OR actor_url LIKE ?
  `).run(domainPattern, domainPattern);

  console.log(`[Domain Block Purge] 🧹 Purged data for "${cleanDomain}": ${postsRes.changes} posts, ${actorsRes.changes} actors, ${followsRes.changes} follows, ${relaysRes.changes} relays`);

  return {
    posts: Number(postsRes.changes),
    actors: Number(actorsRes.changes),
    follows: Number(followsRes.changes),
    relays: Number(relaysRes.changes),
  };
}

export interface NotificationRow {
  id: string;
  user_id: string;
  type: 'reply' | 'follow' | 'renote' | 'reaction' | 'antenna' | 'scheduled_published';
  actor_id: string;
  actor_name: string;
  actor_handle: string;
  actor_icon: string;
  post_id: string | null;
  post_content: string;
  content: string;
  is_read: number;
  created_at: string;
}

/**
 * 通知を作成して DB に保存
 */
export function createNotification(params: {
  userId: string;
  type: 'reply' | 'follow' | 'renote' | 'announce' | 'reaction' | 'antenna' | 'scheduled_published' | 'mention';
  actorId: string;
  actorName: string;
  actorHandle: string;
  actorIcon?: string;
  postId?: string;
  postContent?: string;
  content?: string;
}): boolean {
  // 自分自身に対するアクションは通知しない (予約投稿の自動公開など、システム自己通知は許可)
  if (params.type !== 'scheduled_published' && (params.userId === params.actorId || params.actorHandle.startsWith(`@${params.userId}@`))) {
    return false;
  }

  // 受信者がローカルユーザーとして存在するか
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(params.userId);
  if (!user) return false;

  // 重複防止（フォロー通知は同じ人から未読が既にあれば二重生成しない）
  if (params.type === 'follow') {
    const existing = db.prepare(`
      SELECT id FROM notifications 
      WHERE user_id = ? AND type = 'follow' AND actor_id = ? AND is_read = 0
    `).get(params.userId, params.actorId);
    if (existing) return false;
  }

  // 同一投稿に対する同一ユーザーからの同一リアクション通知の重複防止
  if (params.type === 'reaction' && params.postId) {
    const existing = db.prepare(`
      SELECT id FROM notifications 
      WHERE user_id = ? AND type = 'reaction' AND actor_id = ? AND post_id = ? AND content = ?
    `).get(params.userId, params.actorId, params.postId, params.content || '');
    if (existing) return false;
  }

  const id = `notif_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();

  // HTMLタグを除去し、適切な長さにトリム
  const postSnippet = (params.postContent || '').replace(/<[^>]+>/g, '').trim().slice(0, 100);
  const contentSnippet = (params.content || '').replace(/<[^>]+>/g, '').trim().slice(0, 140);

  try {
    db.prepare(`
      INSERT INTO notifications (id, user_id, type, actor_id, actor_name, actor_handle, actor_icon, post_id, post_content, content, is_read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      id,
      params.userId,
      params.type,
      params.actorId,
      params.actorName,
      params.actorHandle,
      params.actorIcon || '',
      params.postId || null,
      postSnippet,
      contentSnippet,
      now
    );
    console.log(`[Notification] 🔔 Created ${params.type} notification for @${params.userId} from ${params.actorHandle}`);

    // 📡 リアルタイム SSE 通知プッシュ
    sendNotificationToUser(params.userId, {
      id,
      user_id: params.userId,
      type: params.type,
      actor_id: params.actorId,
      actor_name: params.actorName,
      actor_handle: params.actorHandle,
      actor_icon: params.actorIcon || '',
      post_id: params.postId || null,
      post_content: postSnippet,
      content: contentSnippet,
      is_read: 0,
      created_at: now,
    });

    // 🔔 バックグラウンド Web Push 通知の配信
    try {
      let pushTitle = 'Spica';
      let pushBody = '';

      if (params.type === 'reply') {
        pushTitle = `返信: ${params.actorName || params.actorHandle}`;
        pushBody = contentSnippet || '新しい返信が届きました';
      } else if (params.type === 'follow') {
        pushTitle = '新しいフォロワー';
        pushBody = `${params.actorName || params.actorHandle} さんにフォローされました`;
      } else if (params.type === 'renote' || params.type === 'announce') {
        pushTitle = 'リノートされました';
        pushBody = `${params.actorName || params.actorHandle} さんがあなたのノートをリノートしました`;
      } else if (params.type === 'reaction') {
        pushTitle = `リアクション: ${contentSnippet || '❤️'}`;
        pushBody = `${params.actorName || params.actorHandle} さんがリアクションしました`;
      }

      import('./pushService.js')
        .then(({ sendPushToUser }) => {
          sendPushToUser(params.userId, {
            title: pushTitle,
            body: pushBody,
            icon: params.actorIcon || '/logo.jpg',
            url: params.postId ? `/?postId=${params.postId}` : '/?view=notifications',
            tag: `spica-${params.type}-${params.userId}`,
          }).catch(() => {});
        })
        .catch(() => {});
    } catch {}

    return true;
  } catch (err) {
    console.error('[Notification Error] Failed to create notification:', err);
    return false;
  }
}

/**
 * サーバー設定の取得（DB）
 */
export function getServerSetting(key: string, defaultValue?: string): string | undefined {
  try {
    const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * サーバー設定の保存（DB）
 */
export function setServerSetting(key: string, value: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO server_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now);
}

/**
 * 全サーバー設定の取得（DB）
 */
export function getAllServerSettings(): Record<string, string> {
  try {
    const rows = db.prepare('SELECT key, value FROM server_settings').all() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const r of rows) {
      result[r.key] = r.value;
    }
    return result;
  } catch {
    return {};
  }
}

export type RegistrationMode = 'open' | 'invite' | 'closed';

export const DEFAULT_SERVER_RULES: string[] = [
  'お互いを尊重してください',
  '他鯖とのもめごとなどをおこさないでください',
  '個人情報(あなたの本名、住所、学校名、クラス、友達の本名など)を極力書かないこと',
  '利用規約をちゃんと守ること',
];

export interface InstanceInfo {
  name: string;
  description: string;
  icon_url: string;
  banner_url: string;
  registration_mode: RegistrationMode;
  tos_url: string;
  privacy_policy_url: string;
  contact_url: string;
  repository_url: string;
  operator_url: string;
  server_rules: string[];
  require_rules_agreement: boolean;
}

/**
 * サーバー基本設定の取得 (DB優先、フォールバックとしてconfig)
 */
export function getInstanceInfo(): InstanceInfo {
  let rules: string[] = DEFAULT_SERVER_RULES;
  const rawRules = getServerSetting('server_rules');
  if (rawRules) {
    try {
      const parsed = JSON.parse(rawRules);
      if (Array.isArray(parsed)) {
        rules = parsed.filter((r) => typeof r === 'string' && r.trim().length > 0);
      }
    } catch {
      rules = DEFAULT_SERVER_RULES;
    }
  }

  const rawAgreement = getServerSetting('require_rules_agreement');
  const requireRulesAgreement = rawAgreement !== undefined ? rawAgreement === 'true' : true;

  return {
    name: getServerSetting('instance_name', config.instanceName) || config.instanceName,
    description: getServerSetting('instance_description', config.instanceDescription) || config.instanceDescription,
    icon_url: getServerSetting('instance_icon', '/logo.jpg') || '/logo.jpg',
    banner_url: getServerSetting('instance_banner', '') || '',
    registration_mode: (getServerSetting('registration_mode', 'open') as RegistrationMode) || 'open',
    tos_url: getServerSetting('tos_url', '') || '',
    privacy_policy_url: getServerSetting('privacy_policy_url', '') || '',
    contact_url: getServerSetting('contact_url', '') || '',
    repository_url: getServerSetting('repository_url', 'https://github.com/Keychrom/Spica') || '',
    operator_url: getServerSetting('operator_url', '') || '',
    server_rules: rules,
    require_rules_agreement: requireRulesAgreement,
  };
}

/**
 * サーバー基本設定の保存 (DB)
 */
export function saveInstanceInfo(info: Partial<InstanceInfo>): void {
  if (info.name !== undefined) setServerSetting('instance_name', info.name.trim());
  if (info.description !== undefined) setServerSetting('instance_description', info.description.trim());
  if (info.icon_url !== undefined) setServerSetting('instance_icon', info.icon_url.trim());
  if (info.banner_url !== undefined) setServerSetting('instance_banner', info.banner_url.trim());
  if (info.registration_mode !== undefined) setServerSetting('registration_mode', info.registration_mode);
  if (info.tos_url !== undefined) setServerSetting('tos_url', info.tos_url.trim());
  if (info.privacy_policy_url !== undefined) setServerSetting('privacy_policy_url', info.privacy_policy_url.trim());
  if (info.contact_url !== undefined) setServerSetting('contact_url', info.contact_url.trim());
  if (info.repository_url !== undefined) setServerSetting('repository_url', info.repository_url.trim());
  if (info.operator_url !== undefined) setServerSetting('operator_url', info.operator_url.trim());
  if (info.server_rules !== undefined) {
    const cleanRules = Array.isArray(info.server_rules)
      ? info.server_rules.map((r) => r.trim()).filter((r) => r.length > 0)
      : [];
    setServerSetting('server_rules', JSON.stringify(cleanRules));
  }
  if (info.require_rules_agreement !== undefined) {
    setServerSetting('require_rules_agreement', info.require_rules_agreement ? 'true' : 'false');
  }
}
