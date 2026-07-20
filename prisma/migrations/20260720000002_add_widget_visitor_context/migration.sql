-- Live-chat visitor context (location, page, referrer) shown to the owner.
-- Additive, all nullable.
ALTER TABLE "WebVisitor" ADD COLUMN "country" TEXT;
ALTER TABLE "WebVisitor" ADD COLUMN "city" TEXT;
ALTER TABLE "WebVisitor" ADD COLUMN "pageUrl" TEXT;
ALTER TABLE "WebVisitor" ADD COLUMN "referrer" TEXT;
