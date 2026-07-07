-- Time-limited verification: NULL = permanent, a timestamp = auto-expire once
-- past (handled by the verificationExpiry job). Additive + nullable.
ALTER TABLE "User" ADD COLUMN "verifiedUntil" TIMESTAMP(3);
