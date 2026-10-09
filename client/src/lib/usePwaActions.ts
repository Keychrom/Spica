/**
 * PWA まわりの小さな配線（App を厚くしないための切り出し）。
 * ・ホーム画面のショートカット（?compose=1 / ?focus=search）と共有シート（?text=）から開かれたとき
 * ・アプリのアイコンに未読数を出す（対応端末だけ）
 */
import { useEffect } from 'react';
import { setAppBadge } from './pwa';

interface Handlers {
  onCompose: (content?: string) => void;
  onSearch: () => void;
}

export function useLaunchParams({ onCompose, onSearch }: Handlers): void {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const compose = params.get('compose') === '1';
    const focus = params.get('focus');
    const shared = [params.get('text'), params.get('url')].filter(Boolean).join(' ').trim();
    if (!compose && !focus && !shared) return;
    window.history.replaceState(null, '', window.location.pathname);
    if (focus === 'search') {
      onSearch();
      return;
    }
    onCompose(shared || undefined);
    // 起動時に一度だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function useAppBadge(count: number, active: boolean): void {
  useEffect(() => {
    setAppBadge(active ? count : 0);
  }, [count, active]);
}
