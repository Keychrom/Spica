/**
 * 投稿フォームのキーボード操作（Esc で閉じる / Ctrl+Enter で送信）。
 *
 * `onSubmit` は毎レンダー新しい関数を渡す前提で、依存に入れて**毎回張り直す**。
 * こうしないと、添付・アンケート・センシティブなどを変えた直後の Ctrl+Enter が
 * 古い state の submit を呼び、追加した内容が欠落する。
 */
import { useEffect } from 'react';

export function useComposerKeys(onSubmit: () => void, onClose: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') onSubmit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSubmit, onClose]);
}
