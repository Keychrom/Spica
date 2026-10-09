/**
 * 描画の途中で例外が出ても、白い画面で終わらせない。
 * 「もう一度表示する」と「ホームへ戻る」で復帰できるようにする。
 * 画面ごとに使うときは resetKey（現在地）を渡すと、別の画面へ移った時点で解除される。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** これが変わったら、エラー表示を解除してやり直す */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[Spica] 描画エラー', error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <p className="crash__title">表示できませんでした</p>
        <p className="crash__detail">{error.message}</p>
        <div className="crash__actions">
          <button type="button" className="btn btn--solid" onClick={() => this.setState({ error: null })}>
            もう一度表示する
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              window.location.href = '/';
            }}
          >
            ホームへ戻る
          </button>
        </div>
      </div>
    );
  }
}
