/**
 * One-off backfill: repoint reels whose videoUrl points at the now-disabled
 * Cloudinary cloud back to their original R2 object.
 *
 * Background: reels used to be re-uploaded to Cloudinary and the Cloudinary
 * secureUrl was stored as videoUrl (thumbnail derived from it). The Cloudinary
 * cloud was disabled (quota), so every such reel stopped playing. The original
 * R2 object is still there; its key is stored in `cloudinaryId`
 * (reel.service.ts), and the public R2 URL is `${R2_PUBLIC_URL}/${key}`.
 *
 * For each reel whose videoUrl is NOT already an R2 URL, this reconstructs the
 * R2 URL, HEAD-verifies the object actually exists (200), and—only then—sets
 * videoUrl to it and clears the dead Cloudinary thumbnailUrl (R2 has none; the
 * FE falls back to the first frame).
 *
 * Usage (run with the PRODUCTION DATABASE_URL + R2_PUBLIC_URL in env):
 *   npx tsx scripts/backfill-reels-r2-url.ts            # dry run (no writes)
 *   npx tsx scripts/backfill-reels-r2-url.ts --apply    # apply changes
 */
import { prisma } from '../src/config/database';

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/+$/, '');

async function head(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.status;
  } catch {
    return 0; // network error
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (!R2_PUBLIC_URL) {
    throw new Error('R2_PUBLIC_URL is not set — refusing to run (cannot build R2 URLs).');
  }
  console.log(apply ? '=== APPLY MODE (writing changes) ===' : '=== DRY RUN (no writes; pass --apply to commit) ===');
  console.log('R2_PUBLIC_URL:', R2_PUBLIC_URL);

  const reels = await prisma.reel.findMany({
    select: { id: true, videoUrl: true, thumbnailUrl: true, cloudinaryId: true },
  });
  console.log(`Total reels: ${reels.length}`);

  let alreadyR2 = 0;
  let noKey = 0;
  let missingInR2 = 0;
  let repointed = 0;

  for (const r of reels) {
    if (r.videoUrl.startsWith(R2_PUBLIC_URL)) {
      alreadyR2++;
      continue;
    }
    if (!r.cloudinaryId) {
      noKey++;
      console.log(`SKIP ${r.id}: non-R2 videoUrl but no cloudinaryId (key) to rebuild from -> ${r.videoUrl}`);
      continue;
    }
    const r2Url = `${R2_PUBLIC_URL}/${r.cloudinaryId}`;
    const status = await head(r2Url);
    if (status !== 200) {
      missingInR2++;
      console.log(`MISSING ${r.id}: R2 object HEAD ${status} -> ${r2Url}`);
      continue;
    }
    if (apply) {
      await prisma.reel.update({
        where: { id: r.id },
        data: { videoUrl: r2Url, thumbnailUrl: null },
      });
    }
    repointed++;
    console.log(`${apply ? 'REPOINTED' : 'would repoint'} ${r.id} -> ${r2Url}`);
  }

  console.log('--- summary ---');
  console.log(`  already on R2:              ${alreadyR2}`);
  console.log(`  ${apply ? 'repointed' : 'would repoint'} to R2:        ${repointed}`);
  console.log(`  missing in R2 (left as-is): ${missingInR2}`);
  console.log(`  no cloudinaryId key:        ${noKey}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
