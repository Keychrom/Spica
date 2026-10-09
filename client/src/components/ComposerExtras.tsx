/**
 * ノートを作成の追加部分（添付とアンケート）。
 * 状態は Composer が持ち、ここは見た目と操作だけ。
 */
import { useEffect, useRef, useState } from 'react';
import { ImagePlus, ListPlus, Smile, X } from 'lucide-react';
import {
  MAX_ATTACHMENTS,
  isVideoAttachment,
  loadCustomEmojis,
  uploadMedia,
  type Attachment,
  type CustomEmoji,
} from '../lib/media';

export interface PollDraft {
  choices: string[];
  multiple: boolean;
  /** 締切までの時間（秒）。0 なら締め切らない */
  expiresIn: number;
}

const EXPIRY = [
  { value: 1800, label: '30分' },
  { value: 3600, label: '1時間' },
  { value: 21600, label: '6時間' },
  { value: 86400, label: '1日' },
  { value: 604800, label: '7日' },
  { value: 0, label: '締め切らない' },
];

interface Props {
  /** 本文のカーソル位置に :name: を入れる（Composer がやる） */
  onInsertEmoji: (name: string) => void;
  media: Attachment[];
  onChangeMedia: (next: Attachment[]) => void;
  poll: PollDraft | null;
  onChangePoll: (next: PollDraft | null) => void;
  disabled?: boolean;
}

export default function ComposerExtras({
  onInsertEmoji,
  media,
  onChangeMedia,
  poll,
  onChangePoll,
  disabled,
}: Props) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojis, setEmojis] = useState<CustomEmoji[]>([]);

  useEffect(() => {
    if (!emojiOpen || emojis.length > 0) return;
    void (async () => setEmojis(await loadCustomEmojis()))();
  }, [emojiOpen, emojis.length]);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function pick(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setErr('');
    const { media: uploaded, error } = await uploadMedia(Array.from(files));
    setBusy(false);
    if (error) {
      setErr(error);
      return;
    }
    onChangeMedia([...media, ...uploaded.map((item) => ({
      url: item.url,
      mediaType: item.mediaType || 'image/png',
      name: item.name || 'ファイル',
      thumbnailUrl: item.thumbnailUrl,
      size: item.size,
      width: item.width,
      height: item.height,
    }))].slice(0, MAX_ATTACHMENTS));
  }

  function setChoice(index: number, value: string) {
    if (!poll) return;
    const choices = poll.choices.map((choice, i) => (i === index ? value : choice));
    onChangePoll({ ...poll, choices });
  }

  return (
    <div className="extra">
      <div className="extra__tools">
        <button
          type="button"
          className="btn btn--text"
          disabled={disabled || busy || media.length >= MAX_ATTACHMENTS}
          onClick={() => fileRef.current?.click()}
        >
          <ImagePlus size={15} strokeWidth={1.6} />
          {busy ? '上げています…' : '画像・動画'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          hidden
          onChange={(event) => void pick(event.target.files)}
        />

        <button type="button" className="btn btn--text" onClick={() => setEmojiOpen((open) => !open)}>
          <Smile size={15} strokeWidth={1.6} />
          絵文字
        </button>

        {poll ? (
          <button type="button" className="btn btn--text" onClick={() => onChangePoll(null)}>
            <ListPlus size={15} strokeWidth={1.6} />
            アンケートをやめる
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--text"
            disabled={disabled}
            onClick={() => onChangePoll({ choices: ['', ''], multiple: false, expiresIn: 86400 })}
          >
            <ListPlus size={15} strokeWidth={1.6} />
            アンケート
          </button>
        )}
      </div>

      {emojiOpen && (
        <div className="emoji-pop">
          {emojis.length === 0 && (
            <span className="set__hint">
              このサーバーにはカスタム絵文字がありません（登録すると本文に入れられます）。
            </span>
          )}
          <div className="emoji-pop__list">
            {emojis.map((emoji) => (
              <button
                key={emoji.id}
                type="button"
                className="emoji-pop__item"
                title={emoji.name}
                onClick={() => {
                  onInsertEmoji(emoji.name);
                  setEmojiOpen(false);
                }}
              >
                <img src={emoji.url} alt={emoji.name} />
              </button>
            ))}
          </div>
        </div>
      )}

      {err && <p className="set__err">{err}</p>}

      {media.length > 0 && (
        <div className="extra__media">
          {media.map((item, index) => (
            <figure className="extra__thumb" key={item.url + index}>
              {isVideoAttachment(item) ? (
                <span className="extra__play">▶</span>
              ) : (
                <img src={item.thumbnailUrl || item.url} alt="" />
              )}
              <input
                className="extra__alt"
                value={item.description || ''}
                placeholder="ALT（説明）"
                onChange={(event) =>
                  onChangeMedia(
                    media.map((m, i) => (i === index ? { ...m, description: event.target.value } : m)),
                  )
                }
              />
              <button
                type="button"
                className="extra__x"
                aria-label="添付を外す"
                onClick={() => onChangeMedia(media.filter((_, i) => i !== index))}
              >
                <X size={13} strokeWidth={2} />
              </button>
            </figure>
          ))}
        </div>
      )}

      {poll && (
        <div className="extra__poll">
          {poll.choices.map((choice, index) => (
            <div className="extra__choice" key={index}>
              <input
                className="field"
                value={choice}
                placeholder={`選択肢 ${index + 1}`}
                onChange={(event) => setChoice(index, event.target.value)}
              />
              {poll.choices.length > 2 && (
                <button
                  type="button"
                  className="btn btn--text"
                  onClick={() =>
                    onChangePoll({ ...poll, choices: poll.choices.filter((_, i) => i !== index) })
                  }
                >
                  外す
                </button>
              )}
            </div>
          ))}
          <div className="extra__opts">
            {poll.choices.length < 5 && (
              <button
                type="button"
                className="btn btn--text"
                onClick={() => onChangePoll({ ...poll, choices: [...poll.choices, ''] })}
              >
                ＋ 選択肢を足す
              </button>
            )}
            <label className="extra__check">
              <input
                type="checkbox"
                checked={poll.multiple}
                onChange={(event) => onChangePoll({ ...poll, multiple: event.target.checked })}
              />
              複数選べる
            </label>
            <label className="extra__check">
              締切
              <select
                className="field"
                value={poll.expiresIn}
                onChange={(event) => onChangePoll({ ...poll, expiresIn: Number(event.target.value) })}
              >
                {EXPIRY.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
