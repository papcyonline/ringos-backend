/**
 * One-off backfill: generate first-frame JPEG posters for existing reels that
 * have no thumbnail (thumbnailUrl == null). New reels get a poster at upload;
 * this gives older ones one too, so the profile Reels grid shows a still image
 * per tile instead of a placeholder.
 *
 * Downloads each R2-hosted reel, extracts frame 0 with ffmpeg, uploads the JPEG
 * to R2, and sets reel.thumbnailUrl. Fail-open per reel.
 *
 * Run with the PRODUCTION env (DATABASE_URL + R2_* creds):
 *   npx tsx scripts/backfill-reel-thumbnails.ts            # dry run (counts only)
 *   npx tsx scripts/backfill-reel-thumbnails.ts --apply    # generate + upload + update
 */
import { prisma } from '../src/config/database';
import { uploadToR2WithKey } from '../src/shared/r2.service';
import { extractPosterFrame } from '../src/shared/video.service';

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? '=== APPLY MODE (generate + upload + update) ===' : '=== DRY RUN (no writes; pass --apply) ===');

  const reels = await prisma.reel.findMany({
    where: { thumbnailUrl: null },
    select: { id: true, userId: true, videoUrl: true },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`Reels without a thumbnail: ${reels.length}`);

  let done = 0;
  let downloadFail = 0;
  let posterFail = 0;

  for (const r of reels) {
    let buf: Buffer;
    try {
      const res = await fetch(r.videoUrl);
      if (!res.ok) { downloadFail++; console.log(`DL ${res.status} ${r.id}`); continue; }
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      downloadFail++; console.log(`DL error ${r.id}: ${(e as Error).message}`); continue;
    }

    if (!apply) {
      console.log(`would poster ${r.id} (${(buf.length / 1e6).toFixed(1)}MB)`);
      done++;
      continue;
    }

    const poster = await extractPosterFrame(buf, '.mp4');
    if (!poster || poster.length === 0) { posterFail++; console.log(`POSTER fail ${r.id}`); continue; }

    const up = await uploadToR2WithKey(poster, `reels/${r.userId}/thumbs`, 'poster.jpg', 'image/jpeg');
    await prisma.reel.update({ where: { id: r.id }, data: { thumbnailUrl: up.url } });
    done++;
    console.log(`✓ ${r.id} -> ${up.url}`);
  }

  console.log('--- summary ---');
  console.log(`  ${apply ? 'posters generated' : 'would generate'}: ${done}`);
  console.log(`  download failed:    ${downloadFail}`);
  console.log(`  poster failed:      ${posterFail}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
