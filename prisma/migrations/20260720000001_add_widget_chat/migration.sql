-- Website chat widget. An embeddable "chat with me" bubble a user drops on
-- their own site; anonymous visitors are bridged into the owner's Yomeet inbox
-- via a shadow user (User.isWebVisitor). See src/modules/widget.
--
-- Additive only: new enum values, one defaulted User column, three new tables.
-- Nothing existing is altered destructively.

-- New enum values. Postgres 12+ allows ADD VALUE inside a transaction as long
-- as the value isn't USED in the same transaction (it isn't — no rows here use
-- it). IF NOT EXISTS keeps re-runs / partial applies safe.
ALTER TYPE "ConversationType" ADD VALUE IF NOT EXISTS 'WIDGET';
ALTER TYPE "AuthProvider" ADD VALUE IF NOT EXISTS 'WIDGET';

-- Shadow-user flag. Defaulted false so every existing row is a real user.
ALTER TABLE "User" ADD COLUMN "isWebVisitor" BOOLEAN NOT NULL DEFAULT false;

-- Per-owner widget settings.
CREATE TABLE "WidgetConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allowedDomains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "theme" JSONB,
    "offlineCapture" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WidgetConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WidgetConfig_userId_key" ON "WidgetConfig"("userId");
CREATE UNIQUE INDEX "WidgetConfig_handle_key" ON "WidgetConfig"("handle");
CREATE INDEX "WidgetConfig_handle_idx" ON "WidgetConfig"("handle");
ALTER TABLE "WidgetConfig" ADD CONSTRAINT "WidgetConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Anonymous visitor sessions, bridged into chat via a shadow user.
CREATE TABLE "WebVisitor" (
    "id" TEXT NOT NULL,
    "widgetConfigId" TEXT NOT NULL,
    "shadowUserId" TEXT NOT NULL,
    "conversationId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "originDomain" TEXT,
    "blockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WebVisitor_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebVisitor_shadowUserId_key" ON "WebVisitor"("shadowUserId");
CREATE UNIQUE INDEX "WebVisitor_conversationId_key" ON "WebVisitor"("conversationId");
CREATE UNIQUE INDEX "WebVisitor_tokenHash_key" ON "WebVisitor"("tokenHash");
CREATE INDEX "WebVisitor_widgetConfigId_idx" ON "WebVisitor"("widgetConfigId");
CREATE INDEX "WebVisitor_expiresAt_idx" ON "WebVisitor"("expiresAt");
ALTER TABLE "WebVisitor" ADD CONSTRAINT "WebVisitor_widgetConfigId_fkey" FOREIGN KEY ("widgetConfigId") REFERENCES "WidgetConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebVisitor" ADD CONSTRAINT "WebVisitor_shadowUserId_fkey" FOREIGN KEY ("shadowUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Offline leads (email + message captured when the owner is away).
CREATE TABLE "WidgetLead" (
    "id" TEXT NOT NULL,
    "widgetConfigId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WidgetLead_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WidgetLead_widgetConfigId_idx" ON "WidgetLead"("widgetConfigId");
ALTER TABLE "WidgetLead" ADD CONSTRAINT "WidgetLead_widgetConfigId_fkey" FOREIGN KEY ("widgetConfigId") REFERENCES "WidgetConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
