/**
 * 入口（ログイン・新規登録・はじめての設定）の共通の枠。
 * ロゴと説明、中身、下の導線だけを持つ（画面ごとの差は children に入れる）。
 */
import type { ReactNode } from 'react';

interface AuthShellProps {
  lead: ReactNode;
  children?: ReactNode;
  foot?: ReactNode;
}

export default function AuthShell({ lead, children, foot }: AuthShellProps) {
  return (
    <div className="auth">
      <div className="auth__card">
        <div className="auth__brand">
          <span className="nav__mark" style={{ width: 30, height: 30, fontSize: 15 }}>
            ✦
          </span>
          <b>Spica</b>
        </div>
        <p className="auth__lead" style={{ whiteSpace: 'pre-wrap' }}>
          {lead}
        </p>
        {children}
        {foot && <div className="auth__foot">{foot}</div>}
      </div>
    </div>
  );
}
