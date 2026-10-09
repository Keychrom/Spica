/**
 * PWA まわり（インストール導線とアプリのバッジ）。
 * `beforeinstallprompt` は読み込み時に一度しか飛ばないので、
 * ここで握っておいて、設定画面から `useInstallAvailable()` で見る。
 */
import { useSyncExternalStore } from 'react';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // 既定のミニバーは出さず、こちらのボタンから促す
    event.preventDefault();
    deferredPrompt = event as InstallPrompt;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    emit();
  });
}

/** インストールを促せるか */
export function canInstall(): boolean {
  return deferredPrompt !== null;
}

/** すでにアプリ（スタンドアロン）として開いているか */
export function isStandalone(): boolean {
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true
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
  return () => {
    listeners.delete(listener);
  };
}

/** 設定画面から「インストールできるか」を見る */
export function useInstallAvailable(): boolean {
  return useSyncExternalStore(subscribeInstall, canInstall, () => false);
}

/** アプリのアイコンに未読数を出す（対応端末のみ。失敗しても黙って続ける） */
export function setAppBadge(count: number): void {
  const nav = navigator as unknown as {
    setAppBadge?: (n: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) void nav.setAppBadge?.(count);
    else void nav.clearAppBadge?.();
  } catch {
    /* 未対応・権限なしは無視 */
  }
}
