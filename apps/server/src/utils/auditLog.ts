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
 * The row an audit event is stored as. For an event that must commit with
 * the change it records (a ban: the row is part of the ban's transaction,
 * `tx.auditLog.create({ data: auditLogData(...) })`), where the
 * fire-and-forget writer below could lose it to a later step's failure.
 */
export function auditLogData(params: AuditEventParams): Prisma.AuditLogUncheckedCreateInput {
  return {
    actorId: params.actorId,
    action: params.action,
    targetType: params.targetType ?? null,
    targetId: params.targetId ?? null,
    metadata: (params.metadata as Prisma.InputJsonValue) ?? undefined,
  };
}

/**
 * Fire-and-forget audit log writer.
 * Callers should NOT await this — audit logging must never block or break admin operations.
 */
export function logAuditEvent(params: AuditEventParams): void {
  prisma.auditLog
    .create({
      data: auditLogData(params),
    })
    .catch((err) => {
      console.error('[AuditLog] Failed to write audit event:', err?.message ?? err);
    });
}
