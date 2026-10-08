/**
 * AuthPortalView（App.tsx から切り出したモーダル・オーバーレイ群）
 *
 * 表示条件（showXxx）は App 側の state のままで、ここは props で受け取る。
 * App からは React.lazy で読み込むので、初期バンドルには含まれない（開いたときに読み込む）。
 */
import { useState } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, ChevronDown, ChevronUp, ClipboardCheck, ExternalLink, Eye, Fingerprint, Globe, Key, Lock, LogIn, MessageSquare, MoreHorizontal, RefreshCw, Sparkles, Ticket, UserPlus, Users, X, Zap } from 'lucide-react';

export interface AuthPortalViewProps {
  loginMethod: any;
  isValidEmailFormat: any;
  api: any;
  hasAgreedToRules: any;
  setIssuedMasterKey: any;
  setAuthToken: any;
  setAuthUser: any;
  fetchMyFollowingUrls: any;
  setShowRegisterModal: any;
  setShowMasterKeyModal: any;
  /** 承認制で発行したキーか（マスターキーモーダルの文言を切り替える） */
  setMasterKeyModalPending: any;
  setHasConfirmedSaved: any;
  setIsCopied: any;
  fetchServerStats: any;
  setShowLoginModal: any;
  fetchTimeline: any;
  agreeBasicNotes: any;
  agreeRules: any;
  agreeTosPrivacy: any;
  authError: any;
  authPortalTab: any;
  inviteCodeInput: any;
  isPasswordAuthMode: any;
  recoveryStatus: any;
  serverStats: any;
  setAgreeBasicNotes: any;
  setAgreeRules: any;
  setAgreeTosPrivacy: any;
  setAuthError: any;
  setAuthPortalTab: any;
  setHasAgreedToRules: any;
  setInviteCodeInput: any;
  setLoginMethod: any;
  setRecoveryMsg: any;
  setRecoveryStep: any;
  setShowAuthPortal: any;
  setShowRecoveryModal: any;
  showAuthPortal: any;
}

export default function AuthPortalView(props: AuthPortalViewProps) {
  const { fetchTimeline, setShowLoginModal, fetchServerStats, setIsCopied, setHasConfirmedSaved, setShowMasterKeyModal, setMasterKeyModalPending, setShowRegisterModal, fetchMyFollowingUrls, setAuthUser, setAuthToken, setIssuedMasterKey, hasAgreedToRules, api, isValidEmailFormat, loginMethod, agreeBasicNotes, agreeRules, agreeTosPrivacy, authError, authPortalTab, inviteCodeInput, isPasswordAuthMode, recoveryStatus, serverStats, setAgreeBasicNotes, setAgreeRules, setAgreeTosPrivacy, setAuthError, setAuthPortalTab, setHasAgreedToRules, setInviteCodeInput, setLoginMethod, setRecoveryMsg, setRecoveryStep, setShowAuthPortal, setShowRecoveryModal, showAuthPortal } = props;

  // --- App.tsx から移した state とハンドラ（この画面だけで使う） ---
  const [isLoggingInWithPasskey, setIsLoggingInWithPasskey] = useState<boolean>(false);

  const [showServerMenuPopover, setShowServerMenuPopover] = useState<boolean>(false);

  const [expandedAccordions, setExpandedAccordions] = useState<{ rules: boolean; tos: boolean; basic: boolean }>({
    rules: true,
    tos: true,
    basic: true,
  });

  const [loginId, setLoginId] = useState<string>('');

  const [loginKey, setLoginKey] = useState<string>('');

  const [loginPassword, setLoginPassword] = useState<string>('');

  const [regId, setRegId] = useState<string>('');

  const [regName, setRegName] = useState<string>('');

  const [regBio, setRegBio] = useState<string>('');

  const [regEmail, setRegEmail] = useState<string>('');

  const [regPassword, setRegPassword] = useState<string>('');

  const [regPasswordConfirm, setRegPasswordConfirm] = useState<string>('');

  const [regEmailCode, setRegEmailCode] = useState<string>('');

  const [isSendingRegCode, setIsSendingRegCode] = useState<boolean>(false);

  const [regCodeMsg, setRegCodeMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  /** 承認制の申請メッセージ（任意・最大 500 文字） */
  const [regRequestMessage, setRegRequestMessage] = useState<string>('');

  /** 承認制で申請を送信済みか（送信後はフォームの代わりに申請完了の案内を出す） */
  const [regPendingSubmitted, setRegPendingSubmitted] = useState<boolean>(false);

  const isApprovalMode = serverStats?.registration_mode === 'approval';

  const showPasswordLoginForm = isPasswordAuthMode && loginMethod === 'password';

  // サーバー側 (routes/api.ts の isValidEmail) と同じ形式チェック

  const handleSendRegisterCode = async () => {
    const email = regEmail.trim();
    if (!isValidEmailFormat(email)) {
      setRegCodeMsg({ type: 'error', text: 'メールアドレスの形式をご確認ください。' });
      return;
    }
    setIsSendingRegCode(true);
    setRegCodeMsg(null);
    try {
      const res = await api.post('/api/auth/register/email-code', { email });
      const data = await res.json();
      setRegCodeMsg(res.ok
        ? { type: 'success', text: data.message || '確認コードを送信しました（10分有効）。' }
        : { type: 'error', text: data.error || '送信に失敗しました。' });
    } catch (err: any) {
      setRegCodeMsg({ type: 'error', text: err.message });
    } finally {
      setIsSendingRegCode(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    // メールアドレス＋パスワード方式: 送信前にフォーム側でも検証する (サーバーも 400 を返す)
    if (isPasswordAuthMode) {
      const email = regEmail.trim();
      if (!isValidEmailFormat(email)) {
        setAuthError('メールアドレスの形式をご確認ください。');
        return;
      }
      if (regPassword.length < 8) {
        setAuthError('パスワードは8文字以上で入力してください。');
        return;
      }
      if (regPassword !== regPasswordConfirm) {
        setAuthError('確認用パスワードが一致しません。');
        return;
      }
      // SMTP が設定されているサーバーでは、なりすまし登録を防ぐため確認コードを必須にする
      if (recoveryStatus.mailConfigured && !regEmailCode.trim()) {
        setAuthError('メールアドレスの確認コードを入力してください（「確認コードを送信」から取得できます）。');
        return;
      }
    }

    try {
      const res = await api.post('/api/auth/register', { id: regId.trim(), name: regName.trim(), summary: regBio.trim(), inviteCode: inviteCodeInput.trim() || undefined, agreedToRules: hasAgreedToRules || true, ...(isPasswordAuthMode ? { email: regEmail.trim(), password: regPassword, emailCode: regEmailCode.trim() || undefined } : {}), ...(isApprovalMode ? { requestMessage: regRequestMessage.trim() || undefined } : {}) });

      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'アカウント作成に失敗しました。');
        return;
      }

      // 承認制: sessionToken は返らない。承認まではログインできないので、アプリには入れずキーの保存だけ促す
      if (data.pending === true) {
        setIssuedMasterKey(data.masterKey);
        setMasterKeyModalPending(true);
        setShowMasterKeyModal(true);
        setHasConfirmedSaved(false);
        setIsCopied(false);
        setRegPassword('');
        setRegPasswordConfirm('');
        setRegEmailCode('');
        setRegCodeMsg(null);
        setRegRequestMessage('');
        setRegPendingSubmitted(true);
        fetchServerStats();
        return;
      }

      // マスターキー表示用モーダルを起動
      setMasterKeyModalPending(false);
      setIssuedMasterKey(data.masterKey);
      setAuthToken(data.sessionToken);
      localStorage.setItem('spica_token', data.sessionToken);
      localStorage.setItem('astrabit_token', data.sessionToken);
      setAuthUser(data.user);
      fetchMyFollowingUrls(data.sessionToken);
      setShowRegisterModal(false);
      setShowMasterKeyModal(true);
      setHasConfirmedSaved(false);
      setIsCopied(false);
      setRegPassword('');
      setRegPasswordConfirm('');
      setRegEmailCode('');
      setRegCodeMsg(null);
      fetchServerStats();
    } catch (err: any) {
      setAuthError(err.message);
    }
  };

  const handleLoginWithPasskey = async () => {
    setIsLoggingInWithPasskey(true);
    setAuthError(null);
    try {
      const optRes = await api.post('/api/webauthn/authenticate/options', { user_id: loginId.trim() || undefined });
      if (!optRes.ok) {
        const err = await optRes.json();
        throw new Error(err.error || '認証オプションの取得に失敗しました。');
      }
      const options = await optRes.json();

      // SimpleWebAuthn ブラウザ側 生体認証 / パスキープロンプト起動
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const authResponse = await startAuthentication({ optionsJSON: options });

      const verifyRes = await api.post('/api/webauthn/authenticate/verify', { credential: authResponse, expectedChallenge: options.challenge, });

      if (!verifyRes.ok) {
        const err = await verifyRes.json();
        throw new Error(err.error || 'パスキー認証に失敗しました。');
      }

      const data = await verifyRes.json();
      setAuthToken(data.token);
      localStorage.setItem('spica_token', data.token);
      localStorage.setItem('astrabit_token', data.token);
      setAuthUser(data.user);
      fetchMyFollowingUrls(data.token);
      setShowLoginModal(false);
      fetchTimeline();
    } catch (e: any) {
      console.error('Passkey login error:', e);
      if (e.name !== 'NotAllowedError') {
        setAuthError(e.message || 'パスキー認証に失敗しました。');
      }
    } finally {
      setIsLoggingInWithPasskey(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    const identifier = loginId.trim();
    const usePassword = isPasswordAuthMode && loginMethod === 'password';
    if (usePassword) {
      if (!identifier) {
        setAuthError('ユーザーIDまたはメールアドレスを入力してください。');
        return;
      }
      if (!loginPassword) {
        setAuthError('パスワードを入力してください。');
        return;
      }
    }

    try {
      const res = await api.post('/api/auth/login', usePassword // 入力がメールアドレス形式なら email、それ以外はユーザーIDとして送信する
 ? { password: loginPassword, ...(isValidEmailFormat(identifier) ? { email: identifier } : { id: identifier }) } : { id: identifier, masterKey: loginKey.trim() },);

      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'ログインに失敗しました。');
        return;
      }

      setAuthToken(data.sessionToken);
      localStorage.setItem('spica_token', data.sessionToken);
      localStorage.setItem('astrabit_token', data.sessionToken);
      setAuthUser(data.user);
      fetchMyFollowingUrls(data.sessionToken);
      setShowLoginModal(false);
      setLoginKey('');
      setLoginPassword('');
      setLoginId('');
      fetchTimeline();
    } catch (err: any) {
      setAuthError(err.message);
    }
  };
  return (
    <>
      {showAuthPortal && (
        <div className="fixed inset-0 z-[90] overflow-y-auto bg-slate-950 flex flex-col justify-between animate-in fade-in duration-300">
          {/* 背景バナーエリア (コズミック・星空スプリットレイアウト) */}
          <div className="fixed inset-0 pointer-events-none overflow-hidden">
            {serverStats?.banner_url ? (
              <>
                <img
                  src={serverStats.banner_url}
                  alt="Server Banner"
                  className="w-full h-full object-cover object-center scale-105 filter blur-[1px] opacity-65"
                />
                <div className="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-950/85 to-indigo-950/40" />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-slate-950/70" />
              </>
            ) : (
              <div className="w-full h-full relative bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/30 via-slate-950 to-slate-950">
                {/* Spica オリジナルの星空・コズミック光彩 */}
                <div className="absolute top-1/4 -right-20 w-[600px] h-[600px] rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
                <div className="absolute bottom-10 right-1/4 w-[500px] h-[500px] rounded-full bg-purple-500/10 blur-3xl pointer-events-none" />
                <div className="absolute inset-0 opacity-20 bg-[radial-gradient(#818cf8_1px,transparent_1px)] [background-size:32px_32px]" />
              </div>
            )}
          </div>

          {/* トップナビゲーションバー */}
          <header className="relative z-10 w-full px-6 py-5 flex items-center justify-between">
            {/* Spica ノードバッジ */}
            <div className="flex items-center space-x-2 bg-slate-900/80 backdrop-blur-md border border-indigo-500/20 px-3.5 py-1.5 rounded-full shadow-lg shadow-indigo-500/5">
              <div className="w-4 h-4 rounded-full bg-gradient-to-tr from-cyan-400 to-indigo-500 flex items-center justify-center text-[10px] text-white font-black">
                ✦
              </div>
              <span className="text-xs text-slate-300 font-medium">
                Spica Sovereign Node: <strong className="text-white font-bold">{serverStats?.domain || window.location.host}</strong>
              </span>
            </div>

            {/* ゲスト閲覧・閉じるボタン */}
            <button
              onClick={() => setShowAuthPortal(false)}
              className="group flex items-center space-x-2 px-4 py-1.5 bg-slate-900/80 hover:bg-slate-850 text-slate-300 hover:text-white rounded-full border border-slate-800 shadow-lg text-xs font-semibold backdrop-blur-md transition cursor-pointer"
              title="ゲストとしてタイムラインを見る"
            >
              <span>タイムラインを見る</span>
              <X className="w-4 h-4 group-hover:rotate-90 transition transform text-slate-400" />
            </button>
          </header>

          {/* メインコンテンツ (左右2ペイン) */}
          <main className="relative z-10 w-full max-w-6xl mx-auto px-4 py-4 sm:py-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* 左側: メインカード & 統計 & プレビュー */}
            <div className="lg:col-span-5 max-w-md w-full mx-auto lg:mx-0 space-y-4">
              {/* メインヒーローカード */}
              <div className="bg-slate-900/90 backdrop-blur-2xl border border-indigo-500/20 rounded-[28px] p-6 sm:p-7 shadow-2xl relative mt-10">
                {/* アプリアイコン (Spica オービタルリング付き: カード上端から自然に突き出し、下部要素と重ならないよう配置) */}
                <div className="-mt-14 sm:-mt-16 mx-auto w-20 h-20 rounded-3xl bg-gradient-to-tr from-cyan-400 via-indigo-500 to-purple-600 p-0.5 shadow-2xl shadow-indigo-500/30 mb-3 relative z-10">
                  <div className="w-full h-full rounded-[22px] overflow-hidden bg-slate-950 flex items-center justify-center relative">
                    <img
                      src={serverStats?.icon_url || '/logo.jpg'}
                      alt={serverStats?.name || 'Spica'}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.currentTarget as HTMLElement).style.display = 'none';
                      }}
                    />
                  </div>
                </div>

                {/* 右上メニュー (···) */}
                <div className="absolute top-4 right-4 z-20">
                  <button
                    onClick={() => setShowServerMenuPopover(!showServerMenuPopover)}
                    className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 rounded-xl transition cursor-pointer"
                    title="サーバー詳細メニュー"
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                  {showServerMenuPopover && (
                    <div className="absolute right-0 mt-2 w-48 bg-slate-900 border border-slate-800 rounded-2xl p-2 shadow-2xl z-30 space-y-1 text-xs text-slate-300 animate-in fade-in zoom-in-95 duration-150">
                      <div className="px-2.5 py-1.5 text-[11px] font-bold text-slate-400 border-b border-slate-800/80">
                        {serverStats?.domain || 'spica'}
                      </div>
                      <a
                        href="/actor"
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-between px-2.5 py-1.5 hover:bg-slate-800 rounded-lg text-slate-300 transition"
                      >
                        <span>Actor (/actor)</span>
                        <ExternalLink className="w-3 h-3 text-slate-500" />
                      </a>
                      <a
                        href="/nodeinfo/2.1"
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-between px-2.5 py-1.5 hover:bg-slate-800 rounded-lg text-slate-300 transition"
                      >
                        <span>NodeInfo 2.1</span>
                        <ExternalLink className="w-3 h-3 text-slate-500" />
                      </a>
                    </div>
                  )}
                </div>

                {/* ノードステータスバッジ */}
                <div className="flex justify-center mb-2">
                  <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-mono font-semibold shadow-sm">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span>NODE ONLINE • FEDERATED</span>
                  </div>
                </div>

                {/* サーバー名 */}
                <h1 className="text-xl sm:text-2xl font-black text-center text-slate-100 tracking-tight">
                  {serverStats?.name || 'Spica'}
                </h1>

                {/* サーバー説明 */}
                <p className="text-xs text-center text-slate-400 mt-2 leading-relaxed whitespace-pre-wrap max-h-24 overflow-y-auto">
                  {serverStats?.description || '誰にも支配されない、分散型ソーシャルネットワークへようこそ。'}
                </p>

                {/* Spica 参加ポリシー案内枠 */}
                {serverStats?.registration_mode === 'closed' ? (
                  <div className="mt-4 bg-rose-950/40 border border-rose-500/30 rounded-2xl p-3 text-left flex items-start space-x-2.5 shadow-sm">
                    <Lock className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <div className="text-xs text-rose-200/90 leading-relaxed">
                      <strong className="text-rose-300 font-bold block mb-0.5">新規アカウント登録を一時停止中</strong>
                      現在このサーバーは管理者により新規登録の受付を一時停止しています。
                    </div>
                  </div>
                ) : serverStats?.registration_mode === 'invite' ? (
                  <div className="mt-4 bg-amber-950/40 border border-amber-500/30 rounded-2xl p-3 text-left flex items-start space-x-2.5 shadow-sm">
                    <Ticket className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <div className="text-xs text-amber-200/90 leading-relaxed">
                      <strong className="text-amber-300 font-bold block mb-0.5">招待制コミュニティ</strong>
                      このサーバーへの新規参加には有効な招待コードが必要です。
                      {isPasswordAuthMode ? 'メールアドレスとパスワードで今すぐ利用開始できます。' : '暗号学的マスターキーで今すぐ利用開始できます。'}
                    </div>
                  </div>
                ) : serverStats?.registration_mode === 'approval' ? (
                  <div className="mt-4 bg-indigo-950/40 border border-indigo-500/30 rounded-2xl p-3 text-left flex items-start space-x-2.5 shadow-sm">
                    <UserPlus className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                    <div className="text-xs text-indigo-200/90 leading-relaxed">
                      <strong className="text-indigo-300 font-bold block mb-0.5">承認制コミュニティ</strong>
                      アカウントを申請すると、管理者が内容を確認して承認します。承認されるとログインできます。
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 bg-indigo-950/40 border border-indigo-500/20 rounded-2xl p-3 text-left flex items-start space-x-2.5 shadow-sm">
                    <Zap className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                    <div className="text-xs text-indigo-200/90 leading-relaxed">
                      <strong className="text-cyan-300 font-bold block mb-0.5">オープン参加受付中</strong>
                      {isPasswordAuthMode
                        ? '招待コードは不要です。メールアドレスとパスワードで今すぐ利用開始できます。'
                        : '招待コードや電話番号・メールアドレスは不要です。暗号学的マスターキーで今すぐ利用開始できます。'}
                    </div>
                  </div>
                )}

                {/* エラーメッセージ */}
                {authError && (
                  <div className="mt-4 bg-rose-500/15 border border-rose-500/30 text-rose-300 p-2.5 rounded-xl text-xs flex items-center space-x-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{authError}</span>
                  </div>
                )}

                {/* ビュー切り替え */}
                {authPortalTab === 'welcome' && (
                  <div className="mt-6 space-y-2.5">
                    {serverStats?.registration_mode === 'closed' ? (
                      <button
                        disabled
                        className="w-full py-3 bg-slate-800/60 text-slate-500 text-sm font-bold rounded-2xl border border-slate-700/50 cursor-not-allowed flex items-center justify-center space-x-2"
                      >
                        <Lock className="w-4 h-4" />
                        <span>新規登録は一時停止中です</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setAuthError(null);
                          const hasRules = (serverStats?.server_rules && serverStats.server_rules.length > 0) || serverStats?.tos_url || serverStats?.privacy_policy_url;
                          if (serverStats?.require_rules_agreement && hasRules) {
                            setAgreeRules(false);
                            setAgreeTosPrivacy(false);
                            setAgreeBasicNotes(false);
                            setAuthPortalTab('rules_agreement');
                          } else {
                            setAuthPortalTab('register');
                          }
                        }}
                        className="w-full py-3 bg-gradient-to-r from-cyan-500 via-indigo-600 to-purple-600 hover:from-cyan-400 hover:via-indigo-500 hover:to-purple-500 text-white text-sm font-bold rounded-2xl shadow-lg shadow-indigo-600/25 transition transform active:scale-98 flex items-center justify-center space-x-2 cursor-pointer"
                      >
                        <UserPlus className="w-4 h-4" />
                        <span>
                          {serverStats?.registration_mode === 'invite'
                            ? '招待コードで参加する'
                            : serverStats?.registration_mode === 'approval'
                              ? 'アカウントを申請する'
                              : 'Spicaに参加する (アカウント作成)'}
                        </span>
                      </button>
                    )}

                    <button
                      onClick={() => setShowAuthPortal(false)}
                      className="w-full py-2.5 bg-slate-800/80 hover:bg-slate-700/80 text-slate-200 text-xs font-semibold rounded-2xl border border-slate-700/60 transition cursor-pointer flex items-center justify-center space-x-1.5"
                    >
                      <Eye className="w-3.5 h-3.5 text-slate-400" />
                      <span>ゲストとしてタイムラインを見る</span>
                    </button>

                    <button
                      onClick={handleLoginWithPasskey}
                      disabled={isLoggingInWithPasskey}
                      className="w-full py-2.5 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 text-xs font-bold rounded-2xl transition cursor-pointer flex items-center justify-center space-x-2 shadow-sm"
                    >
                      {isLoggingInWithPasskey ? (
                        <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                      ) : (
                        <Fingerprint className="w-4 h-4 text-indigo-400" />
                      )}
                      <span>{isLoggingInWithPasskey ? '生体認証を確認中...' : '🔐 パスキー / 生体認証でログイン'}</span>
                    </button>

                    <button
                      onClick={() => {
                        setAuthError(null);
                        setAuthPortalTab('login');
                      }}
                      className="w-full py-2.5 bg-slate-800/80 hover:bg-slate-700/80 text-slate-200 text-xs font-semibold rounded-2xl border border-slate-700/60 transition cursor-pointer flex items-center justify-center space-x-1.5"
                    >
                      <LogIn className="w-3.5 h-3.5 text-indigo-400" />
                      <span>{isPasswordAuthMode ? 'メールアドレスでログイン' : 'マスターキーでログイン'}</span>
                    </button>

                    {/* フッター規約・ポリシーリンク */}
                    {(serverStats?.tos_url || serverStats?.privacy_policy_url || serverStats?.contact_url || serverStats?.operator_url) && (
                      <div className="pt-4 border-t border-slate-800/60 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1.5 text-[11px] text-slate-500">
                        {serverStats?.tos_url && (
                          <a
                            href={serverStats.tos_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-indigo-400 hover:underline flex items-center space-x-1 transition"
                          >
                            <span>利用規約</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        )}
                        {serverStats?.privacy_policy_url && (
                          <a
                            href={serverStats.privacy_policy_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-indigo-400 hover:underline flex items-center space-x-1 transition"
                          >
                            <span>プライバシーポリシー</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        )}
                        {serverStats?.contact_url && (
                          <a
                            href={serverStats.contact_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-indigo-400 hover:underline flex items-center space-x-1 transition"
                          >
                            <span>お問い合わせ</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        )}
                        {serverStats?.operator_url && (
                          <a
                            href={serverStats.operator_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-indigo-400 hover:underline flex items-center space-x-1 transition"
                          >
                            <span>運営者情報</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* 📜 サーバールール・規約同意ビュー (Misskeyスタイル) */}
                {authPortalTab === 'rules_agreement' && (() => {
                  const rules = serverStats?.server_rules && serverStats.server_rules.length > 0
                    ? serverStats.server_rules
                    : [];
                  const hasRulesSection = rules.length > 0;
                  const hasTosSection = Boolean(serverStats?.tos_url || serverStats?.privacy_policy_url);
                  const hasBasicSection = Boolean(serverStats?.contact_url || serverStats?.operator_url || serverStats?.repository_url);

                  const allAgreed =
                    (!hasRulesSection || agreeRules) &&
                    (!hasTosSection || agreeTosPrivacy) &&
                    (!hasBasicSection || agreeBasicNotes);

                  return (
                    <div className="mt-4 space-y-4 animate-in fade-in duration-200 text-left">
                      {/* 上部ヘッダー (アイコン・タイトル・説明) */}
                      <div className="text-center space-y-2 pb-1">
                        <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center mx-auto shadow-md">
                          <ClipboardCheck className="w-6 h-6" />
                        </div>
                        <p className="text-xs text-slate-300 font-medium leading-relaxed">
                          このサーバーに登録するには、以下の内容を確認し同意する必要があります。<br />
                          <strong className="text-slate-100 font-bold">重要ですので必ずお読みください。</strong>
                        </p>
                      </div>

                      {/* アコーディオンリスト */}
                      <div className="space-y-3 max-h-[48vh] overflow-y-auto pr-1">
                        {/* セクション 1: サーバールール */}
                        {hasRulesSection && (
                          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 overflow-hidden shadow-sm">
                            <button
                              type="button"
                              onClick={() => setExpandedAccordions((prev: any) => ({ ...prev, rules: !prev.rules }))}
                              className="w-full px-4 py-3 bg-slate-900/90 hover:bg-slate-900 flex items-center justify-between text-xs font-bold text-slate-200 transition cursor-pointer"
                            >
                              <span>サーバールール</span>
                              {expandedAccordions.rules ? (
                                <ChevronUp className="w-4 h-4 text-slate-400" />
                              ) : (
                                <ChevronDown className="w-4 h-4 text-slate-400" />
                              )}
                            </button>

                            {expandedAccordions.rules && (
                              <div className="p-3.5 space-y-2.5 border-t border-slate-800/80 bg-slate-950/40">
                                {rules.map((rule: any, idx: any) => (
                                  <div key={idx} className="flex items-start space-x-2.5 text-xs text-slate-200 leading-relaxed">
                                    <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-[11px] flex items-center justify-center shrink-0 mt-0.5 shadow-sm">
                                      {idx + 1}
                                    </span>
                                    <span>{rule}</span>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* 同意するトグル */}
                            <div className="px-4 py-2.5 bg-slate-900/50 border-t border-slate-800/60 flex items-center justify-between">
                              <label
                                onClick={() => setAgreeRules(!agreeRules)}
                                className="flex items-center space-x-3 cursor-pointer select-none"
                              >
                                <div
                                  className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out ${
                                    agreeRules ? 'bg-emerald-500' : 'bg-slate-700'
                                  }`}
                                >
                                  <div
                                    className={`w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out ${
                                      agreeRules ? 'translate-x-4' : 'translate-x-0'
                                    }`}
                                  />
                                </div>
                                <span className={`text-xs font-bold ${agreeRules ? 'text-emerald-300' : 'text-slate-400'}`}>
                                  同意する
                                </span>
                              </label>
                            </div>
                          </div>
                        )}

                        {/* セクション 2: 利用規約・プライバシーポリシー */}
                        {hasTosSection && (
                          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 overflow-hidden shadow-sm">
                            <button
                              type="button"
                              onClick={() => setExpandedAccordions((prev: any) => ({ ...prev, tos: !prev.tos }))}
                              className="w-full px-4 py-3 bg-slate-900/90 hover:bg-slate-900 flex items-center justify-between text-xs font-bold text-slate-200 transition cursor-pointer"
                            >
                              <span>利用規約・プライバシーポリシー</span>
                              {expandedAccordions.tos ? (
                                <ChevronUp className="w-4 h-4 text-slate-400" />
                              ) : (
                                <ChevronDown className="w-4 h-4 text-slate-400" />
                              )}
                            </button>

                            {expandedAccordions.tos && (
                              <div className="p-3.5 space-y-2 border-t border-slate-800/80 bg-slate-950/40">
                                {serverStats?.tos_url && (
                                  <a
                                    href={serverStats.tos_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center space-x-1.5 text-xs font-semibold"
                                  >
                                    <span>利用規約</span>
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                )}
                                {serverStats?.privacy_policy_url && (
                                  <a
                                    href={serverStats.privacy_policy_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center space-x-1.5 text-xs font-semibold"
                                  >
                                    <span>プライバシーポリシー</span>
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                )}
                              </div>
                            )}

                            {/* 同意するトグル */}
                            <div className="px-4 py-2.5 bg-slate-900/50 border-t border-slate-800/60 flex items-center justify-between">
                              <label
                                onClick={() => setAgreeTosPrivacy(!agreeTosPrivacy)}
                                className="flex items-center space-x-3 cursor-pointer select-none"
                              >
                                <div
                                  className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out ${
                                    agreeTosPrivacy ? 'bg-emerald-500' : 'bg-slate-700'
                                  }`}
                                >
                                  <div
                                    className={`w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out ${
                                      agreeTosPrivacy ? 'translate-x-4' : 'translate-x-0'
                                    }`}
                                  />
                                </div>
                                <span className={`text-xs font-bold ${agreeTosPrivacy ? 'text-emerald-300' : 'text-slate-400'}`}>
                                  同意する
                                </span>
                              </label>
                            </div>
                          </div>
                        )}

                        {/* セクション 3: 基本的な注意事項・運営者情報 */}
                        {hasBasicSection && (
                          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 overflow-hidden shadow-sm">
                            <button
                              type="button"
                              onClick={() => setExpandedAccordions((prev: any) => ({ ...prev, basic: !prev.basic }))}
                              className="w-full px-4 py-3 bg-slate-900/90 hover:bg-slate-900 flex items-center justify-between text-xs font-bold text-slate-200 transition cursor-pointer"
                            >
                              <span>基本的な注意事項・運営者情報</span>
                              {expandedAccordions.basic ? (
                                <ChevronUp className="w-4 h-4 text-slate-400" />
                              ) : (
                                <ChevronDown className="w-4 h-4 text-slate-400" />
                              )}
                            </button>

                            {expandedAccordions.basic && (
                              <div className="p-3.5 space-y-2 border-t border-slate-800/80 bg-slate-950/40">
                                {serverStats?.contact_url && (
                                  <a
                                    href={serverStats.contact_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center space-x-1.5 text-xs font-semibold"
                                  >
                                    <span>お問い合わせ先</span>
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                )}
                                {serverStats?.operator_url && (
                                  <a
                                    href={serverStats.operator_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center space-x-1.5 text-xs font-semibold"
                                  >
                                    <span>運営者情報 (Impressum)</span>
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                )}
                                {serverStats?.repository_url && (
                                  <a
                                    href={serverStats.repository_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center space-x-1.5 text-xs font-semibold"
                                  >
                                    <span>リポジトリ</span>
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                )}
                              </div>
                            )}

                            {/* 同意するトグル */}
                            <div className="px-4 py-2.5 bg-slate-900/50 border-t border-slate-800/60 flex items-center justify-between">
                              <label
                                onClick={() => setAgreeBasicNotes(!agreeBasicNotes)}
                                className="flex items-center space-x-3 cursor-pointer select-none"
                              >
                                <div
                                  className={`w-9 h-5 rounded-full p-0.5 transition-colors duration-200 ease-in-out ${
                                    agreeBasicNotes ? 'bg-emerald-500' : 'bg-slate-700'
                                  }`}
                                >
                                  <div
                                    className={`w-4 h-4 rounded-full bg-white transition-transform duration-200 ease-in-out ${
                                      agreeBasicNotes ? 'translate-x-4' : 'translate-x-0'
                                    }`}
                                  />
                                </div>
                                <span className={`text-xs font-bold ${agreeBasicNotes ? 'text-emerald-300' : 'text-slate-400'}`}>
                                  同意する
                                </span>
                              </label>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* 注意テキスト */}
                      <p className="text-[11px] text-center text-slate-400 leading-relaxed">
                        続けるには、全ての「同意する」にチェックが入っている必要があります。
                      </p>

                      {/* アクションボタン */}
                      <div className="flex items-center justify-center space-x-3 pt-2">
                        <button
                          type="button"
                          onClick={() => setAuthPortalTab('welcome')}
                          className="px-5 py-2.5 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition cursor-pointer"
                        >
                          キャンセル
                        </button>
                        <button
                          type="button"
                          disabled={!allAgreed}
                          onClick={() => {
                            setHasAgreedToRules(true);
                            setAuthPortalTab('register');
                          }}
                          className={`px-6 py-2.5 rounded-full text-xs font-bold transition flex items-center space-x-1.5 shadow-lg ${
                            allAgreed
                              ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/30 cursor-pointer transform active:scale-98'
                              : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/60'
                          }`}
                        >
                          <span>続ける</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {authPortalTab === 'register' && (
                  <div className="mt-5 space-y-3.5 animate-in fade-in duration-200">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                      <button
                        onClick={() => {
                          setAuthError(null);
                          setAuthPortalTab('welcome');
                        }}
                        className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition cursor-pointer"
                      >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        <span>戻る</span>
                      </button>
                      <span className="text-xs font-bold text-slate-300">{isApprovalMode ? 'アカウント申請' : 'アカウント新規登録'}</span>
                    </div>

                    {serverStats?.registration_mode === 'closed' ? (
                      <div className="py-6 px-4 bg-slate-950/80 rounded-2xl border border-slate-800 text-center space-y-3">
                        <div className="w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center mx-auto">
                          <Lock className="w-6 h-6" />
                        </div>
                        <div>
                          <h4 className="text-sm font-bold text-slate-200">新規登録を一時停止しています</h4>
                          <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                            現在このサーバーは管理者により新規登録の受付を一時停止しています。<br />
                            すでにアカウントをお持ちの方はログインしてご利用ください。
                          </p>
                        </div>
                        <div className="pt-2">
                          <button
                            type="button"
                            onClick={() => {
                              setAuthError(null);
                              setAuthPortalTab('login');
                            }}
                            className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl border border-slate-700 transition cursor-pointer"
                          >
                            {isPasswordAuthMode ? 'メールアドレスでログインする' : 'マスターキーでログインする'}
                          </button>
                        </div>
                      </div>
                    ) : isApprovalMode && regPendingSubmitted ? (
                      /* 承認制: 申請送信後の完了案内（承認まではログインできない） */
                      <div className="py-6 px-4 bg-slate-950/80 rounded-2xl border border-indigo-500/30 text-center space-y-3">
                        <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/25 text-indigo-400 flex items-center justify-center mx-auto">
                          <UserPlus className="w-6 h-6" />
                        </div>
                        <div>
                          <h4 className="text-sm font-bold text-slate-200">申請を受け付けました</h4>
                          <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                            管理者の承認をお待ちください。承認されるとログインできるようになります。<br />
                            承認されるまではログインできませんのでご了承ください。
                          </p>
                        </div>
                        <p className="text-[11px] text-amber-300/90 leading-relaxed text-left bg-amber-950/40 border border-amber-500/30 rounded-xl p-2.5">
                          登録時に発行されたマスターキーは、承認後にログインするために必要です。必ず安全な場所に保存してください。
                        </p>
                        <div className="pt-1">
                          <button
                            type="button"
                            onClick={() => {
                              setAuthError(null);
                              setAuthPortalTab('login');
                            }}
                            className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl border border-slate-700 transition cursor-pointer"
                          >
                            ログイン画面へ
                          </button>
                        </div>
                        <p className="text-[10px] text-slate-500 leading-relaxed">
                          承認前はログインできません。承認されたあと、{isPasswordAuthMode ? 'メールアドレスとパスワード' : '保存したマスターキー'}でログインしてください。
                        </p>
                      </div>
                    ) : (
                      <form onSubmit={handleRegister} className="space-y-3 text-left">
                        {/* 承認制: 申請フローの案内（招待コード欄と同じトーンの枠で出す） */}
                        {isApprovalMode && (
                          <div className="bg-amber-950/40 border border-amber-500/30 rounded-xl p-3 text-left flex items-start space-x-2.5 shadow-sm">
                            <UserPlus className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                            <div className="text-xs text-amber-200/90 leading-relaxed">
                              <strong className="text-amber-300 font-bold block mb-0.5">承認制コミュニティ</strong>
                              申請後、管理者が承認するとログインできます。承認まではログインできません。
                            </div>
                          </div>
                        )}

                        {/* 招待コード入力欄 (承認制では使わないので出さない) */}
                        {!isApprovalMode && (
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label className="block text-[11px] font-semibold text-slate-300">
                              招待コード {serverStats?.registration_mode === 'invite' ? (
                                <span className="text-rose-400 font-bold">*必須</span>
                              ) : (
                                <span className="text-slate-500 font-normal">(任意)</span>
                              )}
                            </label>
                            {inviteCodeInput && (
                              <span className="text-[10px] text-emerald-400 font-mono">コード適用中</span>
                            )}
                          </div>
                          <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                            <Ticket className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
                            <input
                              type="text"
                              required={serverStats?.registration_mode === 'invite'}
                              placeholder="SPICA-XXXXXX"
                              value={inviteCodeInput}
                              onChange={(e) => setInviteCodeInput(e.target.value.toUpperCase())}
                              className="bg-transparent text-slate-200 placeholder-slate-600 focus:outline-none flex-1 font-mono text-xs uppercase tracking-wider"
                            />
                            {inviteCodeInput && (
                              <button
                                type="button"
                                onClick={() => setInviteCodeInput('')}
                                className="text-slate-500 hover:text-slate-300 ml-1 cursor-pointer"
                                title="クリア"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                          {serverStats?.registration_mode === 'invite' && (
                            <p className="text-[10px] text-amber-400/90 mt-1 flex items-center space-x-1">
                              <AlertCircle className="w-3 h-3 shrink-0" />
                              <span>このサーバーは招待制です。有効な招待コードが必要です。</span>
                            </p>
                          )}
                        </div>
                        )}

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            ユーザーID (英数字・小文字)
                          </label>
                          <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                            <span className="text-slate-500 mr-1 font-mono">@</span>
                            <input
                              type="text"
                              required
                              placeholder="例: alice"
                              value={regId}
                              onChange={(e) => setRegId(e.target.value)}
                              className="bg-transparent text-slate-200 focus:outline-none flex-1 font-mono text-xs"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            表示名
                          </label>
                          <input
                            type="text"
                            required
                            placeholder="例: Alice In Borderland"
                            value={regName}
                            onChange={(e) => setRegName(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                          />
                        </div>

                        {isPasswordAuthMode && (
                          <>
                            <div>
                              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                                メールアドレス <span className="text-rose-400 font-bold">*必須</span>
                              </label>
                              <input
                                type="email"
                                required
                                autoComplete="email"
                                placeholder="you@example.com"
                                value={regEmail}
                                onChange={(e) => setRegEmail(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                              />
                              <p className="text-[10px] text-slate-500 mt-1">
                                このサーバーはメールアドレス＋パスワード方式です。パスワードを忘れたときの復元にも使います。
                              </p>
                            </div>

                            {/* メール確認コード（SMTP が設定されているサーバーのみ） */}
                            {recoveryStatus.mailConfigured && (
                              <div>
                                <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                                  メール確認コード <span className="text-rose-400 font-bold">*必須</span>
                                </label>
                                <div className="flex gap-2">
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    autoComplete="one-time-code"
                                    maxLength={6}
                                    placeholder="6桁のコード"
                                    value={regEmailCode}
                                    onChange={(e) => setRegEmailCode(e.target.value.replace(/[^0-9]/g, ''))}
                                    className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono tracking-widest focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                                  />
                                  <button
                                    type="button"
                                    onClick={handleSendRegisterCode}
                                    disabled={isSendingRegCode || !regEmail.trim()}
                                    className="px-3 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-[11px] font-bold rounded-xl shadow-md transition whitespace-nowrap cursor-pointer"
                                  >
                                    {isSendingRegCode ? '送信中...' : '確認コードを送信'}
                                  </button>
                                </div>
                                {regCodeMsg ? (
                                  <p className={`text-[10px] mt-1 ${regCodeMsg.type === 'success' ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    {regCodeMsg.text}
                                  </p>
                                ) : (
                                  <p className="text-[10px] text-slate-500 mt-1">
                                    入力したメールアドレスに6桁のコードを送ります（10分有効）。他人のメールアドレスでの登録を防ぐため必須です。
                                  </p>
                                )}
                              </div>
                            )}

                            <div>
                              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                                パスワード <span className="text-rose-400 font-bold">*必須</span>
                                <span className="text-slate-500 font-normal"> (8文字以上)</span>
                              </label>
                              <input
                                type="password"
                                required
                                minLength={8}
                                autoComplete="new-password"
                                placeholder="8文字以上"
                                value={regPassword}
                                onChange={(e) => setRegPassword(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                              />
                            </div>

                            <div>
                              <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                                パスワード (確認)
                              </label>
                              <input
                                type="password"
                                required
                                autoComplete="new-password"
                                placeholder="同じパスワードをもう一度入力"
                                value={regPasswordConfirm}
                                onChange={(e) => setRegPasswordConfirm(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                              />
                            </div>
                          </>
                        )}

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            自己紹介 (Bio)
                          </label>
                          <textarea
                            rows={2}
                            placeholder="Spicaをはじめました！"
                            value={regBio}
                            onChange={(e) => setRegBio(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none resize-none"
                          />
                        </div>

                        {/* 承認制: 管理者が承認の判断に使う申請メッセージ（任意） */}
                        {isApprovalMode && (
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <label className="block text-[11px] font-semibold text-slate-300">
                                申請メッセージ <span className="text-slate-500 font-normal">(任意)</span>
                              </label>
                              <span className="text-[10px] text-slate-500 font-mono">{regRequestMessage.length}/500</span>
                            </div>
                            <textarea
                              rows={3}
                              maxLength={500}
                              placeholder="参加したい理由や自己紹介など（任意）。管理者が承認の判断に使います"
                              value={regRequestMessage}
                              onChange={(e) => setRegRequestMessage(e.target.value)}
                              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none resize-none"
                            />
                          </div>
                        )}

                        <button
                          type="submit"
                          className="w-full py-2.5 bg-gradient-to-r from-cyan-500 via-indigo-600 to-purple-600 hover:from-cyan-400 hover:via-indigo-500 hover:to-purple-500 text-white text-xs font-bold rounded-xl shadow-md transition transform active:scale-98 cursor-pointer mt-2"
                        >
                          {isApprovalMode ? 'アカウントを申請する' : isPasswordAuthMode ? 'メールアドレスで登録する' : 'マスターキーを発行して登録'}
                        </button>

                        <div className="text-center pt-1">
                          <button
                            type="button"
                            onClick={() => {
                              setAuthError(null);
                              setAuthPortalTab('login');
                            }}
                            className="text-[11px] text-indigo-400 hover:text-indigo-300 transition hover:underline cursor-pointer"
                          >
                            すでにアカウントをお持ちですか？ ログイン
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                )}

                {authPortalTab === 'login' && (
                  <div className="mt-5 space-y-3.5 animate-in fade-in duration-200">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                      <button
                        onClick={() => {
                          setAuthError(null);
                          setAuthPortalTab('welcome');
                        }}
                        className="flex items-center space-x-1 text-xs text-slate-400 hover:text-slate-200 transition cursor-pointer"
                      >
                        <ArrowLeft className="w-3.5 h-3.5" />
                        <span>戻る</span>
                      </button>
                      <span className="text-xs font-bold text-slate-300">
                        {showPasswordLoginForm ? 'メールアドレス・パスワードでログイン' : 'マスターキーでログイン'}
                      </span>
                    </div>

                    <form onSubmit={handleLogin} className="space-y-3 text-left">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          {showPasswordLoginForm ? 'ユーザーID または メールアドレス' : 'ユーザーID'}
                        </label>
                        <input
                          type="text"
                          required
                          placeholder={showPasswordLoginForm ? '例: alice または you@example.com' : '例: alice'}
                          value={loginId}
                          onChange={(e) => setLoginId(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        />
                      </div>

                      {showPasswordLoginForm ? (
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            パスワード
                          </label>
                          <input
                            type="password"
                            required
                            placeholder="••••••••"
                            autoComplete="current-password"
                            value={loginPassword}
                            onChange={(e) => setLoginPassword(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                          />
                        </div>
                      ) : (
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                            マスターキー
                          </label>
                          <input
                            type="password"
                            required
                            autoComplete="off"
                            placeholder="spica_sk_... または astrabit_sk_..."
                            value={loginKey}
                            onChange={(e) => setLoginKey(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                          />
                        </div>
                      )}

                      <button
                        type="submit"
                        className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-md transition transform active:scale-98 cursor-pointer mt-2"
                      >
                        {showPasswordLoginForm ? 'ログイン' : '認証してログイン'}
                      </button>

                      {recoveryStatus.recoveryAvailable && (
                        <button
                          type="button"
                          onClick={() => { setShowRecoveryModal(true); setRecoveryStep('request'); setRecoveryMsg(null); }}
                          className="w-full text-[11px] text-slate-400 hover:text-amber-300 transition cursor-pointer underline decoration-dotted"
                        >
                          マスターキーを忘れた方はこちら（メールで復元）
                        </button>
                      )}

                      {isPasswordAuthMode && (
                        <button
                          type="button"
                          onClick={() => {
                            setAuthError(null);
                            setLoginMethod(showPasswordLoginForm ? 'master_key' : 'password');
                          }}
                          className="w-full text-[11px] text-indigo-400 hover:text-indigo-300 transition cursor-pointer underline decoration-dotted"
                        >
                          {showPasswordLoginForm
                            ? 'マスターキーでログインする'
                            : 'メールアドレス＋パスワードでログインする'}
                        </button>
                      )}

                      <div className="relative flex py-1 items-center">
                        <div className="flex-grow border-t border-slate-800"></div>
                        <span className="flex-shrink mx-2 text-[10px] text-slate-500 font-semibold">または</span>
                        <div className="flex-grow border-t border-slate-800"></div>
                      </div>

                      <button
                        type="button"
                        onClick={handleLoginWithPasskey}
                        disabled={isLoggingInWithPasskey}
                        className="w-full py-2.5 bg-slate-850 hover:bg-slate-800 text-slate-200 hover:text-white text-xs font-bold rounded-xl border border-slate-700 transition flex items-center justify-center space-x-2 shadow cursor-pointer disabled:opacity-50"
                      >
                        {isLoggingInWithPasskey ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                        ) : (
                          <Fingerprint className="w-3.5 h-3.5 text-emerald-400" />
                        )}
                        <span>{isLoggingInWithPasskey ? '生体認証を確認中...' : 'パスキー (Windows Hello / Touch ID) でログイン'}</span>
                      </button>

                      <div className="text-center pt-1">
                        <button
                          type="button"
                          onClick={() => {
                            setAuthError(null);
                            setAuthPortalTab('register');
                          }}
                          className="text-[11px] text-indigo-400 hover:text-indigo-300 transition hover:underline cursor-pointer"
                        >
                          アカウントをお持ちでないですか？ 新規登録
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </div>

              {/* 統計ボックス (ローカル参加者 / ローカルノート) */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-900/90 backdrop-blur-xl border border-indigo-500/20 rounded-2xl p-3.5 text-left shadow-lg">
                  <div className="flex items-center space-x-1.5 text-[11px] font-semibold text-slate-400">
                    <Users className="w-3.5 h-3.5 text-cyan-400" />
                    <span>ローカル参加者</span>
                  </div>
                  <div className="text-xl font-black text-white mt-0.5">
                    {serverStats?.stats?.users ?? 1}
                  </div>
                </div>
                <div className="bg-slate-900/90 backdrop-blur-xl border border-indigo-500/20 rounded-2xl p-3.5 text-left shadow-lg">
                  <div className="flex items-center space-x-1.5 text-[11px] font-semibold text-slate-400">
                    <MessageSquare className="w-3.5 h-3.5 text-purple-400" />
                    <span>ローカルノート</span>
                  </div>
                  <div className="text-xl font-black text-white mt-0.5">
                    {(serverStats?.stats?.totalPosts ?? 0).toLocaleString()}
                  </div>
                </div>
              </div>

              {/* タイムラインプレビューカード */}
              <div className="bg-slate-900/90 backdrop-blur-xl border border-indigo-500/20 rounded-2xl p-4 text-left shadow-lg space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-300">タイムラインを見てみる</span>
                  <span className="text-[10px] text-indigo-400 font-mono bg-indigo-500/10 px-2 py-0.5 rounded-full border border-indigo-500/20">LIVE FEED</span>
                </div>
                <button
                  onClick={() => setShowAuthPortal(false)}
                  className="w-full py-2 px-3 bg-slate-800/80 hover:bg-slate-800 text-indigo-300 hover:text-white text-xs font-bold rounded-xl transition flex items-center justify-center space-x-1.5 border border-slate-700/60 cursor-pointer shadow"
                >
                  <span>タイムラインへ進む</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* 右側: Spica 主権型機能ショーケース (PC向け) */}
            <div className="hidden lg:flex lg:col-span-7 flex-col justify-center items-start text-left p-8 relative min-h-[500px] space-y-6">
              <div>
                <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/25 text-indigo-300 text-xs font-semibold mb-3">
                  <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Sovereign & Decentralized Social Network</span>
                </div>
                <h2 className="text-3xl font-black text-white drop-shadow-md tracking-tight leading-tight">
                  星屑が集い、誰にも奪われない<br />
                  <span className="bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 via-indigo-300 to-purple-400">
                    あなた自身の自由なソーシャル空間
                  </span>
                </h2>
                <p className="text-xs text-slate-300 max-w-lg mt-3 leading-relaxed drop-shadow">
                  Spica（スピカ）はActivityPubプロトコルに完全準拠した次世代分散型SNSノードです。特定の巨大IT企業の規約変更やアルゴリズム操作に左右されず、自立したアイデンティティを保てます。
                </p>
              </div>

              {/* Spica 3大独自特徴カード */}
              <div className="grid grid-cols-1 gap-3 w-full max-w-lg">
                <div className="bg-slate-900/80 border border-slate-800/80 backdrop-blur-xl rounded-2xl p-3.5 flex items-start space-x-3 shadow-lg">
                  <div className="w-8 h-8 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
                    <Key className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-slate-100">完全自己主権マスターキー</h3>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-normal">
                      メールアドレス・電話番号の入力は一切不要。生成される暗号鍵ひとつで安全にログインできます。
                    </p>
                  </div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800/80 backdrop-blur-xl rounded-2xl p-3.5 flex items-start space-x-3 shadow-lg">
                  <div className="w-8 h-8 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-purple-400 shrink-0">
                    <Globe className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-slate-100">ActivityPub 分散型オープン連合</h3>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-normal">
                      Fediverse全体とつながり、世界中のリモートサーバーと自由にフォロー・ノート・リアクションを交換できます。
                    </p>
                  </div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800/80 backdrop-blur-xl rounded-2xl p-3.5 flex items-start space-x-3 shadow-lg">
                  <div className="w-8 h-8 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shrink-0">
                    <Zap className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-slate-100">ミリ秒単位のリアルタイム通信</h3>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-normal">
                      Server-Sent Events（SSE）による超低遅延ストリーミングで、新着投稿やリアクションが瞬時に届きます。
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </main>

          {/* 最下部: ActivityPub プロトコル表記 (外部サーバーリストは削除し公式プロトコルのみ表記) */}
          <footer className="relative z-10 w-full px-6 py-4 mt-auto border-t border-slate-800/50 bg-slate-950/60 backdrop-blur-md">
            <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-[11px] text-slate-400">
              <div className="flex items-center space-x-2">
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-mono font-bold bg-indigo-500/10 text-indigo-300 border border-indigo-500/25 shadow-sm">
                  <Globe className="w-3 h-3 mr-1 text-indigo-400" />
                  ActivityPub
                </span>
                <span className="text-slate-400 text-xs">Decentralized Sovereign Social Web Protocol</span>
              </div>
              <div className="flex items-center space-x-3 text-slate-500 text-[11px] font-mono">
                <span>Node: {serverStats?.domain || 'spica'}</span>
                <span>•</span>
                <span>Spica v1.0.0</span>
              </div>
            </div>
          </footer>
        </div>
      )}
    </>
  );
}
