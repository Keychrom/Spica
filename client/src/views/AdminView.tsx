/**
 * 管理パネル（/admin）。運営（admin / moderate）だけが使える。
 * 節はタブで切り替える（概要 / 利用者 / 通報 / 登録の承認 / サーバー設定 / 絵文字・招待 /
 * ロール / リレー / ブロック / メンテナンス / お知らせ / メール・ストレージ / 配信キュー）。
 */
import { useState, type ReactNode } from 'react';
import ScreenHead from '../components/ScreenHead';
import AdminOverview from '../components/admin/AdminOverview';
import AdminUsers from '../components/admin/AdminUsers';
import AdminReports from '../components/admin/AdminReports';
import AdminServer from '../components/admin/AdminServer';
import AdminRegistrations from '../components/admin/AdminRegistrations';
import AdminAssets from '../components/admin/AdminAssets';
import AdminRelays from '../components/admin/AdminRelays';
import AdminMaintenance from '../components/admin/AdminMaintenance';
import AdminBlocks from '../components/admin/AdminBlocks';
import AdminRoles from '../components/admin/AdminRoles';
import AdminAnnouncements from '../components/admin/AdminAnnouncements';
import AdminMail from '../components/admin/AdminMail';
import AdminStorage from '../components/admin/AdminStorage';
import AdminQueue from '../components/admin/AdminQueue';
import { navigate } from '../lib/router';

const SECTIONS = [
  { value: 'overview', label: '概要' },
  { value: 'users', label: '利用者' },
  { value: 'reports', label: '通報' },
  { value: 'registration', label: '登録の承認' },
  { value: 'server', label: 'サーバー設定' },
  { value: 'assets', label: '絵文字・招待' },
  { value: 'relays', label: 'リレー' },
  { value: 'blocks', label: 'ブロック' },
  { value: 'maintenance', label: 'メンテナンス' },
  { value: 'roles', label: 'ロール' },
  { value: 'announcements', label: 'お知らせ' },
  { value: 'mail', label: 'メール・ストレージ' },
  { value: 'queue', label: '配信キュー' },
];

interface AdminViewProps {
  menuButton: ReactNode;
  signedIn: boolean;
  /** ログイン中の人（運営かどうかの判定に使う） */
  myId?: string;
  allowed: boolean;
}

export default function AdminView({ menuButton, signedIn, myId, allowed }: AdminViewProps) {
  const [section, setSection] = useState('overview');

  if (!signedIn || !allowed) {
    return (
      <>
        <ScreenHead title="管理パネル" menuButton={menuButton} />
        <div className="divider" />
        <div className="feed">
          <div className="feed__state">
            {signedIn
              ? 'この画面は運営（管理者・モデレーター）だけが使えます。'
              : '管理パネルを使うにはログインしてください。'}
            <br />
            <button
              type="button"
              className="btn btn--text"
              onClick={() => navigate(signedIn ? '/' : '/login')}
            >
              {signedIn ? 'ホームへ戻る' : 'ログイン / 新規登録'}
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <ScreenHead
        title="管理パネル"
        sub="運営のための画面です"
        menuButton={menuButton}
      />
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
        {section === 'overview' && <AdminOverview />}
        {section === 'users' && <AdminUsers myId={myId || ''} />}
        {section === 'reports' && <AdminReports />}
        {section === 'registration' && <AdminRegistrations />}
        {section === 'server' && <AdminServer />}
        {section === 'assets' && <AdminAssets />}
        {section === 'relays' && <AdminRelays />}
        {section === 'blocks' && <AdminBlocks />}
        {section === 'maintenance' && <AdminMaintenance />}
        {section === 'roles' && <AdminRoles />}
        {section === 'announcements' && <AdminAnnouncements />}
        {section === 'mail' && (
          <>
            <AdminMail />
            <AdminStorage />
          </>
        )}
        {section === 'queue' && <AdminQueue />}
      </div>
    </>
  );
}
