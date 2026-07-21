-- Web-visitor shadow users may share display names (two "John" visitors are
-- fine), so the case-insensitive displayName uniqueness now applies only to
-- real users. This lets the widget show exactly the name a visitor typed —
-- no more auto-generated suffix.
DROP INDEX IF EXISTS "User_displayName_lower_key";
CREATE UNIQUE INDEX "User_displayName_lower_key"
  ON "User" (LOWER("displayName"))
  WHERE "isWebVisitor" = false;

-- Reset existing shadow users to the clean name the visitor originally entered
-- (safe now that shadow users are exempt from the uniqueness index).
UPDATE "User" u
SET "displayName" = w."name"
FROM "WebVisitor" w
WHERE w."shadowUserId" = u."id"
  AND u."isWebVisitor" = true
  AND w."name" IS NOT NULL
  AND w."name" <> ''
  AND u."displayName" <> w."name";
