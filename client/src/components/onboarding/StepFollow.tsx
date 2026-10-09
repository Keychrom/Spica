/**
 * 初回設定 6/7: フォロー（おすすめから数人）。
 * だれも選ばなくても進める（サーバーが静かだと、タイムラインが空のままになるため）。
 */
import { useEffect, useState } from 'react';
import WizFoot from './WizFoot';
import { api } from '../../lib/api';
import { initialOf, type Person } from '../../lib/profile';

interface Props {
  /** 自分のユーザー ID（おすすめから除く） */
  myId: string;
  onNext: () => void;
  onBack: () => void;
}

export default function StepFollow({ myId, onNext, onBack }: Props) {
  const [people, setPeople] = useState<Person[]>([]);
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const res = await api.get('/api/directory', { auth: false });
      if (res.ok && res.data && typeof res.data === 'object') {
        const users = ((res.data as { users?: Person[] }).users ?? []).filter((user) => user.id !== myId);
        setPeople(users.slice(0, 6));
      }
      setLoading(false);
    })();
  }, [myId]);

  async function toggle(person: Person) {
    const handle = person.handle || `@${person.username || person.id}`;
    const target = handle.startsWith('@') ? handle : '@' + handle;
    const next = new Set(following);
    if (next.has(person.id)) {
      next.delete(person.id);
      setFollowing(next);
      await api.post('/api/unfollow', { targetHandle: target });
      return;
    }
    next.add(person.id);
    setFollowing(next);
    await api.post('/api/follow', { targetHandle: target });
  }

  return (
    <>
      <div className="wiz__step">
        <h2>だれかをフォロー</h2>
        <p className="wiz__lead">
          フォローすると、その人のノートがホームに並びます。まだ決められないときは、そのまま進んでも大丈夫です。
        </p>

        {loading && <div className="feed__state">読み込んでいます…</div>}
        {!loading && people.length === 0 && (
          <div className="feed__state">このサーバーには、まだほかの人がいません。</div>
        )}

        {people.map((person) => {
          const on = following.has(person.id);
          return (
            <div className="people" key={person.id}>
              <span className="av av--s">
                {person.icon_url ? <img src={person.icon_url} alt="" /> : initialOf(person.name)}
              </span>
              <div className="people__body">
                <b>{person.name || person.username}</b>
                <span>{person.handle || (person.username ? '@' + person.username : '')}</span>
              </div>
              <button
                type="button"
                className={on ? 'btn btn--quiet' : 'btn btn--outline'}
                onClick={() => void toggle(person)}
              >
                {on ? 'フォロー中' : 'フォロー'}
              </button>
            </div>
          );
        })}
      </div>
      <WizFoot onBack={onBack} onNext={onNext} />
    </>
  );
}
