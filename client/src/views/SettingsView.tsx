/**
 * 設定（/settings）。
 * 節はタブで切り替える（プロフィール / 表示 / 通知 / アカウント / つながり / データ）。
 */
import { useState, type ReactNode } from 'react';
import ScreenHead, { type ScreenTab } from '../components/ScreenHead';
import ProfileSection from '../components/settings/ProfileSection';
import DisplaySection from '../components/settings/DisplaySection';
import ComposeSection from '../components/settings/ComposeSection';
import NotifySection from '../components/settings/NotifySection';
import AccountSection from '../components/settings/AccountSection';
import RelationsSection from '../components/settings/RelationsSection';
import DataSection from '../components/settings/DataSection';
import SecuritySection from '../components/settings/SecuritySection';
import { navigate } from '../lib/router';
import type { Prefs } from '../lib/settings';
import type { ThemeChoice } from '../lib/theme';

const SECTIONS: ScreenTab[] = [
  { value: 'profile', label: 'プロフィール' },
  { value: 'display', label: '表示' },
  { value: 'compose', label: '投稿' },
  { value: 'notify', label: '通知' },
  { value: 'account', label: 'アカウント' },
  { value: 'relations', label: 'つながり' },
  { value: 'security', label: '安全' },
  { value: 'data', label: 'データ' },
];

interface SettingsViewProps {
  menuButton: ReactNode;
  signedIn: boolean;
  /** 自分の情報（いま分かっている範囲。詳細は各節が読み直す） */
  me: {
    id: string;
    email: string;
    emailVerified: boolean;
    hasPassword: boolean;
  } | null;
  /** URL の ?section= */
  initialSection?: string;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  onLogout: () => void;
  onPrefsChange: (prefs: Prefs) => void;
}

export default function SettingsView({
  menuButton,
  signedIn,
  me,
  initialSection,
  theme,
  onTheme,
  onLogout,
  onPrefsChange,
}: SettingsViewProps) {
  const [section, setSection] = useState(
    initialSection && SECTIONS.some((item) => item.value === initialSection) ? initialSection : 'profile',
  );

  return (
    <>
      <ScreenHead title="設定" menuButton={menuButton} />
      <div className="headrow">
        <div className="seg seg--wrap">
          {SECTIONS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={'seg__t' + (section === item.value ? ' seg__t--on' : '')}
              onClick={() => setSection(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="divider" />

      <div className="feed">
        {!signedIn && (
          <div className="feed__state">
            設定を変えるにはログインしてください。
            <br />
            <button type="button" className="btn btn--text" onClick={() => navigate('/login')}>
              ログイン / 新規登録
            </button>
          </div>
        )}

        {signedIn && section === 'profile' && me && <ProfileSection myId={me.id} />}
        {signedIn && section === 'display' && (
          <DisplaySection onApply={onPrefsChange} theme={theme} onTheme={onTheme} />
        )}
        {signedIn && section === 'compose' && <ComposeSection />}
        {signedIn && section === 'notify' && <NotifySection />}
        {signedIn && section === 'account' && me && (
          <AccountSection
            email={me.email}
            emailVerified={me.emailVerified}
            hasPassword={me.hasPassword}
            onLogout={onLogout}
          />
        )}
        {signedIn && section === 'relations' && <RelationsSection />}
        {signedIn && section === 'security' && me && <SecuritySection myId={me.id} hasPassword={me.hasPassword} onLogout={onLogout} />}
        {signedIn && section === 'data' && <DataSection />}
      </div>
    </>
  );
}
