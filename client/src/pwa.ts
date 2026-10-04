/**
 * PWA まわりの小さなヘルパー（インストール導線・アプリバッジ）
 *
 * `beforeinstallprompt` は**ページ読み込み時に一度だけ**飛ぶので、
 * 設定画面を開いた時点で拾おうとしても遅い。だから入口のモジュールで捕まえておき、
 * 使いたい場所（設定・ヘッダー）から `useInstallAvailable()` で見る。
 */

import { useSyncExternalStore } from 'react';

let deferredPrompt: any = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // 既定のミニバーは出さず、こちらのボタンから促す
    event.preventDefault();
    deferredPrompt = event;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    emit();
  });
}

/** インストールを促せるか（プロンプトを握れているか） */
export function canInstall(): boolean {
  return deferredPrompt !== null;
}

/** すでにアプリ（スタンドアロン）として開いているか */
export function isStandalone(): boolean {
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as any).standalone === true
    );
  } catch {
    return false;
  }
}

/** インストールのプロンプトを出す（承諾したら true） */
export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  try {
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice?.outcome === 'accepted') {
      deferredPrompt = null;
      emit();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** コンポーネントから「インストールできるか」を購読する */
export function useInstallAvailable(): boolean {
  return useSyncExternalStore(subscribeInstall, canInstall, () => false);
}

/**
 * アプリのアイコンに未読数を出す（対応端末のみ。失敗しても黙って続ける）。
 * 0 のときはバッジを消す。
 */
export function setAppBadge(count: number): void {
  const nav = navigator as any;
  try {
    if (count > 0) {
      void nav.setAppBadge?.(count);
    } else {
      void nav.clearAppBadge?.();
    }
  } catch {
    // 未対応・権限なしは無視
  }
}
