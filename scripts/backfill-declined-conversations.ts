/**
 * One-off backfill: un-stick conversations that were DECLINED as a message
 * request but where the recipient (the person who declined) later replied.
 *
 * Background: declining a request set `requestStatus = 'DECLINED'`, and the
 * inbox query (getConversations) hides DECLINED rows. Sending a message used
 * to only bump `updatedAt`, so a declined-then-resumed conversation stayed
 * hidden from both inboxes forever. sendMessage now promotes such a
 * conversation to ACCEPTED on the recipient's next message; this script fixes
 * the rows that got stuck before that fix shipped.
 *
 * A conversation qualifies when it is DECLINED AND has at least one message
 * from a participant OTHER than `requestedById` (i.e. the decliner has sent
 * something — they chose to engage). Conversations where only the original
 * requester ever messaged stay DECLINED, so declined spam is not resurrected.
 *
 * Usage:
 *   npx tsx scripts/backfill-declined-conversations.ts            # dry run (no writes)
 *   npx tsx scripts/backfill-declined-conversations.ts --apply    # apply changes
 */
import { prisma } from '../src/config/database';

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? '=== APPLY MODE (writing changes) ===' : '=== DRY RUN (no writes; pass --apply to commit) ===');

  const declined = await prisma.conversation.findMany({
    where: { requestStatus: 'DECLINED' },
    select: { id: true, requestedById: true },
  });
  console.log(`Found ${declined.length} DECLINED conversation(s).`);

  let promoted = 0;
  let skippedNoRequester = 0;
  let skippedRequesterOnly = 0;

  for (const c of declined) {
    if (!c.requestedById) {
      // No requester recorded — can't tell who declined; leave it alone.
      skippedNoRequester++;
      continue;
    }
    const recipientMsg = await prisma.message.findFirst({
      where: { conversationId: c.id, senderId: { not: c.requestedById } },
      select: { id: true },
    });
    if (!recipientMsg) {
      skippedRequesterOnly++;
      continue;
    }
    if (apply) {
      await prisma.conversation.update({
        where: { id: c.id },
        data: { requestStatus: 'ACCEPTED', acceptedAt: new Date() },
      });
    }
    promoted++;
    console.log(`${apply ? 'PROMOTED' : 'would promote'} ${c.id} -> ACCEPTED`);
  }

  console.log('--- summary ---');
  console.log(`  ${apply ? 'promoted' : 'would promote'}: ${promoted}`);
  console.log(`  skipped (requester-only, stays DECLINED): ${skippedRequesterOnly}`);
  console.log(`  skipped (no requestedById): ${skippedNoRequester}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
