-- Enforce case-insensitive uniqueness on User.displayName.
-- Matches the app-level check in checkUsernameAvailable() which uses mode: 'insensitive'.
-- Prisma cannot express functional indexes in the schema; managed via raw SQL here.

CREATE UNIQUE INDEX "User_displayName_lower_key" ON "User" (LOWER("displayName"));
