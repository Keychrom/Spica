/**
 * リアルタイム更新のつなぎ込み（App を太らせないための小さなフック）。
 * ・ログインしている間だけ SSE をつなぐ
 * ・通知が届いたら未読を取り直す
 */
import { useEffect, useState } from 'react';
import { openStream } from './streaming';

export function useLiveUpdates(signedIn: boolean, onNotification: () => void): boolean {
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!signedIn) {
      setLive(false);
      return;
    }
    return openStream(setLive);
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn) return;
    window.addEventListener('spica:stream-notification', onNotification);
    return () => window.removeEventListener('spica:stream-notification', onNotification);
  }, [signedIn, onNotification]);

  return live;
}
