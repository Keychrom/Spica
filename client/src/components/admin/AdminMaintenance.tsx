/**
 * 管理パネル ⑧メンテナンス（いまの大きさ・手動実行・自動実行の設定・キャッシュ）。
 */
import { useEffect, useState } from 'react';
import {
  clearImageProxyCache,
  clearTimelineCache,
  loadContentPolicy,
  loadMaintenance,
  runMaintenance,
  saveContentPolicy,
  saveMaintenanceSettings,
  type ContentPolicy,
  type MaintenanceState,
} from '../../lib/adminOps';
import { relativeTime } from '../../lib/format';

function mb(bytes: number | undefined): string {
  if (!bytes) return '0 MB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** 検索の索引に入れる範囲（/api/admin/content-policy） */
const FTS_SCOPES = [
  { value: 'local', label: 'ローカルのノートだけ（Mastodon / Misskey 相当・既定）' },
  { value: 'follows', label: 'ローカル＋フォロー中＋自分宛の返信' },
  { value: 'all', label: 'すべてのノート（従来の Spica）' },
];

/** リモートのブーストを保存するかどうか */
const ANNOUNCE_POLICIES = [
  { value: 'follows', label: 'フォロー中の人のブーストだけ保存（既定）' },
  { value: 'all', label: 'すべて保存（従来の Spica）' },
  { value: 'none', label: 'リモートのブーストは保存しない' },
];

export default function AdminMaintenance() {
  const [state, setState] = useState<MaintenanceState | null>(null);
  const [policy, setPolicy] = useState<ContentPolicy | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  async function load() {
    setState(await loadMaintenance());
    setPolicy(await loadContentPolicy());
  }

  useEffect(() => {
    void load();
  }, []);

  async function run(label: string, work: () => Promise<string | null>, message: string) {
    setBusy(label);
    setErr('');
    setOk('');
    const problem = await work();
    setBusy('');
    if (problem) {
      setErr(problem);
      return;
    }
    setOk(message);
    await load();
  }

  if (!state) return <div className="feed__state">読み込んでいます…</div>;

  const rows: [string, string][] = [
    ['データベース', mb(state.db?.sizeBytes)],
    ['書き込み中の一時ファイル', mb(state.db?.walBytes)],
    ['ノート（全体）', String(state.posts?.total ?? 0)],
    ['うち連合から', String(state.posts?.remote ?? 0)],
    ['片付けられる連合のノート', String(state.posts?.prunableRemote ?? 0)],
    ['検索の索引', String(state.posts?.ftsRows ?? 0)],
    ['メディア', `${state.media?.count ?? 0} 件 ・ ${mb(state.media?.bytes)}`],
    ['画像プロキシ', `${state.imageProxy?.files ?? 0} 件 ・ ${mb(state.imageProxy?.bytes)}`],
    ['連合のノートの保存期間', `${state.policy?.retentionDays ?? 30} 日`],
  ];

  const auto = state.automation?.enabled;
  const hour = state.automation?.hour ?? 4;
  const lastRun = state.automation?.lastRunAt;

  return (
    <>
      <div className="set__group">
        <h3>いまの大きさ</h3>
      </div>
      {rows.map(([label, value]) => (
        <div className="set" key={label}>
          <div className="set__body">
            <span className="set__label">{label}</span>
          </div>
          <div className="set__control">
            <span className="set__value">{value}</span>
          </div>
        </div>
      ))}

      <div className="set__group">
        <h3>手動で走らせる</h3>
        <p className="set__hint">古い連合のノートを片付け、バックアップを取ります。毎日 4 時以降に自動でも走ります。</p>
      </div>
      <div className="set">
        <div className="set__body" />
        <div className="set__control set__actions">
          <button
            type="button"
            className="btn btn--quiet"
            disabled={busy === 'run'}
            onClick={() => void run('run', runMaintenance, 'メンテナンスを実行しました。')}
          >
            {busy === 'run' ? '実行しています…' : 'いま実行する'}
          </button>
          <button
            type="button"
            className="btn btn--text"
            disabled={busy === 'cache'}
            onClick={() => void run('cache', clearTimelineCache, 'タイムラインのキャッシュを消しました。')}
          >
            タイムラインのキャッシュを消す
          </button>
          <button
            type="button"
            className="btn btn--text"
            disabled={busy === 'proxy'}
            onClick={() => void run('proxy', clearImageProxyCache, '画像プロキシのキャッシュを消しました。')}
          >
            画像プロキシを消す
          </button>
        </div>
      </div>

      <div className="set__group">
        <h3>リモートの扱い</h3>
        <p className="set__hint">
          変えたあと、既にあるノートにさかのぼって適用するにはサーバーで別のコマンドが要ります。
        </p>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">検索の索引に入れる範囲</span>
          <div className="set__form">
            <select
              className="field"
              value={policy?.ftsIndexScope || 'local'}
              aria-label="検索の索引に入れる範囲"
              onChange={(event) =>
                setPolicy((current) => (current ? { ...current, ftsIndexScope: event.target.value } : current))
              }
            >
              {FTS_SCOPES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">リモートのブースト</span>
          <div className="set__form">
            <select
              className="field"
              value={policy?.remoteAnnouncePolicy || 'follows'}
              aria-label="リモートのブースト"
              onChange={(event) =>
                setPolicy((current) => (current ? { ...current, remoteAnnouncePolicy: event.target.value } : current))
              }
            >
              {ANNOUNCE_POLICIES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="set">
        <div className="set__body" />
        <div className="set__control">
          <button
            type="button"
            className="btn btn--quiet"
            disabled={busy === 'policy' || !policy}
            onClick={() =>
              void run('policy', () => saveContentPolicy({ ...(policy as ContentPolicy) }), 'リモートの扱いを保存しました。')
            }
          >
            {busy === 'policy' ? '保存しています…' : '保存する'}
          </button>
        </div>
      </div>

      <div className="set__group">
        <h3>自動メンテナンスの設定</h3>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">毎日自動で走らせる</span>
          <p className="set__hint">
            実行する時刻（0〜23 時）: {hour} 時 ・{' '}
            {lastRun ? `最後は ${relativeTime(lastRun)}` : 'まだ走っていません'}
          </p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (auto ? ' sw--on' : '')}
            role="switch"
            aria-checked={Boolean(auto)}
            aria-label="毎日自動で走らせる"
            onClick={() =>
              void run('auto', () => saveMaintenanceSettings({ autoMaintenance: !auto }), '設定を変えました。')
            }
          />
        </div>
      </div>
      <div className="set">
        <div className="set__body">
          <span className="set__label">画像プロキシを使う</span>
          <p className="set__hint">ほかのサーバーの画像を、このサーバー経由で出す（相手に居場所を知られにくくします）。</p>
        </div>
        <div className="set__control">
          <button
            type="button"
            className={'sw' + (state.imageProxy?.enabled ? ' sw--on' : '')}
            role="switch"
            aria-checked={Boolean(state.imageProxy?.enabled)}
            aria-label="画像プロキシを使う"
            onClick={() =>
              void run(
                'proxyOn',
                () => saveMaintenanceSettings({ imageProxy: !state.imageProxy?.enabled }),
                '設定を変えました。',
              )
            }
          />
        </div>
      </div>

      {err && <p className="set__err">{err}</p>}
      {ok && <p className="set__ok">{ok}</p>}
    </>
  );
}
