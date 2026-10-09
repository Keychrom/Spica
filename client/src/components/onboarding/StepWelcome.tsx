/**
 * 初回設定 1/7: ようこそ（Spica の約束）。
 */
import { Feather, KeyRound, Radio } from 'lucide-react';
import WizFoot from './WizFoot';

interface Props {
  name: string;
  onNext: () => void;
}

const PROMISES = [
  {
    icon: <KeyRound size={15} strokeWidth={1.6} />,
    title: '鍵はあなたの手に',
    text: 'アカウントはマスターキーで守られます。運営でも中身は覗けません。',
  },
  {
    icon: <Radio size={15} strokeWidth={1.6} />,
    title: 'ひとりでも、つながっても',
    text: 'このサーバーだけで使っても、ほかのサーバーの人とつながっても構いません。',
  },
  {
    icon: <Feather size={15} strokeWidth={1.6} />,
    title: '静かに読める場所',
    text: '目を引くための飾りは置いていません。読むことに集中できる画面にしてあります。',
  },
];

export default function StepWelcome({ name, onNext }: Props) {
  return (
    <>
      <div className="wiz__step">
        <h2>{name} さん、ようこそ</h2>
        <p className="wiz__lead">
          これから 7 つの画面で、見た目とプロフィールを整えます。1 分ほどで終わります。
          あとから設定でいつでも変えられます。
        </p>
        {PROMISES.map((promise) => (
          <div className="promise" key={promise.title}>
            <span className="promise__ico">{promise.icon}</span>
            <div>
              <b>{promise.title}</b>
              <p>{promise.text}</p>
            </div>
          </div>
        ))}
      </div>
      <WizFoot onNext={onNext} nextLabel="はじめる" />
    </>
  );
}
