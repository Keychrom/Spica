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

/**
 * 受信した HTTP リクエストの署名を検証
 */
export function verifyHttpSignature(params: {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer | string;
  publicKeyPem: string;
}): boolean {
  const sigHeader = params.headers['signature'];
  if (!sigHeader || typeof sigHeader !== 'string') {
    return false;
  }

  const parsed = parseSignatureHeader(sigHeader);
  if (!parsed) {
    return false;
  }

  // Digest ヘッダーの検証（ボディがある場合）
  if (params.rawBody && params.headers['digest']) {
    const expectedDigest = createDigest(params.rawBody);
    const actualDigest = String(params.headers['digest']).trim();
    const expectedHash = expectedDigest.replace(/^SHA-256=/i, '');
    const actualHash = actualDigest.replace(/^SHA-256=/i, '');
    if (expectedHash !== actualHash) {
      return false;
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

    if (hasMissingHeader) continue;

    const signingString = signingLines.join('\n');

    try {
      const verifier = crypto.createVerify('sha256');
      verifier.update(signingString);
      if (verifier.verify(params.publicKeyPem, parsed.signature, 'base64')) {
        return true;
      }
    } catch {
      // 試行失敗時は次の候補へ
    }
  }

  return false;
}
