import type { Prisma } from '../generated/prisma/client';
import { prisma } from './prisma';
import type { AuditAction } from '@voxium/shared';

interface AuditEventParams {
  /** null for something the SERVER did on its own — a scheduled job has no
   *  actor, and the column is nullable precisely so those are still auditable. */
  actorId: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Fire-and-forget audit log writer.
 * Callers should NOT await this — audit logging must never block or break admin operations.
 */
export function logAuditEvent(params: AuditEventParams): void {
  prisma.auditLog
    .create({
      data: {
        actorId: params.actorId,
        action: params.action,
        targetType: params.targetType ?? null,
        targetId: params.targetId ?? null,
        metadata: (params.metadata as Prisma.InputJsonValue) ?? undefined,
      },
    })
    .catch((err) => {
      console.error('[AuditLog] Failed to write audit event:', err?.message ?? err);
    });
}
