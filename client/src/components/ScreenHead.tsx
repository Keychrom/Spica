/**
 * 画面の見出し（題＝セリフ + 件数 + タブ + 新着 + リロード）。
 * 上部の操作はサイドバーと同じ言語（角丸 10・淡い塗り・影なし）で描く。
 */
import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

export interface ScreenTab {
  value: string;
  label: string;
}

interface ScreenHeadProps {
  title: string;
  sub?: string;
  tabs?: ScreenTab[];
  activeTab?: string;
  onTab?: (value: string) => void;
  newCount?: number;
  onShowNew?: () => void;
  onReload?: () => void;
  reloading?: boolean;
  /** モバイルの左上に出るアバター（メニュー） */
  menuButton?: ReactNode;
  right?: ReactNode;
}

export default function ScreenHead({
  title,
  sub,
  tabs,
  activeTab,
  onTab,
  newCount = 0,
  onShowNew,
  onReload,
  reloading,
  menuButton,
  right,
}: ScreenHeadProps) {
  return (
    <>
      <div className="head">
        {menuButton}
        <h1>{title}</h1>
        {sub && <span className="head__sub">{sub}</span>}
        {right && <span className="head__right">{right}</span>}
      </div>
      {(tabs || onReload || newCount > 0) && (
        <div className="headrow">
          {tabs && (
            <div className="seg">
              {tabs.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  className={`seg__t${activeTab === tab.value ? ' seg__t--on' : ''}`}
                  onClick={() => onTab?.(tab.value)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
          <span className="headrow__grow" />
          {newCount > 0 && (
            <button type="button" className="newpill" onClick={onShowNew}>
              新着 {newCount}件
            </button>
          )}
          {onReload && (
            <button
              type="button"
              className="iconbtn"
              onClick={onReload}
              aria-label="読み込み直す"
              title="読み込み直す"
            >
              <RefreshCw size={18} strokeWidth={1.5} className={reloading ? 'spin' : undefined} />
            </button>
          )}
        </div>
      )}
    </>
  );
}
