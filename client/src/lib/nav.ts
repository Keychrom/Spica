/**
 * ナビゲーションの定義（デスクトップの左ナビとモバイルのドロワーで同じ並びを使う）。
 * 画面が増えたら、ここに 1 行足すだけで両方に反映される。
 */
import {
  Bell,
  Bookmark,
  FileText,
  Hash,
  HardDrive,
  Home,
  List,
  Mail,
  Radio,
  Search,
  Settings,
  Shield,
} from 'lucide-react';

export type NavIcon = typeof Home;

export interface NavItem {
  path: string;
  label: string;
  icon: NavIcon;
  /** 未読バッジを出す項目（通知のみ） */
  badge?: 'notifications';
}

export const NAV_PRIMARY: NavItem[] = [
  { path: '/', label: 'ホーム', icon: Home },
  { path: '/notifications', label: '通知', icon: Bell, badge: 'notifications' },
  { path: '/search', label: '見つける', icon: Search },
  { path: '/messages', label: 'メッセージ', icon: Mail },
  { path: '/bookmarks', label: 'ブックマーク', icon: Bookmark },
];

export const NAV_COLLECTIONS: NavItem[] = [
  { path: '/lists', label: 'リスト', icon: List },
  { path: '/antennas', label: 'アンテナ', icon: Radio },
  { path: '/channels', label: 'チャンネル', icon: Hash },
  { path: '/drive', label: 'ドライブ', icon: HardDrive },
  { path: '/drafts', label: '下書き・予約', icon: FileText },
];

export const NAV_SYSTEM: NavItem[] = [
  { path: '/settings', label: '設定', icon: Settings },
];

/** 運営の項目（admin / moderate のときだけ出す） */
export const NAV_ADMIN: NavItem[] = [{ path: '/admin', label: '管理パネル', icon: Shield }];

export function canModerate(role: string | undefined): boolean {
  return role === 'admin' || role === 'moderate' || role === 'moderator';
}

/** 現在地に一致する項目（サブパスも含む） */
export function isActive(path: string, item: NavItem): boolean {
  if (item.path === '/') return path === '/' || path.startsWith('/?') || path.startsWith('/tags/');
  if (item.path === '/search') return path.startsWith('/search') || path.startsWith('/tags/');
  return path.startsWith(item.path);
}
