/**
 * プロフィール（人）まわりの通信。
 * 取得は /api/users/:identifier、つながりは /api/followers と /api/following（userId 指定）。
 */
import { api } from './api';
import type { Post } from './format';

export interface ProfileField {
  name: string;
  value: string;
}

export interface ProfileRole {
  id?: string;
  name: string;
}

export interface Profile {
  id: string;
  name: string;
  summary: string;
  icon_url: string;
  banner_url: string;
  handle: string;
  domain: string;
  /** 相手の本体のURL（DM の許可リストはこれで持つ） */
  actor_url?: string;
  is_local: boolean;
  is_locked: boolean;
  discoverable?: boolean;
  fields?: ProfileField[];
  roles?: ProfileRole[];
  created_at?: string;
  follower_count?: number;
  following_count?: number;
  post_count?: number;
  is_following?: boolean;
  is_blocked?: boolean;
  is_muted?: boolean;
  is_blocking_me?: boolean;
  pinned_posts?: Post[];
}

/** つながりの 1 人（フォロー / フォロワー / ブロック / ミュート） */
export interface Person {
  id: string;
  name?: string;
  /** フォロー一覧は username + domain、ブロック/ミュート一覧は handle で来る */
  username?: string;
  domain?: string;
  handle?: string;
  icon_url?: string;
  created_at?: string;
  /** ブロック/ミュート一覧の id はユーザー ID（actor URL ではない） */
  user_id?: string;
}

export function personHandle(person: Person): string {
  if (person.handle) return person.handle.startsWith('@') ? person.handle : '@' + person.handle;
  const username = person.username || person.id.split('/').pop() || '';
  return person.domain ? `@${username}@${person.domain}` : `@${username}`;
}

/** フォロー/解除に渡すハンドル（サーバーは @user@domain を期待する） */
export function personTarget(person: Person): string {
  const handle = personHandle(person);
  return handle.startsWith('@') ? handle : '@' + handle;
}

/** アイコンが無いときの 1 文字 */
export function initialOf(nameOrId: string | undefined): string {
  return (nameOrId || '?').slice(0, 1);
}

export async function loadProfile(identifier: string): Promise<Profile | null> {
  const res = await api.get('/api/users/' + encodeURIComponent(identifier));
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  return res.data as Profile;
}

export async function loadUserPosts(identifier: string): Promise<Post[]> {
  const res = await api.get('/api/users/' + encodeURIComponent(identifier) + '/posts');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as Post[];
}

export async function loadPeople(kind: 'followers' | 'following', userId: string): Promise<Person[]> {
  const res = await api.get('/api/' + kind + '?userId=' + encodeURIComponent(userId));
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as Person[];
}

export async function loadBlocks(): Promise<Person[]> {
  const res = await api.get('/api/user/blocks');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as Person[];
}

export async function loadMutes(): Promise<Person[]> {
  const res = await api.get('/api/user/mutes');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as Person[];
}

/** targetHandle は @user@domain の形（サーバーの期待どおり） */
export async function follow(handle: string): Promise<boolean> {
  const res = await api.post('/api/follow', { targetHandle: handle });
  return res.ok;
}

export async function unfollow(handle: string): Promise<boolean> {
  const res = await api.post('/api/unfollow', { targetHandle: handle });
  return res.ok;
}

type Relation = 'mute' | 'unmute' | 'block' | 'unblock';

export async function setRelation(identifier: string, action: Relation): Promise<boolean> {
  const res = await api.post('/api/users/' + encodeURIComponent(identifier) + '/' + action);
  return res.ok;
}

export async function togglePin(postId: string): Promise<boolean> {
  const res = await api.post('/api/posts/pin/toggle', { postId });
  return res.ok;
}

/** 承認待ちのフォロー（リモートから承認制のアカウントへ） */
export interface FollowRequest {
  id: string;
  actor_url: string;
  handle?: string;
  name?: string;
  icon_url?: string;
  created_at?: string;
}

export async function loadFollowRequests(): Promise<FollowRequest[]> {
  const res = await api.get('/api/follow-requests');
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data as FollowRequest[];
}

export async function respondFollowRequest(actorUrl: string, action: 'accept' | 'reject'): Promise<boolean> {
  const res = await api.post('/api/follow-requests/respond', { actorUrl, action });
  return res.ok;
}

/** 見ている人のプロフィールで、フォローの状態を反転させる（楽観更新用） */
export function flipFollow(profile: Profile): Profile {
  const next = !profile.is_following;
  return {
    ...profile,
    is_following: next,
    follower_count: Math.max(0, (profile.follower_count ?? 0) + (next ? 1 : -1)),
  };
}
