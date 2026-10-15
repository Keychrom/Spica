/**
 * リアルタイム更新のつなぎ込み（App を太らせないための小さなフック）。
 * ・ログインしている間だけ SSE をつなぐ
 * ・通知が届いたら未読を取り直す
 * ・**表示中のタイムラインに合わせてストリームを申告する**（`streams` が変わったら張り直す）
 */
import { useEffect, useState } from 'react';
import { openStream } from './streaming';

export function useLiveUpdates(
  signedIn: boolean,
  onNotification: () => void,
  streams: string[],
): boolean {
  const [live, setLive] = useState(false);
  // 配列は毎回新しくなるので、中身を 1 本の文字列にして「本当に変わったとき」だけ張り直す
  const key = streams.join(',');

  useEffect(() => {
    if (!signedIn) {
      setLive(false);
      return;
    }
    return openStream(setLive, key ? key.split(',') : []);
  }, [signedIn, key]);

  useEffect(() => {
    if (!signedIn) return;
    window.addEventListener('spica:stream-notification', onNotification);
    return () => window.removeEventListener('spica:stream-notification', onNotification);
  }, [signedIn, onNotification]);

  return live;
}
