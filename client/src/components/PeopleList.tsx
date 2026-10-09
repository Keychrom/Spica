/**
 * 人の一覧（フォロー / フォロワー / ブロック / ミュート）。
 * どの画面でも同じ 1 行を使う。
 */
import { navigate } from '../lib/router';
import { initialOf, personHandle, type Person } from '../lib/profile';

interface PeopleListProps {
  people: Person[];
  loading?: boolean;
  empty: string;
  /** 行の右に出すボタン（解除など） */
  action?: (person: Person) => React.ReactNode;
}

export default function PeopleList({ people, loading, empty, action }: PeopleListProps) {
  if (loading && people.length === 0) return <div className="feed__state">読み込んでいます…</div>;
  if (!loading && people.length === 0) return <div className="feed__state">{empty}</div>;

  return (
    <>
      {people.map((person) => {
        const handle = personHandle(person);
        return (
          <div className="people" key={person.id}>
            <span className="av av--s">
              {person.icon_url ? <img src={person.icon_url} alt="" /> : initialOf(person.name || person.username)}
            </span>
            <button type="button" className="people__body" onClick={() => navigate('/users/' + encodeURIComponent(person.id))}>
              <b>{person.name || person.username || handle}</b>
              <span>{handle}</span>
            </button>
            {action?.(person)}
          </div>
        );
      })}
    </>
  );
}
