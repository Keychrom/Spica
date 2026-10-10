/**
 * 画像を大きく見る（オーバーレイ）。
 *
 * ・押した画像から開き、複数あるときは ← → で送れる
 * ・閉じる: 右上の ×、背景を押す、Esc
 * ・動画はその場で再生できるので、ここには入れない（画像だけ）
 */
import { useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import type { PostMedia as Media } from '../lib/format';

interface MediaViewerProps {
  media: Media[];
  /** 最初に開く画像の位置 */
  startIndex: number;
  onClose: () => void;
}

export default function MediaViewer({ media, startIndex, onClose }: MediaViewerProps) {
  const [index, setIndex] = useState(startIndex);
  const current = media[index];
  const many = media.length > 1;

  const step = (delta: number) => setIndex((i) => (i + delta + media.length) % media.length);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && many) step(-1);
      if (event.key === 'ArrowRight' && many) step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, many, media.length]);

  if (!current) return null;

  return (
    <div className="viewer" role="dialog" aria-modal="true" onClick={onClose}>
      <button type="button" className="viewer__close" onClick={onClose} aria-label="閉じる" title="閉じる（Esc）">
        <X size={20} strokeWidth={1.7} />
      </button>

      {many && (
        <>
          <button
            type="button"
            className="viewer__nav viewer__nav--prev"
            onClick={(event) => {
              event.stopPropagation();
              step(-1);
            }}
            aria-label="前の画像"
          >
            <ChevronLeft size={22} strokeWidth={1.7} />
          </button>
          <button
            type="button"
            className="viewer__nav viewer__nav--next"
            onClick={(event) => {
              event.stopPropagation();
              step(1);
            }}
            aria-label="次の画像"
          >
            <ChevronRight size={22} strokeWidth={1.7} />
          </button>
        </>
      )}

      <figure className="viewer__body" onClick={(event) => event.stopPropagation()}>
        <img src={current.url} alt={current.alt || ''} />
        {(current.alt || many) && (
          <figcaption className="viewer__cap">
            {current.alt}
            {many && <span className="viewer__count">{index + 1} / {media.length}</span>}
          </figcaption>
        )}
      </figure>
    </div>
  );
}
