/**
 * DmView（1対1のメッセージ＝DM の画面）
 *
 * サーバー側は `docs/DM.md` のとおり実装済み。この画面はその API をそのまま使う:
 *   - `GET  /api/dm/conversations`           会話一覧（相手・最終メッセージ・未読数）
 *   - `GET  /api/dm/conversations/:id`       本文（時系列・`cursor` で古い方へ）
 *   - `POST /api/dm/messages`                送信（`to` はハンドルか actor URL）
 *   - `POST /api/dm/conversations/:id/read`  既読
 *
 * 気をつけていること:
 *   - サーバー設定 `dm_enabled` が off のときは API が 404 を返す。導線は App 側で出さないが、
 *     URL を直に開かれた場合に備えてこの画面でも 404 を見て「無効です」を出す
 *   - 相手が受信を許可していないと `delivered: false` が返る（送信自体は保存される）。
 *     そのときは「相手が受け取らない設定です」と控えめに出す（エラー扱いにはしない）
 *   - 通知には本文が入らないので、通知からは会話を開くだけ（`/dm?c=<id>`）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ImageIcon,
  Info,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldAlert,
  X,
} from 'lucide-react';
import { FormattedPostContent } from '../components/PostRendering';
import { compressImage } from '../utils/imageCompressor';
import { usePrefs } from '../prefs';

/** 会話の相手（サーバーの `DmPartnerProfile`） */
export interface DmPartner {
  actor_url: string;
  user_id: string | null;
  name: string;
  handle: string;
  icon_url: string;
  is_local: boolean;
  /** ローカルの相手が自分からの DM を受け取る設定か（リモートは null = 不明） */
  accepts_dm: boolean | null;
}

interface DmLastMessage {
  id: string;
  content: string;
  cw: string | null;
  has_media: boolean;
  published_at: string;
  is_mine: boolean;
}

interface DmConversation {
  id: string;
  partner: DmPartner;
  last_message: DmLastMessage;
  unread_count: number;
  message_count: number;
  updated_at: string;
}

interface DmMessage {
  id: string;
  conversation_id: string;
  content: string;
  cw: string | null;
  emojis: any[] | null;
  media_attachments: any[];
  published_at: string;
  in_reply_to: string | null;
  is_mine: boolean;
  is_read: boolean;
  author: { actor_url: string; name: string; handle: string; icon_url: string };
}

export interface DmViewProps {
  api: any;
  authToken: any;
  authUser: any;
  /** サーバー設定 `dm_enabled`（`/api/server-info` の `features.dm`） */
  featureDm: any;
  /** `/dm?to=<handle>` で開いた相手（ハンドル or actor URL） */
  initialTo: any;
  /** `/dm?c=<id>` で開く会話（通知の `post_id` ＝メッセージ id でもよい） */
  initialConversationId: any;
  /** 会話を開いたときに URL を `/dm?c=<id>` へ置き換える（App の自前ルーター） */
  pushDmUrl: any;
  navigateToView: any;
  openUserProfile: any;
  setShowLoginModal: any;
  /** 未読の合計が変わったときに App へ伝える（ナビのバッジ用） */
  onUnreadChange: any;
}

/** 未読の合計（ナビのバッジに出す値） */
function totalUnread(conversations: DmConversation[]): number {
  return conversations.reduce((sum, conv) => sum + (Number(conv.unread_count) || 0), 0);
}

/**
 * 時刻の表し方（設定 → 表示 → 時刻の表し方に合わせる）。
 * 相対表示は PostRendering の `formatRelativeTime` と同じ規則にする。
 */
function formatDmTime(iso: string, mode: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  if (mode === 'relative') {
    const minutes = Math.floor((Date.now() - then) / 60000);
    if (minutes < 1) return 'たった今';
    if (minutes < 60) return `${minutes}分前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}時間前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}日前`;
  }
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString('ja-JP', {
    ...(sameYear ? {} : { year: 'numeric' as const }),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 一覧に出す短い時刻（今日は時刻だけ、それ以外は日付） */
function formatListTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const date = new Date(then);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('ja-JP', sameYear ? { month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'numeric', day: 'numeric' });
}

export default function DmView(props: DmViewProps) {
  const { api, authToken, authUser, featureDm, initialTo, initialConversationId, pushDmUrl, navigateToView, openUserProfile, setShowLoginModal, onUnreadChange } = props;
  const prefs = usePrefs();

  const [conversations, setConversations] = useState<DmConversation[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState<boolean>(false);
  /** 一度でも会話一覧を取れたか（URL パラメータの相手を開く前に一覧を待つため） */
  const [hasLoadedList, setHasLoadedList] = useState<boolean>(false);
  /** サーバーが 404 を返した（＝ DM 機能が無効） */
  const [isDisabled, setIsDisabled] = useState<boolean>(false);

  const [partner, setPartner] = useState<DmPartner | null>(null);
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [isLoadingThread, setIsLoadingThread] = useState<boolean>(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState<boolean>(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  /** 開いている会話の id（新規の相手にはまだ無いので null） */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [sendText, setSendText] = useState<string>('');
  const [showCw, setShowCw] = useState<boolean>(false);
  const [cwText, setCwText] = useState<string>('');
  const [attachment, setAttachment] = useState<any | null>(null);
  const [isUploadingMedia, setIsUploadingMedia] = useState<boolean>(false);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [notice, setNotice] = useState<{ type: 'error' | 'info'; text: string } | null>(null);

  // 追加読み込みの重複ガードと、開いた相手の取り違え防止
  const threadRequestRef = useRef<number>(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const previousCountRef = useRef<number>(0);
  /** 直近に自動で開いた URL パラメータ（同じ相手を再取得しない） */
  const handledInitialRef = useRef<string>('');

  const isLoggedIn = Boolean(authToken && authUser);
  /** サーバー設定が明示的に off（`/api/server-info` を見て App が判断した値） */
  const featureOff = featureDm === false;
  const closed = isDisabled || featureOff;

  // ==========================================
  // 会話一覧
  // ==========================================
  const loadConversations = useCallback(async (): Promise<DmConversation[]> => {
    if (!isLoggedIn) return [];
    setIsLoadingConversations(true);
    try {
      const res = await api.get('/api/dm/conversations');
      if (res.status === 404) {
        setIsDisabled(true);
        setConversations([]);
        onUnreadChange?.(0);
        return [];
      }
      if (!res.ok) return [];
      const data = await res.json();
      const list: DmConversation[] = Array.isArray(data) ? data : [];
      setConversations(list);
      onUnreadChange?.(totalUnread(list));
      return list;
    } catch {
      return [];
    } finally {
      setIsLoadingConversations(false);
      setHasLoadedList(true);
    }
  }, [api, isLoggedIn, onUnreadChange]);

  // 会話一覧の取得（ログイン直後・相手が変わったとき）
  useEffect(() => {
    if (!isLoggedIn || featureOff) return;
    void loadConversations();
  }, [isLoggedIn, featureOff, loadConversations]);

  // ==========================================
  // スレッド（本文）
  // ==========================================
  const openConversation = useCallback(async (conversationId: string, pushUrl: boolean = true) => {
    if (!isLoggedIn) return;
    const requestId = ++threadRequestRef.current;
    setSelectedId(conversationId);
    setNotice(null);
    setIsLoadingThread(true);
    setNextCursor(null);
    setMessages([]);
    if (pushUrl) pushDmUrl?.(`/dm?c=${encodeURIComponent(conversationId)}`);
    try {
      const res = await api.get(`/api/dm/conversations/${encodeURIComponent(conversationId)}?limit=50`);
      if (requestId !== threadRequestRef.current) return;
      if (res.status === 404) {
        setIsDisabled(true);
        return;
      }
      if (!res.ok) {
        setNotice({ type: 'error', text: '会話を読み込めませんでした。' });
        return;
      }
      const data = await res.json();
      const conversation = data?.conversation;
      const list: DmMessage[] = Array.isArray(data?.messages) ? data.messages : [];
      setPartner(conversation?.partner || null);
      setMessages(list);
      setNextCursor(data?.next_cursor || null);
      // 開いた会話の未読数（サーバーは会話ごとの未読も返す）
      const unread = Number(conversation?.unread_count) || 0;
      if (unread > 0) {
        void markRead(conversationId);
      }
    } catch {
      if (requestId === threadRequestRef.current) {
        setNotice({ type: 'error', text: '会話を読み込めませんでした。' });
      }
    } finally {
      if (requestId === threadRequestRef.current) setIsLoadingThread(false);
    }
  }, [api, isLoggedIn, pushDmUrl]);

  /** 既読にする（スレッドを開いたときに呼ぶ。失敗しても本文は読める） */
  const markRead = useCallback(async (conversationId: string) => {
    try {
      const res = await api.post(`/api/dm/conversations/${encodeURIComponent(conversationId)}/read`);
      if (!res.ok) return;
      setConversations((prev) => {
        const next = prev.map((conv) => (conv.id === conversationId ? { ...conv, unread_count: 0 } : conv));
        onUnreadChange?.(totalUnread(next));
        return next;
      });
    } catch {
      // 既読の記録に失敗しても表示は続ける
    }
  }, [api, onUnreadChange]);

  /**
   * ハンドル（または actor URL）から相手のスレッドを開く。
   * すでに会話があればそれを開き、無ければプロフィール API で名前・アイコンを引いて
   * 「まだメッセージの無いスレッド」を出す（送信時に会話が作られる）。
   */
  const openByTarget = useCallback(async (target: string) => {
    if (!isLoggedIn || !target) return;
    const raw = String(target).trim();
    if (!raw) return;
    const lower = raw.replace(/^@/, '').toLowerCase();
    const existing = conversations.find((conv) => {
      const handle = String(conv.partner?.handle || '').replace(/^@/, '').toLowerCase();
      return handle === lower || conv.partner?.actor_url === raw || conv.id === raw;
    });
    if (existing) {
      void openConversation(existing.id);
      return;
    }

    const requestId = ++threadRequestRef.current;
    setSelectedId(null);
    setMessages([]);
    setNextCursor(null);
    setNotice(null);
    setIsLoadingThread(true);
    pushDmUrl?.(`/dm?to=${encodeURIComponent(raw)}`);
    try {
      const res = await api.get(`/api/users/${encodeURIComponent(raw)}`);
      if (requestId !== threadRequestRef.current) return;
      if (res.ok) {
        const user = await res.json();
        setPartner({
          actor_url: user.actor_url || raw,
          user_id: user.is_local ? user.id : null,
          name: user.name || raw,
          handle: user.handle || raw,
          icon_url: user.icon_url || '',
          is_local: Boolean(user.is_local),
          accepts_dm: null,
        });
      } else {
        // 相手が見つからなくても入力は残す（送信時にサーバーが判定する）
        setPartner({
          actor_url: raw,
          user_id: null,
          name: raw,
          handle: raw,
          icon_url: '',
          is_local: false,
          accepts_dm: null,
        });
      }
    } catch {
      setPartner({
        actor_url: raw,
        user_id: null,
        name: raw,
        handle: raw,
        icon_url: '',
        is_local: false,
        accepts_dm: null,
      });
    } finally {
      if (requestId === threadRequestRef.current) setIsLoadingThread(false);
    }
  }, [api, conversations, isLoggedIn, openConversation, pushDmUrl]);

  // URL パラメータ（`?c=` 通知から / `?to=` プロフィールから）で開く。
  // 会話一覧の取得後に一度だけ実行する（一覧を待たずに `?to=` を引くと二重取得になる）
  useEffect(() => {
    if (!isLoggedIn || closed) return;
    if (!hasLoadedList) return;
    const key = initialConversationId ? `c:${initialConversationId}` : initialTo ? `to:${initialTo}` : '';
    if (!key || handledInitialRef.current === key) return;
    handledInitialRef.current = key;
    if (initialConversationId) {
      void openConversation(String(initialConversationId), false);
    } else {
      void openByTarget(String(initialTo));
    }
  }, [closed, hasLoadedList, initialConversationId, initialTo, isLoggedIn, openByTarget, openConversation]);

  // 古いメッセージを追加で読み込む（先頭に足す）
  const loadOlder = async () => {
    if (!nextCursor || !selectedId || isLoadingOlder) return;
    setIsLoadingOlder(true);
    try {
      const res = await api.get(`/api/dm/conversations/${encodeURIComponent(selectedId)}?limit=50&cursor=${encodeURIComponent(nextCursor)}`);
      if (res.ok) {
        const data = await res.json();
        const older: DmMessage[] = Array.isArray(data?.messages) ? data.messages : [];
        setMessages((prev) => [...older, ...prev]);
        setNextCursor(data?.next_cursor || null);
      }
    } catch {
      // 追加読み込みの失敗は黙って諦める（本文はすでに出ている）
    } finally {
      setIsLoadingOlder(false);
    }
  };

  // 本文の末尾へスクロール（開いたとき・新着のときだけ。過去を読み込んだときは動かさない）
  useEffect(() => {
    const previous = previousCountRef.current;
    previousCountRef.current = messages.length;
    if (messages.length === 0) return;
    if (previous !== 0 && messages.length < previous) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  // 一覧へ戻る（モバイル）
  const closeThread = () => {
    threadRequestRef.current++;
    setPartner(null);
    setSelectedId(null);
    setMessages([]);
    setNextCursor(null);
    setNotice(null);
    setAttachment(null);
    pushDmUrl?.('/dm');
  };

  // ==========================================
  // 送信
  // ==========================================
  const handleSelectMedia = async (files: FileList | null) => {
    if (!files || files.length === 0 || !isLoggedIn) return;
    const file = files[0];
    const isImage = file.type.startsWith('image/');
    const isAv = file.type.startsWith('video/') || file.type.startsWith('audio/');
    if (!isImage && !isAv) {
      setNotice({ type: 'error', text: '画像・動画・音声のみ添付できます。' });
      return;
    }
    setIsUploadingMedia(true);
    setNotice(null);
    try {
      let fileToUpload = file;
      if (prefs.autoCompressImages && isImage) {
        const compressed = await compressImage(file, { maxDimension: 2048, quality: 0.85, format: 'image/webp' });
        fileToUpload = compressed.file;
      }
      const maxSize = isImage ? 15 * 1024 * 1024 : 50 * 1024 * 1024;
      if (fileToUpload.size > maxSize) {
        setNotice({ type: 'error', text: `サイズが${isImage ? '15MB' : '50MB'}を超えています。` });
        return;
      }
      const formData = new FormData();
      formData.append('file', fileToUpload);
      const res = await api.post('/api/media/upload', formData);
      if (res.ok) {
        const data = await res.json();
        const media = Array.isArray(data?.media) ? data.media[0] : data?.attachment;
        if (media) setAttachment(media);
      } else {
        setNotice({ type: 'error', text: 'アップロードに失敗しました。' });
      }
    } catch {
      setNotice({ type: 'error', text: 'アップロードに失敗しました。' });
    } finally {
      setIsUploadingMedia(false);
    }
  };

  const handleSend = async () => {
    if (!isLoggedIn || !partner || isSending || isUploadingMedia) return;
    const content = sendText.trim();
    if (!content && !attachment) return;
    const cw = showCw && cwText.trim() ? cwText.trim() : '';
    setIsSending(true);
    setNotice(null);
    try {
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
      const res = await api.post('/api/dm/messages', {
        to: partner.actor_url || partner.handle,
        content,
        cw: cw || undefined,
        media: attachment ? [attachment] : [],
        in_reply_to: lastMessage?.id,
      });
      if (!res.ok) {
        let message = '送信できませんでした。';
        try {
          const data = await res.json();
          if (data?.error) message = String(data.error);
        } catch {
          // 本文が読めないときは既定の文言のまま
        }
        setNotice({ type: 'error', text: message });
        return;
      }
      const data = await res.json();
      const sent: DmMessage | null = data?.message || null;
      if (sent) {
        setMessages((prev) => [...prev, sent]);
        if (!selectedId && sent.conversation_id) {
          setSelectedId(sent.conversation_id);
          pushDmUrl?.(`/dm?c=${encodeURIComponent(sent.conversation_id)}`);
        }
      }
      setSendText('');
      setCwText('');
      setShowCw(false);
      setAttachment(null);
      // 相手が受け取らない設定のときは控えめに知らせる（送信自体は保存されている）
      if (data?.delivered === false) {
        setNotice({ type: 'info', text: '相手が受け取らない設定のため、このメッセージは届きません（送信は保存されました）。' });
      }
      void loadConversations();
    } catch {
      setNotice({ type: 'error', text: '送信できませんでした。' });
    } finally {
      setIsSending(false);
    }
  };

  const unreadTotal = useMemo(() => totalUnread(conversations), [conversations]);
  const canSend = Boolean(partner) && (Boolean(sendText.trim()) || Boolean(attachment)) && !isSending && !isUploadingMedia;

  // ==========================================
  // 描画
  // ==========================================
  if (!isLoggedIn) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-6 w-full flex-1 pb-24 lg:pb-6">
        <div className="text-center py-20 bg-slate-900/60 rounded-3xl border border-slate-800 space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-slate-800/80 flex items-center justify-center mx-auto text-slate-500">
            <MessageSquare className="w-6 h-6" />
          </div>
          <h3 className="text-base font-bold text-slate-200">メッセージ</h3>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            メッセージの一覧と送受信にはログインが必要です。
          </p>
          <button
            type="button"
            onClick={() => setShowLoginModal(true)}
            className="px-4 py-2 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-md transition cursor-pointer"
          >
            ログイン
          </button>
        </div>
      </main>
    );
  }

  if (closed) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-6 w-full flex-1 pb-24 lg:pb-6">
        <div className="text-center py-20 bg-slate-900/60 rounded-3xl border border-slate-800 space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-slate-800/80 flex items-center justify-center mx-auto text-slate-500">
            <MessageSquare className="w-6 h-6" />
          </div>
          <h3 className="text-base font-bold text-slate-200">メッセージはこのサーバーでは無効です</h3>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            管理者がこの機能をオフにしています。
          </p>
          <button
            type="button"
            onClick={() => navigateToView('timeline')}
            className="px-4 py-2 rounded-xl text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition cursor-pointer"
          >
            タイムラインに戻る
          </button>
        </div>
      </main>
    );
  }

  const threadOpen = Boolean(partner);

  return (
    <main className="max-w-6xl mx-auto px-2 sm:px-4 py-4 w-full flex-1 pb-24 lg:pb-6 space-y-4">
      {/* ヘッダー */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div className="flex items-center space-x-3">
          <button
            onClick={() => navigateToView('timeline')}
            className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
            title="タイムラインに戻る"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h2 className="text-xl font-black text-slate-100 flex items-center space-x-2">
              <MessageSquare className="w-5 h-5 text-indigo-400" />
              <span>メッセージ</span>
              {unreadTotal > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-bold">
                  {unreadTotal} 件の未読
                </span>
              )}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              1対1のメッセージ（相手が許可したときだけ届きます）
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadConversations()}
          disabled={isLoadingConversations}
          className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer self-start sm:self-auto"
          title="更新"
        >
          <RefreshCw className={`w-4 h-4 ${isLoadingConversations ? 'animate-spin text-indigo-400' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[20rem_1fr] gap-4 items-start">
        {/* 📋 会話一覧（モバイルではスレッドを開くと隠れる） */}
        <section className={`${threadOpen ? 'hidden md:block' : 'block'} bg-slate-900/70 border border-slate-800 rounded-3xl overflow-hidden`}>
          <div className="px-4 py-3 border-b border-slate-800/80 flex items-center justify-between">
            <span className="text-xs font-bold text-slate-300">会話</span>
            <span className="text-[10px] text-slate-500">{conversations.length} 件</span>
          </div>
          {isLoadingConversations && conversations.length === 0 ? (
            <div className="text-center py-12">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto text-indigo-400 mb-2" />
              <p className="text-xs text-slate-400">読み込み中...</p>
            </div>
          ) : conversations.length === 0 ? (
            <div className="text-center py-12 px-4 space-y-2">
              <MessageSquare className="w-8 h-8 mx-auto text-slate-600" />
              <p className="text-xs text-slate-400">まだ会話がありません。</p>
              <p className="text-[11px] text-slate-500">
                相手のプロフィールの「メッセージ」から送れます。
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-800/70 max-h-[28rem] md:max-h-[70vh] overflow-y-auto">
              {conversations.map((conv) => {
                const active = selectedId === conv.id;
                const unread = Number(conv.unread_count) || 0;
                return (
                  <li key={conv.id}>
                    <button
                      type="button"
                      onClick={() => void openConversation(conv.id)}
                      className={`w-full text-left px-3.5 py-3 flex items-start space-x-3 transition cursor-pointer ${
                        active ? 'bg-indigo-600/15 border-l-2 border-indigo-500' : 'hover:bg-slate-800/50 border-l-2 border-transparent'
                      }`}
                    >
                      <div className="w-10 h-10 rounded-2xl overflow-hidden bg-gradient-to-tr from-cyan-500 to-indigo-600 flex items-center justify-center font-bold text-white shrink-0 shadow">
                        {conv.partner?.icon_url ? (
                          <img
                            src={conv.partner.icon_url}
                            alt=""
                            className="w-full h-full object-cover"
                            onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
                          />
                        ) : (
                          (conv.partner?.name || '?').slice(0, 1).toUpperCase()
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-xs text-slate-100 truncate">{conv.partner?.name || conv.partner?.handle}</span>
                          <span className="text-[10px] text-slate-500 shrink-0">{formatListTime(conv.last_message?.published_at || conv.updated_at)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-0.5">
                          <span className="text-[11px] text-slate-400 truncate">
                            {conv.last_message?.is_mine ? '自分: ' : ''}
                            {conv.last_message?.cw ? `CW: ${conv.last_message.cw}` : conv.last_message?.content || ''}
                            {conv.last_message?.has_media ? ' 🖼' : ''}
                          </span>
                          {unread > 0 && (
                            <span className="px-1.5 py-0.5 text-[10px] font-black rounded-full bg-rose-500 text-white shadow shrink-0">
                              {unread > 99 ? '99+' : unread}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 💬 スレッド（モバイルでは会話一覧から遷移してくる） */}
        <section className={`${threadOpen ? 'block' : 'hidden md:block'} bg-slate-900/70 border border-slate-800 rounded-3xl overflow-hidden`}>
          {!partner ? (
            <div className="text-center py-24 px-4 space-y-2">
              <MessageSquare className="w-10 h-10 mx-auto text-slate-700" />
              <p className="text-xs text-slate-400">左の一覧から会話を選んでください。</p>
            </div>
          ) : (
            <div className="flex flex-col h-[70vh] md:h-[75vh]">
              {/* 相手のヘッダー */}
              <div className="px-3.5 py-3 border-b border-slate-800/80 flex items-center space-x-3 shrink-0">
                <button
                  type="button"
                  onClick={closeThread}
                  className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition md:hidden cursor-pointer"
                  title="一覧に戻る"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => partner.user_id && openUserProfile(partner.user_id)}
                  className="flex items-center space-x-3 min-w-0 flex-1 text-left cursor-pointer group"
                  title={partner.is_local ? 'プロフィールを開く' : undefined}
                >
                  <div className="w-9 h-9 rounded-2xl overflow-hidden bg-gradient-to-tr from-cyan-500 to-indigo-600 flex items-center justify-center font-bold text-white text-xs shrink-0 shadow">
                    {partner.icon_url ? (
                      <img
                        src={partner.icon_url}
                        alt=""
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
                      />
                    ) : (
                      (partner.name || '?').slice(0, 1).toUpperCase()
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold text-xs text-slate-100 truncate group-hover:text-indigo-300 transition">{partner.name || partner.handle}</p>
                    <p className="text-[10px] text-slate-500 font-mono truncate">{partner.handle}</p>
                  </div>
                </button>
                {partner.accepts_dm === false && (
                  <span className="text-[10px] text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2 py-1 shrink-0 hidden sm:block">
                    受信を許可していません
                  </span>
                )}
              </div>

              {/* 本文 */}
              <div className="flex-1 overflow-y-auto px-3.5 py-4 space-y-3 bg-slate-950/40">
                {isLoadingThread ? (
                  <div className="text-center py-10">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto text-indigo-400 mb-2" />
                    <p className="text-xs text-slate-400">読み込み中...</p>
                  </div>
                ) : (
                  <>
                    {nextCursor && (
                      <div className="text-center">
                        <button
                          type="button"
                          onClick={loadOlder}
                          disabled={isLoadingOlder}
                          className="px-3 py-1.5 rounded-xl text-[11px] font-bold bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 transition cursor-pointer"
                        >
                          {isLoadingOlder ? '読み込み中...' : '以前のメッセージを読み込む'}
                        </button>
                      </div>
                    )}
                    {messages.length === 0 && (
                      <p className="text-center text-[11px] text-slate-500 py-8">
                        まだメッセージがありません。最初の 1 通を送ってみましょう。
                      </p>
                    )}
                    {messages.map((msg) => (
                      <div key={msg.id} className={`flex ${msg.is_mine ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-3.5 py-2.5 border ${
                          msg.is_mine
                            ? 'bg-indigo-600/20 border-indigo-500/30'
                            : 'bg-slate-900/90 border-slate-800'
                        }`}>
                          {msg.cw ? (
                            <div className="mb-1">
                              <span className="inline-flex items-center space-x-1 text-[10px] font-bold text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-1.5 py-0.5">
                                <ShieldAlert className="w-3 h-3" />
                                <span>{msg.cw}</span>
                              </span>
                            </div>
                          ) : null}
                          {msg.content ? (
                            <FormattedPostContent
                              content={msg.content}
                              emojis={msg.emojis && msg.emojis.length > 0 ? JSON.stringify(msg.emojis) : undefined}
                              enableEmojis={prefs.showCustomEmojiImages}
                            />
                          ) : null}
                          {msg.media_attachments && msg.media_attachments.length > 0 && (
                            <div className={`flex flex-wrap gap-1.5 ${msg.content ? 'mt-2' : ''}`}>
                              {msg.media_attachments.slice(0, 1).map((att: any, idx: number) => (
                                <a
                                  key={idx}
                                  href={att.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="block w-40 h-40 rounded-xl overflow-hidden border border-slate-700 bg-slate-950"
                                >
                                  <img
                                    src={att.thumbnailUrl || att.url}
                                    alt={att.description || '添付メディア'}
                                    className="w-full h-full object-cover"
                                    loading="lazy"
                                  />
                                </a>
                              ))}
                            </div>
                          )}
                          <div className={`flex items-center justify-end space-x-1.5 mt-1 text-[10px] ${msg.is_mine ? 'text-indigo-300/70' : 'text-slate-500'}`}>
                            <span>{formatDmTime(msg.published_at, prefs.timeFormat)}</span>
                            {msg.is_mine && <span>{msg.is_read ? '既読' : '送信済み'}</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </>
                )}
                <div ref={bottomRef} />
              </div>

              {/* 送信欄 */}
              <div className="border-t border-slate-800/80 p-3 space-y-2 shrink-0 bg-slate-900/80">
                {notice && (
                  <div className={`px-3 py-2 rounded-xl text-[11px] flex items-center space-x-2 ${
                    notice.type === 'error'
                      ? 'bg-rose-500/10 border border-rose-500/30 text-rose-300'
                      : 'bg-amber-500/10 border border-amber-500/30 text-amber-200'
                  }`}>
                    {notice.type === 'error' ? <AlertCircle className="w-3.5 h-3.5 shrink-0" /> : <Info className="w-3.5 h-3.5 shrink-0" />}
                    <span>{notice.text}</span>
                  </div>
                )}

                {showCw && (
                  <input
                    type="text"
                    value={cwText}
                    onChange={(e) => setCwText(e.target.value)}
                    placeholder="閲覧注意の理由・注記を入力 (例: ネタバレ)"
                    className="w-full bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2 text-xs text-amber-200 placeholder-amber-400/50 focus:ring-2 focus:ring-amber-500 focus:outline-none transition"
                  />
                )}

                {attachment && (
                  <div className="flex items-center space-x-2">
                    <div className="relative w-16 h-16 rounded-xl overflow-hidden border border-slate-700 bg-slate-950">
                      <img src={attachment.thumbnailUrl || attachment.url} alt="添付" className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => setAttachment(null)}
                        className="absolute top-0.5 right-0.5 p-0.5 bg-black/70 hover:bg-rose-600 rounded-full text-white transition cursor-pointer"
                        title="添付を外す"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    <span className="text-[10px] text-slate-500">添付 1 件（メッセージでは 1 枚まで）</span>
                  </div>
                )}

                <div className="flex items-end space-x-2">
                  <textarea
                    rows={2}
                    value={sendText}
                    onChange={(e) => setSendText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                    placeholder={`${partner.name || partner.handle} へメッセージ... (Enter で送信 / Shift+Enter で改行)`}
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-200 placeholder-slate-500 focus:ring-2 focus:ring-indigo-500 focus:outline-none resize-none transition"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSend()}
                    disabled={!canSend}
                    className={`p-3 rounded-xl font-bold shadow-md transition cursor-pointer ${
                      canSend
                        ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
                        : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                    }`}
                    title="送信"
                  >
                    {isSending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </button>
                </div>

                <div className="flex items-center space-x-2">
                  <label
                    className={`cursor-pointer px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-800 text-slate-300 hover:text-indigo-300 text-xs font-semibold flex items-center space-x-1.5 transition border border-slate-700/60 ${
                      attachment || isUploadingMedia ? 'opacity-50 pointer-events-none' : ''
                    }`}
                    title="画像・動画・音声を 1 件まで添付"
                  >
                    {isUploadingMedia ? (
                      <RefreshCw className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                    ) : (
                      <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
                    )}
                    <span className="text-[10px] font-bold">{isUploadingMedia ? 'アップロード中...' : 'メディア'}</span>
                    <input
                      type="file"
                      accept="image/*,video/*,audio/*"
                      disabled={Boolean(attachment) || isUploadingMedia}
                      onChange={(e) => {
                        void handleSelectMedia(e.target.files);
                        e.target.value = '';
                      }}
                      className="hidden"
                    />
                  </label>

                  <button
                    type="button"
                    onClick={() => setShowCw(!showCw)}
                    className={`px-2 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1 border transition cursor-pointer ${
                      showCw
                        ? 'bg-amber-500/20 border-amber-500/40 text-amber-300 shadow-sm'
                        : 'bg-slate-900 border-slate-700/60 text-slate-400 hover:text-amber-300'
                    }`}
                    title="閲覧注意の折りたたみ (CW) を設定"
                  >
                    <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                    <span className="text-[10px] font-bold">CW</span>
                  </button>

                  <span className="text-[10px] text-slate-500 ml-auto">
                    {sendText.length > 0 ? `${sendText.length} 文字` : ''}
                  </span>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
