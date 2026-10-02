/**
 * API クライアント（薄いラッパ）
 *
 * これまで App.tsx の各所で `fetch()` を直に呼び、そのたびに
 * `Authorization: Bearer ...` を手で付けていた（139 か所）。トークンの在処と
 * エラーの見方を 1 か所に集めるのがこのファイルの役割。
 *
 * 担うのは 4 つだけ（機能追加はしない）:
 *   1. 認証ヘッダの付与（`setApiToken()` で渡されたトークン、無ければ localStorage）
 *   2. `AbortController`（`opts.signal` をそのまま fetch へ渡す）
 *   3. レスポンス本文の解析（JSON・空・非 JSON を 1 回だけ読んで使い回す）
 *   4. 共通の型（`ApiResult<T>`: ok / status / headers / data / error）
 *
 * 既存コードとの互換のため、`ApiResult` は Response の「いま使われている部分」
 * （`ok` / `status` / `headers` / `json()`）と同じ形で使えるようにしてある。
 * そのため移行は「fetch(...) の呼び出し式を差し替えるだけ」で済み、
 * `if (res.ok)` や `await res.json()` の側は書き換えなくてよい。
 */

let moduleToken: string | null | undefined;

/** 現在のトークンを渡す（App が authToken の変化に合わせて呼ぶ） */
export function setApiToken(token: string | null): void {
  moduleToken = token;
}

/** リクエストに使うトークン。未設定なら localStorage の既存キーを見る */
export function getApiToken(): string | null {
  if (moduleToken !== undefined) return moduleToken;
  try {
    return localStorage.getItem('spica_token') || localStorage.getItem('astrabit_token');
  } catch {
    return null;
  }
}

export interface ApiOptions {
  /** 明示指定（省略時は getApiToken()）。MiAuth 承認のように別のトークンを使う画面用 */
  token?: string | null;
  /** false で Authorization を付けない（未ログインでも叩ける公開エンドポイント用） */
  auth?: boolean;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface ApiResult<T = any> {
  ok: boolean;
  status: number;
  headers: Headers;
  /** 解析済みの本文（JSON でなければ null。本文が空でも null） */
  data: T | null;
  /** 非 2xx のときの本文（`if (!res.ok)` の中用。2xx では null） */
  error: any;
  /** 生の Response（本文は読み終わっているので blob などは取れない） */
  response: Response;
  /**
   * 従来の `Response.json()` と同じ厳しさで本文を返す。
   * 本文が空・非 JSON のときは例外（既存コードの catch がそのまま働く）。
   */
  json(): Promise<T>;
}

/** 素の Response が欲しいとき（ダウンロードの blob、ヘッダの直読みなど） */
export function apiFetch(
  path: string,
  init: RequestInit = {},
  opts: { token?: string | null; auth?: boolean } = {},
): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const token = opts.token !== undefined ? opts.token : getApiToken();
  if (opts.auth !== false && token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(path, { ...init, headers });
}

/** 本文の種類で Content-Type を決める（FormData のときは付けない = fetch に任せる） */
function encodeBody(body: unknown): { body: BodyInit | undefined; headers: Record<string, string> } {
  if (body === undefined || body === null) return { body: undefined, headers: {} };
  if (
    typeof body === 'string' ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer
  ) {
    return { body: body as BodyInit, headers: {} };
  }
  return { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
}

async function toResult<T>(res: Response): Promise<ApiResult<T>> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  let parsed: any = null;
  let parseError: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parseError = e;
    }
  }
  return {
    ok: res.ok,
    status: res.status,
    headers: res.headers,
    data: parsed as T | null,
    error: res.ok ? null : parsed,
    response: res,
    json: () => {
      if (parseError) return Promise.reject(parseError);
      if (!text) return Promise.reject(new SyntaxError('Unexpected end of JSON input'));
      return Promise.resolve(parsed as T);
    },
  };
}

export async function apiRequest<T = any>(
  method: string,
  path: string,
  body?: unknown,
  opts: ApiOptions = {},
): Promise<ApiResult<T>> {
  const encoded = encodeBody(body);
  const headers: Record<string, string> = { ...encoded.headers, ...(opts.headers || {}) };
  const token = opts.token !== undefined ? opts.token : getApiToken();
  if (opts.auth !== false && token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: encoded.body,
    signal: opts.signal,
  });
  return toResult<T>(res);
}

export const api = {
  get: <T = any>(path: string, opts?: ApiOptions) => apiRequest<T>('GET', path, undefined, opts),
  post: <T = any>(path: string, body?: unknown, opts?: ApiOptions) => apiRequest<T>('POST', path, body, opts),
  put: <T = any>(path: string, body?: unknown, opts?: ApiOptions) => apiRequest<T>('PUT', path, body, opts),
  delete: <T = any>(path: string, body?: unknown, opts?: ApiOptions) => apiRequest<T>('DELETE', path, body, opts),
  request: apiRequest,
  fetch: apiFetch,
};
