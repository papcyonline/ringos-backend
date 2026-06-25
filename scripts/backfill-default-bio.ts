/**
 * One-off backfill: give every onboarded, bio-less user a default bio so
 * they show up complete in the People tab.
 *
 * Background: the People list (userService.listUsers) used to require a
 * non-empty bio, which silently hid every real user with a NULL/'' bio —
 * legacy accounts, social-login accounts created before bio was required,
 * and anyone who cleared their bio in profile edit. That bio gate has been
 * removed, and signup now defaults a missing bio to DEFAULT_BIO. This
 * script applies the same default to the existing rows so their profiles
 * don't look empty.
 *
 * Targets onboarded users (isAnonymous = false) whose bio is NULL or ''.
 * Anonymous / not-yet-onboarded rows are left alone.
 *
 * Usage:
 *   npx tsx scripts/backfill-default-bio.ts            # dry run (no writes)
 *   npx tsx scripts/backfill-default-bio.ts --apply    # apply changes
 */
import { prisma } from '../src/config/database';
import { DEFAULT_BIO } from '../src/modules/auth/auth.service';

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? '=== APPLY MODE (writing changes) ===' : '=== DRY RUN (no writes; pass --apply to commit) ===');
  console.log(`Default bio: "${DEFAULT_BIO}"`);

  const where = {
    isAnonymous: false,
    OR: [{ bio: null }, { bio: '' }],
  };

  const candidates = await prisma.user.findMany({
    where,
    select: { id: true, displayName: true, bio: true },
  });
  console.log(`Found ${candidates.length} onboarded user(s) with no bio.`);

  for (const u of candidates) {
    console.log(`${apply ? 'SET' : 'would set'} ${u.id} (${u.displayName}) bio -> "${DEFAULT_BIO}"`);
  }

  if (apply && candidates.length > 0) {
    const res = await prisma.user.updateMany({
      where,
      data: { bio: DEFAULT_BIO },
    });
    console.log(`--- applied: updated ${res.count} row(s) ---`);
  } else {
    console.log('--- summary ---');
    console.log(`  ${apply ? 'updated' : 'would update'}: ${candidates.length}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
