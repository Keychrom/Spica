/**
 * 設定 → アカウント → API キー（Misskey 互換クライアント用）の API 呼び出し。
 * スコープの判定はサーバー（server/src/appScopes.ts）が正。
 */
import { api, messageOf } from './api';

export interface ApiKey {
  id: string;
  name: string;
  scopes: string[];
  created_at: string;
  expires_at: string;
}

export async function loadApiKeys(): Promise<ApiKey[]> {
  const res = await api.get('/api/api-keys');
  if (!res.ok || !res.data) return [];
  return (res.data as { keys?: ApiKey[] }).keys ?? [];
}

/** 発行できたらトークンを返す（二度と表示されないので、その場で控えてもらう） */
export async function createApiKey(
  name: string,
  scopes: string[],
): Promise<{ token?: string; expiresAt?: string; error?: string }> {
  const res = await api.post('/api/api-keys', { name, scopes });
  if (!res.ok) return { error: messageOf(res.data, 'API キーを発行できませんでした。') };
  const data = res.data as { token?: string; expires_at?: string } | null;
  return { token: data?.token, expiresAt: data?.expires_at };
}

export async function revokeApiKey(id: string): Promise<boolean> {
  return (await api.del('/api/api-keys/' + encodeURIComponent(id))).ok;
}
