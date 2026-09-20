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
