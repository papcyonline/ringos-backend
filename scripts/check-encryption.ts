/**
 * Verify message encryption-at-rest is active. Reads the RAW stored content of
 * the most recent messages (via $queryRaw, bypassing the decrypt middleware)
 * and reports whether each is encrypted (content starts with the "v1:" marker).
 *
 * Privacy: never prints message content — only the marker flag, a length, and
 * the timestamp.
 *
 *   npx tsx scripts/check-encryption.ts
 */
import { prisma } from '../src/config/database';

async function main() {
  const rows = await prisma.$queryRaw<
    { id: string; content: string; createdAt: Date }[]
  >`
    SELECT id, content, "createdAt" FROM "Message"
    WHERE content IS NOT NULL AND content <> ''
    ORDER BY "createdAt" DESC
    LIMIT 15
  `;

  if (rows.length === 0) {
    console.log('No messages found.');
  } else {
    console.log(`Most recent ${rows.length} messages (newest first):`);
    for (const r of rows) {
      const enc = r.content.startsWith('v1:');
      console.log(
        `${enc ? '🔒 ENCRYPTED' : '⚠️  plaintext'}  ${r.createdAt.toISOString()}  len=${r.content.length}  id=${r.id.slice(0, 8)}`,
      );
    }
    const encCount = rows.filter((r) => r.content.startsWith('v1:')).length;
    console.log(`\n${encCount}/${rows.length} of the latest messages are encrypted.`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
