-- Add the append-only audit trail (T-022). Mirrors the AuditLog model in schema.prisma.
-- The api_keys / subscriptions tables already exist from 0001_init; only audit_logs is new.

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_teamId_createdAt_idx" ON "audit_logs"("teamId", "createdAt");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
