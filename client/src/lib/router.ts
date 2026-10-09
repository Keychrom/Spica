/**
 * 小さなルーター。
 * 依存を増やさず、URL 契約（/, /notifications, /tags/:tag, /users/:id …）を守るために
 * pushState + popstate だけを使う。画面側は usePath() で現在地を受け取る。
 */
import { useEffect, useState } from 'react';

const NAVIGATE_EVENT = 'spica:navigate';

export function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function navigate(to: string, options: { replace?: boolean; keepScroll?: boolean } = {}): void {
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT));
  if (!options.keepScroll) window.scrollTo({ top: 0 });
}

/** アプリ内のリンクを捕まえて pushState に回す（<a href> を素直に書ける） */
export function useLinkInterceptor(): void {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (!href.startsWith('/') || anchor.getAttribute('target')) return;
      event.preventDefault();
      navigate(href);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
}

export function usePath(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const update = () => setPath(currentPath());
    window.addEventListener('popstate', update);
    window.addEventListener(NAVIGATE_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAVIGATE_EVENT, update);
    };
  }, []);
  return path;
}
