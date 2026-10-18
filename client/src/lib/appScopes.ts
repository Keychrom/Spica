/**
 * MiAuth のスコープ表示（承認画面と設定のセッション一覧で使う）。
 * 判定はサーバー（server/src/appScopes.ts）が正。ここは日本語ラベルだけ。
 */
export const APP_SCOPE_LABELS: Record<string, string> = {
  read: '読み取り（タイムライン・投稿・プロフィールなど）',
  'write:notes': '投稿の作成・削除・編集、リアクション、投票、ブースト',
  'write:follows': 'フォロー・フォロー解除',
  'write:bookmarks': 'ブックマーク・ピン留め',
  'write:blocks': 'ミュート・ブロック',
  'write:drive': 'メディアのアップロード・削除',
  'write:messages': 'DM の送受信',
  'write:lists': 'リスト・アンテナの管理',
  'write:channels': 'チャンネルの作成・編集・フォロー',
  'write:profile': 'プロフィール・設定の変更',
  legacy: '旧トークン（通常の読み書きは可・安全操作は不可）',
};

export function scopeLabel(scope: string): string {
  return APP_SCOPE_LABELS[scope] || scope;
}

export function scopeLabels(scopes: string[] | undefined): string[] {
  return (scopes || []).map(scopeLabel);
}
