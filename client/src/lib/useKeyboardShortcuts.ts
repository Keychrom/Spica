/**
 * キーボードショートカット（設定「キーボードショートカットを使う」が入っているときだけ）。
 *   n … ノートを作成 / 検索へ / ? … 一覧 / g h・g l・g f … ホーム・ローカル・連合 / j k … 次のノート・前のノート
 */
import { useEffect, useState } from 'react';
import { usePrefs } from './prefs';
import { navigate } from './router';

function isTyping(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
}

/**
 * 画面に見えているノートを 1 つ送る（元の UI と同じ動き）。
 * 「上端にいるノート」を数えて、その次の 1 つ（j）／前の 1 つ（k）へ。
 */
function scrollToAdjacentPost(direction: 1 | -1): void {
  const cards = Array.from(document.querySelectorAll('.post')) as HTMLElement[];
  if (cards.length === 0) return;
  const threshold = 90;
  const tops = cards.map((card) => card.getBoundingClientRect().top);
  // 上端（しきい値より上）にあるノートの数 − 1 = いま見ているノート
  const current = tops.filter((top) => top <= threshold + 4).length - 1;
  const index = Math.min(cards.length - 1, Math.max(0, current + direction));
  cards[index].scrollIntoView({ block: 'start', behavior: 'smooth' });
}

export function useKeyboardShortcuts(onCompose: () => void): { helpOpen: boolean; closeHelp: () => void } {
  const prefs = usePrefs();
  const [helpOpen, setHelpOpen] = useState(false);
  const enabled = Boolean(prefs.keyboardShortcuts);

  useEffect(() => {
    if (!enabled) return;
    let pendingG = false;
    let timer = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      if (event.key === '?') {
        event.preventDefault();
        setHelpOpen((open) => !open);
        return;
      }
      if (event.key === 'n') {
        event.preventDefault();
        onCompose();
        return;
      }
      if (event.key === '/') {
        event.preventDefault();
        navigate('/search');
        return;
      }
      if (event.key === 'g') {
        pendingG = true;
        timer = window.setTimeout(() => {
          pendingG = false;
        }, 800);
        return;
      }
      if (pendingG && (event.key === 'h' || event.key === 'l' || event.key === 'f')) {
        pendingG = false;
        window.clearTimeout(timer);
        const mode = event.key === 'h' ? 'home' : event.key === 'l' ? 'local' : 'all';
        navigate('/');
        // ホーム画面が聞いていれば、その場でタブを切り替える
        window.dispatchEvent(new CustomEvent('spica:timeline-mode', { detail: { mode } }));
        return;
      }
      if (event.key === 'j' || event.key === 'k') scrollToAdjacentPost(event.key === 'j' ? 1 : -1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(timer);
    };
  }, [enabled, onCompose]);

  return { helpOpen, closeHelp: () => setHelpOpen(false) };
}
