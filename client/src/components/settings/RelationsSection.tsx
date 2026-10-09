/**
 * 設定 → つながり（ブロック・ミュートの一覧、承認待ちのフォロー）。
 */
import { useEffect, useState } from 'react';
import PeopleList from '../PeopleList';
import {
  loadBlocks,
  loadFollowRequests,
  loadMutes,
  respondFollowRequest,
  personHandle,
  setRelation,
  type FollowRequest,
  type Person,
} from '../../lib/profile';
import { relativeTime } from '../../lib/format';
import { addMutedWord, loadMutedWords, removeMutedWord, type MutedWord } from '../../lib/settings';
import DMReach from './DMReach';
import DomainMutes from './DomainMutes';

export default function RelationsSection() {
  const [blocks, setBlocks] = useState<Person[]>([]);
  const [mutes, setMutes] = useState<Person[]>([]);
  const [requests, setRequests] = useState<FollowRequest[]>([]);
  const [words, setWords] = useState<MutedWord[]>([]);
  const [wordInput, setWordInput] = useState('');
  const [wordErr, setWordErr] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const [nextBlocks, nextMutes, nextRequests, nextWords] = await Promise.all([
        loadBlocks(),
        loadMutes(),
        loadFollowRequests(),
        loadMutedWords(),
      ]);
      setBlocks(nextBlocks);
      setMutes(nextMutes);
      setRequests(nextRequests);
      setWords(nextWords);
      setLoading(false);
    })();
  }, []);

  async function respond(request: FollowRequest, action: 'accept' | 'reject') {
    if (await respondFollowRequest(request.actor_url, action)) {
      setRequests((current) => current.filter((item) => item.id !== request.id));
    }
  }

  return (
    <>
      {requests.length > 0 && (
        <>
          <div className="set__group">
            <h3>承認待ちのフォロー</h3>
            <p className="set__hint">承認制にしていると、リモートからのフォローはここで待ちます。</p>
          </div>
          <div className="feed" style={{ padding: 0 }}>
            {requests.map((request) => (
              <div className="people" key={request.id}>
                <span className="av av--s">
                  {request.icon_url ? <img src={request.icon_url} alt="" /> : (request.name || '?').slice(0, 1)}
                </span>
                <div className="people__body">
                  <b>{request.name || request.handle || request.actor_url}</b>
                  <span>
                    {request.handle || ''} {request.created_at ? `・ ${relativeTime(request.created_at)}` : ''}
                  </span>
                </div>
                <button type="button" className="btn btn--quiet" onClick={() => void respond(request, 'accept')}>
                  承認
                </button>
                <button type="button" className="btn btn--quiet" onClick={() => void respond(request, 'reject')}>
                  断る
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="set__group">
        <h3>ミュート（{mutes.length}）</h3>
        <p className="set__hint">ミュートした人のノートは、タイムラインに出てきません。</p>
      </div>
      <div className="feed" style={{ padding: 0 }}>
        <PeopleList
          people={mutes}
          loading={loading}
          empty="ミュートしている人はいません。"
          action={(person) => (
            <button
              type="button"
              className="btn btn--text"
              onClick={() =>
                void (async () => {
                  if (await setRelation(personHandle(person).replace(/^@/, ''), 'unmute')) {
                    setMutes((current) => current.filter((item) => item.id !== person.id));
                  }
                })()
              }
            >
              解除
            </button>
          )}
        />
      </div>

      <div className="set__group">
        <h3>ミュートワード（{words.length}）</h3>
        <p className="set__hint">
          この言葉を含むノートを、タイムラインで畳みます（例: ネタバレ、特定の名前）。
        </p>
      </div>
      <div className="set">
        <div className="set__body">
          <div className="set__form" style={{ maxWidth: 320 }}>
            <input
              className="field"
              value={wordInput}
              placeholder="キーワード"
              onChange={(event) => setWordInput(event.target.value)}
            />
          </div>
          {wordErr && <p className="set__err">{wordErr}</p>}
        </div>
        <div className="set__control">
          <button
            type="button"
            className="btn btn--quiet"
            disabled={!wordInput.trim()}
            onClick={() =>
              void (async () => {
                setWordErr('');
                const problem = await addMutedWord(wordInput.trim());
                if (problem) {
                  setWordErr(problem);
                  return;
                }
                setWordInput('');
                setWords(await loadMutedWords());
              })()
            }
          >
            追加
          </button>
        </div>
      </div>
      {words.map((word) => (
        <div className="set" key={word.id}>
          <div className="set__body">
            <span className="set__label">{word.keyword}</span>
            <p className="set__hint">{word.created_at ? `${relativeTime(word.created_at)}に追加` : ''}</p>
          </div>
          <div className="set__control">
            <button
              type="button"
              className="btn btn--text"
              onClick={() =>
                void (async () => {
                  if (await removeMutedWord(word.id)) {
                    setWords((current) => current.filter((item) => item.id !== word.id));
                  }
                })()
              }
            >
              削除
            </button>
          </div>
        </div>
      ))}

      <DMReach />
      <DomainMutes />

      <div className="set__group">
        <h3>ブロック（{blocks.length}）</h3>
        <p className="set__hint">ブロックした人は、こちらのノートを見られません（フォローも外れます）。</p>
      </div>
      <div className="feed" style={{ padding: 0 }}>
        <PeopleList
          people={blocks}
          loading={loading}
          empty="ブロックしている人はいません。"
          action={(person) => (
            <button
              type="button"
              className="btn btn--text"
              onClick={() =>
                void (async () => {
                  if (await setRelation(personHandle(person).replace(/^@/, ''), 'unblock')) {
                    setBlocks((current) => current.filter((item) => item.id !== person.id));
                  }
                })()
              }
            >
              解除
            </button>
          )}
        />
      </div>
    </>
  );
}
