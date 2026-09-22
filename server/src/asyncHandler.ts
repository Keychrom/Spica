import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * 非同期ハンドラ用のラッパ（Express 4 用）。
 *
 * Express 4 は非同期ハンドラが reject しても拾わないため、そのままだと
 * unhandled rejection になりプロセスが落ちる。reject を `next(err)` に流して、
 * 既存のエラーミドルウェア（index.ts の `app.use((err, req, res, next) => ...)`）で扱う。
 *
 * ```ts
 * apiRouter.get('/timeline', asyncHandler(async (req, res) => { ... }));
 * ```
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
