/**
 * ノートの添付（画像・動画）。
 * ・動画はその場で再生できる（設定で「開いたら自動再生」「既定はミュート」を選べる）
 * ・センシティブなノートは、設定「常にセンシティブを隠す」が入っていれば、いったん隠す
 */
import { useState } from 'react';
import type { Post } from '../lib/format';
import { usePrefs } from '../lib/prefs';

export default function PostMedia({ post }: { post: Post }) {
  const prefs = usePrefs();
  const media = post.media_attachments ?? post.attachments ?? [];
  const [revealed, setRevealed] = useState(false);
  if (media.length === 0) return null;

  const veiled = Boolean(post.is_sensitive) && Boolean(prefs.alwaysHideSensitive) && !revealed;
  if (veiled) {
    return (
      <button type="button" className="pics pics--veiled" onClick={() => setRevealed(true)}>
        <span className="pics__veil">
          センシティブな添付（{media.length} 件）
          <em>押すと表示します</em>
        </span>
      </button>
    );
  }

  return (
    <div className={`pics${media.length === 1 ? ' pics--one' : ''}`}>
      {media.slice(0, 4).map((item, index) => {
        const isVideo = String(item.type || '').startsWith('video');
        if (isVideo) {
          return (
            <video
              key={`${item.url}-${index}`}
              className="pic"
              src={item.url}
              poster={item.thumbnail_url}
              controls
              loop
              playsInline
              preload="metadata"
              autoPlay={Boolean(prefs.autoPlayMedia)}
              muted={prefs.muteMediaByDefault !== false}
            />
          );
        }
        return (
          <img
            key={`${item.url}-${index}`}
            className="pic"
            src={item.thumbnail_url || item.url}
            alt={item.alt || ''}
            loading="lazy"
          />
        );
      })}
    </div>
  );
}
