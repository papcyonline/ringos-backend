-- Widget team members: teammates invited to share the widget inbox.
CREATE TYPE "WidgetTeamStatus" AS ENUM ('PENDING', 'ACCEPTED');

CREATE TABLE "WidgetTeamMember" (
    "id" TEXT NOT NULL,
    "widgetConfigId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "WidgetTeamStatus" NOT NULL DEFAULT 'PENDING',
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    CONSTRAINT "WidgetTeamMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WidgetTeamMember_widgetConfigId_userId_key" ON "WidgetTeamMember"("widgetConfigId", "userId");
CREATE INDEX "WidgetTeamMember_userId_idx" ON "WidgetTeamMember"("userId");
CREATE INDEX "WidgetTeamMember_widgetConfigId_idx" ON "WidgetTeamMember"("widgetConfigId");

ALTER TABLE "WidgetTeamMember" ADD CONSTRAINT "WidgetTeamMember_widgetConfigId_fkey" FOREIGN KEY ("widgetConfigId") REFERENCES "WidgetConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WidgetTeamMember" ADD CONSTRAINT "WidgetTeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
