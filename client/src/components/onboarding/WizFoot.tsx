/**
 * 初回設定の足元（戻る / 次へ）。ステップごとに出すものを変えられる。
 */
import type { ReactNode } from 'react';

interface WizFootProps {
  onBack?: () => void;
  onNext?: () => void;
  onSkip?: () => void;
  nextLabel?: string;
  disabled?: boolean;
  busy?: boolean;
  hint?: ReactNode;
}

export default function WizFoot({
  onBack,
  onNext,
  onSkip,
  nextLabel = '次へ',
  disabled,
  busy,
  hint,
}: WizFootProps) {
  return (
    <div className="wiz__foot">
      {onBack && (
        <button type="button" className="btn btn--text" onClick={onBack}>
          戻る
        </button>
      )}
      <span className="wiz__foot-grow">{hint}</span>
      {onSkip && (
        <button type="button" className="btn btn--text" onClick={onSkip}>
          スキップ
        </button>
      )}
      {onNext && (
        <button type="button" className="btn btn--outline" onClick={onNext} disabled={disabled || busy}>
          {busy ? '保存しています…' : nextLabel}
        </button>
      )}
    </div>
  );
}
