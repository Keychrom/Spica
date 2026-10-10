/**
 * 画面の骨格をサーバー側で描画して確かめる（ブラウザを使わない検査）。
 * 「選択中の色が付くか」「左上にサーバーのロゴが出るか」のように、
 * クラスが付いているかで判定できるものをここで見る。
 *
 *   npm run check:client-render
 *   （中身は `npx tsx --tsconfig client/tsconfig.json scripts/check-client-render.tsx`。
 *     JSX の変換は client 側の設定を使う）
 */
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

// ブラウザの window を最低限だけ真似る（permalink が origin を見るため）
(globalThis as any).window = {
  location: { origin: 'http://spica.test', pathname: '/', search: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
  getSelection: () => null,
  dispatchEvent: () => true,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
};
// localStorage も最低限（HomeView の案内が読む）
const storage = new Map<string, string>();
(globalThis as any).window.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, String(value)),
  removeItem: (key: string) => void storage.delete(key),
};
import Nav from '../client/src/components/Nav.js';
import Layout from '../client/src/components/Layout.js';
import MenuButton from '../client/src/components/MenuButton.js';
import Aside from '../client/src/components/Aside.js';
import HomeView from '../client/src/views/HomeView.js';
import PostCard from '../client/src/components/PostCard.js';
import PostMedia from '../client/src/components/PostMedia.js';
import MediaViewer from '../client/src/components/MediaViewer.js';
import { groupThreads, describeReplyTarget } from '../client/src/lib/thread.js';
import { personIdentifier, type Person } from '../client/src/lib/profile.js';
import type { Post } from '../client/src/lib/format.js';

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

// ======================================================================
console.log('\n🧵 会話の線（返信が親より上に来ている組を並べ替える）');
const parent = { id: 'http://spica.test/users/alice/posts/1', user_id: 'alice', content: '', author_name: 'Alice', author_handle: '@alice@spica.test', published_at: '2026-10-10T00:00:00.000Z' } as never as Post;
const child = { id: 'http://spica.test/users/bob/posts/2', user_id: 'bob', content: '', author_name: 'Bob', author_handle: '@bob@spica.test', published_at: '2026-10-10T00:00:00.000Z', in_reply_to: 'http://spica.test/users/alice/posts/1' } as never as Post;
const lone = { id: 'http://spica.test/users/carol/posts/3', user_id: 'carol', content: '', author_name: 'Carol', author_handle: '@carol@spica.test', published_at: '2026-10-10T00:00:00.000Z' } as never as Post;

const grouped = groupThreads([child, parent, lone]);
check('親が先に来る（返信が上でも入れ替える）', grouped[0].post.id === parent.id && grouped[1].post.id === child.id);
check('親に「下へつながる」印', grouped[0].railBottom === true && grouped[0].railTop === false);
check('返信に「上へつながる」印', grouped[1].railTop === true && grouped[1].railBottom === false);
check('無関係なノートには印を付けない', grouped[2].railTop === false && grouped[2].railBottom === false);
check('返信には返信先の案内が付く', grouped[1].replyTo?.label === '@alice@spica.test への返信');
check('案内の行き先は親のノート', String(grouped[1].replyTo?.href || '').includes('/users/alice/posts/1'));

const alreadyOrdered = groupThreads([parent, child]);
check('親が先の並びは入れ替えない', alreadyOrdered[0].post.id === parent.id);
check('親が先でも線は付く', alreadyOrdered[0].railBottom === true && alreadyOrdered[1].railTop === true);
check('ミスキー形（ユーザー名なし）はドメインだけ', describeReplyTarget('https://misskey.test/notes/abc').label === 'misskey.test の投稿への返信');

// ---- カードの見た目（クラスが付くか）
const card = (thread?: never) =>
  renderToStaticMarkup(
    createElement(PostCard, {
      post: parent,
      thread,
      onReact: noop,
      onBookmark: noop,
      onRenote: noop,
      onReply: noop,
      onQuote: noop,
      onShare: noop,
    } as never),
  );
check('線のクラスが付く（親側は下、返信側は上）', card({ railTop: false, railBottom: true, replyTo: null } as never).includes('post--rail-b'));
check('返信の案内が出る', card({ railTop: true, railBottom: false, replyTo: { label: '@alice@x への返信', href: '/users/alice/posts/1' } } as never).includes('@alice@x への返信'));
check('案内は親へのリンク', /<a class="rep" href="\/users\/alice\/posts\/1"/.test(card({ railTop: true, railBottom: false, replyTo: { label: 'x', href: '/users/alice/posts/1' } } as never)));

// ======================================================================
console.log('\n🖼 画像を押して大きく見る');
const withImages = { id: 'http://spica.test/users/alice/posts/9', user_id: 'alice', content: '', author_name: 'Alice', author_handle: '@alice@spica.test', published_at: '2026-10-10T00:00:00.000Z', media_attachments: [
  { url: '/uploads/a.png', type: 'image/png', alt: 'ひとつめ' },
  { url: '/uploads/b.png', type: 'image/png' },
  { url: '/uploads/c.mp4', type: 'video/mp4' },
] } as never as Post;
const mediaHtml = renderToStaticMarkup(createElement(PostMedia, { post: withImages } as never));
check('画像はボタンで包む（押して大きく見る）', (mediaHtml.match(/class="picbtn"/g) || []).length === 2);
check('動画は包まない（その場で再生）', mediaHtml.includes('<video'));
check('押した画像の alt が案内になる', mediaHtml.includes('aria-label="ひとつめ"'));

const viewerHtml = renderToStaticMarkup(
  createElement(MediaViewer, {
    media: [
      { url: '/uploads/a.png', alt: 'ひとつめ' },
      { url: '/uploads/b.png' },
    ],
    startIndex: 0,
    onClose: noop,
  } as never),
);
check('大きく見る面が出る', viewerHtml.includes('class="viewer"'));
check('閉じるボタンがある', viewerHtml.includes('viewer__close') && viewerHtml.includes('aria-label="閉じる"'));
check('複数なら送りが出る', viewerHtml.includes('viewer__nav--prev') && viewerHtml.includes('viewer__nav--next'));
check('何枚目かが出る', viewerHtml.includes('1 / 2'));
check('画像は原寸（縮小版ではない）', viewerHtml.includes('src="/uploads/a.png"'));

// ======================================================================
// 会話の線の幾何（見た目は描画では見えないので、CSS が意図どおりかを直接見る）
console.log('\n📏 線はアイコンの後ろを通る（アイコンに重ねない）');
const css = readFileSync('client/src/styles/posts.css', 'utf8');
check('アイコンを前面に出す（線が上に乗らない）', /\.post \.av \{[^}]*z-index: 1/s.test(css));
check('返信側の線はアイコンの手前で止まる', /\.post--rail-t::before \{[^}]*height: calc\(var\(--pad-row\) \+ 2px\)/s.test(css));
check('親側の線はアイコンの下から始まる', /\.post--rail-b::after \{[^}]*top: calc\(var\(--pad-row\) \+ 38px\)/s.test(css));
check('線はアイコンの中心に来る（左 19px・幅 2px）', css.includes('left: 19px') && css.includes('width: 2px'));

// ======================================================================
console.log('\n👥 人の一覧の行き先と「おすすめ」の中身');
// フォロー一覧の id は follows の行 ID。そのまま開くと「存在しません」になる
const localRow = {
  id: 'row-1',
  following_url: 'http://spica.test/users/bob',
  username: 'bob',
  domain: 'spica.test',
  name: 'Bob',
} as never as Person;
const remoteRow = {
  id: 'row-2',
  following_url: 'https://remote.test/users/eve',
  username: 'eve',
  domain: 'remote.test',
} as never as Person;
check('ローカルの相手は素の ID へ', personIdentifier(localRow) === 'bob');
check('リモートの相手は actor URL のまま', personIdentifier(remoteRow) === 'https://remote.test/users/eve');
check('ブロック/ミュートの行（id が本人）はそのまま', personIdentifier({ id: 'carol' } as never as Person) === 'carol');

const asideHtml = renderToStaticMarkup(
  createElement(Aside, {
    server: null,
    tags: [],
    recommended: [
      { id: 'bob', name: 'Bob', handle: '@bob@spica.test', icon_url: '' },
      { id: 'dave', name: 'Dave', handle: '@dave@spica.test', icon_url: '' },
    ],
    followed: new Set(['@bob@spica.test']),
    signedIn: true,
    onFollow: noop,
  } as never),
);
check('おすすめにフォロー済みは出ない', !asideHtml.includes('Bob'));
check('おすすめに未フォローは出る', asideHtml.includes('Dave'));

// ======================================================================
console.log('\n🔁 ブースト（リノート）のノート');
// 実物の API が返す形（.17 の /api/timeline から取ったもの）: 中身はトップレベル、
// renote には「ブーストした人」が入る。取り違えると中身が undefined になって落ちる
const boosted = {
  id: 'https://misskey.day/notes/as5kwy27b5',
  user_id: 'https://misskey.day/users/aqwvcgdilt',
  author_name: 'ブーストされた人',
  author_handle: '@someone@misskey.day',
  author_url: 'https://misskey.day/users/aqwvcgdilt',
  content: '',
  visibility: 'public',
  published_at: '2026-10-10T06:30:06.703Z',
  renote: {
    id: 'https://misskey.day/notes/as5kwy27b5/activity',
    name: 'ブーストした人',
    handle: '@404_@misskey.day',
    icon: '',
    url: 'https://misskey.day/users/aqwvcgdilt',
    at: '2026-10-10T06:30:06.703Z',
  },
} as never as Post;
const boostHtml = renderToStaticMarkup(
  createElement(PostCard, {
    post: boosted,
    onReact: noop,
    onBookmark: noop,
    onRenote: noop,
    onReply: noop,
    onQuote: noop,
    onShare: noop,
  } as never),
);
check('ブーストしても落ちない（中身が undefined にならない）', boostHtml.includes('post__col'));
check('ノートの作者はトップレベルを使う', boostHtml.includes('ブーストされた人'));
check('「◯◯ がリノート」はブーストした人', boostHtml.includes('ブーストした人 がリノート'));
check('押すとブーストした人を開ける', boostHtml.includes('href="/users/https%3A%2F%2Fmisskey.day%2Fusers%2Faqwvcgdilt"'));
check('本文が無くても印だけ出る', !boostHtml.includes('class=ody'));

// ======================================================================
console.log('\n🗂 タイムラインのタブは URL が決める');
// 以前は画面の中だけで持っていたので、ナビの「ホーム」（= `/` へ移動）を押しても
// URL が変わらず、連合を選んだまま何も起きなかった
const timelineScreen = (extra: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(HomeView, {
      menuButton: null,
      onCompose: noop,
      onReply: noop,
      onQuote: noop,
      signedIn: true,
      ...extra,
    } as never),
  );
const activeTabOf = (html: string) => (html.match(/seg__t seg__t--on">([^<]+)</) || [])[1];
check('?mode=all なら連合を選択中に', activeTabOf(timelineScreen({ mode: 'all' })), '連合');
check('?mode=local ならローカルを選択中に', activeTabOf(timelineScreen({ mode: 'local' })), 'ローカル');
check('?mode= が無ければホーム', activeTabOf(timelineScreen({})), 'ホーム');
check('設定の既定タブを使う', activeTabOf(timelineScreen({ defaultMode: 'local' })), 'ローカル');
check('URL の値が変ならホームへ落とす', activeTabOf(timelineScreen({ mode: 'bogus' })), 'ホーム');

console.log('');
if (failures === 0) console.log(`🎉 すべての確認に合格しました（${checks} 件）`);
else console.error(`❌ ${checks} 件中 ${failures} 件の確認に失敗しました`);
process.exit(failures === 0 ? 0 : 1);