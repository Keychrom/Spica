/**
 * 管理パネルの通信 その4（ロール＝権限のまとまり）。
 * 権限は CSV の文字列で保存されている（'moderate,announce' など）。
 */
import { api, messageOf } from './api';

export interface AdminRole {
  id: string;
  name: string;
  color?: string;
  permissions?: string;
  is_system?: number | boolean;
  member_count?: number;
  created_at?: string;
}

export interface PermissionOption {
  key: string;
  label: string;
}

export interface RolesPayload {
  roles: AdminRole[];
  permissions: PermissionOption[];
}

export function permissionsOf(role: AdminRole): string[] {
  return String(role.permissions || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function loadRoles(): Promise<RolesPayload> {
  const res = await api.get('/api/admin/roles');
  if (!res.ok || !res.data || typeof res.data !== 'object') {
    return { roles: [], permissions: [] };
  }
  const data = res.data as { roles?: AdminRole[]; availablePermissions?: PermissionOption[] };
  return { roles: data.roles ?? [], permissions: data.availablePermissions ?? [] };
}

export async function createRole(name: string, color: string, permissions: string[]): Promise<string | null> {
  const res = await api.post('/api/admin/roles', { name, color, permissions });
  return res.ok ? null : messageOf(res.data, 'ロールを作成できませんでした。');
}

export async function updateRole(id: string, name: string, color: string, permissions: string[]): Promise<string | null> {
  const res = await api.put('/api/admin/roles/' + encodeURIComponent(id), { name, color, permissions });
  return res.ok ? null : messageOf(res.data, 'ロールを更新できませんでした。');
}

export async function setUserRoles(userId: string, roleIds: string[]): Promise<string | null> {
  const res = await api.post('/api/admin/users/' + encodeURIComponent(userId) + '/roles', { roleIds });
  return res.ok ? null : messageOf(res.data, 'ロールを変えられませんでした。');
}

export async function deleteRole(id: string): Promise<boolean> {
  return (await api.del('/api/admin/roles/' + encodeURIComponent(id))).ok;
}
