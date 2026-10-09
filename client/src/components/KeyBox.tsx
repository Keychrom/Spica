/**
 * マスターキーの箱（長い 1 語を枠内で折り返して、ワンクリックでコピー）。
 * 登録直後の案内・初回設定・完了画面で同じものを使う。
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface KeyBoxProps {
  value: string;
}

export default function KeyBox({ value }: KeyBoxProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="keybox">
      <code>{value}</code>
      <button type="button" className="btn btn--quiet" onClick={() => void copy()}>
        {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.6} />}
        {copied ? 'コピーしました' : 'コピー'}
      </button>
    </div>
  );
}
