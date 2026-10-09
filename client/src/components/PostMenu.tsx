/**
 * 投稿の「⋯」メニュー（自分の投稿: 編集・ピン留め・削除 / 他人の投稿: 通報）。
 * メニューと、そこから開く小さな画面（編集・通報・削除の確認）をここにまとめる。
 */
import { useState } from 'react';
import { deletePost, editPost, reportTarget, togglePin, REPORT_REASONS } from '../lib/postActions';
import type { Post } from '../lib/format';

interface PostMenuProps {
  post: Post;
  signedIn: boolean;
  /** 自分の投稿か（自分の投稿だけ編集・削除・ピン留めが出る） */
  isMine: boolean;
  /** 管理者は他人の投稿も削除できる */
  canModerate?: boolean;
}

export default function PostMenu({ post, signedIn, isMine, canModerate }: PostMenuProps) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<'menu' | 'edit' | 'report' | 'delete'>('menu');
  const [content, setContent] = useState(post.content || '');
  const [cw, setCw] = useState(post.cw || '');
  const [reason, setReason] = useState('spam');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  function close() {
    setOpen(false);
    setPane('menu');
    setErr('');
    setNotice('');
  }

  async function saveEdit() {
    setBusy(true);
    setErr('');
    const problem = await editPost(post, content, cw);
    setBusy(false);
    if (problem) {
      setErr(problem);
      return;
    }
    close();
  }

  async function remove() {
    setBusy(true);
    setErr('');
    const problem = await deletePost(post);
    setBusy(false);
    if (problem) {
      setErr(problem);
      return;
    }
    close();
  }

  async function runPin() {
    setBusy(true);
    setNotice('');
    const pinned = await togglePin(post);
    setBusy(false);
    if (pinned === null) {
      setErr('ピン留めを変えられませんでした（5 件までです）。');
      return;
    }
    setNotice(pinned ? 'ピン留めしました。' : 'ピン留めを外しました。');
    window.setTimeout(close, 900);
  }

  async function sendReport() {
    setBusy(true);
    setErr('');
    const problem = await reportTarget({ postId: post.id, category: reason, comment });
    setBusy(false);
    if (problem) {
      setErr(problem);
      return;
    }
    setNotice('通報を送りました。');
    window.setTimeout(close, 900);
  }

  if (!signedIn) return null;

  return (
    <>
      <button
        type="button"
        className="iconbtn"
        aria-label="その他"
        title="その他"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
          setPane('menu');
          setContent(post.content || '');
          setCw(post.cw || '');
        }}
      >
        ⋯
      </button>

      {open && (
        <div className="modal" onClick={close}>
          <div className="sheet" onClick={(event) => event.stopPropagation()}>
            <div className="sheet__head">
              <b>{pane === 'edit' ? '編集' : pane === 'report' ? '通報' : pane === 'delete' ? '削除' : 'その他'}</b>
              <button type="button" className="btn btn--text" onClick={close}>
                閉じる
              </button>
            </div>

            {pane === 'menu' && (
              <div className="sheet__body">
                <div className="menu">
                  {isMine && (
                    <>
                      <button type="button" className="menu__i" onClick={() => setPane('edit')}>
                        本文と注記を編集
                      </button>
                      <button type="button" className="menu__i" onClick={() => void runPin()}>
                        {post.is_pinned ? 'ピン留めを外す' : 'プロフィールにピン留め'}
                      </button>
                      <button type="button" className="menu__i menu__i--danger" onClick={() => setPane('delete')}>
                        削除する
                      </button>
                    </>
                  )}
                  {!isMine && (
                    <button type="button" className="menu__i" onClick={() => setPane('report')}>
                      通報する
                    </button>
                  )}
                  {!isMine && canModerate && (
                    <button type="button" className="menu__i menu__i--danger" onClick={() => setPane('delete')}>
                      運営として削除
                    </button>
                  )}
                </div>
                {err && <p className="set__err">{err}</p>}
                {notice && <p className="set__ok">{notice}</p>}
              </div>
            )}

            {pane === 'edit' && (
              <div className="sheet__body">
                <div className="set__form" style={{ maxWidth: 'none' }}>
                  <input
                    className="field"
                    value={cw}
                    placeholder="閲覧注意の注記（空なら見出しなし）"
                    onChange={(event) => setCw(event.target.value)}
                  />
                  <textarea
                    className="field"
                    rows={6}
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                  />
                </div>
                {err && <p className="set__err">{err}</p>}
              </div>
            )}

            {pane === 'edit' && (
              <div className="sheet__foot">
                <span className="sheet__count" />
                <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => void saveEdit()}>
                  {busy ? '保存しています…' : '保存する'}
                </button>
              </div>
            )}

            {pane === 'report' && (
              <>
                <div className="sheet__body">
                  <div className="set__form" style={{ maxWidth: 'none' }}>
                    <select className="field" value={reason} onChange={(event) => setReason(event.target.value)}>
                      {REPORT_REASONS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                    <textarea
                      className="field"
                      rows={3}
                      value={comment}
                      placeholder="くわしいことがあれば（任意）"
                      onChange={(event) => setComment(event.target.value)}
                    />
                  </div>
                  {err && <p className="set__err">{err}</p>}
                  {notice && <p className="set__ok">{notice}</p>}
                </div>
                <div className="sheet__foot">
                  <span className="sheet__count" />
                  <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => void sendReport()}>
                    {busy ? '送っています…' : '通報を送る'}
                  </button>
                </div>
              </>
            )}

            {pane === 'delete' && (
              <>
                <div className="sheet__body">
                  <p style={{ margin: 0, fontSize: 'var(--fs-ui)', color: 'var(--text-sub)' }}>
                    このノートを削除します。元には戻せません。
                  </p>
                  {err && <p className="set__err">{err}</p>}
                </div>
                <div className="sheet__foot">
                  <span className="sheet__count" />
                  <button type="button" className="btn btn--text" onClick={() => setPane('menu')}>
                    やめる
                  </button>
                  <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => void remove()}>
                    {busy ? '削除しています…' : '削除する'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
