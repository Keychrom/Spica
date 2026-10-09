/**
 * ログインしていない人が「ノートを作成」を押したときの案内。
 */
import { navigate } from '../lib/router';

export default function LoginNotice({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet__head">
          <b>ログインが必要です</b>
          <span className="sheet__esc">Esc</span>
        </div>
        <div className="sheet__body">
          <p style={{ margin: 0, fontSize: 'var(--fs-ui)', color: 'var(--text-sub)' }}>
            ノートを書くにはログインしてください。
          </p>
        </div>
        <div className="sheet__foot">
          <span className="sheet__count" />
          <button type="button" className="btn btn--solid" onClick={() => navigate('/login')}>
            ログイン
          </button>
        </div>
      </div>
    </div>
  );
}
