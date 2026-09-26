-- Spica: PostgreSQL スキーマ
--
-- このファイルは `npm run db:pg:schema` が server/src/db.ts の migrations（SQLite）から生成します。
-- 手で編集しないでください。スキーマを変えるときは db.ts を直して再生成します。
--
-- 適用: npm run db:pg:init -- --dsn "$DATABASE_URL"

-- pg_trgm: 日本語を含む部分一致検索（FTS5 の trigram 相当）に使う
-- 権限が無い環境（マネージド PostgreSQL など）でも適用が止まらないよう、
-- 拡張が無ければ索引を作らずに進む（検索は動くが全走査になる）。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'pg_trgm を有効化できませんでした（管理者権限が必要です）。日本語の部分一致検索は索引なしで動きます。';
    END;
  END IF;
END $$;

-- ==== テーブル ====
CREATE TABLE IF NOT EXISTS admin_actions  (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  method TEXT DEFAULT '',
  path TEXT DEFAULT '',
  target_type TEXT DEFAULT '',
  target_id TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  status BIGINT NOT NULL DEFAULT 200,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS announcements  (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  is_active BIGINT NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS announces  (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_handle TEXT NOT NULL,
  user_icon TEXT DEFAULT '',
  is_local BIGINT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(post_id, user_id)
);
CREATE TABLE IF NOT EXISTS users  (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT DEFAULT '',
  icon_url TEXT DEFAULT '',
  banner_url TEXT DEFAULT '',
  master_key_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  is_frozen BIGINT NOT NULL DEFAULT 0,
  public_key_pem TEXT NOT NULL,
  private_key_pem TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_locked BIGINT NOT NULL DEFAULT 0,
  fields TEXT DEFAULT '[]',
  discoverable BIGINT NOT NULL DEFAULT 1,
  email TEXT DEFAULT '',
  email_verified BIGINT NOT NULL DEFAULT 0,
  password_hash TEXT DEFAULT '',
  moved_to TEXT DEFAULT '',
  also_known_as TEXT DEFAULT '',
  notification_prefs TEXT DEFAULT '{}',
  email_notifications BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS antennas  (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  src TEXT NOT NULL DEFAULT 'all',
  user_list TEXT DEFAULT '',
  keywords TEXT NOT NULL,
  exclude_keywords TEXT DEFAULT '',
  case_sensitive BIGINT NOT NULL DEFAULT 0,
  with_file BIGINT NOT NULL DEFAULT 0,
  notify BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS blocked_domains  (
  domain TEXT PRIMARY KEY,
  reason TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'suspend'
);
CREATE TABLE IF NOT EXISTS bookmarks  (
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, post_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS channels  (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  banner_url TEXT DEFAULT '',
  color TEXT DEFAULT '#6366f1',
  category TEXT DEFAULT 'general',
  is_archived BIGINT NOT NULL DEFAULT 0,
  posts_count BIGINT NOT NULL DEFAULT 0,
  followers_count BIGINT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS channel_follows  (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(channel_id, user_id),
  FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS custom_emojis  (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '一般',
  aliases TEXT DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts  (
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
CREATE TABLE IF NOT EXISTS email_verifications  (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS follows  (
  id TEXT PRIMARY KEY,
  follower_url TEXT NOT NULL,
  following_url TEXT NOT NULL,
  inbox_url TEXT NOT NULL,
  is_local BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TEXT NOT NULL,
  UNIQUE(follower_url, following_url)
);
CREATE TABLE IF NOT EXISTS instance_actor  (
  id TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  private_key_pem TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invitation_codes  (
  code TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  max_uses BIGINT NOT NULL DEFAULT 1,
  used_count BIGINT NOT NULL DEFAULT 0,
  expires_at TEXT DEFAULT NULL,
  memo TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs  (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts BIGINT NOT NULL DEFAULT 0,
  max_attempts BIGINT NOT NULL DEFAULT 5,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT DEFAULT '',
  result TEXT DEFAULT '',
  dedupe_key TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS link_previews  (
  url TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  image_url TEXT,
  site_name TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS list_members  (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL,
  member TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(list_id, member)
);
CREATE TABLE IF NOT EXISTS lists  (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media  (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  key TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size BIGINT NOT NULL DEFAULT 0,
  name TEXT DEFAULT '',
  thumbnail_url TEXT DEFAULT '',
  thumbnail_key TEXT DEFAULT '',
  width BIGINT,
  height BIGINT,
  duration DOUBLE PRECISION,
  post_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS miauth_sessions  (
  id TEXT PRIMARY KEY,
  app_name TEXT NOT NULL DEFAULT '',
  callback TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  approved_user_id TEXT,
  token TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS muted_words  (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  case_sensitive BIGINT NOT NULL DEFAULT 0,
  whole_word BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications  (
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
  is_read BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS outbox_deliveries  (
  id TEXT PRIMARY KEY,
  activity_id TEXT DEFAULT '',
  activity_type TEXT DEFAULT '',
  inbox_url TEXT NOT NULL,
  activity TEXT NOT NULL,
  sender_user_id TEXT DEFAULT NULL,
  use_instance_actor BIGINT NOT NULL DEFAULT 0,
  attempts BIGINT NOT NULL DEFAULT 1,
  next_attempt_at TEXT NOT NULL,
  last_status BIGINT DEFAULT NULL,
  last_error TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts  (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_url TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  author_icon TEXT DEFAULT '',
  content TEXT NOT NULL,
  is_local BIGINT NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'public',
  emojis TEXT DEFAULT '[]',
  cw TEXT DEFAULT NULL,
  in_reply_to TEXT,
  quote_id TEXT DEFAULT NULL,
  is_sensitive BIGINT NOT NULL DEFAULT 0,
  media_attachments TEXT DEFAULT '[]',
  published_at TEXT NOT NULL,
  channel_id TEXT DEFAULT NULL,
  fts_indexed BIGINT NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS pinned_posts  (
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, post_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS polls  (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL UNIQUE,
  multiple BIGINT NOT NULL DEFAULT 0,
  expires_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS poll_choices  (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL,
  choice_index BIGINT NOT NULL,
  text TEXT NOT NULL,
  votes_count BIGINT NOT NULL DEFAULT 0,
  FOREIGN KEY(poll_id) REFERENCES polls(id) ON DELETE CASCADE,
  UNIQUE(poll_id, choice_index)
);
CREATE TABLE IF NOT EXISTS poll_votes  (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL,
  choice_index BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(poll_id) REFERENCES polls(id) ON DELETE CASCADE,
  UNIQUE(poll_id, user_id, choice_index)
);
-- posts_fts: FTS5 仮想テーブルを通常テーブル + pg_trgm 索引に置き換え
CREATE TABLE IF NOT EXISTS posts_fts (
  post_id TEXT PRIMARY KEY,
  content TEXT
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS idx_posts_fts_trgm ON posts_fts USING gin (content gin_trgm_ops);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS proxy_cache  (
  url_hash TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT '',
  size BIGINT NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions  (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS reactions  (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_icon TEXT DEFAULT '',
  reaction TEXT NOT NULL,
  is_local BIGINT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(post_id, user_id, reaction)
);
CREATE TABLE IF NOT EXISTS relays  (
  inbox_url TEXT PRIMARY KEY,
  actor_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_actors  (
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
  updated_at TEXT NOT NULL,
  moved_to TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS remote_blocks  (
  blocker_actor_url TEXT NOT NULL,
  blocked_actor_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_actor_url, blocked_actor_url)
);
CREATE TABLE IF NOT EXISTS reports  (
  id TEXT PRIMARY KEY,
  reporter_actor_url TEXT NOT NULL,
  reporter_user_id TEXT,
  reporter_handle TEXT DEFAULT '',
  target_actor_url TEXT NOT NULL,
  target_user_id TEXT,
  target_handle TEXT DEFAULT '',
  target_post_id TEXT,
  target_post_content TEXT,
  is_remote BIGINT NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'other',
  comment TEXT DEFAULT '',
  forwarded BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT,
  resolved_at TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS roles  (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#6366f1',
  permissions TEXT NOT NULL DEFAULT '',
  is_system BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduled_posts  (
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
CREATE TABLE IF NOT EXISTS server_settings  (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions  (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS user_blocks  (
  user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  target_handle TEXT DEFAULT '',
  target_name TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, target_user_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS user_mutes  (
  user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  target_handle TEXT DEFAULT '',
  target_name TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, target_user_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS user_roles  (
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role_id)
);
CREATE TABLE IF NOT EXISTS webauthn_challenges  (
  challenge TEXT PRIMARY KEY,
  user_id TEXT,
  type TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS webauthn_credentials  (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  device_name TEXT NOT NULL DEFAULT '',
  transports TEXT DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT DEFAULT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ==== 索引 ====
CREATE INDEX IF NOT EXISTS idx_admin_actions_actor ON admin_actions(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON admin_actions(target_id);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_announces_post ON announces(post_id);
CREATE INDEX IF NOT EXISTS idx_announces_user ON announces(user_id);
CREATE INDEX IF NOT EXISTS idx_antennas_user ON antennas(user_id);
CREATE INDEX IF NOT EXISTS idx_blocked_domains_domain ON blocked_domains(domain);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_follows_user ON channel_follows(user_id);
CREATE INDEX IF NOT EXISTS idx_channels_created_at ON channels(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);
CREATE INDEX IF NOT EXISTS idx_custom_emojis_name ON custom_emojis(name);
CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id, purpose);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_url);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_url);
CREATE INDEX IF NOT EXISTS idx_invitation_codes_created_by ON invitation_codes(created_by);
CREATE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key, status);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(kind, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_list_members_list ON list_members(list_id);
CREATE INDEX IF NOT EXISTS idx_lists_user ON lists(user_id);
CREATE INDEX IF NOT EXISTS idx_media_post ON media(post_id);
CREATE INDEX IF NOT EXISTS idx_media_url ON media(url);
CREATE INDEX IF NOT EXISTS idx_media_user ON media(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_miauth_created ON miauth_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_muted_words_user ON muted_words(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_outbox_deliveries_due ON outbox_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_deliveries_target ON outbox_deliveries(activity_id, inbox_url);
CREATE INDEX IF NOT EXISTS idx_pinned_posts_user ON pinned_posts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_poll_choices_poll ON poll_choices(poll_id, choice_index);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll_user ON poll_votes(poll_id, user_id);
CREATE INDEX IF NOT EXISTS idx_polls_post ON polls(post_id);
CREATE INDEX IF NOT EXISTS idx_posts_author_published ON posts(author_url, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_in_reply_to ON posts(in_reply_to);
CREATE INDEX IF NOT EXISTS idx_posts_local_published ON posts(is_local, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_quote_id ON posts(quote_id);
CREATE INDEX IF NOT EXISTS idx_proxy_cache_last_used ON proxy_cache(last_used_at);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id);
CREATE INDEX IF NOT EXISTS idx_reactions_user ON reactions(user_id);
CREATE INDEX IF NOT EXISTS idx_remote_blocks_blocked ON remote_blocks(blocked_actor_url);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_actor_url);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status ON scheduled_posts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_user ON user_blocks(user_id);
CREATE INDEX IF NOT EXISTS idx_user_mutes_user ON user_mutes(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

-- ==== トリガー（plpgsql 関数 + トリガー）====
CREATE OR REPLACE FUNCTION spica_posts_ad() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM posts_fts WHERE post_id = OLD.id;
    RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS posts_ad ON posts;
CREATE TRIGGER posts_ad AFTER DELETE ON posts FOR EACH ROW EXECUTE FUNCTION spica_posts_ad();

CREATE OR REPLACE FUNCTION spica_posts_ai() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO posts_fts(post_id, content) VALUES (NEW.id, NEW.content) ON CONFLICT (post_id) DO UPDATE SET content = EXCLUDED.content;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS posts_ai ON posts;
CREATE TRIGGER posts_ai AFTER INSERT ON posts FOR EACH ROW
  WHEN (NEW.fts_indexed = 1) EXECUTE FUNCTION spica_posts_ai();

CREATE OR REPLACE FUNCTION spica_posts_au() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM posts_fts WHERE post_id = OLD.id;
    INSERT INTO posts_fts(post_id, content) VALUES (NEW.id, NEW.content) ON CONFLICT (post_id) DO UPDATE SET content = EXCLUDED.content;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS posts_au ON posts;
CREATE TRIGGER posts_au AFTER UPDATE ON posts FOR EACH ROW
  WHEN (NEW.fts_indexed = 1) EXECUTE FUNCTION spica_posts_au();

