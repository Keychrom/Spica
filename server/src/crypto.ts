import crypto from 'node:crypto';

export interface KeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

/**
 * RSA 2048bit の公開鍵・秘密鍵ペアを生成
 */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
  };
}

/**
 * リクエストボディの SHA-256 Digest ヘッダー値を計算
 */
export function createDigest(body: string | Buffer): string {
  const hash = crypto.createHash('sha256').update(body).digest('base64');
  return `SHA-256=${hash}`;
}

export interface SignOptions {
  method: string;
  url: string;
  body?: string;
  keyId: string;
  privateKeyPem: string;
}

/**
 * 送信用 HTTP リクエストヘッダーに HTTP Signature を付与
 */
export function signHeaders(options: SignOptions): Record<string, string> {
  const parsedUrl = new URL(options.url);
  // ポート80/443のデフォルトポートは除去して正規化
  const isDefaultPort = (parsedUrl.protocol === 'http:' && parsedUrl.port === '80') ||
                        (parsedUrl.protocol === 'https:' && parsedUrl.port === '443') ||
                        !parsedUrl.port;
  const host = isDefaultPort ? parsedUrl.hostname : parsedUrl.host;
  const path = parsedUrl.pathname + parsedUrl.search;
  const date = new Date().toUTCString();
  const contentType = 'application/activity+json';

  const headersToSign: Record<string, string> = {
    '(request-target)': `${options.method.toLowerCase()} ${path}`,
    host: host,
    date: date,
  };

  if (options.body) {
    headersToSign['digest'] = createDigest(options.body);
    headersToSign['content-type'] = contentType;
  }

  const headerNames = Object.keys(headersToSign);
  const signingString = headerNames
    .map((name) => `${name}: ${headersToSign[name]}`)
    .join('\n');

  const signer = crypto.createSign('sha256');
  signer.update(signingString);
  const signature = signer.sign(options.privateKeyPem, 'base64');

  const signatureHeader = `keyId="${options.keyId}",algorithm="rsa-sha256",headers="${headerNames.join(' ')}",signature="${signature}"`;

  const headers: Record<string, string> = {
    Host: host,
    Date: date,
    Signature: signatureHeader,
  };

  if (options.body) {
    headers['Digest'] = headersToSign['digest'];
    headers['Content-Type'] = contentType;
  }

  return headers;
}

export interface ParsedSignature {
  keyId: string;
  algorithm: string;
  headers: string[];
  signature: string;
}

/**
 * Signature ヘッダー文字列をパース
 */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  const result: Partial<ParsedSignature> = {};
  // key="value" または key=value のパターンを堅牢に抽出
  const regex = /([a-zA-Z]+)=(?:"([^"]*)"|([^\s,]+))/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(header)) !== null) {
    const key = match[1];
    const value = match[2] !== undefined ? match[2] : match[3];
    if (key === 'keyId') result.keyId = value;
    else if (key === 'algorithm') result.algorithm = value;
    else if (key === 'headers') result.headers = value.split(/\s+/).filter(Boolean);
    else if (key === 'signature') result.signature = value;
  }

  if (!result.keyId || !result.signature) {
    return null;
  }

  return {
    keyId: result.keyId,
    algorithm: result.algorithm || 'rsa-sha256',
    headers: result.headers || ['date'],
    signature: result.signature,
  };
}

export interface SignatureVerificationOptions {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer | string;
  publicKeyPem: string;
  /** ボディ付きリクエストで digest ヘッダーの署名を必須にする */
  requireDigest?: boolean;
  /** Date ヘッダーの許容幅（秒）。0 または未指定なら鮮度チェックを行わない */
  maxAgeSeconds?: number;
  /**
   * 追加の host 候補（設定上の公開ドメインなど）。
   * Cloudflare Tunnel 等のリバースプロキシは Host ヘッダーをローカルオリジンに
   * 書き換えるため、署名された公開ドメインを復元するために必要。
   */
  extraHostCandidates?: string[];
}

export interface SignatureVerificationResult {
  valid: boolean;
  reason?: string;
}

function sha256Of(body: Buffer | string): { base64: string; hex: string } {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const hash = crypto.createHash('sha256').update(buf);
  const base64 = hash.digest('base64');
  const hex = crypto.createHash('sha256').update(buf).digest('hex');
  return { base64, hex };
}

/**
 * Digest ヘッダー値がボディの SHA-256 と一致するか検証（base64 / hex 両対応）
 */
function digestMatches(body: Buffer | string, headerValue: string): boolean {
  const trimmed = headerValue.trim();
  const eqIndex = trimmed.indexOf('=');
  if (eqIndex < 0) {
    return false;
  }
  const algorithm = trimmed.slice(0, eqIndex).trim().toLowerCase();
  const value = trimmed.slice(eqIndex + 1).trim();
  if (algorithm !== 'sha-256' && algorithm !== 'sha256') {
    // 未対応アルゴリズムは検証不能のため拒否
    return false;
  }
  const { base64, hex } = sha256Of(body);
  return value === base64 || value.toLowerCase() === hex;
}

/**
 * 受信した HTTP リクエストの署名を検証（後方互換の真偽値 API）
 */
export function verifyHttpSignature(params: SignatureVerificationOptions): boolean {
  return verifyHttpSignatureDetailed(params).valid;
}

/**
 * 受信した HTTP リクエストの署名を検証し、失敗理由付きで結果を返す
 */
export function verifyHttpSignatureDetailed(params: SignatureVerificationOptions): SignatureVerificationResult {
  const sigHeader = params.headers['signature'];
  if (!sigHeader || typeof sigHeader !== 'string') {
    return { valid: false, reason: 'Signature header missing' };
  }

  const parsed = parseSignatureHeader(sigHeader);
  if (!parsed) {
    return { valid: false, reason: 'Malformed Signature header' };
  }

  const signedHeaders = parsed.headers.map((name) => name.toLowerCase());

  // (request-target) は必須。他のエンドポイントへ署名を転用されるのを防ぐ
  if (!signedHeaders.includes('(request-target)')) {
    return { valid: false, reason: '(request-target) is not covered by the signature' };
  }

  // ボディ完全性: digest ヘッダーが署名対象に含まれ、実ボディと一致することを必須にする
  const rawBody = params.rawBody;
  if (rawBody !== undefined && rawBody.length > 0) {
    if (params.requireDigest && !signedHeaders.includes('digest')) {
      return { valid: false, reason: 'digest header is not covered by the signature' };
    }
    const digestHeader = params.headers['digest'];
    if (digestHeader !== undefined) {
      const digestValue = Array.isArray(digestHeader) ? digestHeader[0] : String(digestHeader);
      if (!digestMatches(rawBody, digestValue)) {
        return { valid: false, reason: 'Digest header does not match the request body' };
      }
    } else if (params.requireDigest) {
      return { valid: false, reason: 'Digest header missing for a request with a body' };
    }
  }

  // Date の鮮度検証（リプレイ防止）。署名対象に含まれている場合のみ意味を持つ
  if (params.maxAgeSeconds && params.maxAgeSeconds > 0 && signedHeaders.includes('date')) {
    const dateHeader = params.headers['date'];
    const dateValue = Array.isArray(dateHeader) ? dateHeader[0] : dateHeader;
    if (!dateValue) {
      return { valid: false, reason: 'date header is signed but missing' };
    }
    const signedAt = Date.parse(String(dateValue));
    if (Number.isNaN(signedAt)) {
      return { valid: false, reason: 'date header is not a valid HTTP date' };
    }
    if (Math.abs(Date.now() - signedAt) > params.maxAgeSeconds * 1000) {
      return { valid: false, reason: 'date header is outside the allowed clock skew' };
    }
  }

  // 候補となる host 値リスト（Cloudflare Tunnel等のリバースプロキシを考慮）
  const candidateHosts: string[] = [];
  if (params.headers['x-forwarded-host']) {
    candidateHosts.push(String(params.headers['x-forwarded-host']));
  }
  if (params.headers['host']) {
    candidateHosts.push(String(params.headers['host']));
    const noPort = String(params.headers['host']).replace(/:\d+$/, '');
    if (!candidateHosts.includes(noPort)) candidateHosts.push(noPort);
  }
  // プロキシが Host ヘッダーを書き換える構成では、受信した Host が署名時の値と
  // 一致しないため、設定上の公開ドメインも候補として検証する
  for (const extra of params.extraHostCandidates || []) {
    if (extra && !candidateHosts.includes(extra)) {
      candidateHosts.push(extra);
    }
  }

  let missingSignedHeader = false;

  // candidateHosts のそれぞれで署名文字列を組み立てて検証を試行
  for (const hostCandidate of (candidateHosts.length > 0 ? candidateHosts : [''])) {
    const signingLines: string[] = [];
    let hasMissingHeader = false;

    for (const headerName of parsed.headers) {
      const lowerName = headerName.toLowerCase();
      if (lowerName === '(request-target)') {
        signingLines.push(`(request-target): ${params.method.toLowerCase()} ${params.path}`);
      } else if (lowerName === 'host') {
        signingLines.push(`host: ${hostCandidate || params.headers['host'] || ''}`);
      } else {
        const val = params.headers[lowerName];
        if (val === undefined) {
          hasMissingHeader = true;
          break;
        }
        const headerVal = Array.isArray(val) ? val.join(', ') : val;
        signingLines.push(`${lowerName}: ${headerVal}`);
      }
    }

    if (hasMissingHeader) {
      missingSignedHeader = true;
      continue;
    }

    const signingString = signingLines.join('\n');

    try {
      const verifier = crypto.createVerify('sha256');
      verifier.update(signingString);
      if (verifier.verify(params.publicKeyPem, parsed.signature, 'base64')) {
        return { valid: true };
      }
    } catch {
      // 試行失敗時は次の候補へ
    }
  }

  if (missingSignedHeader) {
    return { valid: false, reason: 'A header covered by the signature is missing from the request' };
  }

  return { valid: false, reason: 'Signature does not verify against the public key' };
}
