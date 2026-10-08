/**
 * OnboardingView（アカウント作成直後の初期設定ウィザード）
 *
 * Spica ならではの初期設定を 8 ステップで行う:
 *   1 ようこそ（思想）→ 2 テーマと表示（サーバー同期の prefs）→ 3 プロフィール →
 *   4 鍵と復元（メール登録は任意）→ 5 プライバシー（＋DM）→ 6 フォロー →
 *   7 通知とアプリ（PWA が公式クライアント）→ 8 完了（データ主権）
 *
 * 「他のサーバーへ移っても同じ手順」ではなく、Spica である理由（鍵はあなたのもの・
 * 設定がサーバーに同期される・持ち出せる）が伝わることを優先している。
 *
 * 保存はステップを進むときに行い、途中で ✕ を押しても入力が消えないようにしている
 * （閉じる前にも一度だけ保存を投げる）。テーマと DM は prefs 経由で押した瞬間に保存。
 * 完了フラグ（onboarding_completed）を立てる API は App 側の責務で、この画面は
 * onComplete を呼ぶだけ。
 *
 * App からは React.lazy で読み込むので、初期バンドルには含まれない。
 */
import { useState, type ReactNode } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bell,
  Calendar,
  Check,
  CheckCircle2,
  Download,
  Fingerprint,
  Globe,
  HardDrive,
  ImageIcon,
  KeyRound,
  Lock,
  Mail,
  MessageSquare,
  Palette,
  Radio,
  RefreshCw,
  Search,
  Sliders,
  SmilePlus,
  Sparkles,
  User,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { compressImage } from '../utils/imageCompressor';
import { usePrefs, updatePrefs } from '../prefs';
import { useInstallAvailable, promptInstall, isStandalone } from '../pwa';

/** App の AuthUser のうち、この画面が読む項目だけ（プライバシー系は 0/1 で届く） */
export interface OnboardingUser {
  id: string;
  name?: string;
  summary?: string;
  icon_url?: string;
  email?: string;
  email_verified?: number;
  is_locked?: number | boolean;
  discoverable?: number | boolean;
  noindex?: number | boolean;
  no_ai_training?: number | boolean;
  onboarding_completed?: number;
}

/** メール登録の可否（`/api/auth/recovery/status` の応答） */
export interface OnboardingRecoveryStatus {
  authMode?: string;
  allowEmailRegistration?: boolean;
  mailConfigured?: boolean;
  recoveryAvailable?: boolean;
}

export interface OnboardingViewProps {
  api: any;
  authToken?: string | null;
  authUser: OnboardingUser;
  /** プッシュ通知の説明に出すサーバー名（未取得なら Spica） */
  serverName?: string;
  /** ディレクトリの handle（@id@domain）を組み立てるためのドメイン */
  serverDomain?: string;
  /** ✉️ DM の導線を出すか（サーバー設定 `dm_enabled`） */
  featuresDm?: boolean;
  /** メール登録の可否（サーバーの認証設定） */
  recoveryStatus?: OnboardingRecoveryStatus;
  /** パスワード方式のサーバーか */
  isPasswordAuthMode?: boolean;
  /** VAPID 公開鍵の base64URL を Uint8Array にするヘルパー（App と同じ実装を使う） */
  urlBase64ToUint8Array: (base64String: string) => Uint8Array<ArrayBuffer>;
  /** 購読に成功したとき、設定画面側のプッシュ状態表示も更新する */
  onPushStatusRefresh?: () => void;
  /** PUT /api/user/profile の応答（更新後のユーザー）を App へ返す */
  onUserUpdated?: (user: any) => void;
  /** メール確認が済んだとき、設定画面側の表示も合わせる */
  onEmailVerified?: (email: string) => void;
  /** 完了画面の「最初の投稿を書く」（App がホームの投稿欄へフォーカスする） */
  onWriteFirstPost?: () => void;
  /** 閉じる（✕ / あとで / はじめる）。完了 API と authUser の更新は App 側 */
  onComplete: () => void;
}

const TOTAL_STEPS = 8;
const STEP_WELCOME = 1;
const STEP_APPEARANCE = 2;
const STEP_PROFILE = 3;
const STEP_KEYS = 4;
const STEP_PRIVACY = 5;
const STEP_FOLLOW = 6;
const STEP_NOTIFY = 7;
const STEP_DONE = 8;

const THEME_OPTIONS: { value: 'dark' | 'pure_black' | 'light'; label: string; swatch: string }[] = [
  { value: 'dark', label: 'ダーク', swatch: 'bg-slate-800 border-slate-700' },
  { value: 'pure_black', label: 'ピュアブラック', swatch: 'bg-black border-slate-800' },
  { value: 'light', label: 'ライト', swatch: 'bg-slate-200 border-slate-300' },
];

const ACCENT_OPTIONS: { value: 'indigo' | 'cyan' | 'emerald' | 'purple' | 'rose' | 'amber'; label: string; color: string }[] = [
  { value: 'indigo', label: 'インディゴ', color: '#6366f1' },
  { value: 'cyan', label: 'シアン', color: '#06b6d4' },
  { value: 'emerald', label: 'エメラルド', color: '#10b981' },
  { value: 'purple', label: 'パープル', color: '#a855f7' },
  { value: 'rose', label: 'ローズ', color: '#f43f5e' },
  { value: 'amber', label: 'アンバー', color: '#f59e0b' },
];

const FONT_OPTIONS: { value: 'small' | 'normal' | 'large'; label: string; preview: string }[] = [
  { value: 'small', label: '小さめ', preview: 'text-xs' },
  { value: 'normal', label: '標準', preview: 'text-sm' },
  { value: 'large', label: '大きめ', preview: 'text-base' },
];

/** 0/1・boolean のどちらで来ても真偽値に寄せる */
function toBool(value: number | boolean | undefined): boolean {
  return value === true || Number(value) === 1;
}

/** プライバシー設定の 1 行（スイッチ付き） */
function ToggleRow({ icon, label, hint, checked, onChange }: {
  icon: ReactNode;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 bg-slate-950/60 border border-slate-800 rounded-2xl p-3.5">
      <div className="flex items-start space-x-2.5 min-w-0">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <span className="min-w-0">
          <span className="text-xs font-bold text-slate-100 block">{label}</span>
          <span className="text-[11px] text-slate-500 block mt-0.5 leading-relaxed">{hint}</span>
        </span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition shrink-0 mt-0.5 cursor-pointer ${
          checked ? 'bg-indigo-600' : 'bg-slate-700'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5' : ''
          }`}
        />
      </button>
    </div>
  );
}

/** ようこそステップの「Spica の約束」1 行 */
function PromiseRow({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <li className="flex items-start space-x-3 bg-slate-950/50 border border-slate-800 rounded-2xl p-3.5 text-left">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="text-xs font-bold text-slate-100 block">{title}</span>
        <span className="text-[11px] text-slate-400 block mt-0.5 leading-relaxed">{text}</span>
      </span>
    </li>
  );
}

/** 完了画面の「Spica でできること」1 行 */
function FeatureRow({ icon, name, hint }: { icon: ReactNode; name: string; hint: string }) {
  return (
    <li className="flex items-start space-x-2.5 bg-slate-950/50 border border-slate-800 rounded-2xl px-3 py-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="text-[11px] font-bold text-slate-100 block">{name}</span>
        <span className="text-[11px] text-slate-500 block leading-relaxed">{hint}</span>
      </span>
    </li>
  );
}

export default function OnboardingView(props: OnboardingViewProps) {
  const {
    api,
    authToken,
    authUser,
    serverName,
    serverDomain,
    featuresDm,
    recoveryStatus,
    isPasswordAuthMode,
    urlBase64ToUint8Array,
    onPushStatusRefresh,
    onUserUpdated,
    onEmailVerified,
    onWriteFirstPost,
    onComplete,
  } = props;
  const prefs = usePrefs();
  const [step, setStep] = useState<number>(STEP_WELCOME);

  // プロフィール（ステップ 3）
  const [name, setName] = useState<string>(authUser.name || '');
  const [summary, setSummary] = useState<string>(authUser.summary || '');
  const [iconUrl, setIconUrl] = useState<string>(authUser.icon_url || '');
  const [isUploadingIcon, setIsUploadingIcon] = useState<boolean>(false);

  // 鍵と復元（ステップ 4）— チェックは画面内の自己確認だけ（保存はしない）
  const [masterKeySaved, setMasterKeySaved] = useState<boolean>(false);
  const [emailInput, setEmailInput] = useState<string>(authUser.email || '');
  const [emailCode, setEmailCode] = useState<string>('');
  const [emailVerified, setEmailVerified] = useState<boolean>(Number(authUser.email_verified) === 1);
  const [isSendingEmail, setIsSendingEmail] = useState<boolean>(false);
  const [emailMsg, setEmailMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // プライバシー（ステップ 5）
  const [isLocked, setIsLocked] = useState<boolean>(toBool(authUser.is_locked));
  const [isListed, setIsListed] = useState<boolean>(!(authUser.discoverable === false || Number(authUser.discoverable) === 0));
  const [noindex, setNoindex] = useState<boolean>(toBool(authUser.noindex));
  // 生成AIの学習拒否は既定でオン。ただし初期設定を終えたアカウントが明示的にオフにしていたなら、その意思を尊重する
  const [noAiTraining, setNoAiTraining] = useState<boolean>(
    () => !(Number(authUser.onboarding_completed) === 1 && !toBool(authUser.no_ai_training)),
  );

  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // フォロー（ステップ 6）
  const [directoryUsers, setDirectoryUsers] = useState<any[] | null>(null);
  const [isLoadingUsers, setIsLoadingUsers] = useState<boolean>(false);
  const [followedIds, setFollowedIds] = useState<string[]>([]);
  const [followBusyId, setFollowBusyId] = useState<string | null>(null);
  const [followError, setFollowError] = useState<string | null>(null);

  // 通知とアプリ（ステップ 7）
  const [pushPermission, setPushPermission] = useState<string>(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  );
  const [isSubscribed, setIsSubscribed] = useState<boolean>(false);
  const [isSubscribing, setIsSubscribing] = useState<boolean>(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const installAvailable = useInstallAvailable();
  const [isInstalledApp, setIsInstalledApp] = useState<boolean>(() => isStandalone());

  const mailRegistrationAvailable = Boolean(recoveryStatus?.mailConfigured && recoveryStatus?.allowEmailRegistration);

  // ステップ 3 / 5 で入力した内容をまとめて保存する（サーバーは未指定の項目を現状維持で扱う）
  const saveProfileAndPrivacy = async () => {
    if (!authToken) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const res = await api.put('/api/user/profile', {
        name: name.trim() || authUser.name || '',
        summary: summary.trim(),
        icon_url: iconUrl,
        is_locked: isLocked,
        discoverable: isListed,
        noindex,
        no_ai_training: noAiTraining,
      });
      if (res.ok) {
        const updated = await res.json();
        onUserUpdated?.(updated);
      } else {
        const err = await res.json().catch(() => null);
        setSaveError(err?.error || '設定の保存に失敗しました。');
      }
    } catch (err: any) {
      setSaveError(err?.message || '通信エラーが発生しました。');
    } finally {
      setIsSaving(false);
    }
  };

  // アイコン画像は既存のプロフィール編集と同じ手順（800px・WebP に圧縮してからアップロード）
  const handleUploadIcon = async (files: FileList | null) => {
    if (!files || files.length === 0 || !authToken) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) {
      setSaveError('画像ファイルを選択してください。');
      return;
    }
    setIsUploadingIcon(true);
    setSaveError(null);
    try {
      const compressRes = await compressImage(file, { maxDimension: 800, quality: 0.88, format: 'image/webp' });
      const formData = new FormData();
      formData.append('file', compressRes.file);
      const res = await api.post('/api/media/upload', formData);
      if (res.ok) {
        const data = await res.json();
        const url = data.attachment?.url || data.media?.[0]?.url;
        if (url) {
          setIconUrl(url);
        } else {
          setSaveError('アイコンのアップロードに失敗しました。');
        }
      } else {
        const err = await res.json().catch(() => null);
        setSaveError(err?.error ? `アイコンのアップロードに失敗しました: ${err.error}` : 'アイコンのアップロードに失敗しました。');
      }
    } catch (err: any) {
      setSaveError(`アップロードエラー: ${err?.message || '不明なエラー'}`);
    } finally {
      setIsUploadingIcon(false);
    }
  };

  // メールアドレスの登録（確認コードを送る → コードで確認）。設定画面と同じ API を使う
  const handleSendEmailCode = async () => {
    if (!authToken || !emailInput.trim() || isSendingEmail) return;
    setIsSendingEmail(true);
    setEmailMsg(null);
    try {
      const res = await api.post('/api/user/email', { email: emailInput.trim() });
      const data = await res.json().catch(() => null);
      setEmailMsg(res.ok
        ? { type: 'success', text: data?.message || '確認コードを送信しました。' }
        : { type: 'error', text: data?.error || '送信に失敗しました。' });
    } catch (err: any) {
      setEmailMsg({ type: 'error', text: err?.message || '通信エラーが発生しました。' });
    } finally {
      setIsSendingEmail(false);
    }
  };

  const handleVerifyEmail = async () => {
    if (!authToken || !emailInput.trim() || !emailCode.trim() || isSendingEmail) return;
    setIsSendingEmail(true);
    setEmailMsg(null);
    try {
      const res = await api.post('/api/user/email/verify', { email: emailInput.trim(), code: emailCode.trim() });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        const email = emailInput.trim().toLowerCase();
        setEmailVerified(true);
        setEmailCode('');
        setEmailMsg({ type: 'success', text: data?.message || 'メールアドレスを確認しました。' });
        onEmailVerified?.(email);
      } else {
        setEmailMsg({ type: 'error', text: data?.error || '確認に失敗しました。' });
      }
    } catch (err: any) {
      setEmailMsg({ type: 'error', text: err?.message || '通信エラーが発生しました。' });
    } finally {
      setIsSendingEmail(false);
    }
  };

  // 人気のユーザー（ディレクトリの先頭 20 人をフォロワー数の多い順に）。自分自身は出さない
  const loadDirectory = async () => {
    // 一度読めていれば再取得しない（空・失敗のときはステップに入り直したときに再試行する）
    if (isLoadingUsers || (directoryUsers !== null && directoryUsers.length > 0)) return;
    setIsLoadingUsers(true);
    setFollowError(null);
    try {
      const res = await api.get('/api/directory?limit=20', { auth: false });
      const data = res.ok ? await res.json() : null;
      const list: any[] = Array.isArray(data?.users) ? data.users : [];
      setDirectoryUsers(
        list
          .filter((u: any) => u && u.id !== authUser.id)
          .sort((a: any, b: any) => Number(b.follower_count ?? 0) - Number(a.follower_count ?? 0)),
      );
    } catch {
      setDirectoryUsers([]);
      setFollowError('人気のユーザーを読み込めませんでした。');
    } finally {
      setIsLoadingUsers(false);
    }
  };

  // ディレクトリの応答に handle が無いので、ここで組み立てる（@id@domain 形式）
  const handleFor = (user: any) => (serverDomain ? `@${user.id}@${serverDomain}` : `@${user.id}`);

  const handleFollow = async (user: any) => {
    if (!authToken || followBusyId) return;
    setFollowBusyId(user.id);
    setFollowError(null);
    try {
      const res = await api.post('/api/follow', { targetHandle: handleFor(user) });
      if (res.ok) {
        setFollowedIds((prev) => (prev.includes(user.id) ? prev : [...prev, user.id]));
      } else {
        const err = await res.json().catch(() => null);
        setFollowError(err?.error || `${user.name || user.id} さんのフォローに失敗しました。`);
      }
    } catch (err: any) {
      setFollowError(err?.message || '通信エラーが発生しました。');
    } finally {
      setFollowBusyId(null);
    }
  };

  // 現在の購読状況（許可済み・購読済み）をステップ 7 に入った時点で確認する
  const refreshPushState = async () => {
    if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushPermission('unsupported');
      return;
    }
    setPushPermission(Notification.permission);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setIsSubscribed(Boolean(sub));
    } catch {}
  };

  // プッシュ通知の有効化（設定画面の手順と同じ: 許可 → VAPID 公開鍵 → 購読 → サーバー登録）
  const handleEnablePush = async () => {
    if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushError('お使いのブラウザまたは環境は Web Push 通知に対応していません。');
      return;
    }
    setIsSubscribing(true);
    setPushError(null);
    try {
      const perm = await Notification.requestPermission();
      setPushPermission(perm);
      if (perm !== 'granted') {
        setPushError('プッシュ通知の許可が拒否されました。ブラウザの設定から通知を許可してください。');
        return;
      }

      const keyRes = await api.get('/api/push/vapid-public-key', { auth: false });
      const { publicKey } = await keyRes.json();
      if (!publicKey) throw new Error('VAPID 公開鍵を取得できませんでした。');

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const subRes = await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
      if (!subRes.ok) {
        const err = await subRes.json().catch(() => null);
        throw new Error(err?.error || 'プッシュ通知の登録に失敗しました。');
      }
      setIsSubscribed(true);
      onPushStatusRefresh?.();
    } catch (err: any) {
      setPushError(err?.message || 'プッシュ通知の登録中にエラーが発生しました。');
    } finally {
      setIsSubscribing(false);
    }
  };

  const handleInstall = async () => {
    const installed = await promptInstall();
    if (installed) setIsInstalledApp(true);
  };

  // ステップに入ったときの読み込み（6 = 人気のユーザー / 7 = プッシュの購読状況）
  const enterStep = (next: number) => {
    if (next === STEP_FOLLOW) void loadDirectory();
    if (next === STEP_NOTIFY) void refreshPushState();
  };

  // ステップを進める（入力のあるステップを抜けるときに保存する）
  const goNext = async () => {
    if (step === STEP_PROFILE || step === STEP_PRIVACY) {
      await saveProfileAndPrivacy();
    }
    const next = Math.min(step + 1, TOTAL_STEPS);
    setStep(next);
    enterStep(next);
  };

  // 1 つ前のステップへ戻る
  const goBack = () => {
    const prev = Math.max(1, step - 1);
    setStep(prev);
    enterStep(prev);
  };

  // ✕ / 「あとで」/ 「はじめる」はすべて完了扱い。未保存の編集があっても失わないよう、
  // 閉じる前にも保存を投げておく（完了 API は App 側が呼ぶ）
  const finish = () => {
    if (step === STEP_PROFILE || step === STEP_PRIVACY) void saveProfileAndPrivacy();
    onComplete();
  };

  // 完了画面から最初の投稿へ（ウィザードを閉じてから、App がホームの投稿欄へフォーカスする）
  const finishAndWritePost = () => {
    finish();
    onWriteFirstPost?.();
  };

  const progressPercent = (step / TOTAL_STEPS) * 100;
  const displayName = name.trim() || authUser.name || '';

  return (
    <div className="fixed inset-0 z-[95] bg-slate-950/95 backdrop-blur-md flex flex-col">
      {/* 上部: 進捗バーと閉じるボタン */}
      <div className="shrink-0">
        <div className="h-1.5 bg-slate-800">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <div className="max-w-2xl mx-auto w-full px-4 pt-3 flex items-center justify-between">
          <button
            type="button"
            onClick={finish}
            title="あとで設定する"
            aria-label="初期設定を閉じる"
            className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
          <span className="text-[11px] font-bold text-slate-500">
            {step} / {TOTAL_STEPS}
          </span>
        </div>
      </div>

      {/* 中央: ステップ本体 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="min-h-full flex items-center justify-center p-4 sm:p-6">
          <div className="w-full max-w-xl bg-slate-900 border border-slate-750 rounded-3xl p-6 sm:p-8 shadow-2xl space-y-5">

            {/* 1. ようこそ（Spica の思想） */}
            {step === STEP_WELCOME && (
              <div className="text-center space-y-4">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white shadow-lg mx-auto">
                  <Sparkles className="w-7 h-7" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-lg font-black text-slate-100">Spica へようこそ！</h2>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    このサーバーは誰か一人のものではなく、あなたが参加する一つのノードです。
                    投稿もフォローも、あなたの名前でここに残ります。
                  </p>
                </div>

                <ul className="space-y-2 pt-1">
                  <PromiseRow
                    icon={<KeyRound className="w-4 h-4 text-amber-400" />}
                    title="鍵はあなたのもの"
                    text="アカウントは暗号鍵で守られます。パスワードを預ける必要はありません。"
                  />
                  <PromiseRow
                    icon={<Globe className="w-4 h-4 text-sky-400" />}
                    title="どこへでも繋がる"
                    text="Fediverse の他のサーバーの人とも、そのまま会話できます。"
                  />
                  <PromiseRow
                    icon={<Download className="w-4 h-4 text-emerald-400" />}
                    title="持ち出せる"
                    text="投稿もフォローも、いつでも丸ごとエクスポートできます。"
                  />
                </ul>

                <div className="pt-2 space-y-3">
                  <button
                    type="button"
                    onClick={() => void goNext()}
                    className="w-full py-3 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition flex items-center justify-center space-x-1.5 cursor-pointer"
                  >
                    <span>はじめる</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={finish}
                    className="text-[11px] text-slate-500 hover:text-slate-300 underline transition cursor-pointer"
                  >
                    あとで
                  </button>
                </div>
              </div>
            )}

            {/* 2. テーマと表示（prefs に保存される＝別端末でも同じ見た目） */}
            {step === STEP_APPEARANCE && (
              <div className="space-y-5">
                <div className="flex items-center space-x-2.5">
                  <div className="w-10 h-10 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-300">
                    <Palette className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-slate-100">テーマと表示</h2>
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      表示の設定はサーバーに保存されます。別の端末でログインしても同じ見た目になります。
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <span className="text-xs font-bold text-slate-300 block">テーマ</span>
                  <div className="grid grid-cols-3 gap-2">
                    {THEME_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => updatePrefs({ themeMode: option.value })}
                        aria-pressed={prefs.themeMode === option.value}
                        className={`rounded-2xl border p-2.5 transition cursor-pointer ${
                          prefs.themeMode === option.value
                            ? 'border-indigo-500 bg-indigo-500/10'
                            : 'border-slate-800 bg-slate-950/60 hover:border-slate-700'
                        }`}
                      >
                        <span className={`block h-10 rounded-xl border ${option.swatch}`} />
                        <span className="block text-[11px] font-bold text-slate-200 mt-2">{option.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <span className="text-xs font-bold text-slate-300 block">アクセントカラー</span>
                  <div className="flex flex-wrap gap-2.5">
                    {ACCENT_OPTIONS.map((option) => {
                      const selected = prefs.accentColor === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => updatePrefs({ accentColor: option.value })}
                          title={option.label}
                          aria-label={option.label}
                          aria-pressed={selected}
                          className={`relative w-9 h-9 rounded-full transition cursor-pointer ${
                            selected ? 'scale-110 ring-2 ring-slate-400' : 'opacity-80 hover:opacity-100'
                          }`}
                          style={{ backgroundColor: option.color }}
                        >
                          {selected && <Check className="absolute inset-0 m-auto w-4 h-4 text-white drop-shadow" />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-2">
                  <span className="text-xs font-bold text-slate-300 block">文字サイズ</span>
                  <div className="grid grid-cols-3 gap-2">
                    {FONT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => updatePrefs({ fontSize: option.value })}
                        aria-pressed={prefs.fontSize === option.value}
                        className={`rounded-2xl border py-2.5 text-center transition cursor-pointer ${
                          prefs.fontSize === option.value
                            ? 'border-indigo-500 bg-indigo-500/10'
                            : 'border-slate-800 bg-slate-950/60 hover:border-slate-700'
                        }`}
                      >
                        <span className={`block text-slate-100 ${option.preview}`}>Aa</span>
                        <span className="block text-[11px] font-bold text-slate-200 mt-0.5">{option.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <p className="text-[11px] text-slate-500 leading-relaxed">
                  選んだ内容はすぐに画面へ反映されます。あとから「設定 → 表示」で変えられます。
                </p>
              </div>
            )}

            {/* 3. プロフィール設定 */}
            {step === STEP_PROFILE && (
              <div className="space-y-5">
                <div className="flex items-center space-x-2.5">
                  <div className="w-10 h-10 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-300">
                    <User className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-slate-100">プロフィール設定</h2>
                    <p className="text-[11px] text-slate-500">これらの設定は後から変更できます。</p>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center gap-3.5">
                  <div className="w-20 h-20 rounded-2xl p-1 bg-slate-900 border-2 border-slate-700/80 shadow-xl shrink-0 overflow-hidden">
                    {iconUrl ? (
                      <img
                        src={iconUrl}
                        alt="アイコンのプレビュー"
                        className="w-full h-full rounded-xl object-cover"
                        onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div className="w-full h-full rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-2xl text-white">
                        {(displayName || 'A').slice(0, 1).toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <label
                      className={`cursor-pointer px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 text-xs font-bold inline-flex items-center space-x-1.5 transition ${
                        isUploadingIcon ? 'opacity-50 pointer-events-none' : ''
                      }`}
                    >
                      {isUploadingIcon ? (
                        <RefreshCw className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                      ) : (
                        <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
                      )}
                      <span>{isUploadingIcon ? '最適化・保存中...' : 'アイコン画像を変更'}</span>
                      <input
                        type="file"
                        accept="image/*"
                        disabled={isUploadingIcon}
                        onChange={(e) => {
                          void handleUploadIcon(e.target.files);
                          e.target.value = '';
                        }}
                        className="hidden"
                      />
                    </label>
                    <p className="text-[11px] text-slate-500">長辺800pxに自動最適化されます。</p>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1.5">名前</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={50}
                    placeholder="例: Alice"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1.5">自己紹介</label>
                  <textarea
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    rows={4}
                    maxLength={500}
                    placeholder="好きなことや、興味のあることを書いてみましょう。"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition resize-y"
                  />
                </div>
              </div>
            )}

            {/* 4. あなたの鍵と復元（マスターキーの自己確認・任意のメール登録） */}
            {step === STEP_KEYS && (
              <div className="space-y-4">
                <div className="flex items-center space-x-2.5">
                  <div className="w-10 h-10 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-300">
                    <KeyRound className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-slate-100">あなたの鍵と、もしもの備え</h2>
                  </div>
                </div>

                <p className="text-xs text-slate-400 leading-relaxed">
                  Spica はパスワードを預からずにアカウントを守ります。
                  <strong className="text-slate-200">マスターキー</strong>がアカウントの最終的な鍵です。
                  なくすと、誰にも復旧できません。
                </p>

                <label className="flex items-start space-x-3 bg-slate-950/60 border border-slate-800 rounded-2xl p-3.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={masterKeySaved}
                    onChange={(e) => setMasterKeySaved(e.target.checked)}
                    className="mt-0.5 w-4 h-4 accent-indigo-500 cursor-pointer"
                  />
                  <span className="text-xs text-slate-200 leading-relaxed">
                    マスターキーを安全な場所（パスワードマネージャー等）に保存した
                  </span>
                </label>

                {mailRegistrationAvailable ? (
                  <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3.5 space-y-3">
                    <div className="flex items-center space-x-2">
                      <Mail className="w-4 h-4 text-indigo-400" />
                      <span className="text-xs font-bold text-slate-100">メールアドレスを登録する（任意）</span>
                    </div>
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      メールを登録しておくと、鍵をなくしたときに復元できます。
                    </p>
                    {emailVerified ? (
                      <p className="text-[11px] text-emerald-300 flex items-center space-x-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>登録済み: {emailInput}</span>
                      </p>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="email"
                            value={emailInput}
                            onChange={(e) => setEmailInput(e.target.value)}
                            placeholder="you@example.com"
                            className="w-full sm:flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                          />
                          <button
                            type="button"
                            onClick={() => void handleSendEmailCode()}
                            disabled={isSendingEmail || !emailInput.trim()}
                            className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 text-xs font-bold transition shrink-0 cursor-pointer"
                          >
                            確認コードを送信
                          </button>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="text"
                            value={emailCode}
                            onChange={(e) => setEmailCode(e.target.value)}
                            placeholder="確認コード"
                            inputMode="numeric"
                            className="w-full sm:flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition font-mono"
                          />
                          <button
                            type="button"
                            onClick={() => void handleVerifyEmail()}
                            disabled={isSendingEmail || !emailCode.trim()}
                            className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold transition shrink-0 cursor-pointer"
                          >
                            登録する
                          </button>
                        </div>
                        {emailMsg && (
                          <p className={`text-[11px] leading-relaxed ${emailMsg.type === 'success' ? 'text-emerald-300' : 'text-rose-300'}`}>
                            {emailMsg.text}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ) : isPasswordAuthMode ? (
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    このサーバーはメールアドレスとパスワードでログインします（登録済み）。
                    マスターキーは緊急時の最終手段です。
                  </p>
                ) : (
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    このサーバーではメール登録が無効です。マスターキーの保管だけお願いします。
                  </p>
                )}

                <p className="text-[11px] text-slate-500 leading-relaxed flex items-start space-x-1.5">
                  <Fingerprint className="w-3.5 h-3.5 shrink-0 mt-0.5 text-indigo-400" />
                  <span>
                    Windows Hello / Touch ID などのパスキーも登録できます（設定 → アカウント・連合 → パスキー / 生体認証）。
                  </span>
                </p>
              </div>
            )}

            {/* 5. プライバシー設定（＋ DM の受け取り） */}
            {step === STEP_PRIVACY && (
              <div className="space-y-4">
                <div className="flex items-center space-x-2.5">
                  <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-300">
                    <Lock className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-slate-100">プライバシー設定</h2>
                    <p className="text-[11px] text-slate-500">これらの設定は後から変更できます。</p>
                  </div>
                </div>

                <ToggleRow
                  icon={<Lock className="w-4 h-4 text-amber-400" />}
                  label="フォローを承認制にする"
                  hint="新しいフォローは自動承認せず、リクエストとして届きます。承認した相手だけがフォロワーになります。"
                  checked={isLocked}
                  onChange={setIsLocked}
                />
                <ToggleRow
                  icon={<Users className="w-4 h-4 text-sky-400" />}
                  label="ユーザー一覧（ディレクトリ）に載せない"
                  hint="オンにすると、このサーバーのユーザー一覧にあなたが表示されなくなります。"
                  checked={!isListed}
                  onChange={(checked) => setIsListed(!checked)}
                />
                <ToggleRow
                  icon={<Search className="w-4 h-4 text-slate-300" />}
                  label="検索エンジンによるインデックスを拒否"
                  hint="検索エンジンに拾われないよう、あなたのプロフィールの robots メタで意思表示します。"
                  checked={noindex}
                  onChange={setNoindex}
                />
                <ToggleRow
                  icon={<Sparkles className="w-4 h-4 text-purple-400" />}
                  label="生成AIによる学習を拒否"
                  hint="生成AIの学習にあなたのコンテンツを使わないよう、robots メタで意思表示します。"
                  checked={noAiTraining}
                  onChange={setNoAiTraining}
                />

                {featuresDm && (
                  <ToggleRow
                    icon={<MessageSquare className="w-4 h-4 text-indigo-400" />}
                    label="メッセージ（DM）を受け取る"
                    hint="受け取る場合も、許可した相手からのメッセージだけが届きます（既定では誰からも届きません）。許可する相手は設定 → メッセージから追加できます。"
                    checked={prefs.dmPolicy === 'allowlist'}
                    onChange={(checked) => updatePrefs({ dmPolicy: checked ? 'allowlist' : 'noone' })}
                  />
                )}

                <p className="text-[11px] text-slate-500 leading-relaxed">
                  この他の様々な設定は「設定」ページから行えます。
                </p>
              </div>
            )}

            {/* 6. フォロー */}
            {step === STEP_FOLLOW && (
              <div className="space-y-4">
                <div className="flex items-center space-x-2.5">
                  <div className="w-10 h-10 rounded-2xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-300">
                    <Users className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-slate-100">フォロー</h2>
                    <p className="text-[11px] text-slate-500">
                      タイムラインを構築するため、気になるユーザーをフォローしてみましょう。
                    </p>
                  </div>
                </div>

                {/* 推奨（おすすめの算出は未実装なので、いまは常に空） */}
                <div className="space-y-2">
                  <h3 className="text-xs font-bold text-slate-300">推奨</h3>
                  <div className="p-4 text-center bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                    ありません
                  </div>
                </div>

                <div className="space-y-2">
                  <h3 className="text-xs font-bold text-slate-300">人気のユーザー</h3>
                  {isLoadingUsers ? (
                    <div className="text-center py-6">
                      <RefreshCw className="w-5 h-5 animate-spin mx-auto text-indigo-400 mb-2" />
                      <p className="text-xs text-slate-400">読み込み中...</p>
                    </div>
                  ) : !directoryUsers || directoryUsers.length === 0 ? (
                    <div className="p-4 text-center bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                      ありません
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-72 overflow-y-auto pr-0.5">
                      {directoryUsers.map((user: any) => (
                        <div
                          key={user.id}
                          className="flex items-start space-x-3 bg-slate-950/50 border border-slate-800 rounded-2xl p-3.5"
                        >
                          {user.icon_url ? (
                            <img src={user.icon_url} alt="" className="w-11 h-11 rounded-full object-cover shrink-0" />
                          ) : (
                            <div className="w-11 h-11 rounded-full bg-slate-800 shrink-0" />
                          )}
                          <div className="min-w-0 flex-1">
                            <span className="font-bold text-sm text-slate-100 block truncate">
                              {user.name || user.id}
                            </span>
                            <span className="text-[11px] text-slate-400 block truncate">{handleFor(user)}</span>
                            {user.summary && (
                              <p className="text-[11px] text-slate-300 mt-1 line-clamp-2 whitespace-pre-wrap break-words">
                                {user.summary}
                              </p>
                            )}
                            <span className="text-[10px] text-slate-500 font-mono block mt-1">
                              フォロワー {Number(user.follower_count ?? 0)}
                            </span>
                          </div>
                          {followedIds.includes(user.id) ? (
                            <span className="px-3 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-emerald-300 text-xs font-bold flex items-center space-x-1 shrink-0">
                              <Check className="w-3.5 h-3.5" />
                              <span>フォロー中</span>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void handleFollow(user)}
                              disabled={followBusyId === user.id}
                              className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold shadow-lg shadow-indigo-600/30 transition flex items-center space-x-1 shrink-0 cursor-pointer"
                            >
                              {followBusyId === user.id ? (
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <UserPlus className="w-3.5 h-3.5" />
                              )}
                              <span>フォロー</span>
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <p className="text-[11px] text-slate-500 leading-relaxed">
                  タイムラインは「アンテナ」や「リスト」でも整理できます（どちらもタイムライン左のメニューから）。
                </p>
              </div>
            )}

            {/* 7. 通知とアプリ（PWA が公式クライアント） */}
            {step === STEP_NOTIFY && (
              <div className="space-y-4">
                <div className="flex items-center space-x-2.5">
                  <div className="w-10 h-10 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-300">
                    <Bell className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-slate-100">通知とアプリ</h2>
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      Spica に公式アプリはありません。その代わり、ブラウザのままアプリのように使えます。
                    </p>
                  </div>
                </div>

                <p className="text-xs text-slate-400 leading-relaxed">
                  プッシュ通知を有効にすると {serverName || 'Spica'} の通知をお使いのデバイスで受け取ることができます。
                </p>

                <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3.5 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">この端末の通知の許可</span>
                    <span className="font-bold text-slate-200">
                      {pushPermission === 'granted' ? '許可済み'
                        : pushPermission === 'denied' ? 'ブロック中'
                          : pushPermission === 'unsupported' ? '非対応'
                            : '未設定'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">プッシュ通知の購読</span>
                    <span className={`font-bold flex items-center space-x-1 ${isSubscribed ? 'text-emerald-300' : 'text-slate-200'}`}>
                      {isSubscribed && <CheckCircle2 className="w-3.5 h-3.5" />}
                      <span>{isSubscribed ? '購読済み' : '未購読'}</span>
                    </span>
                  </div>
                </div>

                {isSubscribed ? (
                  <p className="text-[11px] text-emerald-300/90 leading-relaxed">
                    この端末ではプッシュ通知が有効になっています。通知は「設定」→「通知」からいつでも変更できます。
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleEnablePush()}
                    disabled={isSubscribing || pushPermission === 'denied' || pushPermission === 'unsupported'}
                    className="w-full py-3 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white shadow-lg shadow-indigo-600/30 transition flex items-center justify-center space-x-1.5 cursor-pointer"
                  >
                    {isSubscribing ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Bell className="w-3.5 h-3.5" />
                    )}
                    <span>{isSubscribing ? '設定中...' : 'プッシュ通知を有効化'}</span>
                  </button>
                )}

                {pushPermission === 'denied' && !isSubscribed && (
                  <p className="text-[11px] text-amber-300/90 leading-relaxed">
                    ブラウザで通知がブロックされています。ブラウザの設定からこのサイトの通知を許可してください。
                  </p>
                )}

                <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3.5 space-y-2">
                  <div className="flex items-center space-x-2">
                    <Download className="w-4 h-4 text-indigo-400" />
                    <span className="text-xs font-bold text-slate-100">ホーム画面に追加</span>
                  </div>
                  {isInstalledApp ? (
                    <p className="text-[11px] text-emerald-300/90 flex items-center space-x-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>すでにアプリとして開いています。</span>
                    </p>
                  ) : installAvailable ? (
                    <>
                      <p className="text-[11px] text-slate-500 leading-relaxed">
                        ホーム画面に追加すると、全画面で起動できて通知も受け取りやすくなります。
                      </p>
                      <button
                        type="button"
                        onClick={() => void handleInstall()}
                        className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold transition flex items-center space-x-1.5 cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>ホーム画面に追加</span>
                      </button>
                    </>
                  ) : (
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      お使いのブラウザのメニューから「ホーム画面に追加」「アプリをインストール」を選んでもかまいません。
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* 8. 完了（データ主権 + Spica でできること） */}
            {step === STEP_DONE && (
              <div className="space-y-5">
                <div className="text-center space-y-4">
                  <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-600 flex items-center justify-center text-white shadow-lg mx-auto">
                    <CheckCircle2 className="w-7 h-7" />
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-lg font-black text-slate-100">初期設定が完了しました！</h2>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      投稿もフォローも、<strong className="text-slate-200">あなたのデータはあなたのものです</strong>。
                      設定 → アカウント・連合の「データのエクスポート」からいつでも丸ごと持ち出せます。
                    </p>
                  </div>
                </div>

                {/* Spica でできること（テキストのみ。行き先を添えておく） */}
                <div className="space-y-2 text-left">
                  <h3 className="text-xs font-bold text-slate-300">Spica でできること</h3>
                  <ul className="space-y-1.5">
                    <FeatureRow
                      icon={<Radio className="w-4 h-4 text-indigo-400" />}
                      name="アンテナ"
                      hint="条件を決めておくと投稿が自動で集まる、自分専用のタイムライン（タイムライン左のメニュー）。"
                    />
                    <FeatureRow
                      icon={<MessageSquare className="w-4 h-4 text-sky-400" />}
                      name="チャンネル"
                      hint="話題ごとの場所。掲示板のようにも使えます（タイムライン左のメニュー）。"
                    />
                    <FeatureRow
                      icon={<Calendar className="w-4 h-4 text-amber-400" />}
                      name="予約投稿と下書き"
                      hint="時間を決めて投稿したり、書きかけを保存できます（投稿欄の「下書き」「予約」）。"
                    />
                    <FeatureRow
                      icon={<HardDrive className="w-4 h-4 text-emerald-400" />}
                      name="ドライブ"
                      hint="投稿に添付した画像や動画をまとめて管理できます（タイムライン左のメニュー）。"
                    />
                    <FeatureRow
                      icon={<SmilePlus className="w-4 h-4 text-rose-400" />}
                      name="絵文字リアクション"
                      hint="決まった絵文字だけでなく、好きな絵文字で気持ちを伝えられます。"
                    />
                    <FeatureRow
                      icon={<Sliders className="w-4 h-4 text-slate-300" />}
                      name="キーボードショートカット"
                      hint="キーだけで移動・投稿・検索ができます（既定はオフ。設定 → 表示）。"
                    />
                  </ul>
                </div>

                <div className="pt-1 space-y-2">
                  <button
                    type="button"
                    onClick={finishAndWritePost}
                    className="w-full py-3 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition flex items-center justify-center space-x-1.5 cursor-pointer"
                  >
                    <span>✍️ 最初の投稿を書く</span>
                  </button>
                  <button
                    type="button"
                    onClick={finish}
                    className="w-full py-2.5 rounded-xl text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition cursor-pointer"
                  >
                    はじめる
                  </button>
                </div>
              </div>
            )}

            {/* エラー通知（保存・アップロード・フォロー・プッシュ） */}
            {saveError && (
              <div className="p-3 rounded-2xl text-[11px] font-semibold flex items-start space-x-2 bg-rose-500/15 border border-rose-500/30 text-rose-300">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{saveError}</span>
              </div>
            )}
            {followError && (
              <div className="p-3 rounded-2xl text-[11px] font-semibold flex items-start space-x-2 bg-rose-500/15 border border-rose-500/30 text-rose-300">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{followError}</span>
              </div>
            )}
            {pushError && (
              <div className="p-3 rounded-2xl text-[11px] font-semibold flex items-start space-x-2 bg-rose-500/15 border border-rose-500/30 text-rose-300">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{pushError}</span>
              </div>
            )}

            {/* ナビゲーション（ステップ 1 と完了は本文側にボタンを置く） */}
            {step >= STEP_APPEARANCE && step <= STEP_NOTIFY && (
              <div className="pt-1 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={goBack}
                  disabled={isSaving}
                  className="px-4 py-2.5 rounded-xl text-xs font-bold bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 transition flex items-center space-x-1.5 cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>戻る</span>
                </button>
                <button
                  type="button"
                  onClick={() => void goNext()}
                  disabled={isSaving}
                  className="px-5 py-2.5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white shadow-lg shadow-indigo-600/30 transition flex items-center space-x-1.5 cursor-pointer"
                >
                  {isSaving ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <span>続ける</span>
                  )}
                  {!isSaving && <ArrowRight className="w-3.5 h-3.5" />}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
