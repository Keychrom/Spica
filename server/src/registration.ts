/**
 * 承認制の登録モード（`registration_mode = 'approval'`）のサーバー側ロジック
 *
 * 方針:
 *   - 申請の時点で `users` 行を作る（ID を先に押さえる＝同じ ID の二重申請を防ぐ）。
 *     ただし `approval_status = 'pending'` の間は**ログインできず、公開の場所にも出さない**。
 *   - マスターキーは登録時（＝申請時）に一度だけ本人へ返す。承認後にログインするために必要。
 *   - 承認は `approved` にするだけ。却下は `rejected` にして理由を残す（行は消さない。
 *     申請者はログイン時に理由を見られる。ID を解放したいときは管理者がユーザーを削除する）。
 *
 * 関連: docs/REGISTRATION.md
 */
import { db } from './db.js';

export type ApprovalStatus = 'approved' | 'pending' | 'rejected';

/** 公開の場所（Actor 文書・WebFinger・ディレクトリ・件数・RSS・sitemap）に出してよいか */
export function isApprovedUser(user: { approval_status?: string | null } | undefined | null): boolean {
  // 列が無い古い行（マイグレーション直後）は承認済みとして扱う
  return !user || !user.approval_status || user.approval_status === 'approved';
}

/** 承認待ちの申請一覧（新しい順）。管理者向けに連絡先と申請メッセージを含める */
export async function listPendingRegistrations(): Promise<
  Array<{ id: string; name: string; summary: string; email: string; note: string; created_at: string }>
> {
  const rows = (await db
    .prepare(
      `SELECT id, name, summary, email, approval_note, created_at
       FROM users WHERE approval_status = 'pending'
       ORDER BY created_at DESC`,
    )
    .all()) as Array<{ id: string; name: string; summary: string; email?: string; approval_note?: string; created_at: string }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    summary: row.summary || '',
    email: row.email || '',
    note: row.approval_note || '',
    created_at: row.created_at,
  }));
}

/** 承認する。既に承認済みでも成功として扱う（二重クリックで壊れない） */
export async function approveRegistration(userId: string): Promise<boolean> {
  const user = (await db.prepare('SELECT id, approval_status FROM users WHERE id = ?').get(userId)) as
    | { id: string; approval_status?: string }
    | undefined;
  if (!user) return false;
  await db
    .prepare("UPDATE users SET approval_status = 'approved', approval_reason = '', approval_reviewed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), userId);
  return true;
}

/** 却下する（理由は申請者がログイン時に見る。空でもよい） */
export async function rejectRegistration(userId: string, reason: string): Promise<boolean> {
  const user = (await db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) as { id: string } | undefined;
  if (!user) return false;
  await db
    .prepare("UPDATE users SET approval_status = 'rejected', approval_reason = ?, approval_reviewed_at = ? WHERE id = ?")
    .run(String(reason || '').trim().slice(0, 500), new Date().toISOString(), userId);
  return true;
}

/** 承認待ちの件数（管理画面のバッジ用） */
export async function countPendingRegistrations(): Promise<number> {
  const row = (await db.prepare("SELECT COUNT(*) as c FROM users WHERE approval_status = 'pending'").get()) as { c: number };
  return Number(row.c) || 0;
}
