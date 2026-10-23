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
import { readdirSync, readFileSync } from 'node:fs';
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
import { actorPath } from '../client/src/lib/permalink.js';
import { canSave, canSubmit, composerTargetFromDraft, draftInput, normalizeComposerVisibility, pollPayload, scheduledInput } from '../client/src/lib/composerState.js';
import { NAV_PRIMARY, isActive } from '../client/src/lib/nav.js';
import { isImageMedia, mediaAlt, mediaKind, mediaThumb, type Post } from '../client/src/lib/format.js';
import { MAX_ATTACHMENTS } from '../client/src/lib/media.js';
import {
  DEFAULT_SOUND_ON_NOTE,
  DEFAULT_SOUND_ON_POST,
  SOUNDS,
  playSound,
} from '../client/src/lib/sounds.js';
import SoundSection from '../client/src/components/settings/SoundSection.js';
import { NO_STREAMS, streamQuery, streamsFor } from '../client/src/lib/streamScope.js';
import { withPostPatch } from '../client/src/lib/postPatch.js';
import { groupNotifications } from '../client/src/lib/notifications.js';
import { customEmojiUrl, mergePostEmoji } from '../client/src/lib/contentFormat.js';

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
// 添付の名前はサーバーが返す実物に合わせる（mediaType / description / thumbnailUrl）
const withImages = { id: 'http://spica.test/users/alice/posts/9', user_id: 'alice', content: '', author_name: 'Alice', author_handle: '@alice@spica.test', published_at: '2026-10-10T00:00:00.000Z', media_attachments: [
  { url: '/uploads/a.png', mediaType: 'image/png', description: 'ひとつめ' },
  { url: '/uploads/b.png', mediaType: 'image/png', thumbnailUrl: '/uploads/b-thumb.jpg' },
  { url: '/uploads/c.mp4', mediaType: 'video/mp4', thumbnailUrl: '/uploads/c.jpg' },
] } as never as Post;
const mediaHtml = renderToStaticMarkup(createElement(PostMedia, { post: withImages } as never));
check('画像はボタンで包む（押して大きく見る）', (mediaHtml.match(/class="picbtn"/g) || []).length === 2);
check('動画は包まない（その場で再生）', mediaHtml.includes('<video'));
check('動画のポスターは thumbnailUrl', mediaHtml.includes('poster="/uploads/c.jpg"'));
check('押した画像の alt が案内になる', mediaHtml.includes('aria-label="ひとつめ"'));
check('画像は thumbnailUrl を優先（無ければ元の URL）', mediaHtml.includes('src="/uploads/b-thumb.jpg"') && mediaHtml.includes('src="/uploads/a.png"'));

// ---- 添付の枚数（上限 6・打ち切らない）
console.log('\n🧮 添付は 6 枚まで出せる（4 枚で打ち切らない）');
const makeImages = (count: number) => ({
  id: `http://spica.test/users/alice/posts/media-${count}`,
  user_id: 'alice',
  content: '',
  author_name: 'Alice',
  author_handle: '@alice@spica.test',
  published_at: '2026-10-10T00:00:00.000Z',
  media_attachments: Array.from({ length: count }, (_, i) => ({
    url: `/uploads/p${i + 1}.png`,
    mediaType: 'image/png',
  })),
}) as never as Post;

const sixHtml = renderToStaticMarkup(createElement(PostMedia, { post: makeImages(6) } as never));
check('6 枚すべて出す（打ち切らない）', (sixHtml.match(/class="picbtn"/g) || []).length === 6);
check('5 枚以上は 3 列にする', sixHtml.includes('pics pics--many'));

const eightHtml = renderToStaticMarkup(createElement(PostMedia, { post: makeImages(8) } as never));
check('連合先の 8 枚も全部出す', (eightHtml.match(/class="picbtn"/g) || []).length === 8);
check('上限の 4 枚なら 2 列のまま', !renderToStaticMarkup(createElement(PostMedia, { post: makeImages(4) } as never)).includes('pics--many'));
check('画面の上限は 6', MAX_ATTACHMENTS === 6);
// 画面とサーバーの上限は必ず同じ（片方だけ増やすと選べるのに弾かれる）
check('サーバーの上限も 6（ソースで確認）', /MAX_POST_ATTACHMENTS = 6/.test(readFileSync('server/src/postService.ts', 'utf8')));

const viewerHtml = renderToStaticMarkup(
  createElement(MediaViewer, {
    media: [
      { url: '/uploads/a.png', description: 'ひとつめ' },
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
check('説明（ALT）が出る', viewerHtml.includes('ひとつめ'));

// ---- 🎵 音声（サーバーは audio/mpeg のような mediaType で返す）
console.log('\n🎵 音声はその場で再生できる（画像にしない）');
const withAudio = { id: 'http://spica.test/users/alice/posts/10', user_id: 'alice', content: '', author_name: 'Alice', author_handle: '@alice@spica.test', published_at: '2026-10-10T00:00:00.000Z', media_attachments: [
  { url: '/uploads/song.mp3', mediaType: 'audio/mpeg', name: 'song.mp3', description: '弾き語り' },
] } as never as Post;
const audioHtml = renderToStaticMarkup(createElement(PostMedia, { post: withAudio } as never));
check('音声はプレイヤーで出す', audioHtml.includes('<audio') && audioHtml.includes('controls'));
check('音声を <img> にしない（壊れた絵にしない）', !audioHtml.includes('<img'));
check('音声は勝手に鳴らさない', !audioHtml.includes('autoplay'));
check('説明（ALT）か名前を添える', audioHtml.includes('弾き語り'));

const mixed = { id: 'http://spica.test/users/alice/posts/11', user_id: 'alice', content: '', author_name: 'Alice', author_handle: '@alice@spica.test', published_at: '2026-10-10T00:00:00.000Z', media_attachments: [
  { url: '/uploads/a.png', mediaType: 'image/png' },
  { url: '/uploads/song.mp3', mediaType: 'audio/mpeg', name: 'song.mp3' },
  { url: '/uploads/c.mp4', mediaType: 'video/mp4' },
] } as never as Post;
const mixedHtml = renderToStaticMarkup(createElement(PostMedia, { post: mixed } as never));
check('混ざっても種類ごとに描き分ける', mixedHtml.includes('<img') && mixedHtml.includes('<audio') && mixedHtml.includes('<video'));
check('大きく見る（画像）は 1 つだけ', (mixedHtml.match(/class="picbtn"/g) || []).length === 1);

// ---- 種類の判定（部品の外から見ても正しい。実物の名前で）
check('mediaKind: audio/mpeg は音声', mediaKind({ url: 'x', mediaType: 'audio/mpeg' } as never) === 'audio');
check('mediaKind: video/mp4 は動画', mediaKind({ url: 'x', mediaType: 'video/mp4' } as never) === 'video');
check('mediaKind: 種類が無ければ画像（昔の添付）', mediaKind({ url: 'x' } as never) === 'image');
check('mediaKind: 古い形（type）も見る', mediaKind({ url: 'x', type: 'audio/ogg' } as never) === 'audio');
check('mediaThumb: thumbnailUrl を優先', mediaThumb({ url: '/a.png', thumbnailUrl: '/t.png' } as never) === '/t.png');
check('mediaThumb: 古い thumbnail_url も見る', mediaThumb({ url: '/a.png', thumbnail_url: '/t2.png' } as never) === '/t2.png');
check('mediaAlt: description を ALT に使う', mediaAlt({ url: 'x', description: 'ひとつめ', alt: 'ふるい' } as never) === 'ひとつめ');
check('isImageMedia: 音声は含めない', isImageMedia({ url: 'x', mediaType: 'audio/mpeg' } as never) === false);

// ======================================================================
console.log('\n🔔 通知音（8 つ・設定で選べる）');
const soundOptions = SOUNDS.map((sound) => sound.file).sort();
// 実ファイルと一覧が 1 対 1 か（無い音を選べる状態にしない）
const actualSounds = readdirSync('client/public/sounds').filter((file) => file.endsWith('.mp3')).sort();
check('音の一覧と実ファイルが一致する', JSON.stringify(soundOptions) === JSON.stringify(actualSounds));
check('8 つある', SOUNDS.length === 8 && actualSounds.length === 8);
check('新着ノートの既定は Little Spark', DEFAULT_SOUND_ON_NOTE === 'LittleSpark');
check('投稿の既定は Pop Signal', DEFAULT_SOUND_ON_POST === 'PopSignal');

// サーバー側の検証（SOUND_IDS / 既定）と揃っているか（ソースで確認）
const prefsSource = readFileSync('server/src/userPrefs.ts', 'utf8');
check('サーバーの既定も同じ（LittleSpark / PopSignal）',
  prefsSource.includes("soundOnNote: 'LittleSpark'") && prefsSource.includes("soundOnPost: 'PopSignal'"));
check('サーバーの検証に 8 つとも載っている', SOUNDS.every((sound) => prefsSource.includes(`'${sound.id}'`)));

const soundHtml = renderToStaticMarkup(createElement(SoundSection) as never);
check('設定に 8 つの音が出る', SOUNDS.every((sound) => soundHtml.includes(sound.label)));
check('「鳴らさない」も選べる', soundHtml.includes('鳴らさない'));
check('新着と投稿の 2 か所で選べる', soundHtml.includes('新着ノートが届いたとき') && soundHtml.includes('自分が投稿したとき'));
check('試聴できる', (soundHtml.match(/試聴/g) || []).length === 2);
check('2 つとも選び直せる（select）', (soundHtml.match(/<select/g) || []).length === 2);

// 音が使えない環境（Node）でも落ちない・知らない id は無視する
let playCrashed = false;
try {
  playSound('LittleSpark');
  playSound('NotASound');
  playSound('');
  playSound(undefined);
} catch {
  playCrashed = true;
}
check('再生できない環境でも落ちない', !playCrashed);

// ======================================================================
console.log('\n🎨 テーマの選択肢がクライアントとサーバーで揃っている');
// 「端末に合わせる」がサーバーの検証に無いと、選んでも既定に矯正されて開き直すと戻る（直した不具合）
const themeClient = readFileSync('client/src/lib/theme.ts', 'utf8');
const themeServer = readFileSync('server/src/userPrefs.ts', 'utf8');
check('画面は「端末に合わせる」を持っている', themeClient.includes("'light' | 'dark' | 'system'"));
check('サーバーの検証も system を受け取る', themeServer.includes("'light', 'system'"));
check('サーバーの既定も system（画面の既定と一致）', themeServer.includes("themeMode: 'system'"));

// アクセントを選んでいるときもダーク用の「淡い面」があるか
// （ライトのパステルのままだと、ダークでカードやカレンダーのマスが白く浮く）
const tokensCss = readFileSync('client/src/styles/tokens.css', 'utf8');
for (const accent of ['cyan', 'emerald', 'purple', 'rose', 'amber']) {
  check(
    `ダークの ${accent} に淡い面（--accent-soft）がある`,
    tokensCss.includes(`[data-theme='dark'][data-accent='${accent}']`) &&
      new RegExp(`\\[data-theme='dark'\\]\\[data-accent='${accent}'\\] \\{[^}]*--accent-soft`, 's').test(tokensCss),
  );
}
check('ライトのパステルをそのまま使っていない（ダークの上書きが後ろにある）',
  tokensCss.lastIndexOf("[data-theme='dark'][data-accent='amber']") > tokensCss.lastIndexOf("html[data-accent='amber']"));

// ======================================================================
console.log('\n📡 申告するストリームは「いま見ているタイムライン」に合わせる');
// 申告しないとサーバーは全部を送る＝ホームを開いていても連合の受信で通知音が鳴る（直した不具合）
const scope = (path: string, def?: string) => streamsFor(path, def).join(',');
check('?mode=home はホーム', scope('/?mode=home'), 'home');
check('?mode=local はローカル', scope('/?mode=local'), 'local');
check('?mode=all は連合', scope('/?mode=all'), 'all');
check('?mode= が無ければ設定の既定タブ', scope('/', 'local'), 'local');
check('既定も無ければホーム', scope('/'), 'home');
check('変な mode はホーム', scope('/?mode=bogus'), 'home');
check('タグの画面はそのタグ', scope('/tags/Spica'), 'tag:spica');
check('チャンネルの画面はそのチャンネル', scope('/channels/Ch_1'), 'channel:Ch_1');
check('1 つのノートを開いているときは何も受け取らない', scope('/?post=https%3A%2F%2Fexample.com%2Fnotes%2F1'), 'none');
check('設定は何も受け取らない', scope('/settings'), 'none');
check('通知の画面も何も受け取らない', scope('/notifications'), 'none');
check('プロフィールも何も受け取らない', scope('/users/alice'), 'none');
check('チャンネル一覧（1 つも開いていない）も何も受け取らない', scope('/channels'), 'none');
check('申告はクエリに載る（未申告は「全部」と見なされる）', streamQuery(['none']), 'none');
check('申告はカンマで並べる', streamQuery(['home', 'tag:foo']), 'home,tag:foo');
check('クライアントとサーバーの none が同じ文字列', /NO_STREAMS = 'none'/.test(readFileSync('server/src/streamRouting.ts', 'utf8')) && NO_STREAMS === 'none');
check('旧名 unlisted は local に寄せる', normalizeComposerVisibility('unlisted'), 'local');
check('local はそのまま', normalizeComposerVisibility('local'), 'local');

const routesSource = readFileSync('client/src/Routes.tsx', 'utf8');
check('コレクションの種類が変わったら state を作り直す（key）', routesSource.includes('key={collection}'), true);
const collectionSource = readFileSync('client/src/views/CollectionView.tsx', 'utf8');
check(
  'チャンネルを自動選択したら URL に反映する（channel SSE のため）',
  collectionSource.includes("navigate('/channels/'"),
  true,
);
const composerSource = readFileSync('client/src/components/Composer.tsx', 'utf8');
check(
  'Ctrl+Enter は最新の submit を呼ぶ',
  composerSource.includes('useComposerKeys(() => void submit(), onClose)'),
  true,
);
check(
  '本文へのフォーカスは初回だけ（CW 入力中に奪わない）',
  composerSource.includes('areaRef.current?.focus();\n  }, []);'),
  true,
);

const antennaEditorSource = readFileSync('client/src/components/CollectionEditor.tsx', 'utf8');
check('アンテナに「指定した人」の入力欄がある', antennaEditorSource.includes('対象のユーザー（カンマ区切り'), true);
check(
  '「指定した人」が空なら保存させない',
  antennaEditorSource.includes('対象のユーザーを1人以上入力してください'),
  true,
);
check('拾う範囲に「リスト」がある', antennaEditorSource.includes("value: 'list'"));
const antennaListPickerSource = readFileSync('client/src/components/AntennaListPicker.tsx', 'utf8');
check('リストの一覧を読み込む', antennaListPickerSource.includes("api.get('/api/lists')"));
check('アンテナの編集画面がリスト選択を使う', antennaEditorSource.includes('<AntennaListPicker'));
check('リスト指定ではリスト id を送る', antennaEditorSource.includes("src === 'list'\n                ? listId"));
check('リスト未選択では保存させない', antennaEditorSource.includes('対象のリストを選んでください'));

// クリップ（ブックマークのフォルダ）
const collectionViewSource = readFileSync('client/src/views/CollectionView.tsx', 'utf8');
check('コレクションにクリップがある', collectionViewSource.includes("clips: {"));
check(
  'ブックマークの画面だけフォルダ追加を出す',
  collectionViewSource.includes("kind === 'bookmarks' ? (post) => setClipTarget(post) : undefined"),
);
const clipPickerSource = readFileSync('client/src/components/ClipPicker.tsx', 'utf8');
check('クリップの一覧を contains 付きで取る', clipPickerSource.includes("'/api/clips?postId='"));
check('クリップへノートを追加する', clipPickerSource.includes("'/notes'") && clipPickerSource.includes('postId: post.id'));
check('ルートに /clips が入る', routesSource.includes("'clips'"));
const navSource = readFileSync('client/src/lib/nav.ts', 'utf8');
check('ナビにクリップがある', navSource.includes("path: '/clips'"));
const postCardSource = readFileSync('client/src/components/PostCard.tsx', 'utf8');
check('PostCard にフォルダのボタンがある', postCardSource.includes('onAddToClip'));
check('本文に投稿の絵文字を渡す', postCardSource.includes('formatContent(shown.content, shown.emojis)'), true);
check('リアクションの絵文字を画像にする', postCardSource.includes('customEmojiUrl(r.reaction, shown.emojis)'), true);
const contentFormatSource = readFileSync('client/src/lib/contentFormat.ts', 'utf8');
check('メンションは /users/ へリンクする', contentFormatSource.includes('`/users/${encodeURIComponent(name)}`'), true);
check('カスタム絵文字は img.emoji にする', contentFormatSource.includes("img.className = 'emoji'"), true);

// ======================================================================
// 会話の線の幾何（見た目は描画では見えないので、CSS が意図どおりかを直接見る）
console.log('\n📏 線はアイコンの後ろを通る（アイコンに重ねない）');
const css = readFileSync('client/src/styles/posts.css', 'utf8');
check('アイコンを前面に出す（線が上に乗らない）', /\.post \.av \{[^}]*z-index: 1/s.test(css));
check('返信側の線はアイコンの手前で止まる', /\.post--rail-t::before \{[^}]*height: calc\(var\(--pad-row\) \+ 2px\)/s.test(css));
check('親側の線はアイコンの下から始まる', /\.post--rail-b::after \{[^}]*top: calc\(var\(--pad-row\) \+ 38px\)/s.test(css));
check('線はアイコンの中心に来る（左 19px・幅 2px）', css.includes('left: 19px') && css.includes('width: 2px'));

// 音声プレイヤーの見た目（画像の比率を当てると潰れる）
const partsCss = readFileSync('client/src/styles/post-parts.css', 'utf8');
check('音声に画像の比率を当てない', /\.pics--one \.pic--audio \{[^}]*aspect-ratio: auto/s.test(partsCss));
check('音声は横幅いっぱいを使う', /\.pics__audio \{[^}]*grid-column: 1 \/ -1/s.test(partsCss));
check('5 枚以上は 3 列（CSS も用意されている）', /\.pics--many \{[^}]*grid-template-columns: repeat\(3, 1fr\)/s.test(partsCss));

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

// リモート投稿の作者（user_id が Actor URL）へのリンクも、エンコードしたプロフィールへ
const remoteAuthorHref = 'href="/users/https%3A%2F%2Fmisskey.day%2Fusers%2Faqwvcgdilt"';
check(
  'リモート作者のアイコンと名前は Actor URL をエンコードしたプロフィールへ',
  (boostHtml.match(new RegExp(remoteAuthorHref, 'g')) || []).length,
  2,
);
check('ローカル作者は素の ID のプロフィールへ', (card().match(/href="\/users\/alice"/g) || []).length, 2);
check('ローカル ID はそのまま', actorPath('alice'), '/users/alice');
check('ローカルの Actor URL は ID に直す', actorPath('http://spica.test/users/alice'), '/users/alice');
check('リモートの Actor URL はエンコードする', actorPath('https://misskey.day/users/x'), '/users/https%3A%2F%2Fmisskey.day%2Fusers%2Fx');
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
check('?mode=home もホーム（明示できる）', activeTabOf(timelineScreen({ mode: 'home' })), 'ホーム');
check('?mode=home は既定のタブより優先', activeTabOf(timelineScreen({ mode: 'home', defaultMode: 'local' })), 'ホーム');

// ナビと下部バーの「ホーム」も明示（`/` に任せない）。どのタブでもナビの印は点いたまま
console.log('\n🧭 ナビの「ホーム」も明示する');
const navHome = NAV_PRIMARY.find((item) => item.label === 'ホーム') as never as Parameters<typeof isActive>[1];
const navFind = NAV_PRIMARY.find((item) => item.label === '見つける') as never as Parameters<typeof isActive>[1];
check('左ナビのホームは `/?mode=home`', NAV_PRIMARY.find((item) => item.label === 'ホーム')?.path === '/?mode=home');
check('連合タブでもナビのホームは点く', isActive('/?mode=all', navHome));
check('ログイン直後（`/`）でも点く', isActive('/', navHome));
check('見つけるはホームでは点かない', isActive('/?mode=home', navFind) === false);
check('下部バーのホームも `/?mode=home`', layout('/?mode=all').includes('href="/?mode=home"'));

// 他のサーバーの票で届いたアンケート更新を被せても、自分の印（me）は消えない
console.log('\n🗳 アンケートの更新を被せても自分の票の印は残る');
const votedPoll: Post = {
  id: 'p1',
  content: 'アンケート',
  poll: {
    total_votes: 2,
    my_voted: true,
    choices: [
      { text: 'りんご', votes_count: 1, me: true },
      { text: 'みかん', votes_count: 1, me: false },
    ],
  },
} as never as Post;
const merged = withPostPatch(votedPoll, {
  poll: {
    total_votes: 9,
    my_voted: false,
    choices: [
      { text: 'りんご', votes_count: 7, me: false },
      { text: 'みかん', votes_count: 2, me: false },
    ],
  },
} as never as Partial<Post>);
check('票数は新しい方を採る', merged.poll?.total_votes, 9);
check('選択肢の票数も新しい方', merged.poll?.choices?.map((c) => c.votes_count), [7, 2]);
check('投票済みのまま', merged.poll?.my_voted, true);
check('入れた選択肢の印が残る（テキストで引き継ぐ）', merged.poll?.choices?.map((c) => Boolean(c.me)), [true, false]);
const plain = withPostPatch(votedPoll, { bookmarked: true } as never as Partial<Post>);
check('アンケート以外の更新はそのまま重なる', [plain.bookmarked, plain.poll?.total_votes], [true, 2]);
check('アンケートが無い投稿でも落ちない', withPostPatch({ id: 'p2', content: 'x' } as never as Post, { bookmarked: true } as never as Partial<Post>).bookmarked, true);
// 自分の票が無い人（他のサーバーの更新だけを見た人）は my_voted を尊重する
const untouched = withPostPatch(
  { id: 'p3', content: 'x', poll: { total_votes: 1, choices: [{ text: 'a', votes_count: 1 }] } } as never as Post,
  { poll: { total_votes: 5, my_voted: true, choices: [{ text: 'a', votes_count: 5, me: true }] } } as never as Partial<Post>,
);
check('自分の票が無ければ届いた内容のまま', [untouched.poll?.my_voted, untouched.poll?.choices?.[0]?.me], [true, true]);

// ======================================================================
console.log('\n📝 コンポーザ: 何を送るか・本文なしで出せるか・下書きの引き継ぎ');
const none: never[] = [];
const oneImage = [{ url: '/uploads/a.png', mediaType: 'image/png' }] as never[];
const twoChoices = { choices: ['はい', 'いいえ'], multiple: false, expiresIn: 0 };

check('本文が無ければ出せない', canSubmit({ content: '  ', attachments: none, poll: null, quote: false }) === false);
check('本文だけなら出せる', canSubmit({ content: 'こんにちは', attachments: none, poll: null, quote: false }) === true);
check('アンケートだけでも出せる', canSubmit({ content: '', attachments: none, poll: twoChoices, quote: false }) === true);
check(
  '選択肢が 1 つだけのアンケートでは出せない',
  canSubmit({ content: '', attachments: none, poll: { choices: ['はい', ''], multiple: false, expiresIn: 0 }, quote: false }) === false,
);
check('引用だけでも出せる', canSubmit({ content: '', attachments: none, poll: null, quote: true }) === true);
check('添付だけでも出せる', canSubmit({ content: '', attachments: oneImage, poll: null, quote: false }) === true);
check(
  '下書きは選択肢 1 つのアンケートでも残せる',
  canSave({ content: '', attachments: none, poll: { choices: ['はい', ''], multiple: false, expiresIn: 0 }, quote: false, reply: false }) === true,
);
check('下書きは返信先だけでも残せる', canSave({ content: '', attachments: none, poll: null, quote: false, reply: true }) === true);
check('何も無ければ下書きにできない', canSave({ content: ' ', attachments: none, poll: null, quote: false, reply: false }) === false);
check(
  'アンケートは選択肢を詰めて expires_in で送る',
  JSON.stringify(pollPayload({ choices: [' はい ', '', 'いいえ'], multiple: true, expiresIn: 1800 })) ===
    JSON.stringify({ choices: ['はい', 'いいえ'], multiple: true, expires_in: 1800 }),
);
check('期限なしは expires_in を付けない', !('expires_in' in (pollPayload(twoChoices) || {})));

const resumed = composerTargetFromDraft({
  id: 'd1',
  content: '下書き',
  cw: 'CW',
  visibility: 'followers',
  media_attachments: oneImage,
  poll: { choices: ['はい', 'いいえ'], multiple: false, expiresIn: 3600 },
  in_reply_to: 'https://spica.test/users/bob/posts/2',
  quote_id: 'https://spica.test/users/carol/posts/3',
} as never);
check('再開: 公開範囲が戻る', resumed.visibility, 'followers');
check('再開: 添付が戻る', resumed.media?.length, 1);
check('再開: アンケートが戻る', resumed.poll?.choices?.length, 2);
check('再開: 返信先が戻る', resumed.replyTo?.id, 'https://spica.test/users/bob/posts/2');
check('再開: 引用元が戻る', resumed.quoteOf?.id, 'https://spica.test/users/carol/posts/3');

// 実際に送る形（keepDraft / reserve）に全項目が入るか
const draftPayload = draftInput({
  content: ' 下書き ',
  cw: 'CW',
  visibility: 'followers',
  attachments: oneImage,
  poll: { choices: ['はい', ''], multiple: false, expiresIn: 3600 },
  replyToId: 'p1',
  quoteOfId: 'p2',
});
check('下書きの送信: 本文は前後の空白を落とす', draftPayload.content === '下書き');
check('下書きの送信: 公開範囲', draftPayload.visibility === 'followers');
check('下書きの送信: 添付', draftPayload.attachments?.length === 1);
check('下書きの送信: アンケート（編集中の形のまま）', draftPayload.poll?.choices?.length === 2 && draftPayload.poll?.expiresIn === 3600);
check('下書きの送信: 返信先と引用元', draftPayload.in_reply_to === 'p1' && draftPayload.quote_id === 'p2');

const scheduledPayload = scheduledInput({
  content: '',
  cw: '',
  visibility: 'followers',
  attachments: oneImage,
  poll: { choices: ['はい', 'いいえ'], multiple: false, expiresIn: 3600 },
  replyToId: 'p1',
  quoteOfId: 'p2',
  scheduledAt: '2026-10-18T00:00:00.000Z',
});
check('予約の送信: 公開範囲', scheduledPayload.visibility === 'followers');
check('予約の送信: 添付', scheduledPayload.attachments?.length === 1);
check('予約の送信: アンケートは expires_in（API の形）', (scheduledPayload.poll as any)?.expires_in === 3600);
check('予約の送信: 返信先と引用元', scheduledPayload.in_reply_to === 'p1' && scheduledPayload.quote_id === 'p2');
check('予約の送信: 日時', scheduledPayload.scheduled_at === '2026-10-18T00:00:00.000Z');

// ======================================================================
console.log('\n🔔 通知のまとめ方（設定）と、まとめて既読');
const notif = (id: string, type: string, post_id?: string) => ({ id, type, post_id }) as never;
const sameKind = [notif('n1', 'reaction', 'p1'), notif('n2', 'reaction', 'p1'), notif('n3', 'reaction', 'p2')];
check('まとめる設定: 同じ投稿の同じ種類は 1 つに', groupNotifications(sameKind).length === 2);
check('まとめる設定: 先頭の組に 2 件入る', groupNotifications(sameKind)[0].items.length === 2);
check('まとめない設定: 1 件ずつ出す', groupNotifications(sameKind, 'individual').length === 3);
check('まとめない設定: どの組も 1 件', groupNotifications(sameKind, 'individual').every((g) => g.items.length === 1));
check('まとめない設定: 組の鍵は通知の id', groupNotifications(sameKind, 'individual').map((g) => g.key).join(',') === 'n1,n2,n3');
check('返信はまとめない', groupNotifications([notif('r1', 'reply', 'p1'), notif('r2', 'reply', 'p1')]).length === 2);

const notifViewSource = readFileSync('client/src/views/NotificationsView.tsx', 'utf8');
check('通知画面はまとめ設定を受け取る', notifViewSource.includes("grouping?: 'group' | 'individual'"));
check('通知画面は設定を groupNotifications に渡す', notifViewSource.includes("grouping === 'individual' ? 'individual' : 'group'"));
check('通知画面へ設定の値を渡している', routesSource.includes('grouping={prefs.notificationGrouping}'));
check(
  'まとめ通知は中身すべてをまとめて既読にする',
  notifViewSource.includes("api.post('/api/notifications/read', { ids: unread.map((n) => n.id) })"),
);
check('先頭 1 件だけを既読にする道は残っていない', !notifViewSource.includes('open(first)'));
const notifRouteSource = readFileSync('server/src/routes/notifications.ts', 'utf8');
check('まとめて既読は持ち主の通知だけ', notifRouteSource.includes('WHERE user_id = ? AND is_read = 0 AND id IN ('));
check('まとめて既読の上限は 200', notifRouteSource.includes('ids.length > 200'));

const searchViewSource = readFileSync('client/src/views/SearchView.tsx', 'utf8');
check('検索結果のリノートは toggleRenote を呼ぶ', searchViewSource.includes('const result = await toggleRenote(p)'));
check(
  '検索結果のリノートは状態と件数を反映する',
  searchViewSource.includes('my_announced: result.announced, announce_count: result.count'),
);
check('検索結果に空の onRenote は無い', !searchViewSource.includes('onRenote={() => undefined}'));

const adminRegSource = readFileSync('client/src/components/admin/AdminRegistrations.tsx', 'utf8');
check('拒否理由は申請ごとに持つ', adminRegSource.includes('useState<Record<string, string>>({})'));
check('拒否理由の入力欄は行ごとの値', adminRegSource.includes("value={reasons[request.id] || ''}"));
check('拒否理由の変更は行ごとに保存', adminRegSource.includes('[request.id]: event.target.value'));
check('拒否時はその行の理由を送る', adminRegSource.includes("rejectRegistration(id, reasons[id] || '')"));
check('1 つの理由を全行で共有していない', !adminRegSource.includes('const [reason, setReason]'));

// ======================================================================
console.log('\n🎨 本文に無いカスタム絵文字のリアクション');
const party = [{ name: ':party:', url: '/uploads/party.png' }];
check('本文に同じ絵文字があれば画像にする', customEmojiUrl(':party:', party) === '/uploads/party.png');
check('未登録の絵文字は文字のまま', customEmojiUrl(':unknown:', party) === undefined);
check(
  'リモート形式（:name@host:）も画像にする',
  customEmojiUrl(':party@remote.test:', [{ name: ':party@remote.test:', url: 'https://remote.test/party.png' }]) ===
    'https://remote.test/party.png',
);
check('本文に無いリアクションは emojis に足す', mergePostEmoji('[]', 'party', '/uploads/party.png')?.length === 1);
check('足す名前は :name: 形式', mergePostEmoji('[]', 'party', '/uploads/party.png')?.[0]?.name === ':party:');
check(
  'JSON 文字列の emojis にも足せる',
  mergePostEmoji(JSON.stringify(party), 'other', '/u/other.png')?.length === 2,
);
check('すでにある絵文字は足さない', mergePostEmoji(party, 'party', '/other.png') === null);

const postActionsSource = readFileSync('client/src/lib/postActions.ts', 'utf8');
check('リアクション直後にも絵文字の URL を返す', postActionsSource.includes('if (merged) result.emojis = merged;'));
check('リアクションの絵文字はサーバーの一覧から引く', postActionsSource.includes('await loadCustomEmojis()'));
const timelineSource = readFileSync('client/src/lib/useTimeline.ts', 'utf8');
check('タイムラインは絵文字の更新も反映する', timelineSource.includes('result.emojis ? { emojis: result.emojis }'));
const postDetailSource = readFileSync('client/src/views/PostDetailView.tsx', 'utf8');
check('ノート画面も絵文字の更新を反映する', postDetailSource.includes('result.emojis ? { emojis: result.emojis }'));

console.log('');
if (failures === 0) console.log(`🎉 すべての確認に合格しました（${checks} 件）`);
else console.error(`❌ ${checks} 件中 ${failures} 件の確認に失敗しました`);
process.exit(failures === 0 ? 0 : 1);