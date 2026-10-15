/**
 * 通知音。`client/public/sounds/*.mp3` を鳴らす。
 *
 * ・`SOUNDS` は**実ファイルと 1 対 1**（足すときは public/sounds/ に置いてここにも書く）
 * ・サーバー側の検証（`server/src/userPrefs.ts` の `SOUND_IDS`）と**揃えること**
 * ・ブラウザは「そのページで最初に操作する前」の再生を止める。鳴らないときは黙って諦める
 *   （エラーにしない。ログインの操作をしていれば、たいてい鳴る）
 */
import { useEffect } from 'react';
import { getPrefs } from './prefs';

export interface SoundOption {
  id: string;
  label: string;
  file: string;
}

/** 選べる音（id はファイル名から拡張子を除いたもの） */
export const SOUNDS: SoundOption[] = [
  { id: 'CalmBell', label: 'Calm Bell — 落ち着いたベル', file: 'CalmBell.mp3' },
  { id: 'CrystalSignal', label: 'Crystal Signal — 澄んだ合図', file: 'CrystalSignal.mp3' },
  { id: 'LittleSpark', label: 'Little Spark — 小さくはじける', file: 'LittleSpark.mp3' },
  { id: 'LoungeChime', label: 'Lounge Chime — ラウンジのチャイム', file: 'LoungeChime.mp3' },
  { id: 'PoliteClick', label: 'Polite Click — 控えめなクリック', file: 'PoliteClick.mp3' },
  { id: 'CrystalSounds', label: 'Crystal Sounds — クリスタルの音', file: 'CrystalSounds.mp3' },
  { id: 'LittleChime', label: 'Little Chime — 小さなチャイム', file: 'LittleChime.mp3' },
  { id: 'PopSignal', label: 'Pop Signal — ポンと弾ける', file: 'PopSignal.mp3' },
];

/** 鳴らさない（設定で選べる） */
export const SOUND_OFF = '';

/**
 * 設定が未保存のときの表示（**サーバー側の既定と同じにする**。
 * 実際の既定は `server/src/userPrefs.ts` の `USER_PREFS_DEFAULTS`）
 */
export const DEFAULT_SOUND_ON_NOTE = 'LittleSpark';
export const DEFAULT_SOUND_ON_POST = 'PopSignal';

const cache = new Map<string, HTMLAudioElement>();

/**
 * 連続して鳴らさない最短間隔（ミリ秒）。
 * 連合の burst（リレーがまとめて流し込む時間帯）では新着が毎秒何十件も来るので、
 * そのまま鳴らすと音が繋がって不快になる。**間隔を空けた 1 回だけ鳴らす**
 * （ふつうの使い方では 1 件ごとに鳴っているのと変わらない）。
 */
const NOTE_COOLDOWN_MS = 1200;
let lastNotePlayedAt = 0;

function optionOf(id: string): SoundOption | null {
  return SOUNDS.find((sound) => sound.id === id) ?? null;
}

/** 1 回鳴らす（連打しても重ならないよう、毎回頭から） */
export function playSound(id: unknown): void {
  if (typeof id !== 'string' || !id) return;
  const option = optionOf(id);
  if (!option) return;
  try {
    let audio = cache.get(option.id);
    if (!audio) {
      audio = new Audio('/sounds/' + option.file);
      audio.preload = 'auto';
      cache.set(option.id, audio);
    }
    audio.currentTime = 0;
    void audio.play().catch(() => {
      /* 操作前・無音設定の端末では鳴らない（異常ではない） */
    });
  } catch {
    /* Audio が使えない環境では無音のまま */
  }
}

/**
 * 鳴らす場所は 2 つだけ:
 *  ・新着ノート（SSE の note）— **いま表示しているタイムラインの分だけ**届く
 *    （`streamScope.streamsFor` の申告で絞る。連合を表示中なら連合の受信、ホームなら
 *     ホームに来た分、ローカルならローカルだけ。タイムラインを出していない画面では届かない）
 *  ・自分の投稿（Composer が投稿できたときだけ出す `spica:post-sent`。
 *    下書きの保存・予約の受付では出ない＝鳴らない）
 * 自分の投稿は新着としても流れてくるので、**作者が自分なら新着の音は鳴らさない**（二重に鳴らさない）。
 */
export function useSounds(signedIn: boolean, meId: string | null): void {
  useEffect(() => {
    if (!signedIn) return;
    const onNote = (event: Event) => {
      const post = (event as CustomEvent<{ post?: { user_id?: string } }>).detail?.post;
      if (!post) return;
      if (meId && post.user_id && post.user_id === meId) return;
      const now = Date.now();
      if (now - lastNotePlayedAt < NOTE_COOLDOWN_MS) return;
      lastNotePlayedAt = now;
      const prefs = getPrefs();
      playSound(typeof prefs.soundOnNote === 'string' ? prefs.soundOnNote : DEFAULT_SOUND_ON_NOTE);
    };
    const onPosted = () => {
      const prefs = getPrefs();
      playSound(typeof prefs.soundOnPost === 'string' ? prefs.soundOnPost : DEFAULT_SOUND_ON_POST);
    };
    window.addEventListener('spica:stream-note', onNote);
    window.addEventListener('spica:post-sent', onPosted);
    return () => {
      window.removeEventListener('spica:stream-note', onNote);
      window.removeEventListener('spica:post-sent', onPosted);
    };
  }, [signedIn, meId]);
}
