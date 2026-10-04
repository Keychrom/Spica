/**
 * SettingsView（App.tsx から切り出した画面）
 *
 * 見た目・挙動は App.tsx にあったときのまま。状態は App 側に置いたままにして、
 * ここへは props で渡す（切り出しであって作り直しではない）。
 * App からは React.lazy で読み込むので、初期バンドルには含まれない。
 */
import { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, Ban, Bell, BellOff, Check, CheckCircle2, Copy, Download, ExternalLink, FileText, Fingerprint, FolderArchive, Globe, ImageIcon, Key, KeyRound, LogOut, Mail, Moon, Palette, Plus, RefreshCw, Send, Server, Settings, ShieldAlert, Sliders, Sun, Trash2, Upload, User, Users, Volume2, VolumeX, Zap } from 'lucide-react';
import { usePrefs, updatePrefs } from '../prefs';
import { useInstallAvailable, promptInstall, isStandalone } from '../pwa';

/**
 * 設定の選択肢 1 行（表示と動作の各項目で使う）。
 * 変更はそのままサーバーへ保存される（`updatePrefs`）。
 */
function PrefChoice<T extends string>({ label, hint, value, options, onChange }: {
  label: string;
  hint?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
      <div>
        <span className="text-xs font-bold text-slate-200 block">{label}</span>
        {hint && <span className="text-[11px] text-slate-500 block mt-0.5">{hint}</span>}
      </div>
      <div className="flex gap-1.5 shrink-0">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`px-3 py-1.5 rounded-xl text-[11px] font-bold border transition cursor-pointer ${
              value === option.value
                ? 'bg-indigo-600 border-indigo-500 text-white shadow-sm'
                : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 設定のチェックボックス 1 行 */
function PrefToggle({ label, hint, checked, onChange }: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between space-x-3 cursor-pointer">
      <span>
        <span className="text-xs font-bold text-slate-200 block">{label}</span>
        {hint && <span className="text-[11px] text-slate-500 block mt-0.5 leading-relaxed">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 accent-indigo-500 cursor-pointer shrink-0"
      />
    </label>
  );
}

/**
 * 自分のリアクション履歴（設定 → 自分の記録）。
 * エクスポートには含まれていたのに画面が無かったもの。
 */
function ReactionHistoryModal({ api, onClose }: { api: any; onClose: () => void }) {
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => {
    api
      .get('/api/me/reactions')
      .then(async (res: any) => setItems(res.ok ? await res.json() : []))
      .catch(() => setItems([]));
  }, [api]);
  return (
    <div className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-slate-900 border border-slate-750 rounded-3xl p-5 w-full max-w-lg space-y-3 max-h-[80vh] overflow-y-auto"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-100">リアクション履歴</h3>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xs cursor-pointer">✕</button>
        </div>
        {items === null ? (
          <p className="text-xs text-slate-500">読み込み中...</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-slate-500">まだリアクションはありません。</p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((item) => (
              <li key={item.id} className="flex items-start space-x-3 bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2">
                <span className="text-lg shrink-0">{item.reaction}</span>
                <span className="min-w-0">
                  <span className="block text-[11px] text-slate-400 truncate">
                    {item.post?.author_name} <span className="font-mono opacity-70">{item.post?.author_handle}</span>
                    <span className="ml-2">{new Date(item.created_at).toLocaleString('ja-JP')}</span>
                  </span>
                  <span className="block text-xs text-slate-300 mt-0.5">
                    {String(item.post?.content || '').replace(/<[^>]*>/g, ' ').slice(0, 160)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** 自分の投稿カレンダー（日付ごとの件数） */
function PostCalendarModal({ api, onClose }: { api: any; onClose: () => void }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [days, setDays] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setIsLoading(true);
    api
      .get(`/api/me/post-calendar?month=${month}`)
      .then(async (res: any) => {
        const data = res.ok ? await res.json() : { days: [] };
        const map: Record<string, number> = {};
        for (const row of data.days || []) map[row.day] = row.count;
        setDays(map);
      })
      .catch(() => setDays({}))
      .finally(() => setIsLoading(false));
  }, [api, month]);

  const [yearStr, monthStr] = month.split('-');
  const firstDayOfWeek = new Date(Number(yearStr), Number(monthStr) - 1, 1).getDay();
  const daysInMonth = new Date(Number(yearStr), Number(monthStr), 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(`${month}-${String(day).padStart(2, '0')}`);

  const shiftMonth = (delta: number) => {
    const base = new Date(Number(yearStr), Number(monthStr) - 1 + delta, 1);
    setMonth(`${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}`);
  };

  return (
    <div className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-750 rounded-3xl p-5 w-full max-w-md space-y-3" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-100">投稿カレンダー</h3>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xs cursor-pointer">✕</button>
        </div>
        <div className="flex items-center justify-between">
          <button type="button" onClick={() => shiftMonth(-1)} className="px-2.5 py-1 rounded-lg text-xs bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 cursor-pointer">← 前の月</button>
          <span className="text-xs font-mono text-slate-300">{month}</span>
          <button type="button" onClick={() => shiftMonth(1)} className="px-2.5 py-1 rounded-lg text-xs bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 cursor-pointer">次の月 →</button>
        </div>
        {isLoading ? (
          <p className="text-xs text-slate-500">読み込み中...</p>
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {['日', '月', '火', '水', '木', '金', '土'].map((label) => (
              <span key={label} className="text-[10px] text-slate-500 text-center">{label}</span>
            ))}
            {cells.map((day, index) => (
              <span
                key={day || `blank-${index}`}
                className={`aspect-square rounded-lg flex flex-col items-center justify-center text-[10px] ${
                  day && days[day]
                    ? 'bg-indigo-600/30 border border-indigo-500/40 text-indigo-200 font-bold'
                    : 'bg-slate-950/60 border border-slate-800 text-slate-500'
                }`}
              >
                {day ? Number(day.slice(-2)) : ''}
                {day && days[day] ? <span className="text-[9px] opacity-80">{days[day]}</span> : null}
              </span>
            ))}
          </div>
        )}
        <p className="text-[11px] text-slate-500">自分の投稿の件数です（数字はその日の投稿数）。</p>
      </div>
    </div>
  );
}

/** 自分用のドメインミュート（ホスト名を足す / 消す） */function MutedDomainsEditor() {
  const prefs = usePrefs();
  const [input, setInput] = useState('');

  const addDomain = () => {
    let host = input.trim().toLowerCase();
    if (!host) return;
    host = host.replace(/^https?:\/\//, '').replace(/^@/, '').split('/')[0].split(':')[0];
    if (!host.includes('.') || prefs.mutedDomains.includes(host)) {
      setInput('');
      return;
    }
    updatePrefs({ mutedDomains: [...prefs.mutedDomains, host] });
    setInput('');
  };

  return (
    <div className="space-y-2">
      <div>
        <span className="text-xs font-bold text-slate-200 block">ミュートするドメイン（自分用）</span>
        <span className="text-[11px] text-slate-500 block mt-0.5 leading-relaxed">
          ここに入れたサーバーの投稿が、あなたの画面（タイムライン・検索）に出なくなります。
          サーバー全体の遮断（管理者の設定）とは別で、あなただけに効きます。
        </span>
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addDomain();
            }
          }}
          placeholder="example.com"
          className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
        />
        <button
          type="button"
          onClick={addDomain}
          className="px-3.5 py-2 rounded-xl text-[11px] font-bold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition cursor-pointer flex items-center space-x-1"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>追加</span>
        </button>
      </div>
      {prefs.mutedDomains.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {prefs.mutedDomains.map((domain) => (
            <span
              key={domain}
              className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-xl bg-slate-900 border border-slate-700 text-[11px] font-mono text-slate-300"
            >
              <span>{domain}</span>
              <button
                type="button"
                onClick={() => updatePrefs({ mutedDomains: prefs.mutedDomains.filter((d) => d !== domain) })}
                className="text-slate-500 hover:text-rose-400 transition cursor-pointer"
                title="ミュートを解除"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-slate-600">まだ登録されていません。</p>
      )}
    </div>
  );
}


export interface SettingsViewProps {
  setPostVisibility: any;
  api: any;
  setEmailNotification: any;
  fetchMutedWords: any;
  fetchTimeline: any;
  fetchFollowRequests: any;
  setNotificationPrefs: any;
  setMyEmail: any;
  setMyEmailVerified: any;
  setAuthUser: any;
  fetchMigrationInfo: any;
  fetchPasskeys: any;
  setPasskeys: any;
  setPushPermission: any;
  urlBase64ToUint8Array: any;
  setIsPushSubscribed: any;
  accentColor: any;
  authToken: any;
  authUser: any;
  autoCompressImages: any;
  blockedUsers: any;
  defaultTimeline: any;
  defaultVisibility: any;
  editBannerUrl: any;
  editBio: any;
  editFields: any;
  editIconUrl: any;
  editName: any;
  emailCode: any;
  emailNotification: any;
  fetchBlocksAndMutes: any;
  followRequests: any;
  handleLogout: any;
  handleSaveProfile: any;
  handleUnblockUser: any;
  handleUnmuteUser: any;
  handleUploadAvatar: any;
  handleUploadBanner: any;
  isLoadingBlocksMutes: any;
  isLoadingMyReports: any;
  isLoadingPasskeys: any;
  isPasswordAuthMode: any;
  isPushSubscribed: any;
  isSavingProfile: any;
  isUploadingBanner: any;
  isUploadingIcon: any;
  migrationAliasInput: any;
  migrationInfo: any;
  mutedUsers: any;
  mutedWords: any;
  myEmail: any;
  myEmailVerified: any;
  myReports: any;
  navigateToView: any;
  notificationPrefs: any;
  notificationTypes: any;
  passkeys: any;
  profileDiscoverable: any;
  profileIsLocked: any;
  pushPermission: any;
  recoveryStatus: any;
  serverStats: any;
  setAccentColor: any;
  setAutoCompressImages: any;
  setDefaultTimeline: any;
  setDefaultVisibility: any;
  setEditBannerUrl: any;
  setEditBio: any;
  setEditFields: any;
  setEditIconUrl: any;
  setEditName: any;
  setEmailCode: any;
  setMigrationAliasInput: any;
  setProfileDiscoverable: any;
  setProfileIsLocked: any;
  setSelfDeleteConfirmId: any;
  setSelfDeleteError: any;
  setSelfDeleteMasterKey: any;
  setSettingsMessage: any;
  setSettingsTab: any;
  setShowCustomEmojis: any;
  setShowSelfDeleteModal: any;
  setThemeMode: any;
  settingsMessage: any;
  settingsTab: any;
  showCustomEmojis: any;
  themeMode: any;
}

/** User-Agent を「Windows / Chrome」のような短い説明にする（端末一覧用） */
function describeUserAgent(userAgent: string): string {
  if (!userAgent) return '不明な端末';
  const os = /Windows/.test(userAgent) ? 'Windows'
    : /Android/.test(userAgent) ? 'Android'
    : /iPhone|iPad|iPod/.test(userAgent) ? 'iOS'
    : /Mac OS X/.test(userAgent) ? 'macOS'
    : /Linux/.test(userAgent) ? 'Linux'
    : 'その他のOS';
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Safari\//.test(userAgent) ? 'Safari'
    : 'ブラウザ';
  return `${os} / ${browser}`;
}

/**
 * ログイン中の端末（セッション）一覧。
 * トークンそのものはサーバーが返さない（ハッシュ id で失効させる）。
 */
function SessionsPanel({ api, authToken }: { api: any; authToken: any }) {
  const [sessions, setSessions] = useState<{ id: string; created_at: string; expires_at: string; user_agent: string; current: boolean }[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    if (!authToken) return;
    setIsLoading(true);
    try {
      const res = await api.get('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        setSessions(Array.isArray(data.sessions) ? data.sessions : []);
      }
    } catch (err) {
      console.error('セッション一覧の取得に失敗:', err);
    }
    setIsLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  const revoke = async (id: string) => {
    if (!confirm('この端末からログアウトさせますか？')) return;
    try {
      const res = await api.delete(`/api/sessions/${encodeURIComponent(id)}`);
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== id));
        setMessage('ログアウトさせました。');
      } else {
        const data = await res.json().catch(() => ({}));
        setMessage(data.error || 'ログアウトに失敗しました。');
      }
    } catch {
      setMessage('ログアウトに失敗しました。');
    }
  };

  const revokeOthers = async () => {
    if (!confirm('この端末以外のすべての端末からログアウトさせますか？')) return;
    try {
      const res = await api.post('/api/sessions/revoke-others');
      if (res.ok) {
        await load();
        setMessage('この端末以外をログアウトさせました。');
      }
    } catch {
      setMessage('ログアウトに失敗しました。');
    }
  };

  const others = sessions.filter((s) => !s.current).length;

  return (
    <div className="bg-slate-950/60 p-4 rounded-2xl border border-slate-800 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="text-xs font-bold text-slate-300 block">ログイン中の端末</span>
          <span className="text-[11px] text-slate-500 block mt-0.5">
            心当たりのない端末があれば、そこでログアウトさせてください（パスワードやマスターキーを変えるとなお安全です）。
          </span>
        </div>
        {others > 0 && (
          <button
            type="button"
            onClick={revokeOthers}
            className="shrink-0 px-3 py-1.5 rounded-xl text-[11px] font-bold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition cursor-pointer"
          >
            ほかの端末をすべてログアウト
          </button>
        )}
      </div>

      {message && <p className="text-[11px] text-slate-400">{message}</p>}

      {isLoading ? (
        <p className="text-[11px] text-slate-500">読み込み中...</p>
      ) : sessions.length === 0 ? (
        <p className="text-[11px] text-slate-500">セッションが見つかりません。</p>
      ) : (
        <ul className="space-y-1.5">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex items-center justify-between gap-3 bg-slate-900/70 border border-slate-800 rounded-xl px-3 py-2"
            >
              <div className="min-w-0">
                <span className="text-xs text-slate-200 flex items-center space-x-2">
                  <span className="truncate">{describeUserAgent(session.user_agent)}</span>
                  {session.current && (
                    <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[10px] font-bold shrink-0">この端末</span>
                  )}
                </span>
                <span className="text-[10px] text-slate-500 block mt-0.5 font-mono">
                  ログイン {new Date(session.created_at).toLocaleString('ja-JP')} / 期限 {new Date(session.expires_at).toLocaleDateString('ja-JP')}
                </span>
              </div>
              {!session.current && (
                <button
                  type="button"
                  onClick={() => revoke(session.id)}
                  className="shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-bold text-rose-300 hover:text-white hover:bg-rose-600/80 border border-rose-500/30 transition cursor-pointer"
                >
                  ログアウト
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function SettingsView(props: SettingsViewProps) {
  const { setIsPushSubscribed, urlBase64ToUint8Array, setPushPermission, setPasskeys, fetchPasskeys, fetchMigrationInfo, setAuthUser, setMyEmailVerified, setMyEmail, setNotificationPrefs, fetchFollowRequests, fetchTimeline, fetchMutedWords, setEmailNotification, api, setPostVisibility, accentColor, authToken, authUser, autoCompressImages, blockedUsers, defaultTimeline, defaultVisibility, editBannerUrl, editBio, editFields, editIconUrl, editName, emailCode, emailNotification, fetchBlocksAndMutes, followRequests, handleLogout, handleSaveProfile, handleUnblockUser, handleUnmuteUser, handleUploadAvatar, handleUploadBanner, isLoadingBlocksMutes, isLoadingMyReports, isLoadingPasskeys, isPasswordAuthMode, isPushSubscribed, isSavingProfile, isUploadingBanner, isUploadingIcon, migrationAliasInput, migrationInfo, mutedUsers, mutedWords, myEmail, myEmailVerified, myReports, navigateToView, notificationPrefs, notificationTypes, passkeys, profileDiscoverable, profileIsLocked, pushPermission, recoveryStatus, serverStats, setAccentColor, setAutoCompressImages, setDefaultTimeline, setDefaultVisibility, setEditBannerUrl, setEditBio, setEditFields, setEditIconUrl, setEditName, setEmailCode, setMigrationAliasInput, setProfileDiscoverable, setProfileIsLocked, setSelfDeleteConfirmId, setSelfDeleteError, setSelfDeleteMasterKey, setSettingsMessage, setSettingsTab, setShowCustomEmojis, setShowSelfDeleteModal, setThemeMode, settingsMessage, settingsTab, showCustomEmojis, themeMode } = props;

  // --- App.tsx から移した state とハンドラ（この画面だけで使う） ---

  // 🗄️ サーバー保存の設定（表示と動作）。変更は updatePrefs がそのまま保存する
  const prefs = usePrefs();
  // 自分の記録（リアクション履歴・カレンダー）のモーダル
  const [showReactionHistory, setShowReactionHistory] = useState(false);
  const [showPostCalendar, setShowPostCalendar] = useState(false);
  // PWA のインストール導線
  const installAvailable = useInstallAvailable();
  const [installMessage, setInstallMessage] = useState<string | null>(null);

  const [isRegisteringPasskey, setIsRegisteringPasskey] = useState<boolean>(false);

  const [passkeyDeviceName, setPasskeyDeviceName] = useState<string>('');

  const [passkeyActionMessage, setPasskeyActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [newMutedWord, setNewMutedWord] = useState<string>('');

  const [mutedWordCaseSensitive, setMutedWordCaseSensitive] = useState<boolean>(false);

  const [mutedWordWholeWord, setMutedWordWholeWord] = useState<boolean>(false);

  const [isSavingMutedWord, setIsSavingMutedWord] = useState<boolean>(false);

  const [isRespondingRequest, setIsRespondingRequest] = useState<string | null>(null);

  const [isExportingData, setIsExportingData] = useState<boolean>(false);

  const [exportingFormat, setExportingFormat] = useState<'json' | 'zip' | null>(null);

  const [migrationTargetInput, setMigrationTargetInput] = useState<string>('');

  const [migrationMsg, setMigrationMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [isMigrating, setIsMigrating] = useState<boolean>(false);

  const [isSubscribingPush, setIsSubscribingPush] = useState<boolean>(false);

  const [isSendingTestPush, setIsSendingTestPush] = useState<boolean>(false);

  const handleSavePreferences = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('spica_pref_visibility', defaultVisibility);
    localStorage.setItem('spica_pref_timeline', defaultTimeline);
    localStorage.setItem('spica_pref_emojis', String(showCustomEmojis));
    localStorage.setItem('spica_auto_compress', String(autoCompressImages));
    localStorage.setItem('astrabit_pref_visibility', defaultVisibility);
    localStorage.setItem('astrabit_pref_timeline', defaultTimeline);
    localStorage.setItem('astrabit_pref_emojis', String(showCustomEmojis));
    setPostVisibility(defaultVisibility);
    setSettingsMessage({ type: 'success', text: '環境設定を保存しました！' });
    setTimeout(() => setSettingsMessage(null), 4000);
  };

  const handleToggleEmailNotification = async (enabled: boolean) => {
    if (!authToken) return;
    setIsSavingNotifPrefs(true);
    try {
      const res = await api.post('/api/notifications/email', { enabled });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'メール通知の設定に失敗しました。');
        return;
      }
      setEmailNotification(data.email || null);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsSavingNotifPrefs(false);
    }
  };

  const handleAddMutedWord = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authToken || !newMutedWord.trim()) return;
    setIsSavingMutedWord(true);
    try {
      const res = await api.post('/api/muted-words', { keyword: newMutedWord.trim(), caseSensitive: mutedWordCaseSensitive, wholeWord: mutedWordWholeWord, });
      const data = await res.json();
      if (res.ok) {
        setNewMutedWord('');
        setMutedWordCaseSensitive(false);
        setMutedWordWholeWord(false);
        await fetchMutedWords();
        await fetchTimeline();
      } else {
        alert(data.error || 'キーワードの登録に失敗しました。');
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsSavingMutedWord(false);
    }
  };

  const handleDeleteMutedWord = async (id: string) => {
    if (!authToken) return;
    try {
      const res = await api.delete(`/api/muted-words/${encodeURIComponent(id)}`);
      if (res.ok) {
        await fetchMutedWords();
        await fetchTimeline();
      }
    } catch (err) {
      console.error('ミュートワードの削除エラー:', err);
    }
  };

  const handleRespondFollowRequest = async (actorUrl: string, action: 'accept' | 'reject') => {
    if (!authToken) return;
    setIsRespondingRequest(actorUrl);
    try {
      const res = await api.post('/api/follow-requests/respond', { actorUrl, action });
      const data = await res.json();
      if (res.ok) {
        await fetchFollowRequests();
        alert(action === 'accept' ? 'フォローを承認しました。' : 'フォローを拒否しました。');
      } else {
        alert(data.error || '処理に失敗しました。');
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsRespondingRequest(null);
    }
  };

  const [isSavingNotifPrefs, setIsSavingNotifPrefs] = useState<boolean>(false);

  const handleToggleNotificationPref = async (type: string, enabled: boolean) => {
    if (!authToken || !notificationPrefs) return;
    const next = { ...notificationPrefs, [type]: enabled };
    setNotificationPrefs(next);
    setIsSavingNotifPrefs(true);
    try {
      const res = await api.post('/api/notifications/settings', { prefs: next });
      const data = await res.json();
      if (!res.ok) {
        setNotificationPrefs(notificationPrefs);
        alert(data.error || '通知設定の保存に失敗しました。');
        return;
      }
      setNotificationPrefs(data.prefs || next);
    } catch (err: any) {
      setNotificationPrefs(notificationPrefs);
      alert(err.message);
    } finally {
      setIsSavingNotifPrefs(false);
    }
  };

  const [emailInput, setEmailInput] = useState<string>('');

  const [emailMsg, setEmailMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [isSendingEmail, setIsSendingEmail] = useState<boolean>(false);

  const [pwCurrent, setPwCurrent] = useState<string>('');

  const [pwMasterKey, setPwMasterKey] = useState<string>('');

  const [pwNew, setPwNew] = useState<string>('');

  const [pwNewConfirm, setPwNewConfirm] = useState<string>('');

  const [isSavingPassword, setIsSavingPassword] = useState<boolean>(false);

  const [passwordMsg, setPasswordMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleSendEmailCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authToken || !emailInput.trim()) return;
    setIsSendingEmail(true);
    setEmailMsg(null);
    try {
      const res = await api.post('/api/user/email', { email: emailInput.trim() });
      const data = await res.json();
      setEmailMsg(res.ok
        ? { type: 'success', text: data.message || '確認コードを送信しました。' }
        : { type: 'error', text: data.error || '送信に失敗しました。' });
    } catch (err: any) {
      setEmailMsg({ type: 'error', text: err.message });
    } finally {
      setIsSendingEmail(false);
    }
  };

  const handleVerifyEmail = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authToken || !emailInput.trim() || !emailCode.trim()) return;
    setIsSendingEmail(true);
    setEmailMsg(null);
    try {
      const res = await api.post('/api/user/email/verify', { email: emailInput.trim(), code: emailCode.trim() });
      const data = await res.json();
      if (res.ok) {
        setMyEmail(emailInput.trim().toLowerCase());
        setMyEmailVerified(true);
        setEmailCode('');
        setEmailMsg({ type: 'success', text: data.message || 'メールアドレスを確認しました。' });
      } else {
        setEmailMsg({ type: 'error', text: data.error || '確認に失敗しました。' });
      }
    } catch (err: any) {
      setEmailMsg({ type: 'error', text: err.message });
    } finally {
      setIsSendingEmail(false);
    }
  };

  const handleDeleteEmail = async () => {
    if (!authToken) return;
    if (!confirm('登録したメールアドレスを削除しますか？（マスターキーの復元ができなくなります）')) return;
    try {
      const res = await api.delete('/api/user/email');
      if (res.ok) {
        setMyEmail('');
        setMyEmailVerified(false);
        setEmailInput('');
        setEmailMsg({ type: 'success', text: 'メールアドレスを削除しました。' });
      }
    } catch (err) {
      console.error('メールアドレスの削除エラー:', err);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken) return;
    setPasswordMsg(null);

    const hasPassword = Boolean(authUser?.hasPassword);
    if (pwNew.length < 8) {
      setPasswordMsg({ type: 'error', text: '新しいパスワードは8文字以上で入力してください。' });
      return;
    }
    if (pwNew !== pwNewConfirm) {
      setPasswordMsg({ type: 'error', text: '確認用の新しいパスワードが一致しません。' });
      return;
    }
    if (hasPassword ? (!pwCurrent && !pwMasterKey.trim()) : !pwMasterKey.trim()) {
      setPasswordMsg({
        type: 'error',
        text: hasPassword
          ? '現在のパスワード、またはマスターキーを入力してください。'
          : 'パスワードを新しく設定するにはマスターキーが必要です。',
      });
      return;
    }

    setIsSavingPassword(true);
    try {
      const res = await api.post('/api/user/password', { newPassword: pwNew, ...(pwCurrent ? { currentPassword: pwCurrent } : {}), ...(pwMasterKey.trim() ? { masterKey: pwMasterKey.trim() } : {}), });
      const data = await res.json();
      if (!res.ok) {
        setPasswordMsg({ type: 'error', text: data.error || 'パスワードの変更に失敗しました。' });
        return;
      }
      setPasswordMsg({ type: 'success', text: data.message || 'パスワードを変更しました。' });
      setPwCurrent('');
      setPwMasterKey('');
      setPwNew('');
      setPwNewConfirm('');
      setAuthUser((prev: any) => (prev ? { ...prev, hasPassword: true } : prev));
    } catch (err: any) {
      setPasswordMsg({ type: 'error', text: err.message });
    } finally {
      setIsSavingPassword(false);
    }
  };

  const [importFile, setImportFile] = useState<File | null>(null);

  const [isImporting, setIsImporting] = useState<boolean>(false);

  const [importResult, setImportResult] = useState<{ type: 'success' | 'error'; text: string; detail?: string } | null>(null);

  const handleImportArchive = async () => {
    if (!authToken || !importFile) return;
    setIsImporting(true);
    setImportResult(null);
    try {
      const form = new FormData();
      form.append('archive', importFile);

      const res = await api.post('/api/import/archive', form);
      const data = await res.json();

      if (res.ok) {
        setImportResult({
          type: 'success',
          text: data.message || `${data.imported} 件の投稿を取り込みました。`,
          detail: `形式: ${data.format} / 取り込み: ${data.imported} / 重複スキップ: ${data.skipped} / 失敗: ${data.failed}${data.total ? ` / 対象: ${data.total}` : ''}${
            Array.isArray(data.errors) && data.errors.length > 0 ? `\n${data.errors.join('\n')}` : ''
          }`,
        });
        setImportFile(null);
        await fetchTimeline();
      } else {
        setImportResult({ type: 'error', text: data.error || 'インポートに失敗しました。' });
      }
    } catch (err: any) {
      setImportResult({ type: 'error', text: err.message });
    } finally {
      setIsImporting(false);
    }
  };

  const handleSaveMigrationAlias = async () => {
    if (!authToken) return;
    setIsMigrating(true);
    setMigrationMsg(null);
    try {
      const res = await api.post('/api/user/migration/alias', { alias: migrationAliasInput.trim() });
      const data = await res.json();
      if (!res.ok) {
        setMigrationMsg({ type: 'error', text: data.error || '保存に失敗しました。' });
        return;
      }
      setMigrationMsg({ type: 'success', text: data.message || '保存しました。' });
      await fetchMigrationInfo();
    } catch (err: any) {
      setMigrationMsg({ type: 'error', text: err.message });
    } finally {
      setIsMigrating(false);
    }
  };

  const handleExecuteMove = async () => {
    if (!authToken) return;
    const target = migrationTargetInput.trim();
    if (!target) {
      setMigrationMsg({ type: 'error', text: '引っ越し先アカウント（@ユーザー名@サーバー）を入力してください。' });
      return;
    }
    if (!window.confirm(`このアカウントから ${target} へ引っ越しますか？\nフォロワー全員に通知され、元には戻せません。`)) {
      return;
    }
    setIsMigrating(true);
    setMigrationMsg(null);
    try {
      const res = await api.post('/api/user/migration/move', { target });
      const data = await res.json();
      if (!res.ok) {
        setMigrationMsg({ type: 'error', text: data.error || '引っ越しに失敗しました。' });
        return;
      }
      setMigrationMsg({ type: 'success', text: data.message || '引っ越しを実行しました。' });
      await fetchMigrationInfo();
      fetchTimeline();
    } catch (err: any) {
      setMigrationMsg({ type: 'error', text: err.message });
    } finally {
      setIsMigrating(false);
    }
  };

  const handleCancelMove = async () => {
    if (!authToken) return;
    if (!window.confirm('引っ越し先の記録を解除しますか？（連合先へ配送済みの通知は取り消せません）')) return;
    setIsMigrating(true);
    setMigrationMsg(null);
    try {
      const res = await api.post('/api/user/migration/cancel');
      const data = await res.json();
      setMigrationMsg(
        res.ok ? { type: 'success', text: data.message || '解除しました。' } : { type: 'error', text: data.error || '解除に失敗しました。' },
      );
      await fetchMigrationInfo();
    } catch (err: any) {
      setMigrationMsg({ type: 'error', text: err.message });
    } finally {
      setIsMigrating(false);
    }
  };

  const handleExportData = async (format: 'json' | 'zip') => {
    if (!authToken) return;
    setIsExportingData(true);
    setExportingFormat(format);
    try {
      const started = await api.post('/api/user/export', { format });
      if (!started.ok) {
        const err = await started.json().catch(() => ({}));
        alert(err.error || 'データのエクスポートを開始できませんでした。');
        return;
      }
      const { jobId } = await started.json();
      setSettingsMessage({ type: 'success', text: `${format.toUpperCase()} を作成しています…（そのままお待ちください）` });

      // 出来上がるまで見に行く（最大 2 分。ZIP はアカウントが大きいと時間がかかる）
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const statusRes = await api.get(`/api/user/export/${jobId}`);
        if (!statusRes.ok) continue;
        const info = await statusRes.json();
        if (info.status === 'failed') {
          alert(info.error || 'エクスポートに失敗しました。');
          setSettingsMessage(null);
          return;
        }
        if (info.status !== 'done') continue;

        const fileRes = await api.fetch(info.downloadUrl);
        if (!fileRes.ok) {
          alert('エクスポートのダウンロードに失敗しました。');
          setSettingsMessage(null);
          return;
        }
        const blob = await fileRes.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = info.filename || `spica-export-${authUser?.id || 'me'}.${format}`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        setSettingsMessage({ type: 'success', text: `データを${format.toUpperCase()}形式でダウンロードしました！` });
        setTimeout(() => setSettingsMessage(null), 4000);
        return;
      }
      alert('エクスポートに時間がかかっています。しばらくしてから、もう一度お試しください。');
      setSettingsMessage(null);
    } catch (err: any) {
      alert(`エクスポートエラー: ${err.message}`);
    } finally {
      setIsExportingData(false);
      setExportingFormat(null);
    }
  };

  const handleRegisterPasskey = async () => {
    if (!authToken) return;
    setIsRegisteringPasskey(true);
    setPasskeyActionMessage(null);
    try {
      const optRes = await api.post('/api/webauthn/register/options');
      if (!optRes.ok) {
        const err = await optRes.json();
        throw new Error(err.error || 'オプション取得に失敗しました。');
      }
      const options = await optRes.json();

      // SimpleWebAuthn ブラウザ側 API 実行
      const { startRegistration } = await import('@simplewebauthn/browser');
      const regResponse = await startRegistration({ optionsJSON: options });

      const verifyRes = await api.post('/api/webauthn/register/verify', { response: regResponse, credential: regResponse, device_name: passkeyDeviceName.trim() || undefined, });

      if (!verifyRes.ok) {
        const err = await verifyRes.json();
        throw new Error(err.error || '登録検証に失敗しました。');
      }

      setPasskeyDeviceName('');
      setPasskeyActionMessage({ type: 'success', text: 'パスキーを正常に登録しました！次回から生体認証でワンタップログインできます。' });
      fetchPasskeys();
      setTimeout(() => setPasskeyActionMessage(null), 5000);
    } catch (e: any) {
      console.error('Passkey registration error:', e);
      if (e.name !== 'NotAllowedError') {
        setPasskeyActionMessage({ type: 'error', text: e.message || 'パスキー登録に失敗しました。' });
      }
    } finally {
      setIsRegisteringPasskey(false);
    }
  };

  const handleDeletePasskey = async (credId: string) => {
    if (!authToken || !confirm('このパスキーを削除しますか？')) return;
    try {
      const res = await api.delete(`/api/webauthn/credentials/${credId}`);
      if (res.ok) {
        setPasskeys((prev: any) => prev.filter((p: any) => p.id !== credId));
        setPasskeyActionMessage({ type: 'success', text: 'パスキーを削除しました。' });
        setTimeout(() => setPasskeyActionMessage(null), 4000);
      } else {
        const err = await res.json();
        alert(err.error || 'パスキーの削除に失敗しました。');
      }
    } catch (e: any) {
      alert(`エラー: ${e.message}`);
    }
  };

  const handleSubscribePush = async () => {
    if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) {
      alert('お使いのブラウザまたは環境は Web Push 通知に対応していません。');
      return;
    }

    setIsSubscribingPush(true);
    try {
      // 1. 通知パーミッションの要求
      const perm = await Notification.requestPermission();
      setPushPermission(perm);
      if (perm !== 'granted') {
        alert('プッシュ通知の許可が拒否されました。ブラウザの設定から通知を許可してください。');
        setIsSubscribingPush(false);
        return;
      }

      // 2. サーバーから VAPID 公開鍵を取得
      const keyRes = await api.get('/api/push/vapid-public-key', { auth: false });
      const { publicKey } = await keyRes.json();
      if (!publicKey) throw new Error('VAPID 公開鍵を取得できませんでした。');

      // 3. Service Worker で PushManager.subscribe
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      // 4. サーバーへ登録
      const subRes = await api.post('/api/push/subscribe', { subscription: sub.toJSON() });

      if (subRes.ok) {
        setIsPushSubscribed(true);
        alert('Web Push 通知が有効になりました！通知をテストしたい場合は「テスト通知を送信」をお試しください。');
      } else {
        const err = await subRes.json();
        alert(err.error || 'プッシュ通知の登録に失敗しました。');
      }
    } catch (err: any) {
      alert(err.message || 'プッシュ通知の登録中にエラーが発生しました。');
    } finally {
      setIsSubscribingPush(false);
    }
  };

  const handleUnsubscribePush = async () => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    setIsSubscribingPush(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setIsPushSubscribed(false);
      alert('プッシュ通知の登録を解除しました。');
    } catch (err: any) {
      alert(err.message || '解除中にエラーが発生しました。');
    } finally {
      setIsSubscribingPush(false);
    }
  };

  const handleSendTestPush = async () => {
    if (!authToken) return;
    setIsSendingTestPush(true);
    try {
      const res = await api.post('/api/push/test');
      const data = await res.json();
      if (res.ok) {
        alert('テスト通知を送信しました！スマホまたはデスクトップの通知欄をご確認ください。');
      } else {
        alert(data.error || 'テスト通知の送信に失敗しました。');
      }
    } catch (err: any) {
      alert(err.message || '通信エラーが発生しました。');
    } finally {
      setIsSendingTestPush(false);
    }
  };
  return (
    <>
        {/* ユーザー向け設定画面 (Settings View) */}
        <main className="max-w-5xl mx-auto px-4 py-6 w-full flex-1 space-y-6">
          {/* 戻るボタン & タイトルヘッダー */}
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div className="flex items-center space-x-3">
              <button
                onClick={() => navigateToView('timeline')}
                className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 transition"
                title="タイムラインに戻る"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div>
                <h2 className="text-xl font-black text-slate-100 flex items-center space-x-2">
                  <Settings className="w-5 h-5 text-indigo-400" />
                  <span>ユーザー設定</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  アカウント情報、プロフィール、投稿公開範囲、環境設定
                </p>
              </div>
            </div>
          </div>

          {/* メッセージトースト */}
          {settingsMessage && (
            <div
              className={`p-3.5 rounded-2xl text-xs font-semibold flex items-center space-x-2 shadow-lg ${
                settingsMessage.type === 'success'
                  ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                  : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
              }`}
            >
              {settingsMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
              )}
              <span>{settingsMessage.text}</span>
            </div>
          )}

          {/* 設定タブナビゲーション & コンテンツ */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {/* 左側: タブ一覧 */}
            <div className="md:col-span-1 space-y-1.5 bg-slate-900/70 p-2.5 rounded-2xl border border-slate-800/80 h-fit">
              <button
                onClick={() => { setSettingsTab('profile'); setSettingsMessage(null); }}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold transition flex items-center space-x-2.5 ${
                  settingsTab === 'profile'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <User className="w-4 h-4" />
                <span>プロフィール</span>
              </button>

              <button
                onClick={() => { setSettingsTab('preferences'); setSettingsMessage(null); }}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold transition flex items-center space-x-2.5 ${
                  settingsTab === 'preferences'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Sliders className="w-4 h-4" />
                <span>投稿・表示設定</span>
              </button>

              <button
                onClick={() => { setSettingsTab('account'); setSettingsMessage(null); }}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold transition flex items-center space-x-2.5 ${
                  settingsTab === 'account'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Globe className="w-4 h-4" />
                <span>アカウント・連合</span>
              </button>

              <button
                onClick={() => {
                  setSettingsTab('mutes_blocks');
                  setSettingsMessage(null);
                  fetchBlocksAndMutes();
                }}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold transition flex items-center space-x-2.5 cursor-pointer ${
                  settingsTab === 'mutes_blocks'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Ban className="w-4 h-4" />
                <span>ミュートとブロック</span>
              </button>

              <button
                onClick={() => { setSettingsTab('session'); setSettingsMessage(null); }}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-bold transition flex items-center space-x-2.5 ${
                  settingsTab === 'session'
                    ? 'bg-rose-600 text-white shadow-md shadow-rose-600/25'
                    : 'text-rose-400/80 hover:text-rose-300 hover:bg-rose-950/20'
                }`}
              >
                <LogOut className="w-4 h-4" />
                <span>セッション・ログアウト</span>
              </button>
            </div>

            {/* 右側: タブコンテンツ */}
            <div className="md:col-span-3 bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl">
              {settingsTab === 'profile' ? (
                /* 👤 プロフィール設定 */
                <form onSubmit={handleSaveProfile} className="space-y-5">
                  <div className="border-b border-slate-800 pb-3">
                    <h3 className="text-base font-bold text-slate-100 flex items-center space-x-2">
                      <User className="w-4 h-4 text-indigo-400" />
                      <span>プロフィール設定</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      タイムラインや連合相手（Mastodon / Misskey）に表示されるあなたの名前やアイコンを変更します。
                    </p>
                  </div>

                  {/* プレビュー表示 */}
                  <div className="rounded-2xl border border-slate-800 overflow-hidden bg-slate-900/90 shadow-xl">
                    <div className="h-32 sm:h-36 relative bg-gradient-to-r from-indigo-950 via-slate-900 to-purple-950 overflow-hidden">
                      {editBannerUrl ? (
                        <img
                          src={editBannerUrl}
                          alt="Banner Preview"
                          className="w-full h-full object-cover"
                          onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
                        />
                      ) : (
                        <div className="w-full h-full opacity-30 bg-[radial-gradient(#4f46e5_1px,transparent_1px)] [background-size:16px_16px]" />
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 to-transparent" />
                    </div>
                    <div className="px-5 pb-5 pt-1 relative bg-slate-900/95">
                      <div className="flex items-end space-x-3.5 -mt-10 relative z-10">
                        <div className="w-16 h-16 rounded-2xl p-1 bg-slate-900 border-2 border-slate-700/80 shadow-2xl shrink-0 overflow-hidden">
                          {editIconUrl ? (
                            <img
                              src={editIconUrl}
                              alt="Avatar Preview"
                              className="w-full h-full rounded-xl object-cover"
                              onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
                            />
                          ) : (
                            <div className="w-full h-full rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-xl text-white">
                              {(editName || authUser?.name || 'A').slice(0, 1).toUpperCase()}
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 pb-1 flex-1">
                          <span className="font-bold text-sm text-slate-100 block truncate">
                            {editName || authUser?.name || '表示名'}
                          </span>
                          <span className="text-xs font-mono text-indigo-400 block truncate">
                            {authUser?.handle}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 表示名 */}
                  <div>
                    <label className="block text-xs font-bold text-slate-300 mb-1.5">
                      表示名 <span className="text-rose-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      required
                      placeholder="例: Alice In Borderland"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                    />
                  </div>

                  {/* アイコン画像 (アバター) */}
                  <div>
                    <label className="block text-xs font-bold text-slate-300 mb-1.5">
                      アイコン画像 (アバター)
                    </label>
                    <div className="flex flex-col sm:flex-row gap-2.5 items-start sm:items-center">
                      <label
                        className={`cursor-pointer px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 text-xs font-bold flex items-center space-x-1.5 transition shrink-0 ${
                          isUploadingIcon ? 'opacity-50 pointer-events-none' : ''
                        }`}
                      >
                        {isUploadingIcon ? (
                          <RefreshCw className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                        ) : (
                          <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
                        )}
                        <span>{isUploadingIcon ? '最適化・保存中...' : '画像をアップロード'}</span>
                        <input
                          type="file"
                          accept="image/*"
                          disabled={isUploadingIcon}
                          onChange={(e) => {
                            handleUploadAvatar(e.target.files);
                            e.target.value = '';
                          }}
                          className="hidden"
                        />
                      </label>
                      <input
                        type="url"
                        value={editIconUrl}
                        onChange={(e) => setEditIconUrl(e.target.value)}
                        placeholder="または画像URLを直接入力 (https://...)"
                        className="w-full sm:flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition font-mono"
                      />
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      端末から画像を直接アップロードするか、外部画像URLを指定できます（長辺800pxに自動最適化されます）。
                    </p>
                  </div>

                  {/* ヘッダー画像 URL */}
                  <div>
                    <label className="block text-xs font-bold text-slate-300 mb-1.5">
                      ヘッダーバナー画像
                    </label>
                    <div className="flex flex-col sm:flex-row gap-2.5 items-start sm:items-center">
                      <label
                        className={`cursor-pointer px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 text-xs font-bold flex items-center space-x-1.5 transition shrink-0 ${
                          isUploadingBanner ? 'opacity-50 pointer-events-none' : ''
                        }`}
                      >
                        {isUploadingBanner ? (
                          <RefreshCw className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                        ) : (
                          <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
                        )}
                        <span>{isUploadingBanner ? '最適化・保存中...' : '画像をアップロード'}</span>
                        <input
                          type="file"
                          accept="image/*"
                          disabled={isUploadingBanner}
                          onChange={(e) => {
                            handleUploadBanner(e.target.files);
                            e.target.value = '';
                          }}
                          className="hidden"
                        />
                      </label>
                      <input
                        type="url"
                        value={editBannerUrl}
                        onChange={(e) => setEditBannerUrl(e.target.value)}
                        placeholder="または画像URLを直接入力 (https://...)"
                        className="w-full sm:flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition font-mono"
                      />
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      プロフィールのヘッダー背景画像です（横長・推奨比率 3:1）。
                    </p>
                  </div>

                  {/* 自己紹介 (Bio) */}
                  <div>
                    <label className="block text-xs font-bold text-slate-300 mb-1.5">
                      自己紹介 (Bio)
                    </label>
                    <textarea
                      value={editBio}
                      onChange={(e) => setEditBio(e.target.value)}
                      rows={3}
                      placeholder="自己紹介を入力してください..."
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition resize-none leading-relaxed"
                    />
                  </div>

                  {/* 🔗 プロフィール項目（リンク集など） */}
                  <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-xs text-slate-100">🔗 プロフィール項目（最大4件）</span>
                      {editFields.length < 4 && (
                        <button
                          type="button"
                          onClick={() => setEditFields((prev: any) => [...prev, { name: '', value: '' }])}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-[11px] font-semibold transition cursor-pointer"
                        >
                          ＋ 追加
                        </button>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      リンク集や肩書きなど。連合先（Mastodon / Misskey）のプロフィールにも項目として表示されます。
                    </p>
                    {editFields.length === 0 && (
                      <p className="text-[11px] text-slate-500">項目がありません。「＋ 追加」から登録できます。</p>
                    )}
                    {editFields.map((field: any, index: any) => (
                      <div key={index} className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          value={field.name}
                          maxLength={40}
                          placeholder="項目名（例: Webサイト）"
                          onChange={(e) => setEditFields((prev: any) => prev.map((f: any, i: any) => (i === index ? { ...f, name: e.target.value } : f)))}
                          className="sm:w-40 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        />
                        <input
                          type="text"
                          value={field.value}
                          maxLength={200}
                          placeholder="内容（例: https://example.com）"
                          onChange={(e) => setEditFields((prev: any) => prev.map((f: any, i: any) => (i === index ? { ...f, value: e.target.value } : f)))}
                          className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => setEditFields((prev: any) => prev.filter((_: any, i: any) => i !== index))}
                          className="px-3 py-2 bg-slate-800 hover:bg-rose-600/80 text-slate-300 hover:text-white rounded-xl text-xs font-bold transition cursor-pointer"
                        >
                          削除
                        </button>
                      </div>
                    ))}
                    <label className="flex items-start space-x-3 cursor-pointer pt-1">
                      <input
                        type="checkbox"
                        checked={profileDiscoverable}
                        onChange={(e) => setProfileDiscoverable(e.target.checked)}
                        className="mt-0.5 w-4 h-4 accent-indigo-500 cursor-pointer"
                      />
                      <div>
                        <span className="font-bold text-xs text-slate-100 block">👥 ユーザーディレクトリに掲載する</span>
                        <span className="text-[11px] text-slate-400 leading-relaxed block mt-0.5">
                          オフにすると、このサーバーのユーザー一覧（ディレクトリ）に表示されなくなります。
                        </span>
                      </div>
                    </label>
                  </div>

                  {/* 🔒 鍵アカウント設定 */}
                  <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4 space-y-2">
                    <label className="flex items-start space-x-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={profileIsLocked}
                        onChange={(e) => setProfileIsLocked(e.target.checked)}
                        className="mt-0.5 w-4 h-4 accent-amber-500 cursor-pointer"
                      />
                      <div>
                        <span className="font-bold text-xs text-slate-100 block">🔒 鍵アカウント（フォロー承認制）</span>
                        <span className="text-[11px] text-slate-400 leading-relaxed block mt-0.5">
                          オンにすると、新しいフォローは自動承認されず「フォローリクエスト」として届きます。
                          承認した相手だけがフォロワーになり、フォロワー限定の投稿が届きます（連合先にも承認制として伝わります）。
                        </span>
                      </div>
                    </label>
                  </div>

                  {/* 保存ボタン */}
                  <div className="pt-2 flex justify-end">
                    <button
                      type="submit"
                      disabled={isSavingProfile}
                      className="px-5 py-2.5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white shadow-lg shadow-indigo-600/30 transition flex items-center space-x-1.5"
                    >
                      {isSavingProfile ? (
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5" />
                      )}
                      <span>{isSavingProfile ? '保存中...' : 'プロフィールを保存'}</span>
                    </button>
                  </div>
                </form>
              ) : settingsTab === 'preferences' ? (
                /* ⚙️ 投稿・表示設定 */
                <form onSubmit={handleSavePreferences} className="space-y-6">
                  <div className="border-b border-slate-800 pb-3">
                    <h3 className="text-base font-bold text-slate-100 flex items-center space-x-2">
                      <Sliders className="w-4 h-4 text-indigo-400" />
                      <span>投稿・表示の環境設定</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      投稿作成時のデフォルト公開範囲や、タイムラインの初期表示を設定します（この端末に保存されます）。
                    </p>
                  </div>

                  {/* 🎨 外観テーマ & アクセントカラー設定 */}
                  <div className="space-y-4 p-4 rounded-2xl bg-slate-950/60 border border-slate-800">
                    <div>
                      <label className="block text-xs font-bold text-slate-200 mb-1 flex items-center space-x-2">
                        <Palette className="w-4 h-4 text-indigo-400" />
                        <span>外観テーマ & カラーテーマ</span>
                      </label>
                      <p className="text-[11px] text-slate-400">
                        お好みの画面モードとアクセントカラーにカスタマイズできます（即時反映されます）。
                      </p>
                    </div>

                    {/* テーマモード (ダーク / 漆黒OLED / ライト) */}
                    <div>
                      <span className="text-[11px] font-bold text-slate-300 block mb-2">画面モード</span>
                      <div className="grid grid-cols-3 gap-2.5">
                        {[
                          { id: 'dark', label: 'コズミック・ダーク', icon: Moon, desc: '標準ダーク' },
                          { id: 'pure_black', label: 'OLED 漆黒モード', icon: Zap, desc: '完全ブラック省電力' },
                          { id: 'light', label: 'ソーラー・ライト', icon: Sun, desc: '明るい白基調' },
                        ].map((m) => {
                          const IconComp = m.icon;
                          const isSelected = themeMode === m.id;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => setThemeMode(m.id as any)}
                              className={`p-3 rounded-xl border text-center transition cursor-pointer flex flex-col items-center justify-center space-y-1 ${
                                isSelected
                                  ? 'bg-indigo-600/20 border-indigo-500 text-white font-bold ring-2 ring-indigo-500/30'
                                  : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                              }`}
                            >
                              <IconComp className={`w-4 h-4 ${isSelected ? 'text-indigo-400' : 'text-slate-400'}`} />
                              <span className="text-xs">{m.label}</span>
                              <span className="text-[10px] text-slate-500">{m.desc}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* アクセントカラー (6色) */}
                    <div>
                      <span className="text-[11px] font-bold text-slate-300 block mb-2">アクセントカラー</span>
                      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                        {[
                          { id: 'indigo', label: 'インディゴ', hex: '#6366f1' },
                          { id: 'cyan', label: 'シアン', hex: '#06b6d4' },
                          { id: 'emerald', label: 'エメラルド', hex: '#10b981' },
                          { id: 'purple', label: 'パープル', hex: '#a855f7' },
                          { id: 'rose', label: 'ローズ', hex: '#f43f5e' },
                          { id: 'amber', label: 'アンバー', hex: '#f59e0b' },
                        ].map((c) => {
                          const isSelected = accentColor === c.id;
                          return (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => setAccentColor(c.id as any)}
                              className={`p-2.5 rounded-xl border flex flex-col items-center space-y-1.5 transition cursor-pointer ${
                                isSelected
                                  ? 'border-white bg-slate-900 ring-2 ring-white/30'
                                  : 'border-slate-800 bg-slate-900/60 hover:bg-slate-800/80'
                              }`}
                            >
                              <div
                                className="w-5 h-5 rounded-full shadow"
                                style={{ backgroundColor: c.hex }}
                              />
                              <span className="text-[10px] font-bold text-slate-300">{c.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* デフォルト投稿公開範囲 */}
                  <div className="space-y-2.5">
                    <label className="block text-xs font-bold text-slate-300">
                      デフォルトの投稿公開範囲
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setDefaultVisibility('public')}
                        className={`p-3.5 rounded-2xl border text-left transition flex items-start space-x-3 ${
                          defaultVisibility === 'public'
                            ? 'bg-indigo-600/15 border-indigo-500/60 ring-2 ring-indigo-500/30 text-white'
                            : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800/40'
                        }`}
                      >
                        <Globe className={`w-4 h-4 mt-0.5 shrink-0 ${defaultVisibility === 'public' ? 'text-indigo-400' : 'text-slate-400'}`} />
                        <div>
                          <span className="font-bold text-xs block">🌐 グローバル (連合配信)</span>
                          <span className="text-[11px] text-slate-400 mt-0.5 block leading-relaxed">
                            世界中のActivityPubサーバーや接続リレーへ配信されます。
                          </span>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setDefaultVisibility('local')}
                        className={`p-3.5 rounded-2xl border text-left transition flex items-start space-x-3 ${
                          defaultVisibility === 'local'
                            ? 'bg-emerald-600/15 border-emerald-500/60 ring-2 ring-emerald-500/30 text-white'
                            : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800/40'
                        }`}
                      >
                        <Server className={`w-4 h-4 mt-0.5 shrink-0 ${defaultVisibility === 'local' ? 'text-emerald-400' : 'text-slate-400'}`} />
                        <div>
                          <span className="font-bold text-xs block">🏠 ローカル限定</span>
                          <span className="text-[11px] text-slate-400 mt-0.5 block leading-relaxed">
                            このノード内のみに留め、外部サーバーには配信しません。
                          </span>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setDefaultVisibility('followers')}
                        className={`p-3.5 rounded-2xl border text-left transition flex items-start space-x-3 ${
                          defaultVisibility === 'followers'
                            ? 'bg-amber-600/15 border-amber-500/60 ring-2 ring-amber-500/30 text-white'
                            : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800/40'
                        }`}
                      >
                        <Users className={`w-4 h-4 mt-0.5 shrink-0 ${defaultVisibility === 'followers' ? 'text-amber-400' : 'text-slate-400'}`} />
                        <div>
                          <span className="font-bold text-xs block">🔒 フォロワー限定</span>
                          <span className="text-[11px] text-slate-400 mt-0.5 block leading-relaxed">
                            あなたのフォロワーだけが閲覧できます（連合先のフォロワーにも届きます）。
                          </span>
                        </div>
                      </button>
                    </div>
                  </div>

                  {/* デフォルトタイムライン */}
                  <div className="space-y-2.5">
                    <label className="block text-xs font-bold text-slate-300">
                      タイムラインの初期表示タブ
                    </label>
                    <div className="grid grid-cols-3 gap-2.5">
                      {[
                        { id: 'local', label: '🏠 ローカル', desc: '自サーバーのみ' },
                        { id: 'home', label: '👥 ホーム', desc: 'フォロー中のみ' },
                        { id: 'all', label: '🌐 連合', desc: 'リレー含む全件' },
                      ].map((tl) => (
                        <button
                          key={tl.id}
                          type="button"
                          onClick={() => setDefaultTimeline(tl.id as any)}
                          className={`p-3 rounded-xl border text-center transition ${
                            defaultTimeline === tl.id
                              ? 'bg-indigo-600/20 border-indigo-500 text-white font-bold'
                              : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-800/40'
                          }`}
                        >
                          <span className="text-xs block">{tl.label}</span>
                          <span className="text-[10px] text-slate-500 block mt-0.5">{tl.desc}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* カスタム絵文字表示 */}
                  <div className="space-y-2.5 pt-2 border-t border-slate-800">
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="block text-xs font-bold text-slate-300">
                          カスタム絵文字の画像置換表示
                        </label>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          Misskey / Mastodon から送られてくるカスタム絵文字（例: :ohayo:）を画像として表示します。
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowCustomEmojis(!showCustomEmojis)}
                        className={`w-12 h-6 rounded-full transition p-1 flex items-center shrink-0 cursor-pointer ${
                          showCustomEmojis ? 'bg-indigo-600 justify-end' : 'bg-slate-800 justify-start'
                        }`}
                      >
                        <div className="w-4 h-4 rounded-full bg-white shadow-md" />
                      </button>
                    </div>
                  </div>

                  {/* ⚡ 画像の自動圧縮 (Misskey互換) */}
                  <div className="space-y-2.5 pt-2 border-t border-slate-800">
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="block text-xs font-bold text-slate-300 flex items-center space-x-1.5">
                          <Zap className="w-3.5 h-3.5 text-amber-400" />
                          <span>画像を自動圧縮してアップロード (推奨)</span>
                        </label>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          投稿前にブラウザ上で長辺最大 2048px にリサイズ＆WebP圧縮し、アップロード時間と通信量を大幅に削減します（アニメGIFは保護されます）。
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const next = !autoCompressImages;
                          setAutoCompressImages(next);
                          localStorage.setItem('spica_auto_compress', String(next));
                        }}
                        className={`w-12 h-6 rounded-full transition p-1 flex items-center shrink-0 cursor-pointer ${
                          autoCompressImages ? 'bg-indigo-600 justify-end' : 'bg-slate-800 justify-start'
                        }`}
                      >
                        <div className="w-4 h-4 rounded-full bg-white shadow-md" />
                      </button>
                    </div>
                  </div>

                  {/* 🔔 Web Push 通知 (PWA / スマホ通知) */}
                  <div className="space-y-3 pt-4 border-t border-slate-800">
                    <div className="flex items-start justify-between">
                      <div>
                        <label className="block text-xs font-bold text-slate-200 flex items-center space-x-1.5">
                          <Bell className="w-4 h-4 text-cyan-400" />
                          <span>Web Push 通知 (PWA / スマホ連携)</span>
                        </label>
                        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                          ブラウザやスマホアプリを閉じている時でも、自分宛ての返信・メンション・リアクション・フォローを端末の通知欄へリアルタイムにお届けします。
                        </p>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0 ml-2 ${
                        isPushSubscribed
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                          : pushPermission === 'denied'
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                          : 'bg-slate-800 text-slate-400 border border-slate-700'
                      }`}>
                        {isPushSubscribed ? '🟢 有効' : pushPermission === 'denied' ? '🔴 ブロック中' : '⚪ 未設定'}
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-2 pt-1">
                      {isPushSubscribed ? (
                        <>
                          <button
                            type="button"
                            onClick={handleSendTestPush}
                            disabled={isSendingTestPush}
                            className="px-3.5 py-2 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 rounded-xl text-xs font-semibold transition flex items-center space-x-1.5 cursor-pointer disabled:opacity-50"
                          >
                            <Bell className="w-3.5 h-3.5" />
                            <span>{isSendingTestPush ? '送信中...' : 'テスト通知を送信'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleUnsubscribePush}
                            disabled={isSubscribingPush}
                            className="px-3.5 py-2 bg-slate-800 hover:bg-slate-750 text-slate-300 border border-slate-700 rounded-xl text-xs font-semibold transition flex items-center space-x-1.5 cursor-pointer"
                          >
                            <span>通知を解除</span>
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={handleSubscribePush}
                          disabled={isSubscribingPush}
                          className="px-4 py-2 bg-gradient-to-r from-cyan-500 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 text-white rounded-xl text-xs font-bold shadow-md shadow-indigo-600/20 transition flex items-center space-x-1.5 cursor-pointer disabled:opacity-50"
                        >
                          <Bell className="w-3.5 h-3.5" />
                          <span>{isSubscribingPush ? '設定中...' : 'この端末でプッシュ通知を有効にする'}</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 🔔 通知の種類別設定 */}
                  <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4 space-y-3">
                    <div>
                      <h4 className="font-bold text-sm text-slate-100 flex items-center space-x-2">
                        <Bell className="w-4 h-4 text-amber-400" />
                        <span>通知の種類</span>
                        {isSavingNotifPrefs && <span className="text-[10px] text-slate-500 font-normal">保存中...</span>}
                      </h4>
                      <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                        受け取る通知の種類を選べます。ここで切った種類は、アプリ内の通知・プッシュ通知のどちらも届かなくなります（切っている間に起きた通知は作成されません）。
                      </p>
                    </div>
                    {notificationPrefs === null ? (
                      <p className="text-[11px] text-slate-500">読み込み中...</p>
                    ) : (
                      <div className="space-y-1.5">
                        {(notificationTypes.length > 0
                          ? notificationTypes
                          : [
                              { type: 'follow', label: 'フォロー' },
                              { type: 'reply', label: '返信' },
                              { type: 'mention', label: 'メンション' },
                              { type: 'reaction', label: 'リアクション' },
                              { type: 'renote', label: 'リノート / ブースト' },
                              { type: 'antenna', label: 'アンテナ' },
                              { type: 'move', label: '引っ越し（Move）' },
                            ]
                        ).map((item: any) => {
                          const enabled = notificationPrefs[item.type] !== false;
                          return (
                            <label
                              key={item.type}
                              className="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-800 cursor-pointer hover:border-slate-700 transition"
                            >
                              <span className="flex items-center space-x-2 text-xs text-slate-200">
                                {enabled ? <Bell className="w-3.5 h-3.5 text-amber-400" /> : <BellOff className="w-3.5 h-3.5 text-slate-500" />}
                                <span className={enabled ? '' : 'text-slate-500'}>{item.label}</span>
                              </span>
                              <span className="flex items-center space-x-2">
                                <span className={`text-[10px] font-bold ${enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
                                  {enabled ? 'ON' : 'OFF'}
                                </span>
                                <input
                                  type="checkbox"
                                  checked={enabled}
                                  onChange={(e) => handleToggleNotificationPref(item.type, e.target.checked)}
                                  className="w-4 h-4 accent-emerald-500 cursor-pointer"
                                />
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    <p className="text-[10px] text-slate-500">
                      ※ 予約投稿の公開通知は自分の操作の控えのため、常に届きます。
                    </p>
                  </div>

                  {/* ✉️ メール通知（SMTP 設定時のみ） */}
                  {emailNotification?.available && (
                    <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4 space-y-2">
                      <label className="flex items-center justify-between cursor-pointer">
                        <span className="flex items-center space-x-2">
                          <Mail className="w-4 h-4 text-sky-400" />
                          <span className="text-sm font-bold text-slate-100">メールでも通知を受け取る</span>
                        </span>
                        <span className="flex items-center space-x-2">
                          <span className={`text-[10px] font-bold ${emailNotification.enabled ? 'text-emerald-400' : 'text-slate-500'}`}>
                            {emailNotification.enabled ? 'ON' : 'OFF'}
                          </span>
                          <input
                            type="checkbox"
                            checked={emailNotification.enabled}
                            onChange={(e) => handleToggleEmailNotification(e.target.checked)}
                            className="w-4 h-4 accent-sky-500 cursor-pointer"
                          />
                        </span>
                      </label>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        {emailNotification.verified
                          ? `${emailNotification.email} 宛に、上の種類のうち ON の通知をまとめて送ります。`
                          : 'メールアドレスの確認が済むと有効にできます（設定 → アカウント → メールアドレス）。'}
                        <br />
                        短時間に複数届いた通知は 1 通にまとめ、同じ人へ連続で送らないよう間隔を空けます。切った種類の通知はメールも届きません。
                      </p>
                    </div>
                  )}

                  {/* 🧭 表示と動作（サーバー保存・端末をまたいで同じ） */}
                  <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4 space-y-4">
                    <div>
                      <h4 className="font-bold text-sm text-slate-100 flex items-center space-x-2">
                        <Palette className="w-4 h-4 text-indigo-400" />
                        <span>表示と動作</span>
                        <span className="px-1.5 py-0.5 rounded-md bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-[10px] font-bold">どの端末でも同じ</span>
                      </h4>
                      <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                        ここで変えたものはアカウントに保存され、別の端末でログインしても同じ見た目になります。
                      </p>
                    </div>

                    <PrefChoice
                      label="文字サイズ"
                      hint="画面全体の大きさが変わります（余白も少し変わります）"
                      value={prefs.fontSize}
                      options={[
                        { value: 'small', label: '小' },
                        { value: 'normal', label: '標準' },
                        { value: 'large', label: '大' },
                      ]}
                      onChange={(value) => updatePrefs({ fontSize: value })}
                    />

                    <PrefChoice
                      label="行間・余白"
                      value={prefs.density}
                      options={[
                        { value: 'comfortable', label: 'ゆったり' },
                        { value: 'compact', label: 'コンパクト' },
                      ]}
                      onChange={(value) => updatePrefs({ density: value })}
                    />

                    <PrefChoice
                      label="時刻の表し方"
                      value={prefs.timeFormat}
                      options={[
                        { value: 'absolute', label: '日時' },
                        { value: 'relative', label: '相対（3分前）' },
                      ]}
                      onChange={(value) => updatePrefs({ timeFormat: value })}
                    />

                    <PrefChoice
                      label="新しい投稿が届いたとき"
                      value={prefs.newPostsBehavior}
                      options={[
                        { value: 'badge', label: '件数バッジ' },
                        { value: 'auto', label: 'そのまま反映' },
                        { value: 'manual', label: '手動で読み込む' },
                      ]}
                      onChange={(value) => updatePrefs({ newPostsBehavior: value })}
                    />

                    <div className="border-t border-slate-800 pt-3 space-y-3">
                      <PrefToggle
                        label="ホームでブーストを隠す"
                        hint="ホームタイムラインに他人のブーストを出しません（次に読み込んだときから）"
                        checked={prefs.hideBoostsInHome}
                        onChange={(checked) => updatePrefs({ hideBoostsInHome: checked })}
                      />
                      <PrefToggle
                        label="ホームで返信を隠す"
                        hint="自分が書いた返信は残します（次に読み込んだときから）"
                        checked={prefs.hideRepliesInHome}
                        onChange={(checked) => updatePrefs({ hideRepliesInHome: checked })}
                      />
                    </div>

                    <div className="border-t border-slate-800 pt-3 space-y-3">
                      <PrefToggle
                        label="動画を自動再生する"
                        hint="タイムラインの動画が、表示された時点で再生されます"
                        checked={prefs.autoPlayMedia}
                        onChange={(checked) => updatePrefs({ autoPlayMedia: checked })}
                      />
                      <PrefToggle
                        label="自動再生はミュートで始める"
                        checked={prefs.muteMediaByDefault}
                        onChange={(checked) => updatePrefs({ muteMediaByDefault: checked })}
                      />
                      <PrefToggle
                        label="センシティブを常に隠す"
                        hint="オフにすると、センシティブでもクリックなしで表示します（初期値は隠す）"
                        checked={prefs.alwaysHideSensitive}
                        onChange={(checked) => updatePrefs({ alwaysHideSensitive: checked })}
                      />
                    </div>

                    <div className="border-t border-slate-800 pt-3">
                      <PrefChoice
                        label="通知のまとめ方"
                        hint="「1件ずつ」にすると、同じ投稿への複数リアクションなどもまとめずに並べます"
                        value={prefs.notificationGrouping}
                        options={[
                          { value: 'group', label: 'まとめる' },
                          { value: 'individual', label: '1件ずつ' },
                        ]}
                        onChange={(value) => updatePrefs({ notificationGrouping: value })}
                      />
                    </div>

                    <div className="border-t border-slate-800 pt-3 space-y-3">
                      <PrefToggle
                        label="キーボードショートカット"
                        hint="j / k で投稿を移動、n で投稿欄、/ で検索、? で一覧（入力中は効きません）"
                        checked={prefs.keyboardShortcuts}
                        onChange={(checked) => updatePrefs({ keyboardShortcuts: checked })}
                      />
                      <div className="flex items-center justify-between gap-3">
                        <span>
                          <span className="text-xs font-bold text-slate-200 block">アプリとしてインストール</span>
                          <span className="text-[11px] text-slate-500 block mt-0.5">
                            {isStandalone()
                              ? 'すでにアプリとして開いています。'
                              : installAvailable
                                ? 'ホーム画面に追加すると、通知やバッジが使えます。'
                                : 'お使いのブラウザのメニューから「アプリをインストール」を選べます。'}
                          </span>
                          {installMessage && <span className="text-[11px] text-emerald-400 block mt-0.5">{installMessage}</span>}
                        </span>
                        {installAvailable && !isStandalone() && (
                          <button
                            type="button"
                            onClick={async () => {
                              const accepted = await promptInstall();
                              setInstallMessage(accepted ? 'インストールしました。' : 'キャンセルしました。');
                            }}
                            className="shrink-0 px-3.5 py-2 rounded-xl text-[11px] font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition cursor-pointer"
                          >
                            インストール
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="border-t border-slate-800 pt-3 space-y-3">
                      <div>
                        <span className="text-xs font-bold text-slate-200 block">自分の記録</span>
                        <span className="text-[11px] text-slate-500 block mt-0.5">自分が付けたリアクションと、投稿の件数を振り返ります。</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => setShowReactionHistory(true)}
                          className="px-3.5 py-2 rounded-xl text-[11px] font-bold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition cursor-pointer"
                        >
                          リアクション履歴
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowPostCalendar(true)}
                          className="px-3.5 py-2 rounded-xl text-[11px] font-bold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition cursor-pointer"
                        >
                          投稿カレンダー
                        </button>
                      </div>
                    </div>

                    <div className="border-t border-slate-800 pt-3 space-y-3">
                      <h5 className="text-xs font-bold text-slate-200">投稿の既定</h5>
                      <PrefToggle
                        label="センシティブを既定で ON"
                        checked={prefs.defaultSensitive}
                        onChange={(checked) => updatePrefs({ defaultSensitive: checked })}
                      />
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                        <div>
                          <span className="text-xs font-bold text-slate-200 block">CW（内容の注意書き）の既定文言</span>
                          <span className="text-[11px] text-slate-500 block mt-0.5">入れておくと、投稿欄の CW が最初から開いてこの文言が入ります</span>
                        </div>
                        <input
                          type="text"
                          defaultValue={prefs.defaultCwText}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                          onBlur={(e) => updatePrefs({ defaultCwText: e.target.value })}
                          placeholder="例: ネタバレ注意"
                          className="w-full sm:w-56 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                        />
                      </div>
                      <PrefChoice
                        label="投稿したあと"
                        value={prefs.afterPost}
                        options={[
                          { value: 'timeline', label: 'タイムラインへ戻る' },
                          { value: 'stay', label: 'そのまま留まる' },
                        ]}
                        onChange={(value) => updatePrefs({ afterPost: value })}
                      />
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                        <div>
                          <span className="text-xs font-bold text-slate-200 block">既定のリアクション</span>
                          <span className="text-[11px] text-slate-500 block mt-0.5">リアクションの候補の先頭に出ます</span>
                        </div>
                        <input
                          type="text"
                          defaultValue={prefs.defaultReaction}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                          onBlur={(e) => { const value = e.target.value.trim(); if (value) updatePrefs({ defaultReaction: value }); }}
                          placeholder="👍"
                          className="w-full sm:w-24 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 text-center focus:outline-none focus:border-indigo-500"
                        />
                      </div>
                    </div>

                    <div className="border-t border-slate-800 pt-3">
                      <MutedDomainsEditor />
                    </div>
                  </div>

                  {/* 保存ボタン */}
                  <div className="pt-3 flex justify-end">
                    <button
                      type="submit"
                      className="px-5 py-2.5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition flex items-center space-x-1.5"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>環境設定を保存</span>
                    </button>
                  </div>
                </form>
              ) : settingsTab === 'account' ? (
                /* 🌐 アカウント・連合情報 */
                <div className="space-y-6">
                  <div className="border-b border-slate-800 pb-3">
                    <h3 className="text-base font-bold text-slate-100 flex items-center space-x-2">
                      <Globe className="w-4 h-4 text-cyan-400" />
                      <span>アカウント・Fediverse 連合情報</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      他の Fediverse サーバー（Misskey / Mastodon）からあなたを発見・フォローするためのアドレス情報です。
                    </p>
                  </div>

                  {/* 📧 メールアドレス（復元手段 / password 方式ではログインID） */}
                  {recoveryStatus.mailConfigured && (recoveryStatus.allowEmailRegistration || Boolean(myEmail)) && (
                    <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4 space-y-3">
                      <div>
                        <h4 className="font-bold text-sm text-slate-100 flex items-center space-x-2">
                          <Mail className="w-4 h-4 text-sky-400" />
                          <span>メールアドレス{isPasswordAuthMode ? '' : '（復元用・任意）'}</span>
                          {myEmail && (
                            myEmailVerified ? (
                              <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[10px] font-bold">確認済み</span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-bold">未確認</span>
                            )
                          )}
                        </h4>
                        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                          {isPasswordAuthMode
                            ? <>ログインと、<strong>マスターキーを忘れたときの復元</strong>に使います。下の「確認コードを送信」→「確認する」で確認済みにできます（現在: {myEmail ? `登録済み ${myEmail}` : '未登録'}）。</>
                            : <>登録しておくと、<strong>マスターキーを忘れたときにメール経由で復元</strong>できます。ログインには使われません（現在: {myEmail ? `登録済み ${myEmail}` : '未登録'}）。</>}
                        </p>
                      </div>

                      {emailMsg && (
                        <div className={`p-2.5 rounded-xl text-xs flex items-center space-x-2 ${
                          emailMsg.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}>
                          {emailMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                          <span>{emailMsg.text}</span>
                        </div>
                      )}

                      <form onSubmit={handleSendEmailCode} className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="email"
                          value={emailInput}
                          onChange={(e) => setEmailInput(e.target.value)}
                          placeholder="you@example.com"
                          className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                        <button
                          type="submit"
                          disabled={isSendingEmail || !emailInput.trim()}
                          className="px-4 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition whitespace-nowrap cursor-pointer"
                        >
                          {isSendingEmail ? '送信中...' : '確認コードを送信'}
                        </button>
                      </form>

                      <form onSubmit={handleVerifyEmail} className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          value={emailCode}
                          onChange={(e) => setEmailCode(e.target.value)}
                          maxLength={6}
                          placeholder="6桁の確認コード"
                          className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                        <button
                          type="submit"
                          disabled={isSendingEmail || !emailCode.trim()}
                          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 text-xs font-bold rounded-xl transition whitespace-nowrap cursor-pointer"
                        >
                          確認する
                        </button>
                      </form>

                      {myEmail && (
                        <button
                          type="button"
                          onClick={handleDeleteEmail}
                          className="px-3 py-1.5 bg-slate-800 hover:bg-rose-600/80 text-slate-300 hover:text-white rounded-lg text-[11px] font-semibold transition cursor-pointer"
                        >
                          メールアドレスを削除
                        </button>
                      )}
                    </div>
                  )}

                  {/* 🔑 パスワードの設定・変更（password 方式のみ） */}
                  {isPasswordAuthMode && (
                    <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4 space-y-3">
                      <div>
                        <h4 className="font-bold text-sm text-slate-100 flex items-center space-x-2">
                          <KeyRound className="w-4 h-4 text-amber-400" />
                          <span>{authUser?.hasPassword ? 'パスワードの変更' : 'パスワードの設定'}</span>
                        </h4>
                        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                          {authUser?.hasPassword
                            ? '現在のパスワード（またはマスターキー）を入力して、新しいパスワードに変更します。'
                            : 'このアカウントにはまだパスワードが設定されていません。パスワードを設定すると、メールアドレスでログインできるようになります（マスターキーが必要です）。'}
                        </p>
                      </div>

                      {passwordMsg && (
                        <div className={`p-2.5 rounded-xl text-xs flex items-center space-x-2 ${
                          passwordMsg.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}>
                          {passwordMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                          <span>{passwordMsg.text}</span>
                        </div>
                      )}

                      <form onSubmit={handleChangePassword} className="space-y-3">
                        {authUser?.hasPassword ? (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[11px] font-semibold text-slate-300 mb-1">現在のパスワード</label>
                              <input
                                type="password"
                                autoComplete="current-password"
                                value={pwCurrent}
                                onChange={(e) => setPwCurrent(e.target.value)}
                                placeholder="現在のパスワード"
                                className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-semibold text-slate-300 mb-1">マスターキー（上記の代わり）</label>
                              <input
                                type="password"
                                autoComplete="off"
                                value={pwMasterKey}
                                onChange={(e) => setPwMasterKey(e.target.value)}
                                placeholder="SPICA-XXXX-XXXX-XXXX"
                                className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                              />
                            </div>
                          </div>
                        ) : (
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                              マスターキー <span className="text-rose-400 font-bold">*必須</span>
                            </label>
                            <input
                              type="password"
                              autoComplete="off"
                              value={pwMasterKey}
                              onChange={(e) => setPwMasterKey(e.target.value)}
                              placeholder="SPICA-XXXX-XXXX-XXXX"
                              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                            />
                            <p className="text-[10px] text-slate-500 mt-1">
                              初回登録時に発行されたマスターキー（SPICA-…）を入力してください。分からない場合は、メールアドレスでマスターキーを復元できます。
                            </p>
                          </div>
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                              新しいパスワード <span className="text-slate-500 font-normal">(8文字以上)</span>
                            </label>
                            <input
                              type="password"
                              autoComplete="new-password"
                              value={pwNew}
                              onChange={(e) => setPwNew(e.target.value)}
                              placeholder="8文字以上"
                              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-300 mb-1">新しいパスワード (確認)</label>
                            <input
                              type="password"
                              autoComplete="new-password"
                              value={pwNewConfirm}
                              onChange={(e) => setPwNewConfirm(e.target.value)}
                              placeholder="同じパスワードをもう一度入力"
                              className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-amber-500 focus:outline-none"
                            />
                          </div>
                        </div>

                        <div className="flex justify-end">
                          <button
                            type="submit"
                            disabled={isSavingPassword || !pwNew || !pwNewConfirm}
                            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition flex items-center space-x-1.5 cursor-pointer"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>{isSavingPassword ? '保存中...' : authUser?.hasPassword ? 'パスワードを変更' : 'パスワードを設定'}</span>
                          </button>
                        </div>
                      </form>
                    </div>
                  )}

                  {/* 📥 アカウント移行インポート */}
                  <div className="space-y-3 bg-slate-950/60 border border-slate-800 rounded-2xl p-4">
                    <div>
                      <h4 className="font-bold text-sm text-slate-100 flex items-center space-x-2">
                        <Upload className="w-4 h-4 text-emerald-400" />
                        <span>他のサーバーからの移行（インポート）</span>
                      </h4>
                      <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                        Mastodon の <code className="text-slate-300">outbox.json</code>、または Misskey の{' '}
                        <code className="text-slate-300">notes.json</code> を取り込むと、過去の投稿（本文・CW・公開範囲・投稿日時）を復元できます。
                        元の投稿日時が保持されるため、時系列が崩れません。同じファイルを再度取り込んでも重複しません。
                        <br />※ メディア（画像・動画）とフォロー/ブックマークの取り込みは現在未対応です。
                      </p>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="file"
                        accept=".json,application/json"
                        onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                        className="flex-1 text-xs text-slate-300 file:mr-3 file:py-2 file:px-3 file:rounded-xl file:border-0 file:bg-slate-800 file:text-slate-200 file:text-xs file:font-bold hover:file:bg-slate-700 cursor-pointer"
                      />
                      <button
                        type="button"
                        disabled={!importFile || isImporting}
                        onClick={handleImportArchive}
                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition whitespace-nowrap flex items-center justify-center space-x-1.5 cursor-pointer"
                      >
                        {isImporting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                        <span>{isImporting ? '取り込み中...' : '取り込む'}</span>
                      </button>
                    </div>
                    {importResult && (
                      <div
                        className={`p-3 rounded-xl text-xs flex items-start space-x-2 ${
                          importResult.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}
                      >
                        {importResult.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
                        <div className="space-y-0.5">
                          <span className="block whitespace-pre-wrap">{importResult.text}</span>
                          {importResult.detail && (
                            <span className="block text-[10px] opacity-80 whitespace-pre-wrap">{importResult.detail}</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-3">
                    {/* 連合ハンドル */}
                    <div className="bg-slate-950/70 p-4 rounded-2xl border border-slate-800 space-y-1.5">
                      <span className="text-[11px] text-slate-400 font-semibold block">あなたの ActivityPub ハンドル</span>
                      <div className="flex items-center justify-between bg-slate-900 px-3 py-2 rounded-xl border border-slate-800">
                        <span className="font-mono text-xs text-indigo-300 font-bold select-all truncate mr-2">
                          {authUser?.handle}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            if (authUser?.handle) {
                              navigator.clipboard.writeText(authUser.handle);
                              setSettingsMessage({ type: 'success', text: 'ハンドルをクリップボードにコピーしました！' });
                              setTimeout(() => setSettingsMessage(null), 3000);
                            }
                          }}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-bold transition flex items-center space-x-1 shrink-0"
                          title="コピー"
                        >
                          <Copy className="w-3 h-3" />
                          <span>コピー</span>
                        </button>
                      </div>
                      <p className="text-[11px] text-slate-500">
                        Misskey や Mastodon の検索バーにこのハンドルを入力すると、外部からあなたのアカウントを発見できます。
                      </p>
                    </div>

                    {/* 公開アクターURL */}
                    <div className="bg-slate-950/70 p-4 rounded-2xl border border-slate-800 space-y-1.5">
                      <span className="text-[11px] text-slate-400 font-semibold block">公開 Actor URL</span>
                      <div className="flex items-center justify-between bg-slate-900 px-3 py-2 rounded-xl border border-slate-800">
                        <a
                          href={authUser?.actorUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs text-slate-300 hover:text-indigo-400 underline select-all truncate mr-2 flex items-center space-x-1"
                        >
                          <span>{authUser?.actorUrl}</span>
                          <ExternalLink className="w-3 h-3 shrink-0" />
                        </a>
                        <button
                          type="button"
                          onClick={() => {
                            if (authUser?.actorUrl) {
                              navigator.clipboard.writeText(authUser.actorUrl);
                              setSettingsMessage({ type: 'success', text: 'Actor URL をコピーしました！' });
                              setTimeout(() => setSettingsMessage(null), 3000);
                            }
                          }}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-bold transition flex items-center space-x-1 shrink-0"
                        >
                          <Copy className="w-3 h-3" />
                          <span>コピー</span>
                        </button>
                      </div>
                    </div>

                    {/* 基本ステータス */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2">
                      <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800">
                        <span className="text-[11px] text-slate-500 block">ユーザーID</span>
                        <span className="font-mono font-bold text-xs text-slate-200">@{authUser?.id}</span>
                      </div>
                      <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800">
                        <span className="text-[11px] text-slate-500 block">ロール</span>
                        <span className={`text-xs font-bold ${authUser?.role === 'admin' ? 'text-purple-300' : 'text-slate-200'}`}>
                          {authUser?.role === 'admin' ? '👑 管理者 (ADMIN)' : '一般ユーザー (USER)'}
                        </span>
                      </div>
                      <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800 col-span-2 sm:col-span-1">
                        <span className="text-[11px] text-slate-500 block">参加サーバー</span>
                        <span className="font-mono text-xs text-slate-200">{serverStats?.domain || window.location.host}</span>
                      </div>
                    </div>

                    {/* マスターキー管理についての安全ガイダンス */}
                    <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 p-4 rounded-2xl text-xs space-y-2 mt-4">
                      <div className="flex items-center space-x-2 font-bold text-amber-400">
                        <Key className="w-4 h-4" />
                        <span>{isPasswordAuthMode ? 'ログインとマスターキーに関する重要事項' : 'マスターキー認証に関する重要事項'}</span>
                      </div>
                      <p className="leading-relaxed text-amber-300/90 text-[11px]">
                        {isPasswordAuthMode ? (
                          <>
                            このサーバーはメールアドレス＋パスワード方式です。通常はメールアドレスとパスワードでログインできます。
                            アカウント登録時に発行された <strong>マスターキー (spica_sk_... または astrabit_sk_...)</strong> は、パスワードを忘れたときの最終手段として使えます。
                            紛失すると復旧できなくなる場合がありますので、必ずパスワード管理ツールや安全な保管場所にバックアップしてください。
                          </>
                        ) : (
                          <>
                            Spica では個人情報を収集しないため、メールアドレスやパスワードによるリセット機能はありません。
                            アカウント登録時に発行された <strong>マスターキー (spica_sk_... または astrabit_sk_...)</strong> があなたのアカウントの唯一の鍵です。
                            万が一紛失した場合は再ログインができなくなりますので、必ずパスワード管理ツールや安全な保管場所にバックアップしてください。
                          </>
                        )}
                      </p>
                    </div>

                    {/* 🔐 WebAuthn / パスキー生体認証管理 */}
                    <div className="bg-slate-950/70 border border-slate-800 p-4 sm:p-5 rounded-2xl space-y-4 mt-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2 font-bold text-slate-100">
                          <Fingerprint className="w-5 h-5 text-indigo-400 shrink-0" />
                          <span className="text-sm">パスキー / 生体認証 (WebAuthn)</span>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold">
                          FIDO2 / W3C標準
                        </span>
                      </div>

                      <p className="leading-relaxed text-slate-300 text-xs">
                        Windows Hello、Touch ID、Face ID、物理セキュリティキーを連携すると、長いマスターキーを入力することなく、指紋や顔認証だけでワンタップサインインが可能になります。
                      </p>

                      {/* アクションメッセージ */}
                      {passkeyActionMessage && (
                        <div
                          className={`p-3 rounded-xl text-xs flex items-center space-x-2 animate-in fade-in ${
                            passkeyActionMessage.type === 'success'
                              ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-300'
                              : 'bg-rose-500/20 border border-rose-500/30 text-rose-300'
                          }`}
                        >
                          {passkeyActionMessage.type === 'success' ? (
                            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                          ) : (
                            <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
                          )}
                          <span>{passkeyActionMessage.text}</span>
                        </div>
                      )}

                      {/* パスキー新規登録フォーム */}
                      <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
                        <input
                          type="text"
                          placeholder="デバイス名 (例: 自宅PC, 会社のMacBook, スマホ)"
                          value={passkeyDeviceName}
                          onChange={(e) => setPasskeyDeviceName(e.target.value)}
                          className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3.5 py-2 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                        <button
                          type="button"
                          onClick={handleRegisterPasskey}
                          disabled={isRegisteringPasskey}
                          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition flex items-center justify-center space-x-1.5 shadow-md cursor-pointer shrink-0"
                        >
                          {isRegisteringPasskey ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Fingerprint className="w-3.5 h-3.5" />
                          )}
                          <span>{isRegisteringPasskey ? '端末認証中...' : 'パスキーを登録'}</span>
                        </button>
                      </div>

                      {/* 登録済みパスキー一覧 */}
                      <div className="space-y-2 pt-2 border-t border-slate-800/80">
                        <span className="text-[11px] font-bold text-slate-400 block">
                          登録済みパスキー ({passkeys.length}件)
                        </span>

                        {isLoadingPasskeys ? (
                          <div className="py-4 text-center text-xs text-slate-400">
                            <RefreshCw className="w-4 h-4 animate-spin mx-auto text-indigo-400 mb-1" />
                            読み込み中...
                          </div>
                        ) : passkeys.length === 0 ? (
                          <div className="py-4 text-center text-xs text-slate-500 bg-slate-900/50 rounded-xl border border-dashed border-slate-800">
                            登録されたパスキーはありません
                          </div>
                        ) : (
                          passkeys.map((p: any) => (
                            <div
                              key={p.id}
                              className="flex items-center justify-between p-3 rounded-xl bg-slate-900 border border-slate-800 text-xs"
                            >
                              <div className="flex items-center space-x-2.5 min-w-0">
                                <Fingerprint className="w-4 h-4 text-emerald-400 shrink-0" />
                                <div className="min-w-0">
                                  <div className="font-bold text-slate-200 truncate">
                                    {p.device_name || '生体認証デバイス'}
                                  </div>
                                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                                    登録日: {new Date(p.created_at).toLocaleDateString('ja-JP')}
                                    {p.last_used_at && (
                                      <span> ・ 最終利用: {new Date(p.last_used_at).toLocaleDateString('ja-JP')}</span>
                                    )}
                                  </div>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleDeletePasskey(p.id)}
                                className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition cursor-pointer"
                                title="このパスキーを削除"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    {/* 📦 データエクスポート (バックアップ・データ主権) */}
                    <div className="bg-slate-950/70 border border-slate-800 p-4 sm:p-5 rounded-2xl space-y-3 mt-4">
                      <div className="flex items-center space-x-2 font-bold text-slate-200">
                        <FolderArchive className="w-4 h-4 text-indigo-400 shrink-0" />
                        <span>データのエクスポート（バックアップ）</span>
                      </div>
                      <p className="leading-relaxed text-slate-300 text-xs">
                        分散型ソーシャルネットワーク（Fediverse）の「自分のデータは自分のもの（データ主権）」という理念に基づき、
                        あなたの過去の全投稿、フォロー・フォロワー一覧、ブックマーク、リアクション履歴をいつでも一括ダウンロードできます。
                      </p>
                      <div className="flex flex-wrap gap-2.5 pt-1">
                        <button
                          type="button"
                          disabled={isExportingData}
                          onClick={() => handleExportData('json')}
                          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition flex items-center space-x-2 shadow-md cursor-pointer"
                        >
                          {isExportingData && exportingFormat === 'json' ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <FileText className="w-3.5 h-3.5" />
                          )}
                          <span>{isExportingData && exportingFormat === 'json' ? '出力中...' : '📄 JSON形式でダウンロード'}</span>
                        </button>
                        <button
                          type="button"
                          disabled={isExportingData}
                          onClick={() => handleExportData('zip')}
                          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 rounded-xl text-xs font-bold transition flex items-center space-x-2 shadow-md cursor-pointer"
                        >
                          {isExportingData && exportingFormat === 'zip' ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Download className="w-3.5 h-3.5 text-cyan-400" />
                          )}
                          <span>{isExportingData && exportingFormat === 'zip' ? 'ZIP生成中...' : '🗜️ ZIP形式でダウンロード'}</span>
                        </button>
                      </div>
                      <p className="text-[11px] text-slate-500">
                        ※ ZIPアーカイブには各カテゴリ別のJSONファイルと解説用READMEが格納されます。
                      </p>
                    </div>

                    {/* 📦 アカウントの引っ越し（Move / alsoKnownAs） */}
                    <div className="bg-slate-950/70 border border-slate-800 p-4 sm:p-5 rounded-2xl space-y-4 mt-4">
                      <div className="flex items-center space-x-2 font-bold text-slate-100">
                        <Send className="w-5 h-5 text-indigo-400 shrink-0" />
                        <span className="text-sm">アカウントの引っ越し（Move）</span>
                      </div>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        別のサーバーへ引っ越すときは、引っ越し先アカウントで旧アカウント（このアカウント）を
                        <span className="font-mono text-slate-300"> alsoKnownAs </span>
                        として設定してから、ここで引っ越しを実行します。フォロワーには
                        <span className="font-mono text-slate-300"> Move </span>
                        が配送され、引っ越し先のフォローに引き継がれます。
                      </p>

                      {migrationInfo.movedTo && (
                        <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 p-3 rounded-xl text-xs space-y-1.5">
                          <div className="flex items-center space-x-2 font-bold">
                            <AlertCircle className="w-4 h-4 shrink-0" />
                            <span>このアカウントは引っ越し済みです</span>
                          </div>
                          <p className="font-mono text-[11px] break-all text-amber-200/90">{migrationInfo.movedTo}</p>
                          <button
                            type="button"
                            onClick={handleCancelMove}
                            disabled={isMigrating}
                            className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-50 text-amber-200 border border-amber-500/40 rounded-xl text-[11px] font-bold transition cursor-pointer"
                          >
                            引っ越し先の記録を解除
                          </button>
                        </div>
                      )}

                      {/* 引っ越し元（他のサーバーからここへ引っ越してきた場合） */}
                      <div className="space-y-2">
                        <label className="block text-xs font-bold text-slate-300">
                          引っ越し元アカウント（他のサーバーからここへ引っ越した場合）
                        </label>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="text"
                            value={migrationAliasInput}
                            onChange={(e) => setMigrationAliasInput(e.target.value)}
                            placeholder="@old@example.com または https://example.com/users/old"
                            className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={handleSaveMigrationAlias}
                            disabled={isMigrating}
                            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-bold rounded-xl border border-slate-700 transition cursor-pointer shrink-0"
                          >
                            保存
                          </button>
                        </div>
                        <p className="text-[11px] text-slate-500">
                          設定すると Actor 文書の <span className="font-mono">alsoKnownAs</span> として公開され、他のサーバーがあなたの引っ越しを検証できるようになります（空欄で保存すると解除）。
                        </p>
                      </div>

                      {/* 引っ越し先（このサーバーから出ていく場合） */}
                      <div className="space-y-2 pt-3 border-t border-slate-800">
                        <label className="block text-xs font-bold text-slate-300">
                          引っ越し先アカウント（このサーバーから引っ越す場合）
                        </label>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="text"
                            value={migrationTargetInput}
                            onChange={(e) => setMigrationTargetInput(e.target.value)}
                            placeholder="@new@example.com"
                            className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={handleExecuteMove}
                            disabled={isMigrating}
                            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition flex items-center justify-center space-x-1.5 cursor-pointer shrink-0"
                          >
                            {isMigrating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                            <span>引っ越しを実行</span>
                          </button>
                        </div>
                        <p className="text-[11px] text-slate-500">
                          フォロワー（{migrationInfo.followers} 件）へ Move を配送します。先に引っ越し先アカウント側で、このアカウントを
                          <span className="font-mono"> alsoKnownAs </span>に設定しておく必要があります。
                        </p>
                      </div>

                      {migrationMsg && (
                        <div className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                          migrationMsg.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}>
                          {migrationMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                          <span>{migrationMsg.text}</span>
                        </div>
                      )}
                    </div>

                    {/* ⚠️ 危険なエリア: アカウントの削除（退会） */}
                    <div className="bg-rose-950/20 border border-rose-500/30 p-4 sm:p-5 rounded-2xl space-y-3 mt-4">
                      <div className="flex items-center space-x-2 font-bold text-rose-400">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <span>危険な操作: アカウントの削除（退会）</span>
                      </div>
                      <p className="leading-relaxed text-rose-200/90 text-xs">
                        アカウントを削除すると、あなたのプロフィール、過去の全投稿、画像ファイル、リアクション、フォロー・フォロワー関係、通知などのすべてのデータがサーバーおよび連合先（Fediverse）から完全に消去されます。
                        <br />
                        <span className="text-rose-400 font-semibold">※この操作は取り消すことができず、データを復元することはできません。</span>
                      </p>
                      <div className="pt-1">
                        <button
                          type="button"
                          onClick={() => {
                            setSelfDeleteConfirmId('');
                            setSelfDeleteMasterKey('');
                            setSelfDeleteError(null);
                            setShowSelfDeleteModal(true);
                          }}
                          className="px-4 py-2 bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/40 rounded-xl text-xs font-bold transition flex items-center space-x-1.5 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                          <span>アカウントを完全に削除する...</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : settingsTab === 'mutes_blocks' ? (
                /* 🚫 ミュートとブロック管理 */
                <div className="space-y-6">
                  <div className="border-b border-slate-800 pb-3 flex items-center justify-between">
                    <div>
                      <h3 className="text-base font-bold text-slate-100 flex items-center space-x-2">
                        <Ban className="w-4 h-4 text-rose-400" />
                        <span>ミュートとブロックの管理</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-1">
                        あなたがミュートまたはブロックしているユーザーの一覧です。いつでも解除できます。
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={fetchBlocksAndMutes}
                      disabled={isLoadingBlocksMutes}
                      className="p-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-300 transition cursor-pointer"
                      title="一覧を更新"
                    >
                      <RefreshCw className={`w-4 h-4 ${isLoadingBlocksMutes ? 'animate-spin text-indigo-400' : ''}`} />
                    </button>
                  </div>

                  {isLoadingBlocksMutes ? (
                    <div className="text-center py-12">
                      <RefreshCw className="w-6 h-6 animate-spin mx-auto text-indigo-400 mb-2" />
                      <p className="text-xs text-slate-400">リストを読み込み中...</p>
                    </div>
                  ) : (
                    <div className="space-y-8">
                      {/* 🔒 フォローリクエスト（鍵アカウント） */}
                      {followRequests.length > 0 && (
                        <div className="space-y-3">
                          <div className="flex items-center space-x-2">
                            <User className="w-4 h-4 text-emerald-400" />
                            <h4 className="font-bold text-sm text-slate-100">
                              フォローリクエスト ({followRequests.length})
                            </h4>
                          </div>
                          <p className="text-[11px] text-slate-400 leading-relaxed">
                            鍵アカウントのため承認待ちになっているフォローです。承認すると相手にフォロワーとして通知（Accept）が送られます。
                          </p>
                          <div className="space-y-2">
                            {followRequests.map((req: any) => (
                              <div
                                key={req.id}
                                className="flex items-center justify-between space-x-3 bg-slate-950/60 border border-slate-800 rounded-2xl px-3.5 py-3"
                              >
                                <div className="flex items-center space-x-3 min-w-0">
                                  {req.icon_url ? (
                                    <img src={req.icon_url} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
                                  ) : (
                                    <div className="w-9 h-9 rounded-full bg-slate-800 shrink-0" />
                                  )}
                                  <div className="min-w-0">
                                    <span className="font-bold text-xs text-slate-100 block truncate">{req.name}</span>
                                    <span className="text-[11px] text-slate-400 block truncate">{req.handle}</span>
                                  </div>
                                </div>
                                <div className="flex items-center space-x-2 shrink-0">
                                  <button
                                    type="button"
                                    disabled={isRespondingRequest === req.actor_url}
                                    onClick={() => handleRespondFollowRequest(req.actor_url, 'reject')}
                                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg text-xs font-semibold transition cursor-pointer disabled:opacity-50"
                                  >
                                    拒否
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isRespondingRequest === req.actor_url}
                                    onClick={() => handleRespondFollowRequest(req.actor_url, 'accept')}
                                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold shadow-md transition cursor-pointer disabled:opacity-50"
                                  >
                                    承認
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 🔇 ミュートワード（ワードフィルター） */}
                      <div className="space-y-3">
                        <div className="flex items-center space-x-2">
                          <ShieldAlert className="w-4 h-4 text-amber-400" />
                          <h4 className="font-bold text-sm text-slate-100">
                            ミュートワード ({mutedWords.length})
                          </h4>
                        </div>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          登録したキーワードを含む投稿（本文・CW）は、タイムラインやアンテナなどから自動的に除外されます。
                        </p>

                        <form onSubmit={handleAddMutedWord} className="space-y-2 bg-slate-950/60 border border-slate-800 rounded-2xl p-3.5">
                          <div className="flex flex-col sm:flex-row gap-2">
                            <input
                              type="text"
                              value={newMutedWord}
                              onChange={(e) => setNewMutedWord(e.target.value)}
                              maxLength={100}
                              placeholder="除外したいキーワード（例: ネタバレ）"
                              className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
                            />
                            <button
                              type="submit"
                              disabled={isSavingMutedWord || !newMutedWord.trim()}
                              className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition whitespace-nowrap flex items-center space-x-1 justify-center"
                            >
                              {isSavingMutedWord ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                              <span>追加</span>
                            </button>
                          </div>
                          <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-300">
                            <label className="flex items-center space-x-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={mutedWordCaseSensitive}
                                onChange={(e) => setMutedWordCaseSensitive(e.target.checked)}
                                className="w-3.5 h-3.5 accent-amber-500 cursor-pointer"
                              />
                              <span>大文字小文字を区別</span>
                            </label>
                            <label className="flex items-center space-x-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={mutedWordWholeWord}
                                onChange={(e) => setMutedWordWholeWord(e.target.checked)}
                                className="w-3.5 h-3.5 accent-amber-500 cursor-pointer"
                              />
                              <span>単語単位（英数字のみ）</span>
                            </label>
                          </div>
                        </form>

                        {mutedWords.length === 0 ? (
                          <div className="text-center py-5 bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                            登録されているキーワードはありません。
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {mutedWords.map((w: any) => (
                              <span
                                key={w.id}
                                className="inline-flex items-center space-x-2 bg-slate-900 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200"
                              >
                                <span className="font-mono">{w.keyword}</span>
                                {w.case_sensitive === 1 && <span className="text-[9px] text-amber-400 font-bold">Aa</span>}
                                {w.whole_word === 1 && <span className="text-[9px] text-amber-400 font-bold">W</span>}
                                <button
                                  type="button"
                                  onClick={() => handleDeleteMutedWord(w.id)}
                                  className="p-0.5 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
                                  title="削除"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* ミュート中ユーザーセクション */}
                      <div className="space-y-3">
                        <div className="flex items-center space-x-2">
                          <VolumeX className="w-4 h-4 text-amber-400" />
                          <h4 className="text-sm font-bold text-slate-200">
                            ミュート中のユーザー ({mutedUsers.length})
                          </h4>
                        </div>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          ミュートされたユーザーの投稿やリノートはタイムライン、検索、通知に表示されなくなります（相手には通知されません）。
                        </p>

                        {mutedUsers.length === 0 ? (
                          <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-500">
                            現在ミュートしているユーザーはいません。
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {mutedUsers.map((m: any) => (
                              <div
                                key={m.id || m.target_user_id}
                                className="flex items-center justify-between p-3.5 bg-slate-950/60 border border-slate-800 rounded-2xl hover:border-slate-700/80 transition"
                              >
                                <div className="min-w-0 flex-1 pr-3">
                                  <div className="flex items-center space-x-2">
                                    <span className="font-bold text-xs text-slate-200 truncate">
                                      {m.target_name || m.target_handle}
                                    </span>
                                    <span className="font-mono text-[11px] text-indigo-400 truncate">
                                      @{m.target_handle}
                                    </span>
                                  </div>
                                  <span className="text-[10px] text-slate-500 block mt-0.5">
                                    ミュート日時: {new Date(m.created_at).toLocaleString('ja-JP')}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleUnmuteUser(m.target_handle || m.target_user_id)}
                                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-300 hover:text-amber-200 text-xs font-bold border border-slate-700 transition flex items-center space-x-1 shrink-0 cursor-pointer"
                                >
                                  <Volume2 className="w-3.5 h-3.5" />
                                  <span>解除</span>
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* ブロック中ユーザーセクション */}
                      <div className="space-y-3 pt-4 border-t border-slate-800/80">
                        <div className="flex items-center space-x-2">
                          <Ban className="w-4 h-4 text-rose-400" />
                          <h4 className="text-sm font-bold text-slate-200">
                            ブロック中のユーザー ({blockedUsers.length})
                          </h4>
                        </div>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          ブロックされたユーザーとは相互のフォローが解除され、相手の投稿や通知が完全に遮断されます。
                        </p>

                        {blockedUsers.length === 0 ? (
                          <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-6 text-center text-xs text-slate-500">
                            現在ブロックしているユーザーはいません。
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {blockedUsers.map((b: any) => (
                              <div
                                key={b.id || b.target_user_id}
                                className="flex items-center justify-between p-3.5 bg-slate-950/60 border border-slate-800 rounded-2xl hover:border-slate-700/80 transition"
                              >
                                <div className="min-w-0 flex-1 pr-3">
                                  <div className="flex items-center space-x-2">
                                    <span className="font-bold text-xs text-slate-200 truncate">
                                      {b.target_name || b.target_handle}
                                    </span>
                                    <span className="font-mono text-[11px] text-rose-400 truncate">
                                      @{b.target_handle}
                                    </span>
                                  </div>
                                  <span className="text-[10px] text-slate-500 block mt-0.5">
                                    ブロック日時: {new Date(b.created_at).toLocaleString('ja-JP')}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleUnblockUser(b.target_handle || b.target_user_id)}
                                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-rose-300 hover:text-rose-200 text-xs font-bold border border-slate-700 transition flex items-center space-x-1 shrink-0 cursor-pointer"
                                >
                                  <Ban className="w-3.5 h-3.5" />
                                  <span>ブロック解除</span>
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 🚩 自分が出した通報の履歴（送れるのに結果が見えなかった） */}
                  <div className="border-b border-slate-800 pb-3">
                    <h3 className="text-base font-bold text-slate-100 flex items-center space-x-2">
                      <ShieldAlert className="w-4 h-4 text-amber-400" />
                      <span>送信した通報</span>
                      <span className="text-xs font-normal text-slate-500">({myReports.length})</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      あなたが送った通報と、その対応状況です。管理者が対応すると「対応済み」になります。
                    </p>
                  </div>

                  {isLoadingMyReports ? (
                    <p className="text-xs text-slate-500 py-3">読み込み中…</p>
                  ) : myReports.length === 0 ? (
                    <p className="text-xs text-slate-500 py-3">まだ通報はありません。</p>
                  ) : (
                    <div className="space-y-2">
                      {myReports.map((report: any) => (
                        <div key={report.id} className="bg-slate-950/60 p-3.5 rounded-2xl border border-slate-800 space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[11px] text-slate-300 truncate">{report.target_handle}</span>
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0 ${
                                report.status === 'resolved'
                                  ? 'bg-emerald-500/15 text-emerald-300'
                                  : 'bg-amber-500/15 text-amber-300'
                              }`}
                            >
                              {report.status === 'resolved' ? '対応済み' : '対応待ち'}
                            </span>
                          </div>
                          {report.target_post_preview && (
                            <p className="text-[11px] text-slate-500 line-clamp-2">{report.target_post_preview}</p>
                          )}
                          <p className="text-[11px] text-slate-400">理由: {report.category}</p>
                          {report.comment && <p className="text-[11px] text-slate-500">補足: {report.comment}</p>}
                          {report.resolution_note && (
                            <p className="text-[11px] text-emerald-300/90">対応メモ: {report.resolution_note}</p>
                          )}
                          <span className="text-[10px] text-slate-600 block">
                            送信: {new Date(report.created_at).toLocaleString('ja-JP')}
                            {report.resolved_at ? ` / 対応: ${new Date(report.resolved_at).toLocaleString('ja-JP')}` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                /* 🚪 セッション・ログアウト */
                <div className="space-y-6">
                  <div className="border-b border-slate-800 pb-3">
                    <h3 className="text-base font-bold text-slate-100 flex items-center space-x-2">
                      <LogOut className="w-4 h-4 text-rose-400" />
                      <span>セッションとセキュリティ</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      現在のログイン端末セッションの確認およびサインアウトを行います。
                    </p>
                  </div>

                  <div className="bg-slate-950/60 p-4 rounded-2xl border border-slate-800 space-y-3">
                    <span className="text-xs font-bold text-slate-300 block">現在のセッション情報</span>
                    <div className="space-y-2 text-xs">
                      <div className="flex items-center justify-between text-slate-400 py-1.5 border-b border-slate-800/60">
                        <span>ログインアカウント</span>
                        <span className="font-bold text-slate-200">@{authUser?.id} ({authUser?.name})</span>
                      </div>
                      <div className="flex items-center justify-between text-slate-400 py-1.5 border-b border-slate-800/60">
                        <span>セッショントークン</span>
                        <span className="font-mono text-[11px] text-slate-400">
                          {authToken ? `${authToken.slice(0, 8)}...${authToken.slice(-8)}` : '未ログイン'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-slate-400 py-1.5">
                        <span>ログイン状態</span>
                        <span className="text-[11px] text-emerald-400 flex items-center space-x-1 font-bold">
                          <Check className="w-3 h-3" />
                          <span>アクティブ (認証中)</span>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 危険ゾーン (Danger Zone) */}
                  <div className="bg-rose-950/20 border border-rose-500/30 rounded-2xl p-5 space-y-4">
                    <div>
                      <h4 className="text-sm font-bold text-rose-300 flex items-center space-x-2">
                        <LogOut className="w-4 h-4 text-rose-400" />
                        <span>アカウントからログアウト</span>
                      </h4>
                      <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                        この端末のブラウザからセッショントークンを破棄し、安全にログアウトします。
                        再びログインするには、ユーザーID と マスターキー が必要です。
                      </p>
                    </div>

                    <div className="pt-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm('ログアウトしますか？\n次回ログインには登録時のマスターキーが必要です。')) {
                            handleLogout();
                          }
                        }}
                        className="px-5 py-2.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-rose-600/30 transition flex items-center space-x-2 cursor-pointer"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>この端末からログアウトする</span>
                      </button>
                    </div>
                  </div>

                  {/* 🖥️ ログイン中の端末（セッション）一覧 */}
                  <SessionsPanel api={api} authToken={authToken} />
                </div>
              )}
            </div>
          </div>
        </main>

        {/* 🗂️ 自分の記録（タブに関係なく開けるよう、画面の最後に描く） */}
        {showReactionHistory && <ReactionHistoryModal api={api} onClose={() => setShowReactionHistory(false)} />}
        {showPostCalendar && <PostCalendarModal api={api} onClose={() => setShowPostCalendar(false)} />}
    </>
  );
}
