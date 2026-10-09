/**
 * まだ作っていない画面の置き場所。
 * 「無い」ではなく「次の段階で作る」と正直に伝える（＋どの段階かを書く）。
 */
import type { ReactNode } from 'react';
import ScreenHead from '../components/ScreenHead';
import { navigate } from '../lib/router';

interface PlaceholderViewProps {
  title: string;
  menuButton?: ReactNode;
  phase: string;
  note: string;
}

export default function PlaceholderView({ title, menuButton, phase, note }: PlaceholderViewProps) {
  return (
    <>
      <ScreenHead title={title} menuButton={menuButton} />
      <div className="divider" />
      <div className="placeholder">
        <p className="placeholder__phase">{phase}</p>
        <p className="placeholder__note">{note}</p>
        <button type="button" className="btn btn--quiet" onClick={() => navigate('/')}>
          ホームへ戻る
        </button>
      </div>
    </>
  );
}
