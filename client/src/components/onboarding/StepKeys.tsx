/**
 * 初回設定 4/7: マスターキー。
 * 登録の直後だけ、そのキーを渡す（sessionStorage に一時的に置いてある）。
 * あとから見ることはできないので、控えたかの確認をする。
 */
import { useState } from 'react';
import KeyBox from '../KeyBox';
import WizFoot from './WizFoot';

interface Props {
  /** 登録直後にだけ渡る（無ければ説明だけ出す） */
  masterKey?: string;
  onNext: () => void;
  onBack: () => void;
}

export default function StepKeys({ masterKey, onNext, onBack }: Props) {
  const [kept, setKept] = useState(false);

  return (
    <>
      <div className="wiz__step">
        <h2>マスターキー</h2>
        <p className="wiz__lead">
          マスターキーは、あなたのアカウントを開ける唯一の鍵です。
          これがあれば、パスワードを忘れても戻ってこられます。逆に、失くすと誰にも戻せません。
        </p>

        {masterKey ? (
          <>
            <KeyBox value={masterKey} />
            <p className="set__hint">
              メモアプリでも、紙でもかまいません。人に見せないでください（この画面を離れると、二度と表示できません）。
            </p>
            <label className="auth__check">
              <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} />
              安全な場所に控えました
            </label>
          </>
        ) : (
          <>
            <p className="set__hint">
              いまはキーを表示できません（登録の直後にしか出せません）。控えたかどうかが不安なときは、
              設定 → アカウント でパスワードとメールアドレスを設定しておくと、マスターキーが手元に無くてもログインできます。
            </p>
            <label className="auth__check">
              <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} />
              マスターキーは控えてある（または設定でパスワードを用意する）
            </label>
          </>
        )}
      </div>
      <WizFoot
        onBack={onBack}
        onNext={onNext}
        disabled={masterKey ? !kept : false}
        hint={masterKey && !kept ? '控えたら次へ進めます' : undefined}
      />
    </>
  );
}
