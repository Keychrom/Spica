/**
 * AdminDashboard（App.tsx から切り出した画面）
 *
 * 見た目・挙動は App.tsx にあったときのまま。状態は App 側に置いたままにして、
 * ここへは props で渡す（切り出しであって作り直しではない）。
 * App からは React.lazy で読み込むので、初期バンドルには含まれない。
 */
import { useState } from 'react';
import type { ApiResult } from '../api/client';
import { AlertCircle, ArrowLeft, Check, CheckCircle2, ClipboardList, Cloud, Copy, Database, ExternalLink, EyeOff, Image as ImageIcon, Globe, HardDrive, LayoutDashboard, Lock, Mail, Megaphone, Plus, Radio, RefreshCw, Search, Send, Server, Settings, ShieldAlert, ShieldCheck, Smile, Tag, Ticket, Trash2, Upload, UserPlus, Users } from 'lucide-react';

export interface AdminDashboardProps {
  authToken: any;
  api: any;
  setContentPolicy: any;
  setMaintenanceStats: any;
  setServerStats: any;
  fetchCustomEmojis: any;
  fetchServerStats: any;
  fetchRecoveryStatus: any;
  setAdminAnnouncements: any;
  fetchAnnouncements: any;
  setAdminStorageConfig: any;
  fetchTimeline: any;
  executeBlockDomain: any;
  setBlockMessage: any;
  adminTab: any;
  maintenanceStats: any;
  setAdminTab: any;
  canAdmin: any;
  serverStats: any;
  adminUsers: any;
  adminRoles: any;
  adminRelays: any;
  storageForm: any;
  setStorageForm: any;
  adminStorageConfig: any;
  adminStats: any;
  adminReportCounts: any;
  reportStatusFilter: any;
  adminBlockedDomains: any;
  adminAnnouncements: any;
  blockMessage: any;
  adminFederation: any;
  adminEmojis: any;
  fetchReports: any;
  fetchAdminData: any;
  adminServerRulesText: any;
  adminServerBanner: any;
  adminInvitations: any;
  navigateToView: any;
  isLoadingAdmin: any;
  isBlockingDomain: any;
  contentPolicy: any;
  blockInputDomain: any;
  availablePermissions: any;
  adminServerIcon: any;
  adminReports: any;
  setReportStatusFilter: any;
  setBlockInputReason: any;
  setBlockInputDomain: any;
  setAdminTosUrl: any;
  setAdminServerRulesText: any;
  setAdminServerName: any;
  setAdminServerIcon: any;
  setAdminServerDesc: any;
  setAdminServerBanner: any;
  setAdminRequireRulesAgreement: any;
  setAdminRepositoryUrl: any;
  setAdminPrivacyPolicyUrl: any;
  setAdminOperatorUrl: any;
  setAdminDeleteTargetUser: any;
  setAdminContactUrl: any;
  fetchRoles: any;
  blockInputReason: any;
  authUser: any;
  adminTosUrl: any;
  adminServerName: any;
  adminServerDesc: any;
  adminRequireRulesAgreement: any;
  adminRepositoryUrl: any;
  adminPrivacyPolicyUrl: any;
  adminOperatorUrl: any;
  adminContactUrl: any;
}

export default function AdminDashboard(props: AdminDashboardProps) {
  const { authToken, api, setContentPolicy, setMaintenanceStats, setServerStats, fetchCustomEmojis, fetchServerStats, fetchRecoveryStatus, setAdminAnnouncements, fetchAnnouncements, setAdminStorageConfig, fetchTimeline, executeBlockDomain, setBlockMessage, adminTab, maintenanceStats, setAdminTab, canAdmin, serverStats, adminUsers, adminRoles, adminRelays, storageForm, setStorageForm, adminStorageConfig, adminStats, adminReportCounts, reportStatusFilter, adminBlockedDomains, adminAnnouncements, blockMessage, adminFederation, adminEmojis, fetchReports, fetchAdminData, adminServerRulesText, adminServerBanner, adminInvitations, navigateToView, isLoadingAdmin, isBlockingDomain, contentPolicy, blockInputDomain, availablePermissions, adminServerIcon, adminReports, setReportStatusFilter, setBlockInputReason, setBlockInputDomain, setAdminTosUrl, setAdminServerRulesText, setAdminServerName, setAdminServerIcon, setAdminServerDesc, setAdminServerBanner, setAdminRequireRulesAgreement, setAdminRepositoryUrl, setAdminPrivacyPolicyUrl, setAdminOperatorUrl, setAdminDeleteTargetUser, setAdminContactUrl, fetchRoles, blockInputReason, authUser, adminTosUrl, adminServerName, adminServerDesc, adminRequireRulesAgreement, adminRepositoryUrl, adminPrivacyPolicyUrl, adminOperatorUrl, adminContactUrl } = props;

  // --- App.tsx から移した state とハンドラ（この画面だけで使う） ---
  const [adminUserSearch, setAdminUserSearch] = useState<string>('');

  const [newEmojiName, setNewEmojiName] = useState<string>('');

  const [newEmojiCategory, setNewEmojiCategory] = useState<string>('一般');

  const [newEmojiUrl, setNewEmojiUrl] = useState<string>('');

  const [isUploadingEmoji, setIsUploadingEmoji] = useState<boolean>(false);

  const [emojiActionMsg, setEmojiActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [newInviteMaxUses, setNewInviteMaxUses] = useState<number>(1);

  const [newInviteExpiresDays, setNewInviteExpiresDays] = useState<string>('7');

  const [newInviteMemo, setNewInviteMemo] = useState<string>('');

  const [isCreatingInvite, setIsCreatingInvite] = useState<boolean>(false);

  const [isUpdatingRegMode, setIsUpdatingRegMode] = useState<boolean>(false);

  const [inviteActionMsg, setInviteActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [isSavingContentPolicy, setIsSavingContentPolicy] = useState<boolean>(false);

  const [contentPolicyMsg, setContentPolicyMsg] = useState<string | null>(null);

  const [auditLog, setAuditLog] = useState<any[]>([]);

  const [auditKinds, setAuditKinds] = useState<any[]>([]);

  const [auditFilter, setAuditFilter] = useState<string>('');

  const [auditTotal, setAuditTotal] = useState<number>(0);

  const [auditCursor, setAuditCursor] = useState<string | null>(null);

  const [isLoadingAudit, setIsLoadingAudit] = useState<boolean>(false);

  const [auditMsg, setAuditMsg] = useState<string | null>(null);

  const [isClearingProxyCache, setIsClearingProxyCache] = useState<boolean>(false);

  const [isRunningMaintenance, setIsRunningMaintenance] = useState<boolean>(false);

  const [maintenanceMsg, setMaintenanceMsg] = useState<string | null>(null);

  const [isUploadingServerIcon, setIsUploadingServerIcon] = useState<boolean>(false);

  const [isUploadingServerBanner, setIsUploadingServerBanner] = useState<boolean>(false);

  const [isSavingServerSettings, setIsSavingServerSettings] = useState<boolean>(false);

  const [serverSettingsMessage, setServerSettingsMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [relayInputUrl, setRelayInputUrl] = useState<string>('');

  const [isConnectingRelay, setIsConnectingRelay] = useState<boolean>(false);

  const [relayMessage, setRelayMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [blockInputSeverity, setBlockInputSeverity] = useState<'suspend' | 'silence'>('suspend');

  const [isUpdatingReport, setIsUpdatingReport] = useState<string | null>(null);

  const [reportActionMsg, setReportActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [isTestingStorage, setIsTestingStorage] = useState<boolean>(false);

  const [isSavingStorage, setIsSavingStorage] = useState<boolean>(false);

  const [storageMessage, setStorageMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const REPORT_CATEGORY_LABELS: Record<string, string> = {
    spam: 'スパム',
    abuse: '嫌がらせ・誹謗中傷',
    sensitive: '不適切な内容',
    impersonation: 'なりすまし',
    other: 'その他',
  };

  const handleResolveReport = async (reportId: string, action: 'resolve' | 'reject' | 'reopen') => {
    if (!authToken) return;
    setIsUpdatingReport(reportId);
    setReportActionMsg(null);
    try {
      const res = await api.post(`/api/admin/reports/${encodeURIComponent(reportId)}/resolve`, { action });
      const data = await res.json();
      if (res.ok) {
        setReportActionMsg({
          type: 'success',
          text:
            action === 'resolve'
              ? '通報を「対応済み」にしました。'
              : action === 'reject'
                ? '通報を「却下」にしました。'
                : '通報を再オープンしました。',
        });
        await fetchAdminData();
      } else {
        setReportActionMsg({ type: 'error', text: data.error || '通報の更新に失敗しました。' });
      }
    } catch (err: any) {
      setReportActionMsg({ type: 'error', text: err.message });
    } finally {
      setIsUpdatingReport(null);
    }
  };

  const fetchAuditLog = async (opts: { before?: string | null; action?: string } = {}) => {
    if (!authToken || !canAdmin) return;
    setIsLoadingAudit(true);
    try {
      const params = new URLSearchParams({ limit: '60' });
      if (opts.before) params.set('before', opts.before);
      const action = opts.action !== undefined ? opts.action : auditFilter;
      if (action) params.set('action', action);
      const res = await api.get(`/api/admin/audit?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setAuditMsg(data.error || '監査ログの取得に失敗しました。');
        return;
      }
      const rows: any[] = Array.isArray(data.actions) ? data.actions : [];
      setAuditLog(opts.before ? [...auditLog, ...rows] : rows);
      setAuditCursor(data.nextCursor || null);
      setAuditTotal(Number(data.total) || 0);
      setAuditKinds(Array.isArray(data.kinds) ? data.kinds : []);
      setAuditMsg(null);
    } catch (err: any) {
      setAuditMsg(err.message);
    } finally {
      setIsLoadingAudit(false);
    }
  };

  const handlePruneAuditLog = async () => {
    if (!authToken || !canAdmin) return;
    if (!confirm('180 日より古い監査ログを削除しますか？')) return;
    try {
      const res = await api.post('/api/admin/audit/prune', { days: 180 });
      const data = await res.json();
      if (!res.ok) {
        setAuditMsg(data.error || '削除に失敗しました。');
        return;
      }
      setAuditMsg(data.message || '削除しました。');
      await fetchAuditLog();
    } catch (err: any) {
      setAuditMsg(err.message);
    }
  };

  const handleSaveContentPolicy = async (next: { ftsIndexScope?: string; remoteAnnouncePolicy?: string }) => {
    if (!authToken) return;
    const previous = contentPolicy;
    const updated = { ...contentPolicy, ...next };
    setContentPolicy(updated);
    setIsSavingContentPolicy(true);
    setContentPolicyMsg(null);
    try {
      const res = await api.post('/api/admin/content-policy', next);
      const data = await res.json();
      if (!res.ok) {
        setContentPolicy(previous);
        setContentPolicyMsg(data.error || '保存に失敗しました。');
        return;
      }
      setContentPolicy({
        ftsIndexScope: data.fts_index_scope || updated.ftsIndexScope,
        remoteAnnouncePolicy: data.remote_announce_policy || updated.remoteAnnouncePolicy,
      });
      setContentPolicyMsg(data.message || '保存しました。');
    } catch (err: any) {
      setContentPolicy(previous);
      setContentPolicyMsg(err.message);
    } finally {
      setIsSavingContentPolicy(false);
    }
  };

  const handleRunMaintenance = async () => {
    if (!authToken) return;
    if (!confirm('定期メンテナンスを実行しますか？（バックアップ → 方針適用 → 保持期間を超えたリモート投稿の削除）')) return;
    setIsRunningMaintenance(true);
    setMaintenanceMsg(null);
    try {
      const res = await api.post('/api/admin/maintenance/run');
      const data = await res.json();
      if (!res.ok) {
        setMaintenanceMsg(data.error || '実行に失敗しました。');
        return;
      }
      setMaintenanceMsg(data.message || '実行しました。');
      if (data.stats) setMaintenanceStats(data.stats);
    } catch (err: any) {
      setMaintenanceMsg(err.message);
    } finally {
      setIsRunningMaintenance(false);
    }
  };

  const handleSaveMaintenanceSettings = async (next: { autoMaintenance?: boolean; hour?: number; imageProxy?: boolean; imageProxyMaxMb?: number }) => {
    if (!authToken) return;
    try {
      const res = await api.post('/api/admin/maintenance/settings', next);
      const data = await res.json();
      if (!res.ok) {
        setMaintenanceMsg(data.error || '設定の保存に失敗しました。');
        return;
      }
      setMaintenanceMsg(data.message || '設定を保存しました。');
      if (data.stats) setMaintenanceStats(data.stats);
    } catch (err: any) {
      setMaintenanceMsg(err.message);
    }
  };

  const handleClearProxyCache = async () => {
    if (!authToken) return;
    setIsClearingProxyCache(true);
    try {
      const res = await api.post('/api/admin/image-proxy/cache', {});
      const data = await res.json();
      if (res.ok) {
        setMaintenanceMsg(data.message || 'キャッシュを整理しました。');
        if (data.stats) {
          setMaintenanceStats((prev: any) => (prev ? { ...prev, imageProxy: data.stats } : prev));
          fetchAdminData();
        }
      } else {
        setMaintenanceMsg(data.error || 'キャッシュの整理に失敗しました。');
      }
    } catch (err: any) {
      setMaintenanceMsg(err.message);
    } finally {
      setIsClearingProxyCache(false);
    }
  };

  const handleSaveServerSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken) return;
    if (!adminServerName.trim()) {
      setServerSettingsMessage({ type: 'error', text: 'サーバー名は空にできません。' });
      return;
    }
    setIsSavingServerSettings(true);
    setServerSettingsMessage(null);
    try {
      const res = await api.post('/api/admin/server-settings', { name: adminServerName.trim(), description: adminServerDesc.trim(), icon_url: adminServerIcon.trim(), banner_url: adminServerBanner.trim(), tos_url: adminTosUrl.trim(), privacy_policy_url: adminPrivacyPolicyUrl.trim(), contact_url: adminContactUrl.trim(), repository_url: adminRepositoryUrl.trim(), operator_url: adminOperatorUrl.trim(), server_rules: adminServerRulesText.split('\n').map((r: any) => r.trim()).filter((r: any) => r.length > 0), require_rules_agreement: adminRequireRulesAgreement, });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '設定の保存に失敗しました。');

      setServerStats((prev: any) => prev ? {
        ...prev,
        name: data.settings.name,
        description: data.settings.description,
        icon_url: data.settings.icon_url,
        banner_url: data.settings.banner_url,
        tos_url: data.settings.tos_url,
        privacy_policy_url: data.settings.privacy_policy_url,
        contact_url: data.settings.contact_url,
        repository_url: data.settings.repository_url,
        operator_url: data.settings.operator_url,
        server_rules: data.settings.server_rules,
        require_rules_agreement: data.settings.require_rules_agreement,
      } : prev);
      document.title = data.settings.name;
      setServerSettingsMessage({ type: 'success', text: 'サーバー設定を保存しました！' });
    } catch (err: any) {
      setServerSettingsMessage({ type: 'error', text: err.message || '保存に失敗しました。' });
    } finally {
      setIsSavingServerSettings(false);
    }
  };

  const handleUploadServerIcon = async (file: File) => {
    if (!authToken) return;
    setIsUploadingServerIcon(true);
    setServerSettingsMessage(null);
    try {
      const formData = new FormData();
      formData.append('icon', file);
      const res = await api.post('/api/admin/server-icon', formData);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'アップロードに失敗しました。');
      setAdminServerIcon(data.icon_url);
      setServerStats((prev: any) => prev ? { ...prev, icon_url: data.icon_url } : prev);
      setServerSettingsMessage({ type: 'success', text: 'サーバーアイコンを更新しました！' });
    } catch (err: any) {
      setServerSettingsMessage({ type: 'error', text: err.message || 'アイコンのアップロードに失敗しました。' });
    } finally {
      setIsUploadingServerIcon(false);
    }
  };

  const handleUploadServerBanner = async (file: File) => {
    if (!authToken) return;
    setIsUploadingServerBanner(true);
    setServerSettingsMessage(null);
    try {
      const formData = new FormData();
      formData.append('banner', file);
      const res = await api.post('/api/admin/server-banner', formData);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'バナーのアップロードに失敗しました。');
      setAdminServerBanner(data.banner_url);
      setServerStats((prev: any) => prev ? { ...prev, banner_url: data.banner_url } : prev);
      setServerSettingsMessage({ type: 'success', text: 'サーバーバナー画像を更新しました！' });
    } catch (err: any) {
      setServerSettingsMessage({ type: 'error', text: err.message || 'バナーのアップロードに失敗しました。' });
    } finally {
      setIsUploadingServerBanner(false);
    }
  };

  const handleCreateEmoji = async (file?: File) => {
    if (!authToken) return;
    if (!newEmojiName.trim()) {
      setEmojiActionMsg({ type: 'error', text: '絵文字のショートコード名を入力してください。' });
      return;
    }
    if (!file && !newEmojiUrl.trim()) {
      setEmojiActionMsg({ type: 'error', text: '画像ファイルを選択するか、画像URLを入力してください。' });
      return;
    }
    setIsUploadingEmoji(true);
    setEmojiActionMsg(null);
    try {
      let res: ApiResult;
      if (file) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('name', newEmojiName.trim());
        formData.append('category', newEmojiCategory.trim() || '一般');
        res = await api.post('/api/admin/emojis', formData);
      } else {
        res = await api.post('/api/admin/emojis', { name: newEmojiName.trim(), category: newEmojiCategory.trim() || '一般', url: newEmojiUrl.trim(), });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '絵文字の登録に失敗しました。');
      setNewEmojiName('');
      setNewEmojiUrl('');
      setEmojiActionMsg({ type: 'success', text: data.message || 'カスタム絵文字を登録しました！' });
      fetchCustomEmojis();
      fetchAdminData();
    } catch (err: any) {
      setEmojiActionMsg({ type: 'error', text: err.message || 'エラーが発生しました。' });
    } finally {
      setIsUploadingEmoji(false);
    }
  };

  const handleDeleteEmoji = async (emojiId: string, emojiName: string) => {
    if (!authToken) return;
    if (!confirm(`:${emojiName}: を削除してもよろしいですか？`)) return;
    try {
      const res = await api.delete(`/api/admin/emojis/${encodeURIComponent(emojiId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '削除に失敗しました。');
      setEmojiActionMsg({ type: 'success', text: data.message || '絵文字を削除しました。' });
      fetchCustomEmojis();
      fetchAdminData();
    } catch (err: any) {
      setEmojiActionMsg({ type: 'error', text: err.message || 'エラーが発生しました。' });
    }
  };

  const handleCreateInvitation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken) return;
    setIsCreatingInvite(true);
    setInviteActionMsg(null);
    try {
      const res = await api.post('/api/admin/invitations', { maxUses: newInviteMaxUses, expiresInDays: newInviteExpiresDays === 'infinite' ? null : parseInt(newInviteExpiresDays, 10), memo: newInviteMemo.trim(), });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '招待コードの発行に失敗しました。');
      setNewInviteMemo('');
      setInviteActionMsg({ type: 'success', text: `招待コード ${data.invitation.code} を発行しました！` });
      fetchAdminData();
    } catch (err: any) {
      setInviteActionMsg({ type: 'error', text: err.message || 'エラーが発生しました。' });
    } finally {
      setIsCreatingInvite(false);
    }
  };

  const handleDeleteInvitation = async (code: string) => {
    if (!authToken) return;
    if (!confirm(`招待コード ${code} を無効化・削除しますか？`)) return;
    try {
      const res = await api.delete(`/api/admin/invitations/${encodeURIComponent(code)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '削除に失敗しました。');
      setInviteActionMsg({ type: 'success', text: data.message || '招待コードを削除しました。' });
      fetchAdminData();
    } catch (err: any) {
      setInviteActionMsg({ type: 'error', text: err.message || 'エラーが発生しました。' });
    }
  };

  const handleChangeRegistrationMode = async (mode: 'open' | 'invite' | 'closed') => {
    if (!authToken) return;
    setIsUpdatingRegMode(true);
    setInviteActionMsg(null);
    try {
      const res = await api.post('/api/admin/registration-mode', { mode });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '登録モードの更新に失敗しました。');
      setServerStats((prev: any) => prev ? { ...prev, registration_mode: mode } : prev);
      setInviteActionMsg({ type: 'success', text: data.message });
      fetchServerStats();
    } catch (err: any) {
      setInviteActionMsg({ type: 'error', text: err.message || 'エラーが発生しました。' });
    } finally {
      setIsUpdatingRegMode(false);
    }
  };

  const [newAnnouncementTitle, setNewAnnouncementTitle] = useState<string>('');

  const [newAnnouncementContent, setNewAnnouncementContent] = useState<string>('');

  const [isSavingAnnouncement, setIsSavingAnnouncement] = useState<boolean>(false);

  const [announcementMsg, setAnnouncementMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [newRoleName, setNewRoleName] = useState<string>('');

  const [newRoleColor, setNewRoleColor] = useState<string>('#6366f1');

  const [newRolePermissions, setNewRolePermissions] = useState<string[]>([]);

  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);

  const [roleActionMsg, setRoleActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [mailSettings, setMailSettings] = useState<any>({ host: '', port: 587, secure: false, user: '', pass: '', from: '', allowEmailRegistration: false, authMode: 'master_key' });

  const [mailSettingsMsg, setMailSettingsMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [isSavingMail, setIsSavingMail] = useState<boolean>(false);

  const [deliveryQueue, setDeliveryQueue] = useState<any>({
    stats: { pending: 0, delivered: 0, failed: 0, nextAttemptAt: null },
    pending: [],
    recentFailures: [],
    maxAttempts: 9,
    retryDelaysMs: [],
  });

  const [isLoadingDeliveryQueue, setIsLoadingDeliveryQueue] = useState<boolean>(false);

  const [isActingOnDelivery, setIsActingOnDelivery] = useState<boolean>(false);

  const [deliveryQueueMsg, setDeliveryQueueMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchDeliveryQueue = async () => {
    if (!authToken) return;
    setIsLoadingDeliveryQueue(true);
    try {
      const res = await api.get('/api/admin/delivery-queue');
      if (res.ok) setDeliveryQueue(await res.json());
    } catch (err) {
      console.error('配送キューの取得エラー:', err);
    } finally {
      setIsLoadingDeliveryQueue(false);
    }
  };

  const handleRetryDeliveries = async () => {
    if (!authToken) return;
    setIsActingOnDelivery(true);
    setDeliveryQueueMsg(null);
    try {
      const res = await api.post('/api/admin/delivery-queue/retry');
      const data = await res.json();
      if (!res.ok) {
        setDeliveryQueueMsg({ type: 'error', text: data.error || '再送の実行に失敗しました。' });
        return;
      }
      setDeliveryQueueMsg({ type: 'success', text: data.message || '再送を開始しました。' });
      await fetchDeliveryQueue();
    } catch (err: any) {
      setDeliveryQueueMsg({ type: 'error', text: err.message });
    } finally {
      setIsActingOnDelivery(false);
    }
  };

  const handleClearFailedDeliveries = async () => {
    if (!authToken) return;
    if (!window.confirm('失敗が確定した配送の記録を削除しますか？（再送は行われません）')) return;
    setIsActingOnDelivery(true);
    setDeliveryQueueMsg(null);
    try {
      const res = await api.post('/api/admin/delivery-queue/clear-failed');
      const data = await res.json();
      if (!res.ok) {
        setDeliveryQueueMsg({ type: 'error', text: data.error || '削除に失敗しました。' });
        return;
      }
      setDeliveryQueueMsg({ type: 'success', text: data.message || '削除しました。' });
      await fetchDeliveryQueue();
    } catch (err: any) {
      setDeliveryQueueMsg({ type: 'error', text: err.message });
    } finally {
      setIsActingOnDelivery(false);
    }
  };

  const fetchMailSettings = async () => {
    if (!authToken) return;
    try {
      const res = await api.get('/api/admin/mail-settings');
      if (res.ok) setMailSettings(await res.json());
    } catch (err) {
      console.error('メール設定の取得エラー:', err);
    }
  };

  const handleSaveMailSettings = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authToken) return;
    setIsSavingMail(true);
    setMailSettingsMsg(null);
    try {
      const res = await api.post('/api/admin/mail-settings', { host: mailSettings.host, port: mailSettings.port, secure: mailSettings.secure, user: mailSettings.user, pass: mailSettings.pass, from: mailSettings.from, });
      const data = await res.json();
      if (!res.ok) {
        setMailSettingsMsg({ type: 'error', text: data.error || '保存に失敗しました。' });
        return;
      }

      // 認証方式・メール登録可否も同時に保存する
      const authRes = await api.post('/api/admin/auth-settings', { authMode: mailSettings.authMode, allowEmailRegistration: mailSettings.allowEmailRegistration, });
      if (!authRes.ok) {
        const authData = await authRes.json();
        setMailSettingsMsg({ type: 'error', text: authData.error || '認証設定の保存に失敗しました。' });
        return;
      }

      setMailSettingsMsg({ type: 'success', text: 'メール・認証設定を保存しました。' });
      setMailSettings((prev: any) => ({ ...prev, pass: '' }));
      await fetchRecoveryStatus();
    } catch (err: any) {
      setMailSettingsMsg({ type: 'error', text: err.message });
    } finally {
      setIsSavingMail(false);
    }
  };

  const handleTestMailSettings = async () => {
    if (!authToken) return;
    setIsSavingMail(true);
    setMailSettingsMsg(null);
    try {
      const res = await api.post('/api/admin/mail-settings/test', { host: mailSettings.host, port: mailSettings.port, user: mailSettings.user, pass: mailSettings.pass, from: mailSettings.from });
      const data = await res.json();
      setMailSettingsMsg(
        res.ok
          ? { type: 'success', text: data.message || 'SMTP に接続できました。' }
          : { type: 'error', text: data.error || '接続テストに失敗しました。' },
      );
    } catch (err: any) {
      setMailSettingsMsg({ type: 'error', text: err.message });
    } finally {
      setIsSavingMail(false);
    }
  };

  const handleSaveRole = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authToken || !newRoleName.trim() || newRolePermissions.length === 0) return;
    const isEdit = Boolean(editingRoleId);
    try {
      const res = await api.request(isEdit ? 'PUT' : 'POST', isEdit ? `/api/admin/roles/${encodeURIComponent(editingRoleId as string)}` : '/api/admin/roles', { name: newRoleName.trim(), color: newRoleColor, permissions: newRolePermissions });
      const data = await res.json();
      if (res.ok) {
        setRoleActionMsg({ type: 'success', text: isEdit ? 'ロールを更新しました。' : `ロール「${newRoleName.trim()}」を作成しました。` });
        setNewRoleName('');
        setNewRoleColor('#6366f1');
        setNewRolePermissions([]);
        setEditingRoleId(null);
        await fetchRoles();
        await fetchAdminData();
      } else {
        setRoleActionMsg({ type: 'error', text: data.error || 'ロールの保存に失敗しました。' });
      }
    } catch (err: any) {
      setRoleActionMsg({ type: 'error', text: err.message });
    }
  };

  const handleEditRole = (role: any) => {
    setEditingRoleId(role.id);
    setNewRoleName(role.name);
    setNewRoleColor(role.color || '#6366f1');
    setNewRolePermissions(String(role.permissions || '').split(',').map((p) => p.trim()).filter(Boolean));
    setRoleActionMsg(null);
  };

  const handleDeleteRole = async (id: string) => {
    if (!authToken) return;
    if (!confirm('このロールを削除しますか？（付与済みのユーザーからも外れます）')) return;
    try {
      const res = await api.delete(`/api/admin/roles/${encodeURIComponent(id)}`);
      if (res.ok) {
        setRoleActionMsg({ type: 'success', text: 'ロールを削除しました。' });
        if (editingRoleId === id) {
          setEditingRoleId(null);
          setNewRoleName('');
          setNewRolePermissions([]);
        }
        await fetchRoles();
        await fetchAdminData();
      }
    } catch (err) {
      console.error('ロールの削除エラー:', err);
    }
  };

  const handleToggleUserRole = async (userId: string, roleId: string) => {
    if (!authToken) return;
    const user = adminUsers.find((u: any) => u.id === userId);
    if (!user) return;

    const currentIds = new Set((user.roles || []).map((r: any) => r.id));
    if (currentIds.has(roleId)) {
      currentIds.delete(roleId);
    } else {
      currentIds.add(roleId);
    }

    try {
      const res = await api.post(`/api/admin/users/${encodeURIComponent(userId)}/roles`, { roleIds: Array.from(currentIds) });
      const data = await res.json();
      if (res.ok) {
        setRoleActionMsg({ type: 'success', text: `@${userId} のロールを更新しました。` });
        await fetchAdminData();
        await fetchRoles();
      } else {
        setRoleActionMsg({ type: 'error', text: data.error || 'ロールの更新に失敗しました。' });
      }
    } catch (err: any) {
      setRoleActionMsg({ type: 'error', text: err.message });
    }
  };

  const fetchAdminAnnouncements = async () => {
    if (!authToken) return;
    try {
      const res = await api.get('/api/admin/announcements');
      if (res.ok) setAdminAnnouncements(await res.json());
    } catch (err) {
      console.error('お知らせ管理の取得エラー:', err);
    }
  };

  const handleCreateAnnouncement = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authToken || !newAnnouncementTitle.trim() || !newAnnouncementContent.trim()) return;
    setIsSavingAnnouncement(true);
    setAnnouncementMsg(null);
    try {
      const res = await api.post('/api/admin/announcements', { title: newAnnouncementTitle.trim(), content: newAnnouncementContent.trim() });
      const data = await res.json();
      if (res.ok) {
        setNewAnnouncementTitle('');
        setNewAnnouncementContent('');
        setAnnouncementMsg({ type: 'success', text: 'お知らせを投稿しました。' });
        await fetchAdminAnnouncements();
        await fetchAnnouncements();
      } else {
        setAnnouncementMsg({ type: 'error', text: data.error || 'お知らせの投稿に失敗しました。' });
      }
    } catch (err: any) {
      setAnnouncementMsg({ type: 'error', text: err.message });
    } finally {
      setIsSavingAnnouncement(false);
    }
  };

  const handleToggleAnnouncement = async (id: string, isActive: boolean) => {
    if (!authToken) return;
    try {
      const res = await api.put(`/api/admin/announcements/${encodeURIComponent(id)}`, { isActive });
      if (res.ok) {
        await fetchAdminAnnouncements();
        await fetchAnnouncements();
      }
    } catch (err) {
      console.error('お知らせの更新エラー:', err);
    }
  };

  const handleDeleteAnnouncement = async (id: string) => {
    if (!authToken) return;
    if (!confirm('このお知らせを削除しますか？')) return;
    try {
      const res = await api.delete(`/api/admin/announcements/${encodeURIComponent(id)}`);
      if (res.ok) {
        await fetchAdminAnnouncements();
        await fetchAnnouncements();
      }
    } catch (err) {
      console.error('お知らせの削除エラー:', err);
    }
  };

  const handleSaveStorage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken) return;
    setIsSavingStorage(true);
    setStorageMessage(null);
    try {
      const res = await api.post('/api/admin/storage', storageForm);
      const data = await res.json();
      if (res.ok) {
        setStorageMessage({ type: 'success', text: data.message || '保存しました。' });
        // 再取得してステート反映
        const stRes = await api.get('/api/admin/storage');
        if (stRes.ok) {
          const sData = await stRes.json();
          setAdminStorageConfig(sData);
        }
      } else {
        setStorageMessage({ type: 'error', text: data.error || '保存に失敗しました。' });
      }
    } catch (err: any) {
      setStorageMessage({ type: 'error', text: err.message });
    } finally {
      setIsSavingStorage(false);
    }
  };

  const handleTestStorage = async () => {
    if (!authToken) return;
    setIsTestingStorage(true);
    setStorageMessage(null);
    try {
      const res = await api.post('/api/admin/storage/test', storageForm);
      const data = await res.json();
      if (res.ok) {
        setStorageMessage({ type: 'success', text: data.message || '接続テストに成功しました！' });
      } else {
        setStorageMessage({ type: 'error', text: data.error || '接続テストに失敗しました。' });
      }
    } catch (err: any) {
      setStorageMessage({ type: 'error', text: err.message });
    } finally {
      setIsTestingStorage(false);
    }
  };

  const handleAdminChangeRole = async (userId: string, currentRole: string) => {
    if (!authToken) return;
    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    if (!confirm(`ユーザー @${userId} のロールを ${newRole} に変更しますか？`)) return;

    try {
      const res = await api.post(`/api/admin/users/${userId}/role`, { role: newRole });
      if (res.ok) {
        fetchAdminData();
      } else {
        const err = await res.json();
        alert(err.error);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleAdminToggleFreeze = async (userId: string, isFrozen: boolean) => {
    if (!authToken) return;
    const action = isFrozen ? '凍結解除' : '凍結';
    if (!confirm(`ユーザー @${userId} を${action}しますか？`)) return;

    try {
      const res = await api.post(`/api/admin/users/${userId}/freeze`, { isFrozen: !isFrozen });
      if (res.ok) {
        fetchAdminData();
      } else {
        const err = await res.json();
        alert(err.error);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleConnectRelay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !relayInputUrl.trim() || isConnectingRelay) return;

    setIsConnectingRelay(true);
    setRelayMessage(null);
    try {
      const res = await api.post('/api/admin/relays', { url: relayInputUrl.trim() });
      const data = await res.json();
      if (res.ok) {
        setRelayMessage({ type: 'success', text: data.message });
        setRelayInputUrl('');
        fetchAdminData();
      } else {
        setRelayMessage({ type: 'error', text: data.error || '接続に失敗しました。' });
      }
    } catch (err: any) {
      setRelayMessage({ type: 'error', text: err.message });
    } finally {
      setIsConnectingRelay(false);
    }
  };

  const handleDisconnectRelay = async (inboxUrl: string) => {
    if (!authToken) return;
    if (!confirm(`リレー (${inboxUrl}) の購読を解除しますか？`)) return;

    try {
      const res = await api.delete('/api/admin/relays', { inboxUrl });
      if (res.ok) {
        fetchAdminData();
      } else {
        const data = await res.json();
        alert(data.error);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleAdminClearCache = async () => {
    if (!authToken) return;
    if (!confirm('提携先FediverseドメインのActor情報、および外部から受信した投稿キャッシュをすべて消去しますか？\n（※自ノードの投稿やアカウントは保持されます）')) return;

    try {
      const res = await api.post('/api/admin/cache/clear', { clearPosts: true });
      const data = await res.json();
      if (res.ok) {
        alert(data.message);
        await fetchAdminData();
        await fetchTimeline();
        await fetchServerStats();
      } else {
        alert(`エラー: ${data.error}`);
      }
    } catch (err: any) {
      alert(`エラー: ${err.message}`);
    }
  };

  const handleAdminToggleRelayStatus = async (inboxUrl: string, currentStatus: string) => {
    if (!authToken) return;
    const newStatus = currentStatus === 'accepted' ? 'pending' : 'accepted';
    try {
      const res = await api.post('/api/admin/relays/toggle-status', { inboxUrl, status: newStatus });
      if (res.ok) {
        fetchAdminData();
      } else {
        const data = await res.json();
        alert(data.error);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleAdminResendRelay = async (inboxUrl?: string) => {
    if (!authToken) return;
    try {
      const res = await api.post('/api/admin/relays/resend', inboxUrl ? { inboxUrl } : {});
      const data = await res.json();
      if (res.ok) {
        alert(data.message || 'Follow Activity を再送しました。');
        fetchAdminData();
      } else {
        alert(data.error);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleQuickBlockDomain = async (domain: string) => {
    if (!confirm(`ドメイン "${domain}" をブロックしますか？\n\n・このサーバーからの通信（Inbox）を遮断します\n・蓄積されたキャッシュや投稿を即時削除します`)) {
      return;
    }
    await executeBlockDomain(domain, '連携先一覧からのクイックブロック');
  };

  const handleManualBlockDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!blockInputDomain.trim()) return;
    await executeBlockDomain(blockInputDomain.trim(), blockInputReason.trim(), blockInputSeverity);
  };

  const handleUnblockDomain = async (domain: string) => {
    if (!authToken) return;
    if (!confirm(`ドメイン "${domain}" のブロックを解除しますか？`)) return;

    try {
      const res = await api.delete(`/api/admin/blocks/${encodeURIComponent(domain)}`);
      const data = await res.json();
      if (res.ok) {
        setBlockMessage({ type: 'success', text: data.message || `ドメイン "${domain}" のブロックを解除しました。` });
        await fetchAdminData();
      } else {
        alert(data.error);
      }
    } catch (err: any) {
      alert(err.message);
    }
  };
  return (
    <>
        {/* 🛡️ 管理者コントロールパネル (Misskey風 2カラムレイアウト) */}
        <main className="max-w-7xl mx-auto px-4 py-6 flex-1 w-full">
          {/* 上部ヘッダー（全画面共通） */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-5 border-b border-slate-800/80 mb-6">
            <div className="flex items-center space-x-3">
              <button
                onClick={() => navigateToView('timeline')}
                className="p-2.5 rounded-2xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 transition"
                title="タイムラインへ戻る"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div>
                <h2 className="text-xl font-black text-slate-100 flex items-center space-x-2">
                  <Settings className="w-5 h-5 text-indigo-400" />
                  <span>コントロールパネル</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  ノードの統計、ユーザー管理、Fediverse 連合、メディアストレージ設定
                </p>
              </div>
            </div>

            <div className="flex items-center space-x-2 self-end sm:self-auto">
              <button
                onClick={fetchAdminData}
                disabled={isLoadingAdmin}
                className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 text-xs font-bold rounded-xl flex items-center space-x-1.5 transition shadow-sm"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoadingAdmin ? 'animate-spin text-indigo-400' : ''}`} />
                <span>データ再取得</span>
              </button>
            </div>
          </div>

          <div className="flex flex-col md:flex-row gap-6 items-start">
            {/* 📋 左サイドバー (Misskey 風メニュー) */}
            <aside className="w-full md:w-64 shrink-0 bg-slate-900/90 border border-slate-800 rounded-3xl p-3 shadow-xl space-y-4">
              {/* クイック検索バー */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="ユーザー検索..."
                  value={adminUserSearch}
                  onChange={(e) => {
                    setAdminUserSearch(e.target.value);
                    if (adminTab !== 'users') setAdminTab('users');
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition font-sans"
                />
              </div>

              {/* メニューリスト */}
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-slate-500 px-3 uppercase tracking-wider block mb-1">
                  管理
                </span>

                {canAdmin && (
  <>
{/* ダッシュボード */}
                <button
                  type="button"
                  onClick={() => setAdminTab('dashboard')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'dashboard'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <LayoutDashboard className="w-4 h-4" />
                    <span>ダッシュボード</span>
                  </div>
                </button>

</>
)}
                {canAdmin && (
  <>
{/* ユーザー */}
                <button
                  type="button"
                  onClick={() => setAdminTab('users')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'users'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Users className="w-4 h-4" />
                    <span>ユーザー</span>
                  </div>
                  {adminUsers.length > 0 && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                      adminTab === 'users' ? 'bg-indigo-700 text-white' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {adminUsers.length}
                    </span>
                  )}
                </button>

</>
)}
                {canAdmin && (
  <>
{/* 連合・リレー */}
                <button
                  type="button"
                  onClick={() => setAdminTab('federation')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'federation'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Radio className="w-4 h-4" />
                    <span>連合 (リレー)</span>
                  </div>
                  {adminRelays.length > 0 && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                      adminTab === 'federation' ? 'bg-indigo-700 text-white' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {adminRelays.length}
                    </span>
                  )}
                </button>

</>
)}
                {canAdmin && (
  <>
{/* サーバーブロック */}
                <button
                  type="button"
                  onClick={() => setAdminTab('blocks')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'blocks'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <ShieldAlert className="w-4 h-4" />
                    <span>サーバーブロック</span>
                  </div>
                  {adminBlockedDomains.length > 0 && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                      adminTab === 'blocks' ? 'bg-indigo-700 text-white' : 'bg-slate-800 text-rose-400'
                    }`}>
                      {adminBlockedDomains.length}
                    </span>
                  )}
                </button>

</>
)}
                {canAdmin && (
  <>
{/* メディアストレージ */}
                <button
                  type="button"
                  onClick={() => setAdminTab('storage')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'storage'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Cloud className="w-4 h-4" />
                    <span>ファイル / ストレージ</span>
                  </div>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                    adminStorageConfig?.configured ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'
                  }`}>
                    {adminStorageConfig?.configured ? 'R2' : 'Local'}
                  </span>
                </button>

</>
)}
                {canAdmin && (
  <>
{/* ⚙️ サーバー設定 */}
                <button
                  type="button"
                  onClick={() => setAdminTab('settings')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'settings'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Settings className="w-4 h-4" />
                    <span>サーバー設定</span>
                  </div>
                </button>

</>
)}
                {canAdmin && (
  <>
{/* 🎨 カスタム絵文字 */}
                <button
                  type="button"
                  onClick={() => setAdminTab('emojis')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'emojis'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Smile className="w-4 h-4 text-yellow-400" />
                    <span>絵文字管理</span>
                  </div>
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-slate-850 text-slate-400">
                    {adminEmojis.length}
                  </span>
                </button>

</>
)}
                {canAdmin && (
  <>
{/* 🎟 招待コード */}
                <button
                  type="button"
                  onClick={() => setAdminTab('invites')}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'invites'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Ticket className="w-4 h-4 text-cyan-400" />
                    <span>招待コード</span>
                  </div>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                    serverStats?.registration_mode === 'invite' ? 'bg-amber-500/20 text-amber-300' : serverStats?.registration_mode === 'closed' ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-400'
                  }`}>
                    {serverStats?.registration_mode === 'invite' ? '招待制' : serverStats?.registration_mode === 'closed' ? '停止中' : '公開'}
                  </span>
                </button>

</>
)}
                <button
                  type="button"
                  onClick={() => { setAdminTab('reports'); fetchReports(reportStatusFilter); }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'reports'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <ShieldAlert className="w-4 h-4 text-rose-400" />
                    <span>通報</span>
                  </div>
                  {adminReportCounts.open > 0 && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                      adminTab === 'reports' ? 'bg-rose-600 text-white' : 'bg-rose-500/20 text-rose-300'
                    }`}>
                      {adminReportCounts.open}
                    </span>
                  )}
                </button>

                {canAdmin && (
<>
<button
                  type="button"
                  onClick={() => { setAdminTab('announcements'); fetchAdminAnnouncements(); }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'announcements'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Megaphone className="w-4 h-4 text-amber-400" />
                    <span>お知らせ</span>
                  </div>
                  {adminAnnouncements.filter((a: any) => a.is_active === 1).length > 0 && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                      adminTab === 'announcements' ? 'bg-indigo-700 text-white' : 'bg-slate-800 text-amber-400'
                    }`}>
                      {adminAnnouncements.filter((a: any) => a.is_active === 1).length}
                    </span>
                  )}
                </button>
</>
)}

                {canAdmin && (
<>
<button
                  type="button"
                  onClick={() => { setAdminTab('roles'); fetchRoles(); }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'roles'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <UserPlus className="w-4 h-4 text-violet-400" />
                    <span>ロール</span>
                  </div>
                  {adminRoles.length > 0 && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                      adminTab === 'roles' ? 'bg-indigo-700 text-white' : 'bg-slate-800 text-violet-300'
                    }`}>
                      {adminRoles.length}
                    </span>
                  )}
                </button>
</>
)}

                {canAdmin && (
<>
<button
                  type="button"
                  onClick={() => { setAdminTab('mail'); fetchMailSettings(); }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'mail'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Mail className="w-4 h-4 text-sky-400" />
                    <span>メール・認証</span>
                  </div>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                    mailSettings.configured ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'
                  }`}>
                    {mailSettings.configured ? '設定済' : '未設定'}
                  </span>
                </button>
</>
)}

                {canAdmin && (
<>
<button
                  type="button"
                  onClick={() => { setAdminTab('delivery'); setDeliveryQueueMsg(null); fetchDeliveryQueue(); }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                    adminTab === 'delivery'
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <Send className="w-4 h-4 text-emerald-400" />
                    <span>配送キュー</span>
                  </div>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                    (deliveryQueue.stats?.pending || 0) > 0
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'bg-slate-800 text-slate-400'
                  }`}>
                    {deliveryQueue.stats?.pending || 0}
                  </span>
                </button>
</>
)}

                {canAdmin && (
<>
<button
                type="button"
                onClick={() => { setAdminTab('audit'); fetchAuditLog({ before: null }); }}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-2xl text-xs font-bold transition cursor-pointer ${
                  adminTab === 'audit'
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center space-x-2.5">
                  <ClipboardList className="w-4 h-4 text-amber-400" />
                  <span>監査ログ</span>
                </div>
              </button>
</>
)}
              </div>

              {/* クイック操作 */}
              <div className="pt-3 border-t border-slate-800/80 space-y-1">
                <span className="text-[10px] font-bold text-slate-500 px-3 uppercase tracking-wider block mb-1">
                  システム
                </span>
                {canAdmin && (
                <button
                  type="button"
                  onClick={handleAdminClearCache}
                  className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition cursor-pointer"
                  title="外部アクター情報や受信投稿のキャッシュを消去します"
                >
                  <Database className="w-4 h-4 text-slate-400" />
                  <span>キャッシュ消去</span>
                </button>
                )}
                <button
                  type="button"
                  onClick={() => navigateToView('timeline')}
                  className="w-full flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4 text-slate-400" />
                  <span>タイムラインへ戻る</span>
                </button>
              </div>
            </aside>

            {/* 💻 右メインコンテンツエリア */}
            <div className="flex-1 w-full min-w-0 space-y-6">
              {/* 📊 1. ダッシュボードタブ */}
              {adminTab === 'dashboard' && (
                <div className="space-y-6 animate-in fade-in duration-150">
                  {/* 統計カード群 (Misskey Stats互換) */}
                  {adminStats && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-lg">
                        <span className="text-xs text-slate-400 block mb-1 font-medium">登録ユーザー数</span>
                        <span className="text-3xl font-black text-slate-100">{adminStats.stats.users}</span>
                        <span className="text-[11px] text-indigo-400 block mt-1 font-mono">
                          管理者: {adminStats.stats.admins} 名
                        </span>
                      </div>
                      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-lg">
                        <span className="text-xs text-slate-400 block mb-1 font-medium">ローカル投稿数</span>
                        <span className="text-3xl font-black text-indigo-400">{adminStats.stats.localPosts}</span>
                        <span className="text-[11px] text-slate-500 block mt-1">自サーバーのノート</span>
                      </div>
                      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-lg">
                        <span className="text-xs text-slate-400 block mb-1 font-medium">連合受信投稿数</span>
                        <span className="text-3xl font-black text-emerald-400">{adminStats.stats.federatedPosts}</span>
                        <span className="text-[11px] text-slate-500 block mt-1">Fediverse からのノート</span>
                      </div>
                      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-lg">
                        <span className="text-xs text-slate-400 block mb-1 font-medium">連携外部ドメイン</span>
                        <span className="text-3xl font-black text-cyan-400">{adminStats.stats.federatedDomains}</span>
                        <span className="text-[11px] text-slate-500 block mt-1">Mastodon / Misskey等</span>
                      </div>
                    </div>
                  )}

                  {/* サーバー概要 & モデレーター一覧 */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* サーバー基本情報 */}
                    {/* 🧹 容量とメンテナンス */}
                    {maintenanceStats && (
                      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-lg space-y-4">
                        <div className="flex items-center justify-between">
                          <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                            <HardDrive className="w-4 h-4 text-emerald-400" />
                            <span>容量とメンテナンス</span>
                          </h3>
                          <button
                            type="button"
                            onClick={handleRunMaintenance}
                            disabled={isRunningMaintenance}
                            className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[11px] font-bold transition cursor-pointer flex items-center space-x-1.5"
                          >
                            <RefreshCw className={`w-3 h-3 ${isRunningMaintenance ? 'animate-spin' : ''}`} />
                            <span>{isRunningMaintenance ? '実行中...' : 'いますぐ整理を実行'}</span>
                          </button>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                          <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                            <div className="text-[10px] text-slate-500">DB サイズ</div>
                            <div className="font-bold text-slate-100">{(maintenanceStats.db.sizeBytes / 1024 / 1024).toFixed(1)} MB</div>
                            <div className="text-[10px] text-slate-500">WAL {(maintenanceStats.db.walBytes / 1024 / 1024).toFixed(1)} MB</div>
                          </div>
                          <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                            <div className="text-[10px] text-slate-500">投稿</div>
                            <div className="font-bold text-slate-100">{maintenanceStats.posts.total.toLocaleString()} 件</div>
                            <div className="text-[10px] text-slate-500">
                              ローカル {maintenanceStats.posts.local} / リモート {maintenanceStats.posts.remote.toLocaleString()}
                            </div>
                          </div>
                          <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                            <div className="text-[10px] text-slate-500">検索索引</div>
                            <div className="font-bold text-slate-100">{maintenanceStats.posts.ftsRows.toLocaleString()} 行</div>
                            <div className="text-[10px] text-slate-500">範囲: {maintenanceStats.policy.ftsIndexScope}</div>
                          </div>
                          <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                            <div className="text-[10px] text-slate-500">ドライブ</div>
                            <div className="font-bold text-slate-100">
                              {(maintenanceStats.media.bytes / 1024 / 1024).toFixed(1)} MB
                              {maintenanceStats.media.quotaBytes > 0 && (
                                <span className="text-slate-500 font-normal"> / {(maintenanceStats.media.quotaBytes / 1024 / 1024).toFixed(0)} MB</span>
                              )}
                            </div>
                            <div className="text-[10px] text-slate-500">{maintenanceStats.media.count} ファイル</div>
                          </div>
                        </div>

                        <div className="text-[11px] text-slate-400 space-y-1">
                          <p>
                            保持期間（{maintenanceStats.policy.retentionDays} 日）を超えたリモート投稿:{' '}
                            <strong className="text-slate-200">{maintenanceStats.posts.prunableRemote.toLocaleString()}</strong> 件
                            {maintenanceStats.posts.prunableRemote > 0 && <span className="text-slate-500">（次回の自動整理で削除されます）</span>}
                          </p>
                          <p>
                            リモートのブースト: <strong className="text-slate-200">{maintenanceStats.announces.toLocaleString()}</strong> 件
                            <span className="text-slate-500">（保存方針: {maintenanceStats.policy.remoteAnnouncePolicy}）</span>
                          </p>
                        </div>

                        {/* 🖼️ 画像プロキシ（リモート画像の直リンク解消） */}
                        {maintenanceStats.imageProxy && (
                          <div className="bg-slate-950/60 border border-slate-800/80 rounded-2xl p-3 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <label className="flex items-center space-x-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={maintenanceStats.imageProxy.enabled}
                                  onChange={(e) => handleSaveMaintenanceSettings({ imageProxy: e.target.checked })}
                                  className="w-4 h-4 accent-indigo-500 cursor-pointer"
                                />
                                <span className="text-[11px] font-semibold text-slate-300">🖼️ 画像プロキシ（リモート画像をこのノード経由で配信）</span>
                              </label>
                              <button
                                type="button"
                                disabled={isClearingProxyCache}
                                onClick={handleClearProxyCache}
                                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 rounded-lg text-[11px] font-semibold transition whitespace-nowrap"
                              >
                                {isClearingProxyCache ? '削除中...' : 'キャッシュを整理'}
                              </button>
                            </div>
                            <div className="text-[10px] text-slate-500 leading-relaxed">
                              キャッシュ: <span className="text-slate-300 font-semibold">{maintenanceStats.imageProxy.files.toLocaleString()}</span> 件 /{' '}
                              <span className="text-slate-300 font-semibold">{(maintenanceStats.imageProxy.bytes / 1024 / 1024).toFixed(1)} MB</span>
                              （上限 {(maintenanceStats.imageProxy.maxBytes / 1024 / 1024).toFixed(0)} MB・{maintenanceStats.imageProxy.ttlDays} 日で期限切れ）
                              <br />
                              有効にすると、リモートのアイコンや添付画像を相手サーバーから直接読まず、このノードが取得して配信します（閲覧者の IP や User-Agent が相手に渡りません）。毎日の自動整理で期限切れ分を削除します。
                            </div>
                          </div>
                        )}

                        <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-slate-800/60 text-[11px]">
                          <label className="flex items-center space-x-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={maintenanceStats.automation.enabled}
                              onChange={(e) => handleSaveMaintenanceSettings({ autoMaintenance: e.target.checked })}
                              className="w-4 h-4 accent-emerald-500 cursor-pointer"
                            />
                            <span className="text-slate-300">毎日 {String(maintenanceStats.automation.hour).padStart(2, '0')}:00 に自動整理</span>
                          </label>
                          <label className="flex items-center space-x-1.5 text-slate-400">
                            <span>実行時刻</span>
                            <select
                              value={maintenanceStats.automation.hour}
                              onChange={(e) => handleSaveMaintenanceSettings({ hour: parseInt(e.target.value, 10) })}
                              className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-[11px] text-slate-200 focus:outline-none"
                            >
                              {Array.from({ length: 24 }, (_, h) => (
                                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                              ))}
                            </select>
                          </label>
                          <span className="text-slate-500">
                            バックアップ {maintenanceStats.automation.backupEnabled ? '有効' : '無効'}（{maintenanceStats.backups.count} 世代
                            {maintenanceStats.backups.latestAt && <span> / 最新 {new Date(maintenanceStats.backups.latestAt).toLocaleString('ja-JP')}</span>}）
                          </span>
                          {maintenanceStats.automation.lastRunAt && (
                            <span className="text-slate-500">前回: {new Date(maintenanceStats.automation.lastRunAt).toLocaleString('ja-JP')}</span>
                          )}
                        </div>

                        {maintenanceMsg && (
                          <div className="p-2.5 rounded-xl text-[11px] bg-emerald-500/10 border border-emerald-500/30 text-emerald-200">{maintenanceMsg}</div>
                        )}

                        <p className="text-[10px] text-slate-500 leading-relaxed">
                          ※ 自動整理は「バックアップ → 保持期間を超えたリモート投稿の削除」までを行います。空いた領域を実際に解放するには、サーバーを停止して
                          <code className="mx-1 px-1.5 py-0.5 rounded bg-slate-950 border border-slate-800 font-mono">npm run db:maintenance -- --apply</code>
                          を実行してください（FTS のマージと VACUUM）。
                        </p>
                      </div>
                    )}

                    <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-lg space-y-3">
                      <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                        <Server className="w-4 h-4 text-indigo-400" />
                        <span>サーバー基本情報</span>
                      </h3>
                      <div className="divide-y divide-slate-800/60 text-xs">
                        <div className="py-2.5 flex justify-between items-center">
                          <span className="text-slate-400">ノードドメイン</span>
                          <span className="font-mono font-bold text-slate-200">{serverStats?.domain || window.location.host}</span>
                        </div>
                        <div className="py-2.5 flex justify-between items-center">
                          <span className="text-slate-400">ソフトウェア</span>
                          <span className="font-bold text-indigo-300">Spica SNS (ActivityPub Engine)</span>
                        </div>
                        <div className="py-2.5 flex justify-between items-center">
                          <span className="text-slate-400">メディアストレージ</span>
                          <span className={`font-bold px-2 py-0.5 rounded-full text-[10px] ${
                            adminStorageConfig?.configured
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-slate-800 text-slate-400'
                          }`}>
                            {adminStorageConfig?.configured ? 'Cloudflare R2 (S3互換)' : 'サーバーローカル (/uploads)'}
                          </span>
                        </div>
                        <div className="py-2.5 flex justify-between items-center">
                          <span className="text-slate-400">接続中リレー</span>
                          <span className="font-mono font-bold text-purple-300">{adminRelays.length} サーバー</span>
                        </div>
                      </div>
                    </div>

                    {/* モデレーター (管理者一覧) */}
                    <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-lg space-y-3">
                      <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                        <ShieldCheck className="w-4 h-4 text-emerald-400" />
                        <span>モデレーター / 管理者 ({adminUsers.filter((u: any) => u.role === 'admin').length})</span>
                      </h3>
                      <div className="space-y-2">
                        {adminUsers
                          .filter((u: any) => u.role === 'admin')
                          .map((u: any) => (
                            <div
                              key={u.id}
                              className="flex items-center justify-between p-2.5 rounded-2xl bg-slate-950/60 border border-slate-800/80"
                            >
                              <div className="flex items-center space-x-3">
                                <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center font-bold text-xs text-white shrink-0">
                                  {u.name ? u.name.slice(0, 1).toUpperCase() : 'A'}
                                </div>
                                <div>
                                  <span className="font-bold text-xs text-slate-100 block">{u.name}</span>
                                  <span className="font-mono text-[11px] text-indigo-400">@{u.id}</span>
                                </div>
                              </div>
                              <span className="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 font-bold text-[10px] border border-purple-500/30">
                                ADMIN
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 👥 2. ユーザー管理タブ */}
              {adminTab === 'users' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-4 animate-in fade-in duration-150">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                        <Users className="w-4 h-4 text-indigo-400" />
                        <span>ユーザー管理 ({adminUsers.length})</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        アカウントの権限変更、凍結・解除、活動状況の確認
                      </p>
                    </div>

                    <div className="w-full sm:w-64">
                      <input
                        type="text"
                        placeholder="ユーザー名やIDで絞り込み..."
                        value={adminUserSearch}
                        onChange={(e) => setAdminUserSearch(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 transition"
                      />
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400">
                          <th className="pb-3 font-semibold">ユーザー</th>
                          <th className="pb-3 font-semibold">ロール</th>
                          <th className="pb-3 font-semibold">投稿数</th>
                          <th className="pb-3 font-semibold">フォロワー</th>
                          <th className="pb-3 font-semibold">登録日時</th>
                          <th className="pb-3 font-semibold text-right">アクション</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {adminUsers
                          .filter((u: any) => {
                            if (!adminUserSearch.trim()) return true;
                            const q = adminUserSearch.toLowerCase();
                            return (
                              (u.name && u.name.toLowerCase().includes(q)) ||
                              (u.id && u.id.toLowerCase().includes(q))
                            );
                          })
                          .map((u: any) => (
                            <tr key={u.id} className="hover:bg-slate-800/30 transition">
                              <td className="py-3">
                                <div className="font-bold text-slate-200">{u.name}</div>
                                <div className="font-mono text-[11px] text-indigo-400">@{u.id}</div>
                              </td>
                              <td className="py-3">
                                {u.role === 'admin' ? (
                                  <span className="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 font-bold text-[10px] border border-purple-500/30">
                                    ADMIN
                                  </span>
                                ) : (
                                  <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-medium text-[10px]">
                                    USER
                                  </span>
                                )}
                              </td>
                              <td className="py-3 font-mono text-slate-300">{u.postCount ?? 0}</td>
                              <td className="py-3 font-mono text-slate-300">{u.followerCount ?? 0}</td>
                              <td className="py-3 text-slate-400 whitespace-nowrap">
                                {new Date(u.created_at).toLocaleDateString('ja-JP')}
                              </td>
                              <td className="py-3 text-right space-x-1.5 whitespace-nowrap">
                                {u.id !== authUser?.id && (
                                  <>
                                    <button
                                      onClick={() =>
                                        handleAdminChangeRole(u.id, u.role)
                                      }
                                      className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs transition"
                                      title={u.role === 'admin' ? '一般ユーザーに降格' : '管理者に昇格'}
                                    >
                                      {u.role === 'admin' ? '一般へ降格' : '管理者へ'}
                                    </button>
                                    <button
                                      onClick={() => handleAdminToggleFreeze(u.id, Boolean(u.is_frozen))}
                                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition ${
                                        u.is_frozen
                                          ? 'bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 border border-emerald-500/30'
                                          : 'bg-rose-600/20 text-rose-300 hover:bg-rose-600/30 border border-rose-500/30'
                                      }`}
                                    >
                                      {u.is_frozen ? '凍結解除' : '凍結'}
                                    </button>
                                    <button
                                      onClick={() => setAdminDeleteTargetUser(u)}
                                      className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-rose-950/60 hover:bg-rose-900/80 text-rose-300 border border-rose-800/60 transition cursor-pointer inline-flex items-center space-x-1"
                                      title="アカウントを完全に削除"
                                    >
                                      <Trash2 className="w-3 h-3 text-rose-400" />
                                      <span>削除</span>
                                    </button>
                                  </>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 🌐 3. 連合・リレータブ */}
              {adminTab === 'federation' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div>
                    <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                      <Radio className="w-4 h-4 text-purple-400" />
                      <span>ActivityPub リレーサーバー管理 (PubSub Relay)</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                      Misskey や Mastodon のリレーサーバーに接続すると、連合タイムラインに世界中のパブリック投稿がリアルタイムに流れるようになります。また、自サーバーの投稿もリレーを通じて世界中へ拡散されます。
                    </p>
                  </div>

                  {/* リレー追加フォーム */}
                  <form onSubmit={handleConnectRelay} className="space-y-3 bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80">
                    <label className="block text-xs font-semibold text-slate-300">
                      リレーサーバー URL (Actor または Inbox URL)
                    </label>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="url"
                        required
                        placeholder="https://relay.example.com/actor または /inbox"
                        value={relayInputUrl}
                        onChange={(e) => setRelayInputUrl(e.target.value)}
                        className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-purple-500 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={!relayInputUrl.trim() || isConnectingRelay}
                        className="px-5 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition whitespace-nowrap flex items-center justify-center space-x-1"
                      >
                        <Radio className="w-3.5 h-3.5" />
                        <span>{isConnectingRelay ? '接続中...' : 'リレーに接続 (Follow)'}</span>
                      </button>
                    </div>

                    {relayMessage && (
                      <div
                        className={`p-2.5 rounded-xl text-xs flex items-center space-x-2 ${
                          relayMessage.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}
                      >
                        {relayMessage.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                        <span>{relayMessage.text}</span>
                      </div>
                    )}
                  </form>

                  {/* 接続中リレー一覧 */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-slate-400">登録済みリレー ({adminRelays.length})</h4>
                      {adminRelays.length > 0 && (
                        <button
                          type="button"
                          onClick={() => handleAdminResendRelay()}
                          className="px-2.5 py-1 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-[11px] font-bold transition flex items-center space-x-1"
                          title="登録されているすべてのリレーに購読(Follow)リクエストを一括再送します"
                        >
                          <span>🔄 全リレー一括再送</span>
                        </button>
                      )}
                    </div>
                    {adminRelays.length === 0 ? (
                      <div className="text-center py-6 bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                        登録されているリレーサーバーはありません。
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {adminRelays.map((r: any) => (
                          <div
                            key={r.inbox_url}
                            className="bg-slate-950/80 border border-slate-800 p-3.5 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-slate-200 font-bold truncate">{r.inbox_url}</span>
                                {r.status === 'accepted' ? (
                                  <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-bold text-[10px] border border-emerald-500/30 flex items-center space-x-1">
                                    <Check className="w-3 h-3" />
                                    <span>接続中 (ACCEPTED)</span>
                                  </span>
                                ) : (
                                  <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-bold text-[10px] border border-amber-500/30">
                                    承認待ち (PENDING)
                                  </span>
                                )}
                              </div>
                              <span className="text-[11px] text-slate-500 block mt-0.5">登録: {new Date(r.created_at).toLocaleString('ja-JP')}</span>
                            </div>
                            <div className="flex items-center space-x-2 shrink-0">
                              <button
                                onClick={() => handleAdminResendRelay(r.inbox_url)}
                                className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                                title="このリレーに Follow Activity を再送します"
                              >
                                再送
                              </button>
                              <button
                                onClick={() => handleAdminToggleRelayStatus(r.inbox_url, r.status)}
                                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition ${
                                  r.status === 'accepted'
                                    ? 'bg-amber-500/15 border-amber-500/30 text-amber-300 hover:bg-amber-500/30'
                                    : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/30'
                                }`}
                                title="承認ステータスを手動で切り替えます"
                              >
                                {r.status === 'accepted' ? '承認待ちに戻す' : '承認済みにする'}
                              </button>
                              <button
                                onClick={() => handleDisconnectRelay(r.inbox_url)}
                                className="px-3 py-1.5 rounded-lg bg-rose-600/20 text-rose-300 hover:bg-rose-600/40 text-[11px] font-medium transition"
                              >
                                購読解除
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 連携先リモートサーバー一覧 */}
                  <div className="space-y-3 pt-4 border-t border-slate-800">
                    <div>
                      <h4 className="text-xs font-semibold text-slate-300 flex items-center space-x-2">
                        <Globe className="w-3.5 h-3.5 text-cyan-400" />
                        <span>連携先リモートサーバー ({adminFederation?.domainStats?.length || 0})</span>
                      </h4>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        これまでに投稿を受信またはフォローを行った外部インスタンスです。ワンクリックで通信遮断（ブロック）が可能です。
                      </p>
                    </div>

                    {(!adminFederation?.domainStats || adminFederation.domainStats.length === 0) ? (
                      <div className="text-center py-6 bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                        連携中の外部サーバー情報はまだありません。
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {adminFederation.domainStats.map((stat: any) => (
                          <div
                            key={stat.domain}
                            className="bg-slate-950/80 border border-slate-800/80 p-3 rounded-2xl flex items-center justify-between text-xs hover:border-slate-700 transition"
                          >
                            <div className="min-w-0 pr-2">
                              <span className="font-mono font-bold text-slate-200 truncate block">
                                {stat.domain}
                              </span>
                              <span className="text-[10px] text-slate-500">
                                登録アカウント: {stat.actor_count} 件
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleQuickBlockDomain(stat.domain)}
                              className="px-2.5 py-1 bg-rose-600/10 hover:bg-rose-600/20 text-rose-300 border border-rose-500/20 rounded-lg text-[11px] font-semibold transition shrink-0 flex items-center space-x-1"
                              title="このサーバーをブロックして通信を遮断・キャッシュを削除します"
                            >
                              <ShieldAlert className="w-3 h-3" />
                              <span>ブロック</span>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 🚫 4. サーバーブロックタブ */}
              {adminTab === 'blocks' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div>
                    <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                      <ShieldAlert className="w-4 h-4 text-rose-400" />
                      <span>サーバー（ドメイン）ブロック管理 ({adminBlockedDomains.length})</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                      <span className="text-rose-300 font-semibold">🚫 ブロック（suspend）</span>: 通信（Inbox）を 403 で遮断し、配送・WebFinger も停止、該当サーバーの過去のキャッシュ投稿・アクター情報も自動消去します。
                      <br />
                      <span className="text-amber-300 font-semibold">🔇 サイレンス（silence）</span>: 通信とフォロー関係は維持したまま、そのサーバーの投稿をホーム・ローカル・検索・通知から隠します。データは消しません（後から戻せます）。
                    </p>
                  </div>

                  {/* 手動ブロック追加フォーム */}
                  <form onSubmit={handleManualBlockDomain} className="space-y-3 bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-1">
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          対象ドメイン名 <span className="text-rose-400">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          placeholder="spam.example.com"
                          value={blockInputDomain}
                          onChange={(e) => setBlockInputDomain(e.target.value)}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-rose-500 focus:outline-none"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          理由（管理者メモ・任意）
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            placeholder="スパム送信サーバーのため、荒らし対策など"
                            value={blockInputReason}
                            onChange={(e) => setBlockInputReason(e.target.value)}
                            className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-rose-500 focus:outline-none"
                          />
                          <button
                            type="submit"
                            disabled={!blockInputDomain.trim() || isBlockingDomain}
                            className={`px-4 py-2 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition whitespace-nowrap flex items-center space-x-1 shrink-0 ${
                              blockInputSeverity === 'silence'
                                ? 'bg-amber-600 hover:bg-amber-500'
                                : 'bg-rose-600 hover:bg-rose-500'
                            }`}
                          >
                            {blockInputSeverity === 'silence' ? <EyeOff className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
                            <span>{isBlockingDomain ? '処理中...' : blockInputSeverity === 'silence' ? 'サイレンスにする' : 'ブロック実行'}</span>
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* 強度の選択 */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <label
                        className={`flex items-start space-x-2 p-3 rounded-xl border cursor-pointer transition ${
                          blockInputSeverity === 'suspend'
                            ? 'bg-rose-500/10 border-rose-500/40'
                            : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <input
                          type="radio"
                          name="blockSeverity"
                          className="mt-0.5 accent-rose-500"
                          checked={blockInputSeverity === 'suspend'}
                          onChange={() => setBlockInputSeverity('suspend')}
                        />
                        <span className="text-xs">
                          <span className="font-bold text-rose-300">🚫 ブロック（既定）</span>
                          <span className="block text-slate-400 mt-0.5 leading-relaxed">
                            通信を遮断し、そのサーバーの投稿・アクター情報を削除します。荒らし・スパム向け。
                          </span>
                        </span>
                      </label>
                      <label
                        className={`flex items-start space-x-2 p-3 rounded-xl border cursor-pointer transition ${
                          blockInputSeverity === 'silence'
                            ? 'bg-amber-500/10 border-amber-500/40'
                            : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <input
                          type="radio"
                          name="blockSeverity"
                          className="mt-0.5 accent-amber-500"
                          checked={blockInputSeverity === 'silence'}
                          onChange={() => setBlockInputSeverity('silence')}
                        />
                        <span className="text-xs">
                          <span className="font-bold text-amber-300">🔇 サイレンス</span>
                          <span className="block text-slate-400 mt-0.5 leading-relaxed">
                            表示から隠すだけで、通信・フォロー・投稿データは維持します。様子見や一時的な措置向け。
                          </span>
                        </span>
                      </label>
                    </div>

                    {blockMessage && (
                      <div
                        className={`p-2.5 rounded-xl text-xs flex items-center space-x-2 ${
                          blockMessage.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}
                      >
                        {blockMessage.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                        <span>{blockMessage.text}</span>
                      </div>
                    )}
                  </form>

                  {/* ブロック中ドメイン一覧 */}
                  {adminBlockedDomains.length === 0 ? (
                    <div className="text-center py-6 bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                      現在ブロックされているサーバーはありません。
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-400">
                            <th className="pb-3 font-semibold">対象ドメイン</th>
                            <th className="pb-3 font-semibold">強度</th>
                            <th className="pb-3 font-semibold">理由</th>
                            <th className="pb-3 font-semibold">登録日</th>
                            <th className="pb-3 font-semibold">登録者</th>
                            <th className="pb-3 font-semibold text-right">操作</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60">
                          {adminBlockedDomains.map((b: any) => (
                            <tr key={b.domain} className="hover:bg-slate-800/20 transition">
                              <td className="py-3 font-mono font-bold text-rose-300">
                                {b.severity === 'silence' ? '🔇' : '🚫'} {b.domain}
                              </td>
                              <td className="py-3 whitespace-nowrap">
                                {b.severity === 'silence' ? (
                                  <span
                                    className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] font-bold"
                                    title="通信は維持し、表示から隠すだけ（データは削除していません）"
                                  >
                                    サイレンス
                                  </span>
                                ) : (
                                  <span
                                    className="px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[10px] font-bold"
                                    title="通信を遮断し、キャッシュも削除済み"
                                  >
                                    ブロック
                                  </span>
                                )}
                              </td>
                              <td className="py-3 text-slate-300 max-w-xs truncate">
                                {b.reason || <span className="text-slate-500 italic">(理由記載なし)</span>}
                              </td>
                              <td className="py-3 text-slate-400 whitespace-nowrap">
                                {new Date(b.created_at).toLocaleString('ja-JP')}
                              </td>
                              <td className="py-3 text-slate-400 font-mono">
                                @{b.created_by}
                              </td>
                              <td className="py-3 text-right whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => handleUnblockDomain(b.domain)}
                                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold transition"
                                >
                                  {b.severity === 'silence' ? 'サイレンス解除' : 'ブロック解除'}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* ☁️ 5. メディアストレージタブ */}
              {adminTab === 'storage' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                      <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                        <Cloud className="w-4 h-4 text-cyan-400" />
                        <span>メディアストレージ設定 (Cloudflare R2 / S3互換)</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                        Cloudflare R2 などの S3 互換オブジェクトストレージを接続すると、投稿画像を大容量・高速に配信できます。
                        未設定の場合はサーバーローカル（<code className="text-indigo-300 font-mono">data/uploads</code>）へ自動保存されます。
                      </p>
                    </div>
                    <div className="shrink-0">
                      {adminStorageConfig?.configured ? (
                        <span className="px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-bold flex items-center space-x-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          <span>S3 / R2 有効</span>
                        </span>
                      ) : (
                        <span className="px-3 py-1 rounded-full bg-slate-800 text-slate-400 border border-slate-700 text-xs font-bold flex items-center space-x-1.5">
                          <Server className="w-3.5 h-3.5 text-slate-400" />
                          <span>ローカル保存中</span>
                        </span>
                      )}
                    </div>
                  </div>

                  <form onSubmit={handleSaveStorage} className="space-y-4 bg-slate-950/60 p-5 rounded-2xl border border-slate-800/80">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          エンドポイント URL (Endpoint)
                        </label>
                        <input
                          type="url"
                          placeholder="https://<account-id>.r2.cloudflarestorage.com"
                          value={storageForm.endpoint}
                          onChange={(e) => setStorageForm((prev: any) => ({ ...prev, endpoint: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                        />
                        <span className="text-[10px] text-slate-500 mt-0.5 block">
                          Cloudflare R2 の「S3 API エンドポイント」を入力
                        </span>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          バケット名 (Bucket)
                        </label>
                        <input
                          type="text"
                          placeholder="spica-media"
                          value={storageForm.bucket}
                          onChange={(e) => setStorageForm((prev: any) => ({ ...prev, bucket: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                        />
                        <span className="text-[10px] text-slate-500 mt-0.5 block">
                          作成した R2 または S3 バケットの名称
                        </span>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          公開 URL (Public Access URL)
                        </label>
                        <input
                          type="url"
                          placeholder="https://pub-xxxx.r2.dev または https://media.example.com"
                          value={storageForm.publicUrl}
                          onChange={(e) => setStorageForm((prev: any) => ({ ...prev, publicUrl: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                        />
                        <span className="text-[10px] text-slate-500 mt-0.5 block">
                          R2 のパブリックアクセス URL またはバインドしたカスタムドメイン
                        </span>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          リージョン (Region)
                        </label>
                        <input
                          type="text"
                          placeholder="auto"
                          value={storageForm.region}
                          onChange={(e) => setStorageForm((prev: any) => ({ ...prev, region: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                        />
                        <span className="text-[10px] text-slate-500 mt-0.5 block">
                          Cloudflare R2 の場合は通常 <code className="text-slate-400">auto</code>
                        </span>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          Access Key ID
                        </label>
                        <input
                          type="text"
                          placeholder="API トークンの Access Key ID"
                          value={storageForm.accessKeyId}
                          onChange={(e) => setStorageForm((prev: any) => ({ ...prev, accessKeyId: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          Secret Access Key
                        </label>
                        <input
                          type="password"
                          placeholder={adminStorageConfig?.hasSecretAccessKey ? '******** (変更する場合のみ入力)' : 'API トークンの Secret Access Key'}
                          value={storageForm.secretAccessKey}
                          onChange={(e) => setStorageForm((prev: any) => ({ ...prev, secretAccessKey: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                        />
                      </div>
                    </div>

                    {storageMessage && (
                      <div
                        className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                          storageMessage.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}
                      >
                        {storageMessage.type === 'success' ? (
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 shrink-0" />
                        )}
                        <span>{storageMessage.text}</span>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-slate-800/80">
                      <button
                        type="button"
                        onClick={handleTestStorage}
                        disabled={isTestingStorage || isSavingStorage}
                        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 text-xs font-bold rounded-xl transition flex items-center space-x-1.5 cursor-pointer"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isTestingStorage ? 'animate-spin' : ''}`} />
                        <span>{isTestingStorage ? 'テスト接続中...' : '接続テスト'}</span>
                      </button>
                      <button
                        type="submit"
                        disabled={isSavingStorage || isTestingStorage}
                        className="px-5 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition flex items-center space-x-1.5 cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>{isSavingStorage ? '保存中...' : 'ストレージ設定を保存'}</span>
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {/* ⚙️ サーバー基本設定タブ */}
              {adminTab === 'settings' && (
                <div className="space-y-6">
                  {/* ヘッダーカード */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-2">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-2xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                        <Settings className="w-5 h-5" />
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-slate-100">サーバー基本設定</h2>
                        <p className="text-xs text-slate-400">
                          サーバーの正式名称や紹介文、ヘッダーに表示されるアイコン・ロゴ画像を自由にカスタマイズできます。
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* フォームカード */}
                  <form onSubmit={handleSaveServerSettings} className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-6">
                    {/* アイコン設定 */}
                    <div>
                      <label className="block text-xs font-bold text-slate-300 mb-2">
                        サーバーアイコン / ロゴ
                      </label>
                      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                        <div className="w-20 h-20 rounded-3xl bg-slate-950 border-2 border-slate-700/80 flex items-center justify-center overflow-hidden shadow-lg shrink-0">
                          <img
                            src={adminServerIcon || serverStats?.icon_url || '/logo.jpg'}
                            alt="Preview"
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              (e.currentTarget as HTMLElement).style.display = 'none';
                            }}
                          />
                        </div>
                        <div className="flex-1 space-y-2">
                          <div className="flex flex-wrap gap-2">
                            <label className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition flex items-center space-x-1.5 cursor-pointer shadow-md">
                              {isUploadingServerIcon ? (
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Upload className="w-3.5 h-3.5" />
                              )}
                              <span>{isUploadingServerIcon ? 'アップロード中...' : '画像を選択してアップロード'}</span>
                              <input
                                type="file"
                                accept="image/*"
                                disabled={isUploadingServerIcon}
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) handleUploadServerIcon(file);
                                  e.target.value = '';
                                }}
                                className="hidden"
                              />
                            </label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <span className="text-[11px] text-slate-500 shrink-0">または直接URLを指定:</span>
                            <input
                              type="text"
                              placeholder="https://example.com/logo.png"
                              value={adminServerIcon}
                              onChange={(e) => setAdminServerIcon(e.target.value)}
                              className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                            />
                          </div>
                          <p className="text-[11px] text-slate-500">
                            ※ 正方形の画像（PNG, JPEG, WebP）を推奨します。最大10MB。
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* サーバーバナー設定 */}
                    <div className="pt-4 border-t border-slate-800/80">
                      <label className="block text-xs font-bold text-slate-300 mb-2">
                        サーバーバナー画像 (Instance Banner)
                      </label>
                      <div className="space-y-3">
                        <div className="w-full h-36 sm:h-44 rounded-2xl bg-slate-950 border-2 border-slate-700/80 overflow-hidden relative shadow-lg flex items-center justify-center">
                          {adminServerBanner || serverStats?.banner_url ? (
                            <img
                              src={adminServerBanner || serverStats?.banner_url}
                              alt="Banner Preview"
                              className="w-full h-full object-cover"
                              onError={(e) => {
                                (e.currentTarget as HTMLElement).style.display = 'none';
                              }}
                            />
                          ) : (
                            <div className="flex flex-col items-center justify-center text-slate-500 space-y-1 p-4 text-center">
                              <ImageIcon className="w-8 h-8 opacity-40" />
                              <span className="text-xs">バナー画像が未設定です（デフォルトのグラデーション背景が使用されます）</span>
                            </div>
                          )}
                        </div>

                        <div className="space-y-2">
                          <div className="flex flex-wrap gap-2">
                            <label className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition flex items-center space-x-1.5 cursor-pointer shadow-md">
                              {isUploadingServerBanner ? (
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Upload className="w-3.5 h-3.5" />
                              )}
                              <span>{isUploadingServerBanner ? 'アップロード中...' : 'バナー画像を選択してアップロード'}</span>
                              <input
                                type="file"
                                accept="image/*"
                                disabled={isUploadingServerBanner}
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) handleUploadServerBanner(file);
                                  e.target.value = '';
                                }}
                                className="hidden"
                              />
                            </label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <span className="text-[11px] text-slate-500 shrink-0">または直接URLを指定:</span>
                            <input
                              type="text"
                              placeholder="https://example.com/banner.png"
                              value={adminServerBanner}
                              onChange={(e) => setAdminServerBanner(e.target.value)}
                              className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                            />
                          </div>
                          <p className="text-[11px] text-slate-500">
                            ※ 横長画像（アスペクト比 16:9 や 3:1、1200×630px 以上推奨）を推奨します。最大15MB。ログイン・新規登録画面の背景や連合紹介に表示されます。
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* サーバー名 */}
                    <div className="space-y-1.5 pt-4 border-t border-slate-800/80">
                      <label className="block text-xs font-bold text-slate-300">
                        サーバー名 (Instance Name) <span className="text-rose-400">*</span>
                      </label>
                      <input
                        type="text"
                        placeholder="例: Spica, 星屑ソーシャル, My Mastodon Node"
                        value={adminServerName}
                        onChange={(e) => setAdminServerName(e.target.value)}
                        required
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 font-medium focus:ring-2 focus:ring-indigo-500 focus:outline-none transition"
                      />
                      <p className="text-[11px] text-slate-500">
                        ヘッダー、ブラウザのタイトルタブ、および連合（NodeInfo / ActivityPub）に公開される正式名称です。
                      </p>
                    </div>

                    {/* サーバー説明文 */}
                    <div className="space-y-1.5 pt-4 border-t border-slate-800/80">
                      <label className="block text-xs font-bold text-slate-300">
                        サーバー説明文 (Description)
                      </label>
                      <textarea
                        rows={3}
                        placeholder="このサーバーの特徴やルール、コミュニティの紹介文を入力してください..."
                        value={adminServerDesc}
                        onChange={(e) => setAdminServerDesc(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none transition resize-none leading-relaxed"
                      />
                      <p className="text-[11px] text-slate-500">
                        NodeInfo や外部の Fediverse サーバーからインスタンス詳細を取得した際に表示されます。
                      </p>
                    </div>

                    {/* 📜 サーバールール設定 */}
                    <div className="space-y-3 pt-4 border-t border-slate-800/80">
                      <div className="flex items-center justify-between">
                        <label className="block text-xs font-bold text-slate-300">
                          サーバールール (Server Rules)
                        </label>
                        <span className="text-[11px] text-slate-500">1行に1ルール入力</span>
                      </div>
                      <textarea
                        rows={4}
                        placeholder={"お互いを尊重してください\n他鯖とのもめごとなどをおこさないでください\n個人情報を極力書かないこと\n利用規約をちゃんと守ること"}
                        value={adminServerRulesText}
                        onChange={(e) => setAdminServerRulesText(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none transition resize-none leading-relaxed font-mono"
                      />
                      {adminServerRulesText.split('\n').filter((r: any) => r.trim()).length > 0 && (
                        <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1.5">
                          <span className="text-[10px] font-bold text-slate-400 block mb-1">新規登録画面でのプレビュー</span>
                          {adminServerRulesText.split('\n').filter((r: any) => r.trim()).map((rule: any, idx: any) => (
                            <div key={idx} className="flex items-start space-x-2 text-xs text-slate-300">
                              <span className="w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-[10px] flex items-center justify-center shrink-0 mt-0.5">
                                {idx + 1}
                              </span>
                              <span>{rule.trim()}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 規約同意の必須化スイッチ */}
                    <div className="pt-4 border-t border-slate-800/80">
                      <label className="flex items-start space-x-3 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={adminRequireRulesAgreement}
                          onChange={(e) => setAdminRequireRulesAgreement(e.target.checked)}
                          className="mt-0.5 w-4 h-4 rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-indigo-500"
                        />
                        <div className="space-y-0.5">
                          <span className="text-xs font-bold text-slate-200 block">
                            新規登録時にサーバールール・利用規約への同意を必須にする
                          </span>
                          <span className="text-[11px] text-slate-400 block leading-relaxed">
                            有効にすると、ユーザーがアカウントを作成する前にMisskeyスタイルのルール・規約同意モーダルが表示され、全項目への同意を要求します。
                          </span>
                        </div>
                      </label>
                    </div>

                    {/* 利用規約・ポリシー・外部リンク設定 (Misskeyスタイル) */}
                    <div className="space-y-4 pt-4 border-t border-slate-800/80">
                      <div className="flex items-center space-x-2 pb-1">
                        <Globe className="w-4 h-4 text-indigo-400" />
                        <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                          ポリシー・外部リンク設定 (Misskey互換)
                        </h3>
                      </div>

                      {/* 利用規約URL */}
                      <div className="space-y-1">
                        <label className="block text-[11px] font-semibold text-slate-300">
                          利用規約URL
                        </label>
                        <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                          <ExternalLink className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
                          <input
                            type="text"
                            placeholder="https://example.com/terms.html"
                            value={adminTosUrl}
                            onChange={(e) => setAdminTosUrl(e.target.value)}
                            className="bg-transparent text-slate-200 placeholder-slate-600 focus:outline-none flex-1 font-mono text-xs"
                          />
                        </div>
                      </div>

                      {/* プライバシーポリシーURL */}
                      <div className="space-y-1">
                        <label className="block text-[11px] font-semibold text-slate-300">
                          プライバシーポリシーURL
                        </label>
                        <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                          <ExternalLink className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
                          <input
                            type="text"
                            placeholder="https://example.com/privacy.html"
                            value={adminPrivacyPolicyUrl}
                            onChange={(e) => setAdminPrivacyPolicyUrl(e.target.value)}
                            className="bg-transparent text-slate-200 placeholder-slate-600 focus:outline-none flex-1 font-mono text-xs"
                          />
                        </div>
                      </div>

                      {/* 問い合わせ先URL */}
                      <div className="space-y-1">
                        <label className="block text-[11px] font-semibold text-slate-300">
                          問い合わせ先URL
                        </label>
                        <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                          <ExternalLink className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
                          <input
                            type="text"
                            placeholder="https://example.com/contact.html"
                            value={adminContactUrl}
                            onChange={(e) => setAdminContactUrl(e.target.value)}
                            className="bg-transparent text-slate-200 placeholder-slate-600 focus:outline-none flex-1 font-mono text-xs"
                          />
                        </div>
                        <p className="text-[10px] text-slate-500">
                          サーバー運営者へのお問い合わせフォームのURLや、運営者の連絡先等が記載されたWebページのURLを指定します。
                        </p>
                      </div>

                      {/* リポジトリURL */}
                      <div className="space-y-1">
                        <label className="block text-[11px] font-semibold text-slate-300">
                          リポジトリURL
                        </label>
                        <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                          <ExternalLink className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
                          <input
                            type="text"
                            placeholder="https://github.com/Keychrom/Spica"
                            value={adminRepositoryUrl}
                            onChange={(e) => setAdminRepositoryUrl(e.target.value)}
                            className="bg-transparent text-slate-200 placeholder-slate-600 focus:outline-none flex-1 font-mono text-xs"
                          />
                        </div>
                        <p className="text-[10px] text-slate-500">
                          ソースコードが公開されているリポジトリがある場合、そのURLを記入します。
                        </p>
                      </div>

                      {/* 運営者情報URL */}
                      <div className="space-y-1">
                        <label className="block text-[11px] font-semibold text-slate-300">
                          運営者情報URL
                        </label>
                        <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                          <ExternalLink className="w-3.5 h-3.5 text-slate-500 mr-2 shrink-0" />
                          <input
                            type="text"
                            placeholder="https://example.com/profile.html"
                            value={adminOperatorUrl}
                            onChange={(e) => setAdminOperatorUrl(e.target.value)}
                            className="bg-transparent text-slate-200 placeholder-slate-600 focus:outline-none flex-1 font-mono text-xs"
                          />
                        </div>
                        <p className="text-[10px] text-slate-500">
                          ドイツなどの一部の国と地域では表示が義務付けられています (Impressum)。
                        </p>
                      </div>
                    </div>

                    {/* メッセージ表示 */}
                    {serverSettingsMessage && (
                      <div
                        className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                          serverSettingsMessage.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}
                      >
                        {serverSettingsMessage.type === 'success' ? (
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 shrink-0" />
                        )}
                        <span>{serverSettingsMessage.text}</span>
                      </div>
                    )}

                    {/* 送信ボタン */}
                    <div className="flex justify-end pt-4 border-t border-slate-800/80">
                      <button
                        type="submit"
                        disabled={isSavingServerSettings}
                        className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/30 transition flex items-center space-x-2 cursor-pointer"
                      >
                        {isSavingServerSettings ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Check className="w-3.5 h-3.5" />
                        )}
                        <span>{isSavingServerSettings ? '保存中...' : 'サーバー設定を保存'}</span>
                      </button>
                    </div>
                  </form>

                  {/* 🔎 リモートコンテンツの保存・索引（Mastodon / Misskey 相当が既定） */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-2xl bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                        <Search className="w-5 h-5" />
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-slate-100">検索とリモート投稿の保存</h2>
                        <p className="text-xs text-slate-400">
                          リレー経由で流入するリモート投稿は DB を大きく膨らませます。Mastodon / Misskey と同じく、既定では<b>リモート投稿の本文を検索索引に入れず</b>、<b>フォロー外のブーストも保存しません</b>。
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="block text-[11px] font-semibold text-slate-300">検索索引の範囲</label>
                        <select
                          value={contentPolicy.ftsIndexScope}
                          disabled={isSavingContentPolicy}
                          onChange={(e) => handleSaveContentPolicy({ ftsIndexScope: e.target.value })}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                        >
                          <option value="local">ローカル投稿のみ（Mastodon / Misskey 相当・推奨）</option>
                          <option value="follows">ローカル＋フォロー中のアクター＋自分宛の返信</option>
                          <option value="all">すべての投稿（旧来の挙動・容量を大きく使います）</option>
                        </select>
                        <p className="text-[10px] text-slate-500">
                          狭めるほど DB が小さくなります。タイムラインの表示内容は変わりません（変わるのは検索だけです）。
                        </p>
                      </div>

                      <div className="space-y-1">
                        <label className="block text-[11px] font-semibold text-slate-300">リモートのブースト（リノート）</label>
                        <select
                          value={contentPolicy.remoteAnnouncePolicy}
                          disabled={isSavingContentPolicy}
                          onChange={(e) => handleSaveContentPolicy({ remoteAnnouncePolicy: e.target.value })}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-cyan-500 focus:outline-none"
                        >
                          <option value="follows">フォロー中アクターのものだけ保存（推奨）</option>
                          <option value="all">すべて保存（旧来の挙動）</option>
                          <option value="none">リモートのブーストは保存しない</option>
                        </select>
                        <p className="text-[10px] text-slate-500">
                          フォローしていない相手のブーストは、リレー経由で大量に届き DB の約 1/4 を占めます。
                        </p>
                      </div>
                    </div>

                    {contentPolicyMsg && (
                      <div className="p-3 rounded-xl text-xs bg-cyan-500/10 border border-cyan-500/30 text-cyan-200">
                        {contentPolicyMsg}
                      </div>
                    )}

                    <p className="text-[10px] text-slate-500 leading-relaxed">
                      ※ 設定は<b>これ以降に届く投稿</b>に適用されます。既に保存済みの投稿・ブーストへ遡って適用するには、サーバーを停止して
                      <code className="mx-1 px-1.5 py-0.5 rounded bg-slate-950 border border-slate-800 font-mono">npm run db:maintenance -- --apply</code>
                      を実行してください（先にバックアップを取ります）。
                    </p>
                  </div>
                </div>
              )}

              {/* 🎨 カスタム絵文字管理タブ */}
              {adminTab === 'emojis' && (
                <div className="space-y-6">
                  {/* ヘッダーカード */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-2">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-2xl bg-yellow-500/20 border border-yellow-500/30 flex items-center justify-center text-yellow-400">
                        <Smile className="w-5 h-5" />
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-slate-100">カスタム絵文字管理</h2>
                        <p className="text-xs text-slate-400">
                          サーバーオリジナルのカスタム絵文字を追加・管理できます。登録した絵文字は投稿本文やリアクションピッカーで使用でき、連合先（Mastodon / Misskey）にも画像タグ付きで配信されます。
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* 新規絵文字追加カード */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
                    <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-2">
                      <Plus className="w-4 h-4 text-emerald-400" />
                      <span>新規カスタム絵文字を登録</span>
                    </h3>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-bold text-slate-300 mb-1">
                          ショートコード名 <span className="text-rose-400">*</span>
                        </label>
                        <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-indigo-500">
                          <span className="text-slate-500 font-mono mr-1">:</span>
                          <input
                            type="text"
                            placeholder="例: blobcat, party_parrot, spica"
                            value={newEmojiName}
                            onChange={(e) => setNewEmojiName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                            className="bg-transparent text-slate-200 focus:outline-none flex-1 font-mono text-xs"
                          />
                          <span className="text-slate-500 font-mono ml-1">:</span>
                        </div>
                        <p className="text-[10px] text-slate-500 mt-1">※ 2〜30文字の小文字英数字・アンダースコア</p>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-300 mb-1">
                          カテゴリ
                        </label>
                        <input
                          type="text"
                          placeholder="例: 一般, キャラクター, ネタ, 挨拶"
                          value={newEmojiCategory}
                          onChange={(e) => setNewEmojiCategory(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        />
                        <p className="text-[10px] text-slate-500 mt-1">※ ピッカー内でタブ分け表示されます</p>
                      </div>
                    </div>

                    {/* 画像選択エリア */}
                    <div className="pt-2 border-t border-slate-800/80">
                      <label className="block text-xs font-bold text-slate-300 mb-2">
                        絵文字画像ファイル / 画像URL <span className="text-rose-400">*</span>
                      </label>
                      <div className="flex flex-col sm:flex-row gap-3">
                        <label className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition flex items-center justify-center space-x-1.5 cursor-pointer shadow-md shrink-0">
                          {isUploadingEmoji ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <Upload className="w-4 h-4" />
                          )}
                          <span>{isUploadingEmoji ? 'アップロード中...' : 'ファイルを選択して登録'}</span>
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                            disabled={isUploadingEmoji}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) handleCreateEmoji(file);
                              e.target.value = '';
                            }}
                            className="hidden"
                          />
                        </label>

                        <div className="flex-1 flex items-center space-x-2">
                          <span className="text-[11px] text-slate-500 shrink-0">またはURL:</span>
                          <input
                            type="text"
                            placeholder="https://example.com/emoji.png"
                            value={newEmojiUrl}
                            onChange={(e) => setNewEmojiUrl(e.target.value)}
                            className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => handleCreateEmoji()}
                            disabled={isUploadingEmoji || !newEmojiName.trim() || !newEmojiUrl.trim()}
                            className="px-4 py-2 bg-slate-800 hover:bg-indigo-600 text-slate-200 hover:text-white rounded-xl text-xs font-bold transition disabled:opacity-40 cursor-pointer shrink-0"
                          >
                            URLで登録
                          </button>
                        </div>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-2">
                        ※ PNG, WebP, GIF, SVG に対応。正方形の透過画像（128×128px 前後）を推奨します。
                      </p>
                    </div>

                    {/* 通知メッセージ */}
                    {emojiActionMsg && (
                      <div
                        className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                          emojiActionMsg.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}
                      >
                        {emojiActionMsg.type === 'success' ? (
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 shrink-0" />
                        )}
                        <span>{emojiActionMsg.text}</span>
                      </div>
                    )}
                  </div>

                  {/* 登録済み絵文字一覧カード */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-2">
                        <Tag className="w-4 h-4 text-indigo-400" />
                        <span>登録済みカスタム絵文字 ({adminEmojis.length}件)</span>
                      </h3>
                      <button
                        type="button"
                        onClick={fetchAdminData}
                        className="p-1.5 text-slate-400 hover:text-slate-200 rounded-xl hover:bg-slate-800 transition text-xs flex items-center space-x-1"
                        title="一覧を更新"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>更新</span>
                      </button>
                    </div>

                    {adminEmojis.length === 0 ? (
                      <div className="p-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800/60">
                        <Smile className="w-10 h-10 mx-auto text-slate-600 mb-2" />
                        <p className="text-xs text-slate-400 font-bold">まだカスタム絵文字が登録されていません</p>
                        <p className="text-[11px] text-slate-500 mt-1">
                          上のフォームから画像を選択して、コミュニティオリジナルの絵文字を追加してみましょう！
                        </p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                        {adminEmojis.map((emoji: any) => (
                          <div
                            key={emoji.id}
                            className="bg-slate-950/70 border border-slate-800/80 hover:border-slate-750 rounded-2xl p-3 flex flex-col items-center justify-between text-center group transition shadow-sm"
                          >
                            <div className="w-12 h-12 flex items-center justify-center my-1">
                              <img
                                src={emoji.url}
                                alt={emoji.name}
                                className="w-10 h-10 object-contain drop-shadow"
                                loading="lazy"
                              />
                            </div>
                            <div className="w-full mt-2">
                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard.writeText(`:${emoji.name}:`);
                                  alert(`:${emoji.name}: をコピーしました！`);
                                }}
                                className="font-mono text-xs font-bold text-slate-200 hover:text-indigo-400 truncate block w-full transition cursor-pointer"
                                title="クリックでショートコードをコピー"
                              >
                                :{emoji.name}:
                              </button>
                              <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-800/60 text-[10px]">
                                <span className="px-1.5 py-0.5 rounded bg-slate-850 text-slate-400 font-semibold truncate max-w-[70px]">
                                  {emoji.category || '一般'}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteEmoji(emoji.id, emoji.name)}
                                  className="p-1 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
                                  title="削除"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 🎟 招待コード & 登録モード管理タブ */}
              {adminTab === 'mail' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div>
                    <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                      <Mail className="w-4 h-4 text-sky-400" />
                      <span>メール送信（SMTP）と認証方式</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                      マスターキー復元やメール確認に使う SMTP を設定します。未設定のあいだ、メール関連の機能は自動的に無効になります。
                    </p>
                  </div>

                  <form onSubmit={handleSaveMailSettings} className="space-y-3 bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2">
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">SMTP ホスト</label>
                        <input
                          type="text"
                          value={mailSettings.host}
                          onChange={(e) => setMailSettings((p: any) => ({ ...p, host: e.target.value }))}
                          placeholder="smtp.example.com"
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">ポート</label>
                        <input
                          type="number"
                          value={mailSettings.port}
                          onChange={(e) => setMailSettings((p: any) => ({ ...p, port: parseInt(e.target.value, 10) || 587 }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">ユーザー名（任意）</label>
                        <input
                          type="text"
                          value={mailSettings.user}
                          onChange={(e) => setMailSettings((p: any) => ({ ...p, user: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          パスワード {mailSettings.hasPassword ? '（設定済み・空欄で維持）' : '（任意）'}
                        </label>
                        <input
                          type="password"
                          value={mailSettings.pass}
                          onChange={(e) => setMailSettings((p: any) => ({ ...p, pass: e.target.value }))}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">差出人アドレス <span className="text-rose-400">*</span></label>
                        <input
                          type="text"
                          value={mailSettings.from}
                          onChange={(e) => setMailSettings((p: any) => ({ ...p, from: e.target.value }))}
                          placeholder="no-reply@example.com"
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-mono focus:ring-2 focus:ring-sky-500 focus:outline-none"
                        />
                      </div>
                    </div>

                    <label className="flex items-center space-x-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(mailSettings.secure)}
                        onChange={(e) => setMailSettings((p: any) => ({ ...p, secure: e.target.checked }))}
                        className="w-3.5 h-3.5 accent-sky-500 cursor-pointer"
                      />
                      <span>SSL/TLS で接続する（ポート465など。587の場合はOFFのままでSTARTTLSを使います）</span>
                    </label>

                    <div className="pt-2 border-t border-slate-800 space-y-3">
                      <h4 className="font-bold text-xs text-slate-200">認証方式とメール登録</h4>
                      <div className="space-y-2">
                        <label className="flex items-start space-x-2 text-xs text-slate-300 cursor-pointer">
                          <input
                            type="radio"
                            name="authMode"
                            checked={mailSettings.authMode === 'master_key'}
                            onChange={() => setMailSettings((p: any) => ({ ...p, authMode: 'master_key' }))}
                            className="mt-0.5 accent-sky-500 cursor-pointer"
                          />
                          <span>マスターキー方式（パスワードレス・推奨）</span>
                        </label>
                        <label className="flex items-start space-x-2 text-xs text-slate-300 cursor-pointer">
                          <input
                            type="radio"
                            name="authMode"
                            checked={mailSettings.authMode === 'password'}
                            onChange={() => setMailSettings((p: any) => ({ ...p, authMode: 'password' }))}
                            className="mt-0.5 accent-sky-500 cursor-pointer"
                          />
                          <span>
                            メールアドレス＋パスワード方式
                            <span className="block text-[10px] text-slate-500">
                              ※ 新規登録とログインがメールアドレス＋パスワード方式に切り替わります（招待コードや利用規約の同意はそのまま有効です。メール送信が未設定でも登録できます）
                            </span>
                          </span>
                        </label>
                      </div>
                      <label className="flex items-start space-x-2 text-xs text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(mailSettings.allowEmailRegistration)}
                          onChange={(e) => setMailSettings((p: any) => ({ ...p, allowEmailRegistration: e.target.checked }))}
                          className="mt-0.5 w-3.5 h-3.5 accent-sky-500 cursor-pointer"
                        />
                        <span>
                          ユーザーがメールアドレスを登録できるようにする
                          <span className="block text-[10px] text-slate-500">オンにすると、ユーザー設定にメール登録欄が出て、マスターキー復元が使えるようになります</span>
                        </span>
                      </label>
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                      <button
                        type="button"
                        onClick={handleTestMailSettings}
                        disabled={isSavingMail || !mailSettings.host}
                        className="px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-bold rounded-xl border border-slate-700 transition cursor-pointer"
                      >
                        接続テスト
                      </button>
                      <button
                        type="submit"
                        disabled={isSavingMail}
                        className="px-4 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition flex items-center space-x-1.5 cursor-pointer"
                      >
                        {isSavingMail ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                        <span>設定を保存</span>
                      </button>
                    </div>

                    {mailSettingsMsg && (
                      <div className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                        mailSettingsMsg.type === 'success'
                          ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                          : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                      }`}>
                        {mailSettingsMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                        <span>{mailSettingsMsg.text}</span>
                      </div>
                    )}
                  </form>
                </div>
              )}

              {/* 📮 配送再送キュー（ActivityPub 配送の指数バックオフ再送） */}
              {adminTab === 'delivery' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                        <Send className="w-4 h-4 text-emerald-400" />
                        <span>配送キュー（再送待ち / 失敗）</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                        相手サーバーの一時的な障害（ネットワークエラー・5xx・429 など）で失敗した配送を指数バックオフで自動再送します。
                        401/403/404 などの恒久的な失敗は再送しません。最大 {deliveryQueue.maxAttempts ?? 9} 回試行します。
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={fetchDeliveryQueue}
                      disabled={isLoadingDeliveryQueue}
                      className="shrink-0 px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-bold rounded-xl border border-slate-700 transition cursor-pointer flex items-center space-x-1.5"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isLoadingDeliveryQueue ? 'animate-spin text-emerald-400' : ''}`} />
                      <span>更新</span>
                    </button>
                  </div>

                  {/* 統計 */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-3">
                      <p className="text-[11px] text-slate-400">再送待ち</p>
                      <p className="text-xl font-black text-amber-300 mt-0.5">{deliveryQueue.stats?.pending ?? 0}</p>
                    </div>
                    <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-3">
                      <p className="text-[11px] text-slate-400">再送に成功</p>
                      <p className="text-xl font-black text-emerald-300 mt-0.5">{deliveryQueue.stats?.delivered ?? 0}</p>
                    </div>
                    <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-3">
                      <p className="text-[11px] text-slate-400">失敗（確定）</p>
                      <p className="text-xl font-black text-rose-300 mt-0.5">{deliveryQueue.stats?.failed ?? 0}</p>
                    </div>
                  </div>

                  {deliveryQueue.stats?.nextAttemptAt && (
                    <p className="text-[11px] text-slate-400">
                      次回の再送予定:{' '}
                      <span className="font-mono text-slate-200">
                        {new Date(deliveryQueue.stats.nextAttemptAt).toLocaleString('ja-JP')}
                      </span>
                    </p>
                  )}

                  {/* 操作 */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleRetryDeliveries}
                      disabled={isActingOnDelivery || (deliveryQueue.stats?.pending ?? 0) === 0}
                      className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold rounded-xl shadow-md transition cursor-pointer flex items-center space-x-1.5"
                    >
                      {isActingOnDelivery ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      <span>今すぐ再送</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleClearFailedDeliveries}
                      disabled={isActingOnDelivery || (deliveryQueue.stats?.failed ?? 0) === 0}
                      className="px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-bold rounded-xl border border-slate-700 transition cursor-pointer flex items-center space-x-1.5"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>失敗した記録を削除</span>
                    </button>
                  </div>

                  {deliveryQueueMsg && (
                    <div className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                      deliveryQueueMsg.type === 'success'
                        ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                        : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                    }`}>
                      {deliveryQueueMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                      <span>{deliveryQueueMsg.text}</span>
                    </div>
                  )}

                  {/* 再送待ちの一覧 */}
                  <div className="space-y-2">
                    <h4 className="font-bold text-xs text-slate-300">
                      再送待ちの配送 ({deliveryQueue.pending?.length ?? 0})
                    </h4>
                    {(deliveryQueue.pending?.length ?? 0) === 0 ? (
                      <p className="text-xs text-slate-500 bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                        再送待ちの配送はありません。
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {deliveryQueue.pending.map((item: any) => (
                          <div key={item.id} className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3 text-xs space-y-1">
                            <div className="flex items-start justify-between gap-2">
                              <span className="font-bold text-slate-200 break-all">
                                {item.activity_type || 'Activity'} → <span className="font-mono text-slate-300">{item.inbox_url}</span>
                              </span>
                              <span className="shrink-0 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-mono text-[10px]">
                                {item.attempts}回失敗
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-500">
                              次回: {new Date(item.next_attempt_at).toLocaleString('ja-JP')}
                              {item.last_status ? ` / 直近の応答: HTTP ${item.last_status}` : ''}
                            </p>
                            {item.last_error && <p className="text-[11px] text-rose-300/80 break-all">{item.last_error}</p>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 失敗が確定した配送 */}
                  <div className="space-y-2">
                    <h4 className="font-bold text-xs text-slate-300">
                      失敗が確定した配送 ({deliveryQueue.recentFailures?.length ?? 0})
                    </h4>
                    {(deliveryQueue.recentFailures?.length ?? 0) === 0 ? (
                      <p className="text-xs text-slate-500 bg-slate-950/60 border border-slate-800 rounded-2xl p-3">
                        失敗が確定した配送はありません。
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {deliveryQueue.recentFailures.map((item: any) => (
                          <div key={item.id} className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3 text-xs space-y-1">
                            <div className="flex items-start justify-between gap-2">
                              <span className="font-bold text-slate-200 break-all">
                                {item.activity_type || 'Activity'} → <span className="font-mono text-slate-300">{item.inbox_url}</span>
                              </span>
                              <span className="shrink-0 px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 font-mono text-[10px]">
                                {item.attempts}回失敗
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-500">
                              最終試行: {new Date(item.updated_at).toLocaleString('ja-JP')}
                              {item.last_status ? ` / 応答: HTTP ${item.last_status}` : ''}
                            </p>
                            {item.last_error && <p className="text-[11px] text-rose-300/80 break-all">{item.last_error}</p>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 🧾 監査ログ（誰が・いつ・何をしたか） */}
              {adminTab === 'audit' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-4 animate-in fade-in duration-150">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                        <ClipboardList className="w-4 h-4 text-amber-400" />
                        <span>監査ログ（管理操作の履歴）</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                        管理パネルからの変更操作を記録しています（誰が・いつ・何を・どの対象に）。表示のみの操作は記録しません。
                        パスワードやトークン類は記録時に伏せられます。合計 {auditTotal.toLocaleString()} 件。
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={auditFilter}
                        onChange={(e) => { setAuditFilter(e.target.value); fetchAuditLog({ before: null, action: e.target.value }); }}
                        className="bg-slate-950 border border-slate-800 rounded-xl px-2.5 py-1.5 text-[11px] text-slate-200 focus:outline-none"
                      >
                        <option value="">すべての操作</option>
                        {auditKinds.map((k: any) => (
                          <option key={k.action} value={k.action}>{k.label}（{k.count}）</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => fetchAuditLog({ before: null })}
                        disabled={isLoadingAudit}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-[11px] font-bold rounded-xl border border-slate-700 transition cursor-pointer flex items-center space-x-1.5"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isLoadingAudit ? 'animate-spin' : ''}`} />
                        <span>更新</span>
                      </button>
                      <button
                        type="button"
                        onClick={handlePruneAuditLog}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-rose-300 text-[11px] font-bold rounded-xl border border-rose-500/30 transition cursor-pointer"
                      >
                        古いログを削除
                      </button>
                    </div>
                  </div>

                  {auditMsg && (
                    <div className="p-2.5 rounded-xl text-[11px] bg-slate-950/70 border border-slate-800 text-slate-300">{auditMsg}</div>
                  )}

                  {auditLog.length === 0 ? (
                    <div className="text-center py-10 bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                      記録された管理操作はまだありません。
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-400">
                            <th className="pb-2.5 font-semibold whitespace-nowrap">日時</th>
                            <th className="pb-2.5 font-semibold whitespace-nowrap">実行者</th>
                            <th className="pb-2.5 font-semibold">操作</th>
                            <th className="pb-2.5 font-semibold">対象</th>
                            <th className="pb-2.5 font-semibold">内容</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60">
                          {auditLog.map((row: any) => (
                            <tr key={row.id} className="hover:bg-slate-800/20 transition align-top">
                              <td className="py-2.5 text-slate-400 whitespace-nowrap font-mono text-[11px]">
                                {new Date(row.created_at).toLocaleString('ja-JP')}
                              </td>
                              <td className="py-2.5 font-mono text-[11px] text-indigo-300 whitespace-nowrap">@{row.actor_id}</td>
                              <td className="py-2.5 text-slate-200 font-semibold whitespace-nowrap">{row.label}</td>
                              <td className="py-2.5 font-mono text-[11px] text-rose-300 break-all">
                                {row.target_id || <span className="text-slate-600">—</span>}
                              </td>
                              <td className="py-2.5 text-slate-400 break-all text-[11px] max-w-md">
                                {row.detail_json || <span className="text-slate-600">—</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {auditCursor && (
                    <div className="flex justify-center pt-1">
                      <button
                        type="button"
                        onClick={() => fetchAuditLog({ before: auditCursor })}
                        disabled={isLoadingAudit}
                        className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-bold rounded-xl border border-slate-700 transition cursor-pointer"
                      >
                        {isLoadingAudit ? '読み込み中...' : 'もっと見る'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {adminTab === 'roles' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div>
                    <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                      <UserPlus className="w-4 h-4 text-violet-400" />
                      <span>ロール（権限）管理 ({adminRoles.length})</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                      ロールを作成し、ユーザーごとに付け外しできます。付与された権限は再ログイン不要で即時反映されます。
                      「管理者」権限は管理画面のすべての操作、「モデレーター」は通報対応・凍結・ドメインブロックが対象です。
                    </p>
                  </div>

                  <form onSubmit={handleSaveRole} className="space-y-3 bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2">
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          ロール名 <span className="text-rose-400">*</span>
                        </label>
                        <input
                          type="text"
                          value={newRoleName}
                          onChange={(e) => setNewRoleName(e.target.value)}
                          maxLength={40}
                          placeholder="例: モデレーター"
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-violet-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">表示色</label>
                        <input
                          type="color"
                          value={newRoleColor}
                          onChange={(e) => setNewRoleColor(e.target.value)}
                          className="w-full h-9 bg-slate-900 border border-slate-800 rounded-xl cursor-pointer"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                        権限 <span className="text-rose-400">*</span>
                      </label>
                      <div className="space-y-1.5">
                        {availablePermissions.map((perm: any) => (
                          <label key={perm.key} className="flex items-start space-x-2 cursor-pointer text-xs text-slate-300">
                            <input
                              type="checkbox"
                              checked={newRolePermissions.includes(perm.key)}
                              onChange={(e) => {
                                setNewRolePermissions((prev: any) =>
                                  e.target.checked ? [...prev, perm.key] : prev.filter((p: any) => p !== perm.key),
                                );
                              }}
                              className="mt-0.5 w-3.5 h-3.5 accent-violet-500 cursor-pointer"
                            />
                            <span>{perm.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center justify-end space-x-2">
                      {editingRoleId && (
                        <button
                          type="button"
                          onClick={() => { setEditingRoleId(null); setNewRoleName(''); setNewRolePermissions([]); }}
                          className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-xl transition cursor-pointer"
                        >
                          新規作成に切り替え
                        </button>
                      )}
                      <button
                        type="submit"
                        disabled={!newRoleName.trim() || newRolePermissions.length === 0}
                        className="px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition flex items-center space-x-1.5 cursor-pointer"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>{editingRoleId ? 'ロールを更新' : 'ロールを作成'}</span>
                      </button>
                    </div>
                  </form>

                  {roleActionMsg && (
                    <div
                      className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                        roleActionMsg.type === 'success'
                          ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                          : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                      }`}
                    >
                      {roleActionMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                      <span>{roleActionMsg.text}</span>
                    </div>
                  )}

                  {/* ロール一覧 */}
                  {adminRoles.length === 0 ? (
                    <div className="p-6 text-center bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                      まだロールがありません。上のフォームから作成してください。
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {adminRoles.map((role: any) => (
                        <div key={role.id} className="flex flex-wrap items-center justify-between gap-2 bg-slate-950/50 border border-slate-800 rounded-2xl px-3.5 py-2.5">
                          <div className="flex items-center space-x-2 min-w-0">
                            <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: role.color || '#6366f1' }} />
                            <span className="font-bold text-xs text-slate-100 truncate">{role.name}</span>
                            <span className="text-[10px] text-slate-500 font-mono">{role.member_count} 人</span>
                            <span className="text-[10px] text-slate-400 truncate">
                              {String(role.permissions || '')
                                .split(',')
                                .filter(Boolean)
                                .map((p: string) => availablePermissions.find((ap: any) => ap.key === p)?.label || p)
                                .join(' / ')}
                            </span>
                          </div>
                          <div className="flex items-center space-x-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleEditRole(role)}
                              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold transition cursor-pointer"
                            >
                              編集
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteRole(role.id)}
                              className="px-3 py-1.5 bg-rose-600/80 hover:bg-rose-600 text-white rounded-lg text-xs font-bold transition cursor-pointer"
                            >
                              削除
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ユーザーへのロール付与 */}
                  <div className="space-y-2 pt-2 border-t border-slate-800">
                    <h4 className="font-bold text-sm text-slate-100">ユーザーへの付与</h4>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      チップをクリックするとロールを付け外しできます（即時反映）。
                    </p>
                    {adminUsers.length === 0 ? (
                      <div className="p-4 text-center bg-slate-950/40 rounded-2xl border border-dashed border-slate-800 text-slate-500 text-xs">
                        ユーザーがいません。
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {adminUsers.map((user: any) => {
                          const userRoleIds: string[] = (user.roles || []).map((r: any) => r.id);
                          return (
                            <div key={user.id} className="bg-slate-950/50 border border-slate-800 rounded-2xl px-3.5 py-3 space-y-2">
                              <div className="flex items-center space-x-2">
                                <span className="font-bold text-xs text-slate-100">@{user.id}</span>
                                {user.role === 'admin' && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 font-bold">
                                    管理者
                                  </span>
                                )}
                                {user.is_frozen === 1 && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-bold">凍結中</span>
                                )}
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {adminRoles.map((role: any) => {
                                  const active = userRoleIds.includes(role.id);
                                  return (
                                    <button
                                      key={role.id}
                                      type="button"
                                      onClick={() => handleToggleUserRole(user.id, role.id)}
                                      className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition cursor-pointer ${
                                        active
                                          ? 'text-white border-transparent'
                                          : 'bg-slate-900 text-slate-400 border-slate-800 hover:bg-slate-800'
                                      }`}
                                      style={active ? { backgroundColor: role.color || '#6366f1' } : undefined}
                                    >
                                      {role.name}
                                    </button>
                                  );
                                })}
                                {adminRoles.length === 0 && <span className="text-[11px] text-slate-500">ロール未作成</span>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {adminTab === 'announcements' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div>
                    <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                      <Megaphone className="w-4 h-4 text-amber-400" />
                      <span>お知らせ ({adminAnnouncements.length})</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                      サーバーからの一斉告知です。有効なお知らせは全ユーザーのタイムライン上部に表示されます。メンテナンス予定や運営からの連絡にご利用ください。
                    </p>
                  </div>

                  <form onSubmit={handleCreateAnnouncement} className="space-y-3 bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                        タイトル <span className="text-rose-400">*</span>
                      </label>
                      <input
                        type="text"
                        value={newAnnouncementTitle}
                        onChange={(e) => setNewAnnouncementTitle(e.target.value)}
                        maxLength={120}
                        placeholder="例: サーバーメンテナンスのお知らせ"
                        className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-amber-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                        本文 <span className="text-rose-400">*</span>
                      </label>
                      <textarea
                        value={newAnnouncementContent}
                        onChange={(e) => setNewAnnouncementContent(e.target.value)}
                        rows={3}
                        maxLength={5000}
                        placeholder="例: 9/25 3:00〜5:00 の間、メンテナンスのため停止します。"
                        className="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-amber-500 focus:outline-none resize-none"
                      />
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="submit"
                        disabled={isSavingAnnouncement || !newAnnouncementTitle.trim() || !newAnnouncementContent.trim()}
                        className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-md transition flex items-center space-x-1.5 cursor-pointer"
                      >
                        {isSavingAnnouncement ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Megaphone className="w-3.5 h-3.5" />}
                        <span>お知らせを投稿</span>
                      </button>
                    </div>
                  </form>

                  {announcementMsg && (
                    <div
                      className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                        announcementMsg.type === 'success'
                          ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                          : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                      }`}
                    >
                      {announcementMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                      <span>{announcementMsg.text}</span>
                    </div>
                  )}

                  {adminAnnouncements.length === 0 ? (
                    <div className="p-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800/60">
                      <Megaphone className="w-10 h-10 mx-auto text-slate-600 mb-2" />
                      <p className="text-xs text-slate-400 font-bold">まだお知らせがありません</p>
                      <p className="text-[11px] text-slate-500 mt-1">上のフォームから投稿できます。</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {adminAnnouncements.map((a: any) => (
                        <div key={a.id} className="bg-slate-950/50 border border-slate-800 rounded-2xl p-4 space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center space-x-2 min-w-0">
                              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                                a.is_active === 1 ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'bg-slate-800 text-slate-400 border border-slate-700'
                              }`}>
                                {a.is_active === 1 ? '公開中' : '非公開'}
                              </span>
                              <span className="font-bold text-xs text-slate-100 truncate">{a.title}</span>
                            </div>
                            <span className="text-[10px] text-slate-500 font-mono shrink-0">
                              {new Date(a.created_at).toLocaleString('ja-JP')}
                            </span>
                          </div>
                          <p className="text-xs text-slate-300 whitespace-pre-wrap break-words bg-slate-900/60 rounded-xl p-3 border border-slate-800">
                            {a.content}
                          </p>
                          <div className="flex items-center justify-end space-x-2">
                            <button
                              type="button"
                              onClick={() => handleToggleAnnouncement(a.id, a.is_active !== 1)}
                              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold transition cursor-pointer"
                            >
                              {a.is_active === 1 ? '非公開にする' : '公開する'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteAnnouncement(a.id)}
                              className="px-3 py-1.5 bg-rose-600/80 hover:bg-rose-600 text-white rounded-lg text-xs font-bold transition cursor-pointer flex items-center space-x-1"
                            >
                              <Trash2 className="w-3 h-3" />
                              <span>削除</span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {adminTab === 'reports' && (
                <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 shadow-xl space-y-5 animate-in fade-in duration-150">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-sm text-slate-200 flex items-center space-x-2">
                        <ShieldAlert className="w-4 h-4 text-rose-400" />
                        <span>通報の対応（未対応 {adminReportCounts.open} 件 / 全 {adminReportCounts.total} 件）</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                        ユーザーおよび他サーバーから届いた通報の一覧です。内容を確認し、必要に応じて対象アカウントの凍結やドメインブロックを行ってください。
                        他サーバーのユーザーを通報した場合は、相手サーバーへ Flag として転送されます。
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => fetchReports(reportStatusFilter)}
                      className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-xl border border-slate-700 transition flex items-center space-x-1.5 cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>更新</span>
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {([['open', '未対応'], ['all', 'すべて'], ['resolved', '対応済み'], ['rejected', '却下']] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => { setReportStatusFilter(value); fetchReports(value); }}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition cursor-pointer ${
                          reportStatusFilter === value
                            ? 'bg-indigo-600 border-indigo-500 text-white'
                            : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:bg-slate-800/60'
                        }`}
                      >
                        {label}
                        {value === 'open' && adminReportCounts.open > 0 ? ` (${adminReportCounts.open})` : ''}
                      </button>
                    ))}
                  </div>

                  {reportActionMsg && (
                    <div
                      className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                        reportActionMsg.type === 'success'
                          ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                          : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                      }`}
                    >
                      {reportActionMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                      <span>{reportActionMsg.text}</span>
                    </div>
                  )}

                  {(() => {
                    const shown = reportStatusFilter === 'all'
                      ? adminReports
                      : adminReports.filter((r: any) => r.status === reportStatusFilter);

                    if (shown.length === 0) {
                      return (
                        <div className="p-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800/60">
                          <ShieldAlert className="w-10 h-10 mx-auto text-slate-600 mb-2" />
                          <p className="text-xs text-slate-400 font-bold">該当する通報はありません</p>
                          <p className="text-[11px] text-slate-500 mt-1">新しい通報が届くとここに表示されます。</p>
                        </div>
                      );
                    }

                    return shown.map((r: any) => {
                      const statusStyle =
                        r.status === 'open'
                          ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                          : r.status === 'resolved'
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            : 'bg-slate-800 text-slate-400 border border-slate-700';
                      const statusLabel = r.status === 'open' ? '未対応' : r.status === 'resolved' ? '対応済み' : '却下';

                      return (
                        <div key={r.id} className="bg-slate-950/50 border border-slate-800 rounded-2xl p-4 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${statusStyle}`}>{statusLabel}</span>
                              <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-slate-800 text-slate-300">
                                {REPORT_CATEGORY_LABELS[r.category] || r.category}
                              </span>
                              {r.is_remote === 1 && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">他サーバーから</span>
                              )}
                              {r.forwarded === 1 && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-slate-800 text-slate-400">Flag転送済</span>
                              )}
                            </div>
                            <span className="text-[10px] text-slate-500 font-mono">
                              {new Date(r.created_at).toLocaleString('ja-JP')}
                            </span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                            <div className="bg-slate-900/60 rounded-xl p-3 border border-slate-800">
                              <span className="text-[10px] text-slate-500 font-bold block mb-1">通報者</span>
                              <span className="text-slate-200 break-all">{r.reporter_handle || r.reporter_actor_url}</span>
                            </div>
                            <div className="bg-slate-900/60 rounded-xl p-3 border border-slate-800">
                              <span className="text-[10px] text-slate-500 font-bold block mb-1">対象</span>
                              <span className="text-slate-200 break-all">
                                {r.target_handle || r.target_actor_url}
                                {r.target_post_id ? ' の投稿' : ''}
                              </span>
                            </div>
                          </div>

                          {r.comment && (
                            <p className="text-xs text-slate-300 bg-slate-900/60 rounded-xl p-3 border border-slate-800 whitespace-pre-wrap break-words">
                              {r.comment}
                            </p>
                          )}
                          {r.target_post_content && (
                            <p className="text-[11px] text-slate-400 bg-slate-900/40 rounded-xl p-3 border border-slate-800/60 whitespace-pre-wrap break-words">
                              対象投稿: {r.target_post_content}
                            </p>
                          )}
                          {r.resolution_note && (
                            <p className="text-[11px] text-emerald-300/80 bg-emerald-500/5 rounded-xl p-3 border border-emerald-500/20 whitespace-pre-wrap break-words">
                              対応メモ: {r.resolution_note}
                            </p>
                          )}

                          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                            {r.target_user_id && (
                              <button
                                type="button"
                                onClick={() => { setAdminUserSearch(r.target_user_id); setAdminTab('users'); }}
                                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold transition cursor-pointer"
                              >
                                対象ユーザーを管理
                              </button>
                            )}
                            {r.status !== 'open' && (
                              <button
                                type="button"
                                disabled={isUpdatingReport === r.id}
                                onClick={() => handleResolveReport(r.id, 'reopen')}
                                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg text-xs font-semibold transition disabled:opacity-50 cursor-pointer"
                              >
                                再オープン
                              </button>
                            )}
                            {r.status === 'open' && (
                              <>
                                <button
                                  type="button"
                                  disabled={isUpdatingReport === r.id}
                                  onClick={() => handleResolveReport(r.id, 'reject')}
                                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg text-xs font-semibold transition disabled:opacity-50 cursor-pointer"
                                >
                                  却下
                                </button>
                                <button
                                  type="button"
                                  disabled={isUpdatingReport === r.id}
                                  onClick={() => handleResolveReport(r.id, 'resolve')}
                                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold shadow-md transition disabled:opacity-50 cursor-pointer flex items-center space-x-1"
                                >
                                  {isUpdatingReport === r.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                                  <span>対応済みにする</span>
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}

              {adminTab === 'invites' && (
                <div className="space-y-6">
                  {/* ヘッダーカード */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-2">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-2xl bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                        <Ticket className="w-5 h-5" />
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-slate-100">招待コード ＆ 登録モード管理</h2>
                        <p className="text-xs text-slate-400">
                          サーバーの登録モードを切り替えたり、招待リンク・コードを発行してクローズドなコミュニティを運営できます。
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* 登録モード切り替えカード */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-2">
                        <Lock className="w-4 h-4 text-indigo-400" />
                        <span>サーバー新規登録ポリシー</span>
                      </h3>
                      {isUpdatingRegMode && (
                        <div className="flex items-center space-x-1 text-xs text-indigo-400">
                          <RefreshCw className="w-3 h-3 animate-spin" />
                          <span>更新中...</span>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {/* オープン */}
                      <button
                        type="button"
                        onClick={() => handleChangeRegistrationMode('open')}
                        disabled={isUpdatingRegMode}
                        className={`p-4 rounded-2xl border text-left transition cursor-pointer ${
                          serverStats?.registration_mode === 'open'
                            ? 'bg-emerald-500/15 border-emerald-500/60 shadow-lg shadow-emerald-500/10'
                            : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center space-x-2 mb-1.5">
                          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                          <span className="text-xs font-black text-slate-100">🟢 自由登録 (オープン)</span>
                        </div>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          誰でも自由にアカウントを作成できます。一般的なパブリックサーバー向けの設定です。
                        </p>
                      </button>

                      {/* 招待制 */}
                      <button
                        type="button"
                        onClick={() => handleChangeRegistrationMode('invite')}
                        disabled={isUpdatingRegMode}
                        className={`p-4 rounded-2xl border text-left transition cursor-pointer ${
                          serverStats?.registration_mode === 'invite'
                            ? 'bg-amber-500/15 border-amber-500/60 shadow-lg shadow-amber-500/10'
                            : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center space-x-2 mb-1.5">
                          <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                          <span className="text-xs font-black text-slate-100">🟡 招待制 (コード必須)</span>
                        </div>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          有効な招待コードを持つ人のみ登録できます。身内やコミュニティ限定運用、スパム対策に最適です。
                        </p>
                      </button>

                      {/* 受付停止 */}
                      <button
                        type="button"
                        onClick={() => handleChangeRegistrationMode('closed')}
                        disabled={isUpdatingRegMode}
                        className={`p-4 rounded-2xl border text-left transition cursor-pointer ${
                          serverStats?.registration_mode === 'closed'
                            ? 'bg-rose-500/15 border-rose-500/60 shadow-lg shadow-rose-500/10'
                            : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center space-x-2 mb-1.5">
                          <span className="w-2.5 h-2.5 rounded-full bg-rose-400" />
                          <span className="text-xs font-black text-slate-100">🔴 新規登録一時停止</span>
                        </div>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          招待コードを含め、すべての新規アカウント登録を拒否します。メンテナンス時や閉鎖運用時に使用します。
                        </p>
                      </button>
                    </div>
                  </div>

                  {/* 招待コード新規発行カード */}
                  <form onSubmit={handleCreateInvitation} className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
                    <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-2">
                      <Ticket className="w-4 h-4 text-cyan-400" />
                      <span>新規招待コードを発行</span>
                    </h3>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-xs font-bold text-slate-300 mb-1">
                          最大使用可能回数
                        </label>
                        <select
                          value={newInviteMaxUses}
                          onChange={(e) => setNewInviteMaxUses(parseInt(e.target.value, 10))}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        >
                          <option value={1}>1回のみ (個人用・使い捨て)</option>
                          <option value={5}>5回まで</option>
                          <option value={10}>10回まで</option>
                          <option value={50}>50回まで</option>
                          <option value={1000000}>無制限 (何人でも登録可)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-300 mb-1">
                          有効期限
                        </label>
                        <select
                          value={newInviteExpiresDays}
                          onChange={(e) => setNewInviteExpiresDays(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        >
                          <option value="1">1日間 (24時間)</option>
                          <option value="3">3日間</option>
                          <option value="7">7日間 (1週間)</option>
                          <option value="30">30日間 (約1ヶ月)</option>
                          <option value="infinite">無期限 (期限なし)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-slate-300 mb-1">
                          管理用メモ (任意)
                        </label>
                        <input
                          type="text"
                          placeholder="例: 友人Alice用, Discord配布用"
                          value={newInviteMemo}
                          onChange={(e) => setNewInviteMemo(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-slate-800/80">
                      <p className="text-[11px] text-slate-500">
                        ※ 発行されたコードは招待リンクとしてワンクリックでコピーできます。
                      </p>
                      <button
                        type="submit"
                        disabled={isCreatingInvite}
                        className="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-lg shadow-cyan-600/30 transition flex items-center space-x-1.5 cursor-pointer shrink-0"
                      >
                        {isCreatingInvite ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Plus className="w-3.5 h-3.5" />
                        )}
                        <span>{isCreatingInvite ? '発行中...' : '招待コードを発行'}</span>
                      </button>
                    </div>

                    {/* 通知メッセージ */}
                    {inviteActionMsg && (
                      <div
                        className={`p-3 rounded-xl text-xs flex items-center space-x-2 ${
                          inviteActionMsg.type === 'success'
                            ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
                        }`}
                      >
                        {inviteActionMsg.type === 'success' ? (
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 shrink-0" />
                        )}
                        <span>{inviteActionMsg.text}</span>
                      </div>
                    )}
                  </form>

                  {/* 発行済み招待コード一覧 */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-xl space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-2">
                        <Ticket className="w-4 h-4 text-indigo-400" />
                        <span>発行済み招待コード ({adminInvitations.length}件)</span>
                      </h3>
                      <button
                        type="button"
                        onClick={fetchAdminData}
                        className="p-1.5 text-slate-400 hover:text-slate-200 rounded-xl hover:bg-slate-800 transition text-xs flex items-center space-x-1"
                        title="一覧を更新"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>更新</span>
                      </button>
                    </div>

                    {adminInvitations.length === 0 ? (
                      <div className="p-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800/60">
                        <Ticket className="w-10 h-10 mx-auto text-slate-600 mb-2" />
                        <p className="text-xs text-slate-400 font-bold">まだ招待コードが発行されていません</p>
                        <p className="text-[11px] text-slate-500 mt-1">
                          上のフォームから招待コードを発行して、新メンバーを招待してみましょう。
                        </p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs border-collapse">
                          <thead>
                            <tr className="border-b border-slate-800 text-slate-400 text-[11px]">
                              <th className="py-2.5 px-3 font-semibold">招待コード / 招待URL</th>
                              <th className="py-2.5 px-3 font-semibold">使用状況</th>
                              <th className="py-2.5 px-3 font-semibold">有効期限</th>
                              <th className="py-2.5 px-3 font-semibold">用途メモ</th>
                              <th className="py-2.5 px-3 font-semibold">発行日</th>
                              <th className="py-2.5 px-3 font-semibold text-right">操作</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/60">
                            {adminInvitations.map((inv: any) => {
                              const isExpired = inv.expires_at && new Date(inv.expires_at) < new Date();
                              const isUsedUp = inv.max_uses > 0 && inv.used_count >= inv.max_uses;
                              const inviteUrl = `${window.location.origin}/?invite=${encodeURIComponent(inv.code)}`;

                              return (
                                <tr key={inv.code} className="hover:bg-slate-800/30 transition">
                                  <td className="py-3 px-3">
                                    <div className="flex items-center space-x-2">
                                      <span className="font-mono font-bold text-cyan-300 bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800">
                                        {inv.code}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          navigator.clipboard.writeText(inviteUrl);
                                          alert(`招待リンクをコピーしました！\n${inviteUrl}`);
                                        }}
                                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                                        title="招待リンクをコピー"
                                      >
                                        <Copy className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  </td>
                                  <td className="py-3 px-3">
                                    <div className="flex items-center space-x-1.5">
                                      <span className={`font-mono font-bold ${isUsedUp ? 'text-rose-400' : 'text-slate-200'}`}>
                                        {inv.used_count}
                                      </span>
                                      <span className="text-slate-500 font-mono">/</span>
                                      <span className="text-slate-400 font-mono">
                                        {inv.max_uses > 100000 ? '無制限' : inv.max_uses}
                                      </span>
                                      {isUsedUp && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 ml-1">
                                          上限到達
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="py-3 px-3">
                                    {inv.expires_at ? (
                                      <span className={`text-[11px] ${isExpired ? 'text-rose-400 line-through' : 'text-slate-300'}`}>
                                        {new Date(inv.expires_at).toLocaleString('ja-JP', {
                                          month: 'numeric',
                                          day: 'numeric',
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })}
                                      </span>
                                    ) : (
                                      <span className="text-[11px] text-emerald-400">無期限</span>
                                    )}
                                  </td>
                                  <td className="py-3 px-3 text-slate-300 max-w-xs truncate">
                                    {inv.memo || <span className="text-slate-500 italic">-</span>}
                                  </td>
                                  <td className="py-3 px-3 text-[11px] text-slate-500 font-mono">
                                    {new Date(inv.created_at).toLocaleDateString('ja-JP')}
                                  </td>
                                  <td className="py-3 px-3 text-right">
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteInvitation(inv.code)}
                                      className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
                                      title="招待コードを削除 / 無効化"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
    </>
  );
}
