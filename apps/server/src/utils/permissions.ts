import type { MemberRole } from '@voxium/shared';

const ROLE_LEVEL: Record<MemberRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

export function outranks(actorRole: MemberRole, targetRole: MemberRole): boolean {
  return ROLE_LEVEL[actorRole] > ROLE_LEVEL[targetRole];
}

export function isAdminOrOwner(role: MemberRole): boolean {
  return role === 'owner' || role === 'admin';
}
