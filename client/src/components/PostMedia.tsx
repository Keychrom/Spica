/**
 * ノートの添付（画像・動画・音声）。
 * ・動画と音声はその場で再生できる（動画は設定で「開いたら自動再生」「既定はミュート」を選べる）
 * ・画像は押すと大きく見られる（MediaViewer。複数あるときは ← → で送れる）
 * ・センシティブなノートは、設定「常にセンシティブを隠す」が入っていれば、いったん隠す
 * ⚠️ 種類は `mediaType` で見る（`type` ではない）。音声を画像として出すと再生できない
 */
import { useState } from 'react';
import type { Post } from '../lib/format';
import { isImageMedia, mediaAlt, mediaKind, mediaThumb } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import MediaViewer from './MediaViewer';

export default function PostMedia({ post }: { post: Post }) {
  const prefs = usePrefs();
  const media = post.media_attachments ?? post.attachments ?? [];
  const [revealed, setRevealed] = useState(false);
  /** 大きく見ている画像の位置（null なら閉じている） */
  const [viewing, setViewing] = useState<number | null>(null);
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

  // 大きく見られるのは画像だけ（動画と音声はその場で再生できる）
  const images = media.filter(isImageMedia);
  // 枚数で見た目を変える: 1 枚は大きく、5 枚以上は 3 列（2 列だと縦に伸びすぎる）
  const gridClass = `pics${media.length === 1 ? ' pics--one' : media.length >= 5 ? ' pics--many' : ''}`;

  return (
    <>
      <div className={gridClass}>
        {/* 上限まで全部出す（連合先の投稿は相手が付けた数だけ来るので、ここで切らない） */}
        {media.map((item, index) => {
          const key = `${item.url}-${index}`;
          const kind = mediaKind(item);

          // 🎵 音声はプレイヤーをそのまま出す（画像の枠や比率は当てない・自動再生はしない）
          if (kind === 'audio') {
            const label = mediaAlt(item) || item.name || '';
            return (
              <div className="pics__audio" key={key}>
                <audio className="pic pic--audio" src={item.url} controls preload="metadata" />
                {label && <span className="pics__audio-name">{label}</span>}
              </div>
            );
          }

          // 🎬 動画
          if (kind === 'video') {
            return (
              <video
                key={key}
                className="pic"
                src={item.url}
                poster={item.thumbnailUrl || item.thumbnail_url || undefined}
                controls
                loop
                playsInline
                preload="metadata"
                autoPlay={Boolean(prefs.autoPlayMedia)}
                muted={prefs.muteMediaByDefault !== false}
              />
            );
          }

          // 🖼 画像（押すと大きく見る）
          const imageIndex = images.findIndex((image) => image.url === item.url);
          const alt = mediaAlt(item);
          return (
            <button
              key={key}
              type="button"
              className="picbtn"
              onClick={() => setViewing(imageIndex)}
              aria-label={alt || '画像を大きく見る'}
              title={alt || '画像を大きく見る'}
            >
              <img className="pic" src={mediaThumb(item)} alt={alt} loading="lazy" />
            </button>
          );
        })}
      </div>

      {viewing !== null && (
        <MediaViewer media={images} startIndex={viewing} onClose={() => setViewing(null)} />
      )}
    </>
  );
}
