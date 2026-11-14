import type { Prisma, PrismaClient } from "@dealmind/db";

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entity: string;
  entityId?: string;
  metadata?: Prisma.InputJsonObject;
}

/** Appends to the audit log. Never include secrets (passwords, tokens) in metadata. */
export async function recordAudit(prisma: PrismaClient, entry: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? {},
    },
  });
}
