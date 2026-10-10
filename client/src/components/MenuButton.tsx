/**
 * モバイルの左上（ドロワーを開くボタン）。
 * 管理者が設定した**サーバーのロゴ**を出す（未設定なら自分のアイコン、それも無ければ頭文字）。
 */
import type { ServerInfo, SessionUser } from '../lib/format';

interface MenuButtonProps {
  user: SessionUser | null;
  server?: ServerInfo | null;
  onOpen: () => void;
}

export default function MenuButton({ user, server, onOpen }: MenuButtonProps) {
  return (
    <button type="button" className="mhead__menu" onClick={onOpen} aria-label="メニュー" title="メニュー">
      {server?.icon_url ? (
        <img src={server.icon_url} alt={server.name || ''} />
      ) : user?.icon_url ? (
        <img src={user.icon_url} alt="" />
      ) : (
        (user?.name || '?').slice(0, 1)
      )}
    </button>
  );
}
