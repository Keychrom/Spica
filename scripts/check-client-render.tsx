/**
 * 画面の骨格をサーバー側で描画して確かめる（ブラウザを使わない検査）。
 * 「選択中の色が付くか」「左上にサーバーのロゴが出るか」のように、
 * クラスが付いているかで判定できるものをここで見る。
 *
 *   npm run check:client-render
 *   （中身は `npx tsx --tsconfig client/tsconfig.json scripts/check-client-render.tsx`。
 *     JSX の変換は client 側の設定を使う）
 */
import { renderToStaticMarkup } from 'react-dom/server';
import Nav from '../client/src/components/Nav.js';
import Layout from '../client/src/components/Layout.js';
import MenuButton from '../client/src/components/MenuButton.js';

let checks = 0;
let failures = 0;
function check(name: string, ok: boolean): void {
  checks++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  if (!ok) failures++;
}

const user = {
  id: 'suiren',
  name: '猫星 吹恋',
  handle: '@suiren@spica.studio-nosa.live',
  icon_url: '/uploads/suiren/icon.png',
  role: 'admin',
  onboarding_completed: 1,
} as never;
const server = { name: '星ノ道', icon_url: '/logo.jpg' } as never;

const noop = () => {};
const layout = (path: string, children = '本文') =>
  renderToStaticMarkup(
    Layout({
      path,
      user,
      server,
      unread: 3,
      theme: 'light',
      onTheme: noop,
      onCompose: noop,
      onLogout: noop,
      onOpenProfile: noop,
      drawerOpen: false,
      onOpenDrawer: noop,
      onCloseDrawer: noop,
      notificationsActive: path.startsWith('/notifications'),
      aside: null,
      children,
    }) as never,
  );

console.log('🧪 画面の骨格の検査（サーバー側で描画）');

// ---- ホーム: 下部バーの「ホーム」が光る
const home = layout('/');
check('ホーム: 下部バーのホームが選択中', /mbar__item--on[^>]*href="\/"/.test(home) || home.includes('mbar__item mbar__item--on'));
check('ホーム: 通知は選択中でない', !/mbar__item--on[^>]*href="\/notifications"/.test(home));

// ---- 通知: 下部バーの「通知」が光る（ここが直っていなかった）
const notifications = layout('/notifications');
check('通知: 下部バーの通知が選択中', /class="mbar__item mbar__item--on"[^>]*href="\/notifications"/.test(notifications));

// ---- 自分: 自分のプロフィールで「自分」が光る
const me = layout('/users/suiren');
check('自分: プロフィールで「自分」が選択中', /class="mbar__item mbar__item--on"/.test(me.split('onOpenProfile')[0] + me));
check('自分: 左下（ナビ）も選択中', me.includes('nav__me nav__me--on'));

// ---- 他人のプロフィールでは光らない
const other = layout('/users/someone');
check('他人のプロフィールでは自分は光らない', other.includes('class="mbar__item" onClick') || !other.includes('mbar__item mbar__item--on" onClick'));

// ---- 左上（モバイル）と左ナビ（デスクトップ）にサーバーのロゴと名前
const nav = renderToStaticMarkup(
  Nav({ path: '/', user, server, unread: 0, onCompose: noop, onOpenProfile: noop }) as never,
);
check('左ナビ: サーバーの名前が出る', nav.includes('星ノ道'));
check('左ナビ: サーバーのロゴが出る', /nav__mark"><img src="\/logo\.jpg"/.test(nav));

const mark = renderToStaticMarkup(MenuButton({ user, server, onOpen: noop }) as never);
check('左上: サーバーのロゴが出る', mark.includes('src="/logo.jpg"'));

// ---- ロゴ未設定なら自分のアイコンへ落ちる
const noIcon = renderToStaticMarkup(
  MenuButton({ user, server: { name: 'Spica', icon_url: '' } as never, onOpen: noop }) as never,
);
check('左上: ロゴ未設定なら自分のアイコン', noIcon.includes('src="/uploads/suiren/icon.png"'));
const noIconNav = renderToStaticMarkup(
  Nav({ path: '/', user, server: { name: 'Spica', icon_url: '' } as never, unread: 0, onCompose: noop, onOpenProfile: noop }) as never,
);
check('左ナビ: ロゴ未設定なら ✦ と既定の名前', noIconNav.includes('✦') && noIconNav.includes('<b>Spica</b>'));

console.log('');
if (failures === 0) console.log(`🎉 すべての確認に合格しました（${checks} 件）`);
else console.error(`❌ ${checks} 件中 ${failures} 件の確認に失敗しました`);
process.exit(failures === 0 ? 0 : 1);
