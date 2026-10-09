/**
 * 設定 → つながり → DM（1対1のメッセージ）の受け取り。
 * 既定は「誰からも受け取らない」。許可した相手だけ通す。
 * 保存するのは相手の actor URL（サーバーはそれで見分けている）。
 */
import { useEffect, useState } from 'react';
import { dmEnabled, loadDmPrefs, saveDmPrefs, type DmPolicy, type DmPrefs } from '../../lib/me';
import { loadProfile } from '../../lib/profile';

export default function DMReach() {
  const [prefs, setPrefs] = useState<DmPrefs | null>(null);
  const [available, setAvailable] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    void (async () => {
      const [nextPrefs, enabled] = await Promise.all([loadDmPrefs(), dmEnabled()]);
      setPrefs(nextPrefs);
      setAvailable(enabled);
    })();
  }, []);

  async function setPolicy(policy: DmPolicy) {
    if (!prefs) return;
    setPrefs({ ...prefs, dmPolicy: policy });
    const problem = await saveDmPrefs({ dmPolicy: policy });
    if (problem) setErr(problem);
  }

  async function add() {
    if (!prefs) return;
    const raw = input.trim();
    if (!raw) return;
    setBusy(true);
    setErr('');
    let actor = raw;
    if (!/^https?:/i.test(raw)) {
      const profile = await loadProfile(raw.replace(/^@/, ''));
      if (!profile) {
        setBusy(false);
        setErr('その人が見つかりませんでした。');
        return;
      }
      actor = profile.actor_url || '';
      if (!actor) {
        setBusy(false);
        setErr('この相手の宛先が分かりませんでした。プロフィールのURLを貼ってください。');
        return;
      }
    }
    if (prefs.dmAllow.includes(actor)) {
      setBusy(false);
      setErr('もう入っています。');
      return;
    }
    const problem = await saveDmPrefs({ dmAllow: [...prefs.dmAllow, actor] });
    setBusy(false);
    if (problem) {
      setErr(problem);
      return;
    }
    setPrefs({ ...prefs, dmAllow: [...prefs.dmAllow, actor] });
    setInput('');
  }

  async function remove(actor: string) {
    if (!prefs) return;
    const problem = await saveDmPrefs({ dmAllow: prefs.dmAllow.filter((item) => item !== actor) });
    if (problem) {
      setErr(problem);
      return;
    }
    setPrefs({ ...prefs, dmAllow: prefs.dmAllow.filter((item) => item !== actor) });
  }

  if (!prefs) return null;

  if (!available) {
    return (
      <div className="set">
        <div className="set__body">
          <span className="set__label">メッセージ（DM）の受け取り</span>
          <p className="set__hint">このサーバーではメッセージを使わない設定になっています。</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="set__group">
        <h3>メッセージ（DM）の受け取り</h3>
        <p className="set__hint">知らない人からのメッセージを防ぐため、既定では誰からも受け取りません。</p>
      </div>

      <div className="set">
        <div className="set__body">
          <label className="checkline">
            <input
              type="radio"
              name="dmPolicy"
              checked={prefs.dmPolicy === 'noone'}
              onChange={() => void setPolicy('noone')}
            />
            <span>誰からも受け取らない</span>
          </label>
          <label className="checkline">
            <input
              type="radio"
              name="dmPolicy"
              checked={prefs.dmPolicy === 'allowlist'}
              onChange={() => void setPolicy('allowlist')}
            />
            <span>許可した相手だけ受け取る</span>
          </label>
        </div>
      </div>

      {prefs.dmPolicy === 'allowlist' && (
        <>
          {prefs.dmAllow.length === 0 && (
            <div className="feed__state">まだ誰も許可していません。このままでは誰からも受け取りません。</div>
          )}
          {prefs.dmAllow.map((actor) => (
            <div className="set" key={actor}>
              <div className="set__body">
                <span className="set__label" style={{ wordBreak: 'break-all' }}>{actor}</span>
              </div>
              <div className="set__control">
                <button type="button" className="btn btn--text" onClick={() => void remove(actor)}>
                  外す
                </button>
              </div>
            </div>
          ))}

          <div className="set">
            <div className="set__body">
              <span className="set__label">許可する相手を足す</span>
              <p className="set__hint">@user@example.com のように書くか、プロフィールのURLを貼ってください。</p>
              <div className="set__form">
                <input
                  className="field"
                  value={input}
                  placeholder="@user@example.com"
                  onChange={(event) => setInput(event.target.value)}
                />
                <button type="button" className="btn btn--quiet" disabled={busy || !input.trim()} onClick={() => void add()}>
                  {busy ? '探しています…' : '足す'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {err && <p className="set__err">{err}</p>}
    </>
  );
}
