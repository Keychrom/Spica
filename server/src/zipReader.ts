import zlib from 'node:zlib';

/**
 * 最小限の ZIP 読み取り（エクスポート側の `archiver` の逆）
 *
 * 依存を増やさないため、Node 標準の `zlib` と自前の解析だけで実装する。
 * 中央ディレクトリ（EOCD）→ 各エントリの中央ディレクトリ → ローカルヘッダーの順に読み、
 * 実データは `zlib.inflateRawSync`（無圧縮ならそのまま）で取り出す。
 *
 * 安全のための約束:
 *   - **zip-slip 対策**: `..` / 絶対パス / ドライブ文字 / バックスラッシュ / 制御文字を含む名前は
 *     **拒否する**（例外にする）。このアプリのエクスポートは常に相対パスなので、正規の
 *     アーカイブが読めなくなることはない
 *   - **ZIP 爆弾対策**: 件数・1 件の展開後サイズ・合計サイズに上限を設ける。上限を超えた
 *     エントリは**読み飛ばして報告**する（取り込み全体は止めない。`skipped` に名前が入る）
 *   - ZIP64（4GB 超・6 万件超）には対応しない（出会ったら例外にして、黙って壊さない）
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

export interface ZipLimits {
  /** 読み込むエントリの最大数 */
  maxEntries: number;
  /** 1 エントリの最大サイズ（展開後） */
  maxEntryBytes: number;
  /** 全エントリの合計サイズ（展開後） */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxEntryBytes: 100 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

export interface ZipReadResult {
  /** 検証済みの相対パス → 中身（ディレクトリのエントリは含めない） */
  entries: Map<string, Buffer>;
  /** 上限・未対応の圧縮方式で読み飛ばしたエントリの名前（報告用） */
  skipped: string[];
}

/** ZIP の先頭シグネチャ（`PK\x03\x04`）を持つか */
export function isZipBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === SIG_LOCAL;
}

/**
 * 名前が安全か確かめる（危険なら例外にする）。
 * 正規のエクスポートは `media/<userId>/<file>` のような相対パスしか作らない。
 */
function assertSafePath(name: string): void {
  if (!name || name.length > 1000) {
    throw new Error('ZIP 内に不正なファイル名があります。');
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('ZIP 内のファイル名に制御文字が含まれています。');
  }
  if (name.includes('\\')) {
    throw new Error(`ZIP 内のファイル名に「\\」が含まれています: ${name}`);
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`ZIP 内に絶対パスが含まれています: ${name}`);
  }
  if (name.split('/').some((part) => part === '..')) {
    throw new Error(`ZIP 内に上位ディレクトリへの参照（..）が含まれています: ${name}`);
  }
}

/** 中央ディレクトリの終端（EOCD）の位置を探す（コメントは最大 65535 バイト） */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let pos = buffer.length - 22; pos >= min; pos--) {
    if (buffer.readUInt32LE(pos) === SIG_EOCD) return pos;
  }
  throw new Error('ZIP の終端（中央ディレクトリ）が見つかりませんでした。');
}

/**
 * ZIP の中身を読み出す。
 * 危険な名前（zip-slip）は例外、大きすぎる・未対応のエントリは `skipped` として報告する。
 */
export function readZipEntries(buffer: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipReadResult {
  const eocd = findEndOfCentralDirectory(buffer);
  const total = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  if (total === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error('ZIP64 形式のアーカイブは未対応です。');
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new Error('ZIP の中央ディレクトリが壊れています。');
  }

  const entries = new Map<string, Buffer>();
  const skipped: string[] = [];
  let totalBytes = 0;
  let pos = centralOffset;

  for (let i = 0; i < total; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new Error('ZIP の中央ディレクトリが壊れています。');
    }
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;

    // ディレクトリ自身のエントリは中身が無いので飛ばす
    if (name.endsWith('/')) continue;
    assertSafePath(name);

    if (entries.size >= limits.maxEntries) {
      skipped.push(name);
      continue;
    }
    // 展開する前に宣言サイズで弾く（ZIP 爆弾対策。ここで展開してはならない）
    if (uncompressedSize > limits.maxEntryBytes || totalBytes + uncompressedSize > limits.maxTotalBytes) {
      skipped.push(name);
      continue;
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`ZIP のローカルヘッダーが壊れています: ${name}`);
    }

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      throw new Error(`ZIP のデータが途中で切れています: ${name}`);
    }
    const raw = buffer.subarray(dataStart, dataEnd);

    let data: Buffer;
    if (method === 0) {
      data = raw; // 無圧縮
    } else if (method === 8) {
      try {
        // 宣言サイズが嘘でもメモリを食い潰さないよう、展開側でも上限を掛ける
        data = zlib.inflateRawSync(raw, { maxOutputLength: limits.maxEntryBytes });
      } catch {
        skipped.push(name); // 壊れている・大きすぎるエントリは飛ばす
        continue;
      }
    } else {
      skipped.push(name); // 対応していない圧縮方式（bzip2 など）
      continue;
    }

    if (data.length > limits.maxEntryBytes || totalBytes + data.length > limits.maxTotalBytes) {
      skipped.push(name);
      continue;
    }
    totalBytes += data.length;
    entries.set(name, data);
  }

  return { entries, skipped };
}
