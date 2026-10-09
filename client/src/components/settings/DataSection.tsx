/**
 * 設定 → データ（自分のノートの持ち出し）。
 * ・JSON（機械で読む用）と ZIP（人が見る用: HTML とメディア）を選べる
 * ・作るのには時間がかかるので、状態を見に行く（pending → running → done）
 */
import { useEffect, useRef, useState } from 'react';
import { loadExport, startExport, type ExportJob } from '../../lib/settings';
import { api, messageOf } from '../../lib/api';
import ReactionHistory from './ReactionHistory';

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '準備しています…',
  running: 'まとめています…',
  done: 'できました',
  failed: '失敗しました',
};

export default function DataSection() {
  const [job, setJob] = useState<ExportJob | null>(null);
  const [importMsg, setImportMsg] = useState('');
  const [importing, setImporting] = useState(false);
  const [format, setFormat] = useState<'json' | 'zip'>('zip');
  const [err, setErr] = useState('');
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, []);

  function watch(jobId: string) {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(() => {
      void (async () => {
        const next = await loadExport(jobId);
        if (!next) return;
        setJob(next);
        if (next.status === 'done' || next.status === 'failed') {
          if (timer.current) window.clearInterval(timer.current);
        }
      })();
    }, 2000);
  }

  async function start() {
    setErr('');
    setJob(null);
    const started = await startExport(format);
    if (typeof started === 'string') {
      setErr(started);
      return;
    }
    if (started.jobId) {
      setJob(started);
      watch(started.jobId);
    }
  }

  const status = job?.status || '';

  return (
    <>
      <div className="set__group">
        <h3>自分のノートを持ち出す</h3>
        <p className="set__hint">
          ノート・プロフィール・フォローの一覧をまとめて 1 つのファイルにします。作るのには少し時間がかかります。
        </p>
      </div>

      <div className="set">
        <div className="set__body">
          <span className="set__label">形式</span>
          <p className="set__hint">ZIP は人が読める HTML つき。JSON は機械で読みたいとき。</p>
        </div>
        <div className="set__control">
          <div className="seg">
            <button
              type="button"
              className={'seg__t' + (format === 'zip' ? ' seg__t--on' : '')}
              onClick={() => setFormat('zip')}
            >
              ZIP
            </button>
            <button
              type="button"
              className={'seg__t' + (format === 'json' ? ' seg__t--on' : '')}
              onClick={() => setFormat('json')}
            >
              JSON
            </button>
          </div>
          <button type="button" className="btn btn--quiet" onClick={() => void start()} disabled={status === 'pending' || status === 'running'}>
            作りはじめる
          </button>
        </div>
      </div>

      {job && (
        <div className="set">
          <div className="set__body">
            <span className="set__label">{STATUS_LABEL[status] || status}</span>
            <p className="set__hint">
              {job.filename || ''} {formatBytes(job.bytes)}
              {job.error ? ` ／ ${job.error}` : ''}
            </p>
          </div>
          <div className="set__control">
            {status === 'done' && job.jobId && (
              <a className="btn btn--quiet" href={'/api/user/export/' + encodeURIComponent(job.jobId) + '/file'}>
                ダウンロード
              </a>
            )}
          </div>
        </div>
      )}

      {err && <p className="set__err">{err}</p>}

      <ReactionHistory />
      <p className="set__hint">※ ダウンロードできるのは 1 回だけです。終わったら、もう一度作り直してください。</p>

      <div className="set__group">
        <h3>持ち出したものを取り込む</h3>
        <p className="set__hint">
          前に持ち出した ZIP（または JSON）を選ぶと、ノートを読み込みます（同じ投稿は二重になりません）。
        </p>
      </div>
      <div className="set">
        <div className="set__body">
          <input
            type="file"
            accept=".zip,.json,application/zip,application/json"
            onChange={(event) => {
              const file = event.target.files ? event.target.files[0] : null;
              if (!file) return;
              void (async () => {
                setImporting(true);
                setImportMsg('');
                const form = new FormData();
                form.append('file', file);
                const res = await api.post('/api/import/archive', form);
                setImporting(false);
                if (res.ok && res.data) {
                  const data = res.data as { imported?: number; skipped?: number; message?: string };
                  setImportMsg(
                    data.message ||
                      '取り込みました（追加 ' + (data.imported || 0) + ' 件 / そのまま ' + (data.skipped || 0) + ' 件）。',
                  );
                } else {
                  setImportMsg(messageOf(res.data, '取り込めませんでした。'));
                }
              })();
            }}
          />
          {importing && <p className="set__hint">取り込んでいます…</p>}
          {importMsg && <p className="set__ok">{importMsg}</p>}
        </div>
      </div>
    </>
  );
}
