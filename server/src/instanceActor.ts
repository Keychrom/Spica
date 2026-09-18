import { db, getInstanceInfo } from './db.js';
import { config } from './config.js';
import { generateKeyPair, KeyPair } from './crypto.js';
import { ACTIVITYSTREAMS_CONTEXT } from './activitypub.js';

// インスタンス鍵保存用テーブルの確保
db.exec(`
  CREATE TABLE IF NOT EXISTS instance_actor (
    id TEXT PRIMARY KEY,
    public_key_pem TEXT NOT NULL,
    private_key_pem TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

/**
 * インスタンス Actor 専用の RSA 2048-bit キーペアを取得（無ければ初回自動生成）
 */
export function getInstanceActorKeyPair(): KeyPair {
  const row = db.prepare('SELECT * FROM instance_actor WHERE id = ?').get('instance') as {
    public_key_pem: string;
    private_key_pem: string;
  } | undefined;

  if (row) {
    return {
      publicKeyPem: row.public_key_pem,
      privateKeyPem: row.private_key_pem,
    };
  }

  console.log('[InstanceActor] Generating dedicated RSA 2048-bit keypair for instance actor...');
  const keyPair = generateKeyPair();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO instance_actor (id, public_key_pem, private_key_pem, created_at)
    VALUES (?, ?, ?, ?)
  `).run('instance', keyPair.publicKeyPem, keyPair.privateKeyPem, now);

  return keyPair;
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
