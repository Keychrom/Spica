/**
 * 投稿本文の HTML 化（リンク・メンション・ハッシュタグ・カスタム絵文字）。
 *
 * `format.ts` から分離した。本文まわりは DOMPurify と DOM を使うため、
 * 時刻・件数などの純粋な整形（format.ts）と分けた方がテストしやすい。
 */
import DOMPurify from 'dompurify';
import { getPrefs } from './prefs';

/** posts.emojis（JSON 文字列 or 配列）の受け口 */
export type EmojiSource = string | { name: string; url: string }[] | null | undefined;

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] || c);
}

function looksLikeHtml(raw: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(raw);
}

const ALLOWED_TAGS = [
  'a', 'p', 'br', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre',
  'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'hr', 'small',
];
const ALLOWED_ATTR = ['href', 'class', 'src', 'alt', 'title', 'width', 'height'];

/** 本文のプレーンテキストを、URL・@メンション・#タグだけリンクにする */
function linkifyPlainText(raw: string): string {
  return escapeHtml(raw)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/(^|[\s(])(@[A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?)/g, (_m, lead: string, mention: string) => {
      const body = mention.slice(1);
      const at = body.indexOf('@');
      const name = at === -1 ? body : body.slice(0, at);
      const domain = at === -1 ? '' : body.slice(at + 1);
      // 自分のサーバーの人はプロフィールへ。リモートは検索へ（# のダミーリンクは作らない）
      const local = !domain || domain.toLowerCase() === window.location.host.toLowerCase();
      const href = local
        ? `/users/${encodeURIComponent(name)}`
        : `/search?q=${encodeURIComponent(mention)}`;
      return `${lead}<a class="mention" href="${href}">${mention}</a>`;
    })
    .replace(/(^|[\s(])(#[^\s<#]+)/g, (_m, lead: string, tag: string) =>
      `${lead}<a class="hashtag" href="/tags/${encodeURIComponent(tag.slice(1))}">${tag}</a>`);
}

interface PostEmoji {
  name: string;
  url: string;
}

/** posts.emojis（JSON 文字列 or 配列）を安全に配列にする */
function parsePostEmojis(emojis: EmojiSource): PostEmoji[] {
  const valid = (list: unknown): PostEmoji[] =>
    Array.isArray(list)
      ? list.filter(
          (e): e is PostEmoji =>
            Boolean(e) && typeof e === 'object' && typeof (e as PostEmoji).name === 'string' && typeof (e as PostEmoji).url === 'string',
        )
      : [];
  if (Array.isArray(emojis)) return valid(emojis);
  if (typeof emojis !== 'string' || !emojis) return [];
  try {
    return valid(JSON.parse(emojis));
  } catch {
    return [];
  }
}

/** 絵文字名は `:name:` 形式で保存される（古いデータは前後のコロン無し）。比較用に落とす */
function emojiKey(name: string): string {
  return String(name || '').trim().replace(/^:+|:+$/g, '');
}

/** リアクションの `:name:` を画像の URL にする（設定で画像を切っているときは undefined） */
export function customEmojiUrl(code: string, emojis: EmojiSource): string | undefined {
  if (getPrefs().showCustomEmojiImages === false) return undefined;
  const match = /^:([A-Za-z0-9_+-]+):$/.exec(String(code || '').trim());
  if (!match) return undefined;
  return parsePostEmojis(emojis).find((emoji) => emojiKey(emoji.name) === match[1])?.url;
}

/** テキストノードの :name: を <img class="emoji"> に置き換える（リンク内・コード内は触らない） */
function replaceEmojiShortcodes(host: HTMLElement, emojis: EmojiSource): void {
  const list = parsePostEmojis(emojis);
  if (list.length === 0) return;
  const byName = new Map(list.map((emoji) => [emojiKey(emoji.name), emoji.url]));
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  for (const node of nodes) {
    if (!node.nodeValue?.includes(':')) continue;
    if (node.parentElement?.closest('a, code, pre')) continue;
    const text = node.nodeValue;
    const fragment = document.createDocumentFragment();
    let last = 0;
    let replaced = false;
    for (const match of text.matchAll(/:([A-Za-z0-9_+-]+):/g)) {
      const url = byName.get(match[1]);
      if (!url || match.index === undefined) continue;
      if (match.index > last) fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
      const img = document.createElement('img');
      img.className = 'emoji';
      img.src = url;
      img.alt = match[0];
      img.title = match[0];
      fragment.appendChild(img);
      last = match.index + match[0].length;
      replaced = true;
    }
    if (replaced) {
      if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
      node.replaceWith(fragment);
    }
  }
}

/** 本文を安全な HTML にする（表示は dangerouslySetInnerHTML で行う） */
export function formatContent(raw: string, emojis?: EmojiSource): string {
  if (!raw) return '';
  const html = looksLikeHtml(raw) ? raw : linkifyPlainText(raw);
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment;

  const host = document.createElement('div');
  host.appendChild(clean);

  // 投稿が使っているカスタム絵文字だけを画像にする（未登録の :name: はそのまま）
  if (getPrefs().showCustomEmojiImages !== false) {
    replaceEmojiShortcodes(host, emojis);
  }

  // 設定「カスタム絵文字を画像で出す」が切ってあるときは、:name: の文字に戻す
  // （リモートの HTML に元から入っている <img class="emoji"> もここで戻す）
  if (getPrefs().showCustomEmojiImages === false) {
    for (const img of Array.from(host.querySelectorAll('img'))) {
      const alt = img.getAttribute('alt') || '';
      if (!img.classList.contains('emoji') && !alt.startsWith(':')) continue;
      const text = document.createElement('span');
      text.textContent = alt.startsWith(':') ? alt : `:${alt}:`;
      img.replaceWith(text);
    }
  }

  for (const a of Array.from(host.querySelectorAll('a'))) {
    const href = a.getAttribute('href') || '';
    const text = a.textContent || '';
    if (href.includes('/tags/')) {
      const tag = decodeURIComponent(href.split('/tags/').pop() || '').replace(/^#/, '');
      a.setAttribute('href', `/tags/${encodeURIComponent(tag)}`);
      a.classList.add('hashtag');
      a.removeAttribute('target');
      a.removeAttribute('rel');
      continue;
    }
    if (text.startsWith('@') || href.includes('/users/') || href.startsWith('/search')) {
      a.classList.add('mention');
    }
    if (href.startsWith('/')) {
      // アプリ内（プロフィール・検索・タグ）は同じタブで開く。リンク横取りが SPA 遷移にする
      a.removeAttribute('target');
      a.removeAttribute('rel');
    } else if (/^https?:/.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      // `#` などの行き先の無いリンクは文字のまま残す
      a.removeAttribute('href');
      a.removeAttribute('target');
      a.removeAttribute('rel');
    }
  }
  return host.innerHTML;
}
