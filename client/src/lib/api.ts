/**
 * API クライアント（薄いラッパ）。
 *
 * 担うのは 4 つだけ:
 *  1. 認証ヘッダの付与（トークンの在処を 1 か所にする）
 *  2. AbortController（呼び出し側が signal を渡す）
 *  3. JSON の型付けと、204 / 空応答の扱い
 *  4. 401 の検出（呼び出し側でログアウトに使う）
 *
 * サーバーの API の形は変えない（クライアントの都合でサーバーを触らない）。
 */

const TOKEN_KEY = 'spica_token';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* localStorage が使えない環境ではメモリだけ（この実装では未対応） */
  }
}

export interface ApiResult {
  ok: boolean;
  status: number;
  headers: Headers;
  /** 本文が空・非 JSON のときは null */
  data: unknown;
}

interface RequestOptions {
  auth?: boolean;
  signal?: AbortSignal;
  body?: unknown;
}

async function request(method: string, path: string, options: RequestOptions = {}): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (options.auth !== false && token) {
    headers.Authorization = `Bearer ${token}`;
  }
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (typeof FormData !== 'undefined' && options.body instanceof FormData) {
      // ファイルのアップロード。**JSON にしてはいけない**（そのまま送ると本文が `{}` になり、
      // サーバーには「ファイルがありません」と見える）。Content-Type も付けない
      // （multipart の境界はブラウザが決める）
      body = options.body;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
  }

  const res = await fetch(path, { method, headers, body, signal: options.signal });
  let data: unknown = null;
  if (res.status !== 204) {
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
  }
  return { ok: res.ok, status: res.status, headers: res.headers, data };
}

export const api = {
  get: (path: string, options?: RequestOptions) => request('GET', path, options),
  post: (path: string, body?: unknown, options?: RequestOptions) =>
    request('POST', path, { ...options, body }),
  put: (path: string, body?: unknown, options?: RequestOptions) =>
    request('PUT', path, { ...options, body }),
  del: (path: string, options?: RequestOptions) => request('DELETE', path, options),
};

export function messageOf(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'error' in data) {
    const err = (data as { error?: unknown }).error;
    if (typeof err === 'string' && err) return err;
  }
  return fallback;
}
