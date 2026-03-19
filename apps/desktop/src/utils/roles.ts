import type { MemberRole } from '@voxium/shared';

const ROLE_LEVELS: Record<MemberRole, number> = { owner: 3, admin: 2, member: 1 };

export function outranksRole(actor: MemberRole, target: MemberRole): boolean {
  return ROLE_LEVELS[actor] > ROLE_LEVELS[target];
}
