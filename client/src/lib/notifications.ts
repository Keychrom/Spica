/**
 * 通知の型と、まとめ表示（同じ種類・同じ投稿が続いたら 1 件にまとめる）。
 * 表示の文言は NotificationsView 側に置く（ここは純関数だけ）。
 */
export interface AppNotification {
  id: string;
  type: string;
  actor_id?: string;
  actor_name?: string;
  actor_handle?: string;
  actor_icon?: string;
  /** リアクションの絵文字、アンテナ名、返信の本文など（種類による） */
  content?: string;
  post_id?: string;
  post_content?: string;
  created_at?: string;
  is_read?: boolean | number;
}

export interface NotificationGroup {
  key: string;
  items: AppNotification[];
}

/** まとめてよい種類（返信・メンションは 1 件ずつ読む意味があるのでまとめない） */
const GROUPABLE = new Set(['reaction', 'announce', 'renote', 'follow']);

export function groupNotifications(items: AppNotification[]): NotificationGroup[] {
  const groups: NotificationGroup[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    const sameKind =
      last &&
      GROUPABLE.has(item.type) &&
      last.items[0].type === item.type &&
      (last.items[0].post_id || '') === (item.post_id || '');
    if (sameKind) last.items.push(item);
    else groups.push({ key: item.id, items: [item] });
  }
  return groups;
}

export function isUnread(item: AppNotification): boolean {
  return !item.is_read;
}

/** 種類ごとの見出し（1 件のとき） */
export function notificationAction(type: string): string {
  switch (type) {
    case 'follow':
      return 'がフォローしました';
    case 'reaction':
      return 'がリアクションしました';
    case 'announce':
    case 'renote':
      return 'がリノートしました';
    case 'reply':
      return 'が返信しました';
    case 'mention':
      return 'がメンションしました';
    case 'dm':
      return 'からメッセージが届きました';
    case 'move':
      return 'が引っ越してきました';
    case 'report':
      return '通報が届きました';
    default:
      return 'からの通知';
  }
}

/**
 * 行為者を前に付けない種類の見出し（本人しか関わらない通知）。
 * 文字列を返したら「そのまま見出し」として使い、null なら
 * 「<b>行為者</b> が◯◯しました」の形で組み立てる。
 */
export function notificationHeadline(item: AppNotification): string | null {
  switch (item.type) {
    case 'login':
      return '新しい端末からログインしました';
    case 'antenna':
      // 本文にアンテナ名が入っている（「アンテナ「◯◯」に新しいノートが届きました」）
      return item.content || 'アンテナに新しいノートが届きました';
    case 'scheduled_published':
      return '予約したノートを公開しました';
    default:
      return null;
  }
}

/** 種類ごとのまとめ見出し（複数のとき） */
export function notificationGroupAction(type: string, count: number): string {
  switch (type) {
    case 'reaction':
      return `${count}人がリアクションしました`;
    case 'announce':
    case 'renote':
      return `${count}人がリノートしました`;
    case 'follow':
      return `${count}人がフォローしました`;
    default:
      return `${count}件の通知`;
  }
}
