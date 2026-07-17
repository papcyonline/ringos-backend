/**
 * One-off backfill: encrypt existing plaintext Message.content rows now that
 * encryption-at-rest is enabled (see shared/message-crypto).
 *
 * New messages are encrypted automatically by the Prisma middleware; this
 * catches the history that predates the key being set. It reads RAW content
 * (bypassing the decrypt middleware) so it can skip rows already encrypted
 * (content starting with the "v1:" marker), which makes it idempotent and
 * resumable — just run it again if interrupted.
 *
 * Requires MESSAGE_ENC_KEY to be set (the same key the server runs with).
 *
 * Usage:
 *   npx tsx scripts/encrypt-existing-messages.ts            # dry run (counts only)
 *   npx tsx scripts/encrypt-existing-messages.ts --apply    # encrypt in place
 */
import { prisma } from '../src/config/database';
import {
  encryptContent,
  isMessageEncryptionEnabled,
} from '../src/shared/message-crypto';

const BATCH = 500;

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(
    apply
      ? '=== APPLY MODE (encrypting in place) ==='
      : '=== DRY RUN (counts only; pass --apply to commit) ===',
  );

  if (!isMessageEncryptionEnabled()) {
    console.error('MESSAGE_ENC_KEY is not set — refusing to run.');
    process.exit(1);
  }

  // Count remaining plaintext rows.
  const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "Message"
    WHERE content IS NOT NULL AND content NOT LIKE 'v1:%'
  `;
  console.log(`Plaintext messages to encrypt: ${count}`);
  if (!apply || count === 0n) {
    await prisma.$disconnect();
    return;
  }

  let done = 0;
  for (;;) {
    // Raw read so we see the stored (un-decrypted) value and skip encrypted rows.
    const rows = await prisma.$queryRaw<{ id: string; content: string }[]>`
      SELECT id, content FROM "Message"
      WHERE content IS NOT NULL AND content NOT LIKE 'v1:%'
      LIMIT ${BATCH}
    `;
    if (rows.length === 0) break;
    for (const r of rows) {
      const enc = encryptContent(r.content);
      // Raw update so the middleware doesn't double-encrypt.
      await prisma.$executeRaw`UPDATE "Message" SET content = ${enc} WHERE id = ${r.id}`;
    }
    done += rows.length;
    console.log(`Encrypted ${done}/${count}...`);
  }

  console.log(`Done. Encrypted ${done} messages.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
