/**
 * はじめての設定（/onboarding）。
 * 登録の直後に一度だけ通る 7 ステップの案内。途中で抜けてもよい
 * （各ステップで保存しながら進むので、入り直せば続きから）。
 * 最後に「完了」をサーバーへ伝える（onboarding_completed）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import ScreenHead from '../components/ScreenHead';
import StepWelcome from '../components/onboarding/StepWelcome';
import StepLook from '../components/onboarding/StepLook';
import StepProfile from '../components/onboarding/StepProfile';
import StepKeys from '../components/onboarding/StepKeys';
import StepPrivacy from '../components/onboarding/StepPrivacy';
import StepFollow from '../components/onboarding/StepFollow';
import StepDone from '../components/onboarding/StepDone';
import { navigate } from '../lib/router';
import { api } from '../lib/api';
import { loadProfileDraft, type Prefs, type ProfileDraft } from '../lib/settings';
import type { SessionUser } from '../lib/format';
import type { ThemeChoice } from '../lib/theme';

/** 登録直後のマスターキーは、この画面に渡すまでだけ預かる */
export const MASTER_KEY_HINT = 'spica_master_key_hint';

const STEP_COUNT = 7;

interface OnboardingViewProps {
  menuButton: ReactNode;
  user: SessionUser | null;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  prefs: Prefs;
  onPrefsChange: (prefs: Prefs) => void;
  onCompose: () => void;
  onFinished: () => void;
}

export default function OnboardingView({
  menuButton,
  user,
  theme,
  onTheme,
  prefs,
  onPrefsChange,
  onCompose,
  onFinished,
}: OnboardingViewProps) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [masterKey, setMasterKey] = useState('');

  useEffect(() => {
    const hint = window.sessionStorage.getItem(MASTER_KEY_HINT);
    if (hint) setMasterKey(hint);
  }, []);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      const loaded = await loadProfileDraft(user.id);
      if (loaded) setDraft(loaded);
    })();
  }, [user]);

  async function finish() {
    setBusy(true);
    await api.post('/api/me/onboarding/complete');
    window.sessionStorage.removeItem(MASTER_KEY_HINT);
    setBusy(false);
    onFinished();
    navigate('/');
  }

  if (!user) {
    return (
      <>
        <ScreenHead title="はじめての設定" menuButton={menuButton} />
        <div className="divider" />
        <div className="feed">
          <div className="feed__state">
            ログインすると使えます。
            <br />
            <button type="button" className="btn btn--text" onClick={() => navigate('/login')}>
              ログイン / 新規登録
            </button>
          </div>
        </div>
      </>
    );
  }

  const next = () => setStep((current) => Math.min(current + 1, STEP_COUNT - 1));
  const back = () => setStep((current) => Math.max(current - 1, 0));

  return (
    <>
      <ScreenHead title="はじめての設定" sub={`${step + 1} / ${STEP_COUNT}`} menuButton={menuButton} />
      <div className="wiz">
        {Array.from({ length: STEP_COUNT }).map((_, index) => (
          <span key={index} className={'wiz__seg' + (index === step ? ' wiz__seg--now' : ' wiz__seg--done')} />
        ))}
      </div>

      {step === 0 && <StepWelcome name={user.name || user.id} onNext={next} />}

      {step === 1 && (
        <StepLook
          theme={theme}
          onTheme={onTheme}
          prefs={prefs}
          onPrefsChange={onPrefsChange}
          onNext={next}
          onBack={back}
        />
      )}

      {step === 2 &&
        (draft ? (
          <StepProfile draft={draft} onChange={setDraft} onNext={next} onBack={back} />
        ) : (
          <div className="feed">
            <div className="feed__state">読み込んでいます…</div>
          </div>
        ))}

      {step === 3 && <StepKeys masterKey={masterKey} onNext={next} onBack={back} />}

      {step === 4 &&
        (draft ? (
          <StepPrivacy draft={draft} onChange={setDraft} onNext={next} onBack={back} />
        ) : (
          <div className="feed">
            <div className="feed__state">読み込んでいます…</div>
          </div>
        ))}

      {step === 5 && <StepFollow myId={user.id} onNext={next} onBack={back} />}

      {step === 6 && (
        <StepDone
          masterKey={masterKey}
          busy={busy}
          onCompose={onCompose}
          onFinish={() => void finish()}
          onBack={back}
        />
      )}
    </>
  );
}
