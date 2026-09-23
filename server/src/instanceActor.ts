import { db, getInstanceInfo } from './db.js';
import { config } from './config.js';
import { generateKeyPair, KeyPair } from './crypto.js';
import { ACTIVITYSTREAMS_CONTEXT } from './activitypub.js';

/**
 * インスタンス Actor の鍵はプロセス内で不変のシングルトンなので、
 * 起動時（initDatabase）に 1 度だけ読み込んでメモリに保持する。
 * 署名（署名ヘッダ・プロキシ URL）のように同期処理から参照されるため、
 * 参照側を async にせずに済ませるための設計。
 */
let cachedKeyPair: KeyPair | null = null;

/** インスタンス Actor 専用の RSA 2048-bit キーペアを読み込む（無ければ初回自動生成して保存） */
export async function loadInstanceActorKeyPair(): Promise<KeyPair> {
  if (cachedKeyPair) return cachedKeyPair;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS instance_actor (
      id TEXT PRIMARY KEY,
      public_key_pem TEXT NOT NULL,
      private_key_pem TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const row = await db.prepare('SELECT * FROM instance_actor WHERE id = ?').get('instance') as {
    public_key_pem: string;
    private_key_pem: string;
  } | undefined;

  if (row) {
    cachedKeyPair = {
      publicKeyPem: row.public_key_pem,
      privateKeyPem: row.private_key_pem,
    };
    return cachedKeyPair;
  }

  console.log('[InstanceActor] Generating dedicated RSA 2048-bit keypair for instance actor...');
  const keyPair = generateKeyPair();
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO instance_actor (id, public_key_pem, private_key_pem, created_at)
    VALUES (?, ?, ?, ?)
  `).run('instance', keyPair.publicKeyPem, keyPair.privateKeyPem, now);

  cachedKeyPair = keyPair;
  return keyPair;
}

/** 読み込み済みのインスタンス鍵（起動時の loadInstanceActorKeyPair が前提） */
export function getInstanceActorKeyPair(): KeyPair {
  if (!cachedKeyPair) {
    throw new Error('Instance actor keypair is not loaded yet (loadInstanceActorKeyPair must run at startup)');
  }
  return cachedKeyPair;
}

/**
 * Mastodon / Misskey 互換のインスタンス Actor JSON-LD を生成
 */
export function getInstanceActorJson() {
  const actorUrl = `${config.origin}/actor`;
  const keyPair = getInstanceActorKeyPair();
  const info = getInstanceInfo();

  let iconUrl = info.icon_url;
  if (iconUrl && !iconUrl.startsWith('http://') && !iconUrl.startsWith('https://')) {
    iconUrl = `${config.origin}${iconUrl.startsWith('/') ? '' : '/'}${iconUrl}`;
  }

  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: actorUrl,
    type: 'Application',
    preferredUsername: config.domain,
    name: info.name,
    summary: info.description,
    url: config.origin,
    inbox: `${config.origin}/inbox`,
    outbox: `${config.origin}/outbox`,
    icon: iconUrl ? {
      type: 'Image',
      mediaType: iconUrl.endsWith('.png') ? 'image/png' : (iconUrl.endsWith('.webp') ? 'image/webp' : 'image/jpeg'),
      url: iconUrl,
    } : undefined,
    endpoints: {
      sharedInbox: `${config.origin}/inbox`,
    },
    publicKey: {
      id: `${actorUrl}#main-key`,
      owner: actorUrl,
      publicKeyPem: keyPair.publicKeyPem,
    },
  };
}
