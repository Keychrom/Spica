/**
 * 設定（/api/me/prefs）の現在値を、アプリで 1 つだけ持つ。
 *
 * 読み込みは App が 1 回行い、画面から変えたら publishPrefs で配る。
 * 投稿の既定・時刻の書式・メディアの扱いのように、部品の奥で使うものはここを見る
 * （毎回 /api/me/prefs を叩かないため）。
 */
import { useSyncExternalStore } from 'react';
import { savePrefs, type Prefs } from './settings';

let current: Prefs = {};
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  return current;
}

/** 読み込んだ / 保存した設定を配る */
export function publishPrefs(next: Prefs): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 部品から読む（設定が変わったら描き直される） */
export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}

/** 画面の操作から設定を書き換える（リアクションの履歴など） */
export async function updatePrefs(patch: Prefs): Promise<void> {
  const saved = await savePrefs(patch);
  if (saved) publishPrefs(saved);
}
