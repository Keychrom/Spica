/**
 * 初回設定 7/7: おわり。
 * 最初のノートを書くか、そのままタイムラインへ。
 */
import KeyBox from '../KeyBox';
import WizFoot from './WizFoot';

interface Props {
  masterKey?: string;
  busy: boolean;
  onCompose: () => void;
  onFinish: () => void;
  onBack: () => void;
}

export default function StepDone({ masterKey, busy, onCompose, onFinish, onBack }: Props) {

  return (
    <>
      <div className="wiz__step">
        <h2>準備できました</h2>
        <p className="wiz__lead">
          ここまでで、あなたのプロフィールと見た目が整いました。あとは書くだけです。
        </p>

        <div className="set">
          <div className="set__body">
            <span className="set__label">最初のノートを書く</span>
            <p className="set__hint">「はじめて使っています」の一言で十分です。</p>
          </div>
          <div className="set__control">
            <button type="button" className="btn btn--quiet" onClick={onCompose}>
              ノートを作成
            </button>
          </div>
        </div>

        {masterKey && (
          <div className="set">
            <div className="set__body">
              <span className="set__label">マスターキー（最後の表示です）</span>
              <p className="set__hint">まだ控えていないなら、いまコピーしてください。</p>
              <div style={{ marginTop: 10 }}>
                <KeyBox value={masterKey} />
              </div>
            </div>
          </div>
        )}
      </div>
      <WizFoot onBack={onBack} onNext={onFinish} nextLabel="タイムラインへ" busy={busy} />
    </>
  );
}
