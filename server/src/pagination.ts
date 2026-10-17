import { Request, Response } from 'express';

/**
 * カーソルページネーション共通処理
 *
 * 一覧系 API は「配列をそのまま返す」既存のレスポンス形状を維持しつつ、
 * 続きがある場合のみ `X-Next-Cursor` レスポンスヘッダで次のカーソルを通知する。
 * （レスポンス形状を変えないため、古いクライアントでも壊れない）
 *
 * カーソルは「並び替えキー + 一意な ID」の組を base64url で包んだ不透明な文字列。
 * 単一時刻だけをカーソルにすると、同一時刻の行で取りこぼしや重複が起きるため、
 * 必ず ID との組で比較する。
 */

export interface PageCursor {
  /** 並び替えに使う時刻（published_at / created_at など） */
  at: string;
  /** 同時刻内での順序を確定させる一意な ID（posts.id など） */
  id: string;
}

export interface PageQuery {
  limit: number;
  cursor: PageCursor | null;
  /** カーソル文字列が不正だった場合のエラーメッセージ */
  error?: string;
}

/**
 * limit / cursor クエリを解釈する。cursor が不正な場合は error を返す。
 * （不正なカーソルで先頭ページを黙って返すと、クライアントが無限に同じページを
 *   読み続けてしまうため、呼び出し側で 400 を返すこと）
 */
export function parsePageQuery(req: Request, defaultLimit: number, maxLimit = 100): PageQuery {
  const rawLimit = parseInt(String(req.query.limit ?? ''), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, maxLimit) : defaultLimit;

  const rawCursor = req.query.cursor;
  if (rawCursor === undefined || rawCursor === '') {
    return { limit, cursor: null };
  }
  if (typeof rawCursor !== 'string') {
    return { limit, cursor: null, error: 'カーソルが不正です。' };
  }

  const cursor = decodeCursor(rawCursor);
  if (!cursor) {
    return { limit, cursor: null, error: 'カーソルが不正です。' };
  }
  return { limit, cursor };
}

export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): PageCursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separator = decoded.indexOf('|');
    if (separator <= 0) {
      return null;
    }
    const at = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (!at || !id) {
      return null;
    }
    return { at, id };
  } catch {
    return null;
  }
}

/**
 * 降順ページング用の WHERE 断片を返す。
 * 使用側は対応するパラメータ [cursor.at, cursor.at, cursor.id] をこの順で push する。
 * ORDER BY は `<sortColumn> DESC, <idColumn> DESC` と一致させること。
 */
export function cursorPredicate(sortColumn: string, idColumn: string): string {
  return `(${sortColumn} < ? OR (${sortColumn} = ? AND ${idColumn} < ?))`;
}

/**
 * 取得結果（limit + 1 件取得した想定）から、返却分を切り出して
 * 続きがある場合のみ X-Next-Cursor を設定する。
 *
 * カーソルは「返却した最後の行」から生成するため、enrich 処理で一部の行が
 * 除外されても取りこぼしは発生しない（除外された行は次ページ以降に進むだけ）。
 *
 * ※ 除外が多いと 1 ページが短くなる問題を直すには [[collectVisiblePage]] を使うこと
 */
export function applyPageHeaders<T extends object>(
  res: Response,
  rows: T[],
  limit: number,
  sortKey: string,
  idKey: string,
): T[] {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  res.setHeader('Access-Control-Expose-Headers', 'X-Next-Cursor');
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1] as Record<string, unknown>;
    const at = last[sortKey];
    const id = last[idKey];
    if (at != null && id != null) {
      res.setHeader('X-Next-Cursor', encodeCursor(String(at), String(id)));
    }
  }
  return page;
}

export interface VisiblePageResult<T> {
  items: T[];
  /** 続きがあるときだけ入る（無ければ null） */
  nextCursor: string | null;
}

/**
 * 表示できる行が `limit` 件そろうまで、続きを読み足して 1 ページを組む。
 *
 * ブロック・ミュート・ミュートワード・フォロワー限定の閲覧不可などは SQL の WHERE では
 * 表せず、`enrichAndFilterPosts` の後で分かる。先に `limit + 1` 件だけでカーソルを確定すると、
 * **除外が多いページは 1 ページが極端に短くなる（0 件にもなる）**ので、ここで読み足す。
 *
 * - カーソルは「最後に判定した行」の位置。読み捨てた行は次ページで読み直さない
 * - 並び順は `sortColumn DESC, idColumn DESC`（fetchRows 側の ORDER BY と一致させること）
 * - `filterRows` は順序を保つこと（並べ替えるとカーソルがずれる）
 * - 1 リクエストで読む行数には上限を置く（全部が除外される相手でも DB を読み続けない）。
 *   上限で打ち切ったときはカーソルを返すので、次のリクエストで続きから読める
 */
export async function collectVisiblePage<T extends object>(params: {
  limit: number;
  cursor: PageCursor | null;
  /** cursor より古い行を最大 n 件読む */
  fetchRows: (cursor: PageCursor | null, n: number) => Promise<T[]>;
  /** 表示できる行だけにする（順序は保つ） */
  filterRows: (rows: T[]) => Promise<T[]>;
  sortKey: string;
  idKey: string;
  /** 1 リクエストで判定する行数の上限。既定は max(200, limit * 4) */
  maxScanRows?: number;
}): Promise<VisiblePageResult<T>> {
  const { limit, sortKey, idKey } = params;
  const maxScanRows = params.maxScanRows ?? Math.max(200, limit * 4);
  const items: T[] = [];
  let scanCursor = params.cursor;
  let scanned = 0;
  let exhausted = false;

  while (items.length < limit && scanned < maxScanRows && !exhausted) {
    // ほしい件数 + 1 行読む（+1 は「まだ続きがあるか」の判定用で、判定には使わない）
    const take = Math.min(limit - items.length + 1, maxScanRows - scanned);
    const rows = await params.fetchRows(scanCursor, take);
    scanned += rows.length;
    if (rows.length < take) exhausted = true;
    if (rows.length === 0) break;

    // 返す枠に入る分だけ判定する（+1 の 1 行は次のリクエストで読み直す）
    const decideCount = Math.min(rows.length, limit - items.length);
    const toDecide = rows.slice(0, decideCount);
    const kept = await params.filterRows(toDecide);
    items.push(...kept);

    const last = toDecide[toDecide.length - 1] as Record<string, unknown>;
    const at = last?.[sortKey];
    const id = last?.[idKey];
    if (at == null || id == null) {
      // カーソルに使える位置が分からないときは、そこで打ち切る（取りこぼしより重複を避ける）
      return { items, nextCursor: null };
    }
    scanCursor = { at: String(at), id: String(id) };
  }

  // 読み切った（＝これ以上は無い）ときはカーソルを返さない。
  // 例外は「上限で打ち切った」ときで、そのときは続きから読めるようカーソルを返す
  const nextCursor = exhausted || !scanCursor ? null : encodeCursor(scanCursor.at, scanCursor.id);
  return { items, nextCursor };
}
