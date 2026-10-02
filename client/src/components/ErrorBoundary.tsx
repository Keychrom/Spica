import React from 'react';

/**
 * エラー境界（白画面にしない）
 *
 * ルートと画面ごとに 1 つずつ置く。描画中に例外が出ても、ここで受け止めて
 * 「再読み込み」を出す（チャンクの読み込み失敗もここで受ける）。
 */
interface Props {
  children: React.ReactNode;
  /** 画面名（メッセージに出す） */
  label?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 画面に出さない情報（スタック）はコンソールへ
    console.error('[ErrorBoundary]', this.props.label || 'root', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const label = this.props.label ? `${this.props.label} の表示中に` : '';
    return (
      <div className="m-4 p-5 rounded-2xl bg-slate-900 border border-rose-500/40 space-y-3">
        <h2 className="text-sm font-bold text-rose-300">⚠️ {label}エラーが発生しました</h2>
        <p className="text-xs text-slate-300 leading-relaxed">
          この部分だけを表示できませんでした。他の画面はそのまま使えます。
          再読み込みで直ることがあります。
        </p>
        <pre className="text-[11px] text-slate-400 bg-slate-950/60 rounded-xl p-3 overflow-x-auto whitespace-pre-wrap break-all">
          {this.state.error.message}
        </pre>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition cursor-pointer"
          >
            もう一度表示する
          </button>
          <button
            type="button"
            onClick={() => { window.location.href = '/'; }}
            className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition cursor-pointer"
          >
            タイムラインへ
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition cursor-pointer"
          >
            再読み込み
          </button>
        </div>
      </div>
    );
  }
}
