/**
 * 表示の好みを画面に効かせる。
 * 文字の大きさと行のつめ方は、CSS 側のトークンを差し替えて反映する
 * （<html data-size="normal" data-density="comfortable">）。
 */
import type { Prefs } from './settings';

export function applyDisplayPrefs(prefs: Prefs | null): void {
  const root = document.documentElement;
  const size = prefs?.fontSize;
  const density = prefs?.density;

  if (size === 'small' || size === 'large') root.dataset.size = size;
  else delete root.dataset.size;

  if (density === 'compact') root.dataset.density = 'compact';
  else delete root.dataset.density;
}
