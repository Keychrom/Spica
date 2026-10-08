/**
 * OnboardingView（アカウント作成直後の初期設定ウィザード）
 *
 * Misskey のオンボーディングと同じ流れの 6 ステップ
 * （ようこそ → プロフィール → プライバシー → フォロー → プッシュ通知 → 完了）を
 * Spica の見た目で行う。
 *
 * 保存はステップを進むときに行い、途中で ✕ を押しても入力が消えないようにしている
 * （閉じる前にも一度だけ保存を投げる）。完了フラグ（onboarding_completed）を立てる
 * API は App 側の責務で、この画面は onComplete を呼ぶだけ。
 *
 * App からは React.lazy で読み込むので、初期バンドルには含まれない。
 */
import { useState, type ReactNode } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  CheckCircle2,
  ImageIcon,
  Lock,
  RefreshCw,
  Search,
  Sparkles,
  User,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { compressImage } from '../utils/imageCompressor';

/** App の AuthUser のうち、この画面が読む項目だけ（プライバシー系は 0/1 で届く） */
export interface OnboardingUser {
  id: string;
  name?: string;
  summary?: string;
  icon_url?: string;
  is_locked?: number | boolean;
  discoverable?: number | boolean;
  noindex?: number | boolean;
  no_ai_training?: number | boolean;
  onboarding_completed?: number;
}

export interface OnboardingViewProps {
  api: any;
  authToken?: string | null;
  authUser: OnboardingUser;
  /** プッシュ通知の説明に出すサーバー名（未取得なら Spica） */
  serverName?: string;
  /** ディレクトリの handle（@id@domain）を組み立てるためのドメイン */
  serverDomain?: string;
  /** VAPID 公開鍵の base64URL を Uint8Array にするヘルパー（App と同じ実装を使う） */
  urlBase64ToUint8Array: (base64String: string) => Uint8Array<ArrayBuffer>;
  /** 購読に成功したとき、設定画面側のプッシュ状態表示も更新する */
  onPushStatusRefresh?: () => void;
  /** PUT /api/user/profile の応答（更新後のユーザー）を App へ返す */
  onUserUpdated?: (user: any) => void;
  /** 閉じる（✕ / あとで / はじめる）。完了 API と authUser の更新は App 側 */
  onComplete: () => void;
}

const TOTAL_STEPS = 6;

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

export default function OnboardingView(props: OnboardingViewProps) {
  const { api, authToken, authUser, serverName, serverDomain, urlBase64ToUint8Array, onPushStatusRefresh, onUserUpdated, onComplete } = props;
  const [step, setStep] = useState<number>(1);

  // プロフィール（ステップ 2）
  const [name, setName] = useState<string>(authUser.name || '');
  const [summary, setSummary] = useState<string>(authUser.summary || '');
  const [iconUrl, setIconUrl] = useState<string>(authUser.icon_url || '');
  const [isUploadingIcon, setIsUploadingIcon] = useState<boolean>(false);

  // プライバシー（ステップ 3）
  const [isLocked, setIsLocked] = useState<boolean>(toBool(authUser.is_locked));
  const [isListed, setIsListed] = useState<boolean>(!(authUser.discoverable === false || Number(authUser.discoverable) === 0));
  const [noindex, setNoindex] = useState<boolean>(toBool(authUser.noindex));
  // 生成AIの学習拒否は既定でオン。ただし初期設定を終えたアカウントが明示的にオフにしていたなら、その意思を尊重する
  const [noAiTraining, setNoAiTraining] = useState<boolean>(
    () => !(Number(authUser.onboarding_completed) === 1 && !toBool(authUser.no_ai_training)),
  );

  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // フォロー（ステップ 4）
  const [directoryUsers, setDirectoryUsers] = useState<any[] | null>(null);
  const [isLoadingUsers, setIsLoadingUsers] = useState<boolean>(false);
  const [followedIds, setFollowedIds] = useState<string[]>([]);
  const [followBusyId, setFollowBusyId] = useState<string | null>(null);
  const [followError, setFollowError] = useState<string | null>(null);

  // プッシュ通知（ステップ 5）
  const [pushPermission, setPushPermission] = useState<string>(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  );
  const [isSubscribed, setIsSubscribed] = useState<boolean>(false);
  const [isSubscribing, setIsSubscribing] = useState<boolean>(false);
  const [pushError, setPushError] = useState<string | null>(null);

  // ステップ 2 / 3 で入力した内容をまとめて保存する（サーバーは未指定の項目を現状維持で扱う）
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

  // 現在の購読状況（許可済み・購読済み）をステップ 5 に入った時点で確認する
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

  // ステップに入ったときの読み込み（4 = 人気のユーザー / 5 = プッシュの購読状況）
  const enterStep = (next: number) => {
    if (next === 4) void loadDirectory();
    if (next === 5) void refreshPushState();
  };

  // ステップを進める（入力のあるステップを抜けるときに保存する）
  const goNext = async () => {
    if (step === 2 || step === 3) {
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
    if (step === 2 || step === 3) void saveProfileAndPrivacy();
    onComplete();
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

            {/* 1. ようこそ */}
            {step === 1 && (
              <div className="text-center space-y-4">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white shadow-lg mx-auto">
                  <Sparkles className="w-7 h-7" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-lg font-black text-slate-100">アカウントの作成が完了しました！</h2>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    さっそくアカウントの初期設定を行いましょう。
                  </p>
                </div>
                <div className="pt-2 space-y-3">
                  <button
                    type="button"
                    onClick={() => void goNext()}
                    className="w-full py-3 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition flex items-center justify-center space-x-1.5 cursor-pointer"
                  >
                    <span>プロフィール設定</span>
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

            {/* 2. プロフィール設定 */}
            {step === 2 && (
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

            {/* 3. プライバシー設定 */}
            {step === 3 && (
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
                  hint="Google などの検索エンジンに拾われないよう、あなたのプロフィールの robots メタで意思表示します。"
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

                <p className="text-[11px] text-slate-500 leading-relaxed">
                  この他の様々な設定は「設定」ページから行えます。
                </p>
              </div>
            )}

            {/* 4. フォロー */}
            {step === 4 && (
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
              </div>
            )}

            {/* 5. プッシュ通知 */}
            {step === 5 && (
              <div className="space-y-4">
                <div className="flex items-center space-x-2.5">
                  <div className="w-10 h-10 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-300">
                    <Bell className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-slate-100">プッシュ通知</h2>
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
              </div>
            )}

            {/* 6. 完了 */}
            {step === 6 && (
              <div className="text-center space-y-4">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-600 flex items-center justify-center text-white shadow-lg mx-auto">
                  <CheckCircle2 className="w-7 h-7" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-lg font-black text-slate-100">初期設定が完了しました！</h2>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    設定はいつでも「設定」画面から変更できます。
                  </p>
                </div>
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={finish}
                    className="w-full py-3 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition flex items-center justify-center space-x-1.5 cursor-pointer"
                  >
                    <span>はじめる</span>
                  </button>
                </div>
              </div>
            )}

            {/* エラー通知（保存・アップロード・フォロー） */}
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
            {step >= 2 && step <= 5 && (
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
