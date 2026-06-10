/**
 * One-off backfill: faststart existing reel videos in place.
 *
 * Older reels were uploaded without a faststart MP4 (moov atom at front), so
 * playback stalls on a black screen while the player pulls the whole file.
 * This downloads each R2-hosted reel, checks whether it already has faststart,
 * remuxes the ones that don't, and re-uploads to the SAME R2 key — so videoUrl
 * never changes and no DB update is needed.
 *
 * Run with the PRODUCTION env (DATABASE_URL + R2_* creds), e.g. Render shell:
 *   npx tsx scripts/faststart-existing-reels.ts            # dry run
 *   npx tsx scripts/faststart-existing-reels.ts --apply    # remux + re-upload
 */
import { prisma } from '../src/config/database';
import { uploadToR2WithCustomKey } from '../src/shared/r2.service';
import { faststartRemux } from '../src/shared/video.service';

/**
 * Heuristic faststart check: in the file header, does the top-level `moov`
 * box appear before `mdat`? Scans the first chunk for the box-type tags.
 */
function isFaststarted(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(buf.length, 2_000_000));
  const moov = head.indexOf('moov');
  const mdat = head.indexOf('mdat');
  if (moov === -1) return false;            // moov not near the front → not faststarted
  if (mdat === -1) return true;             // moov present, mdat not yet → faststarted
  return moov < mdat;
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? '=== APPLY MODE (remux + re-upload) ===' : '=== DRY RUN (no writes; pass --apply) ===');

  const reels = await prisma.reel.findMany({
    select: { id: true, videoUrl: true, cloudinaryId: true },
  });
  console.log(`Total reels: ${reels.length}`);

  let skippedNoKey = 0;
  let downloadFail = 0;
  let alreadyFast = 0;
  let remuxed = 0;

  for (const r of reels) {
    if (!r.cloudinaryId) { skippedNoKey++; continue; }
    let buf: Buffer;
    try {
      const res = await fetch(r.videoUrl);
      if (!res.ok) { downloadFail++; console.log(`DL ${res.status} ${r.id} ${r.videoUrl}`); continue; }
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      downloadFail++; console.log(`DL error ${r.id}: ${(e as Error).message}`); continue;
    }
    if (isFaststarted(buf)) { alreadyFast++; continue; }

    if (apply) {
      const out = await faststartRemux(buf, '.mp4');
      if (out === buf) { console.log(`REMUX no-op ${r.id} (ffmpeg fail) — left as-is`); continue; }
      await uploadToR2WithCustomKey(out, r.cloudinaryId, 'video/mp4');
    }
    remuxed++;
    console.log(`${apply ? 'FASTSTARTED' : 'would faststart'} ${r.id} (${(buf.length / 1e6).toFixed(1)}MB)`);
  }

  console.log('--- summary ---');
  console.log(`  already faststarted:   ${alreadyFast}`);
  console.log(`  ${apply ? 'faststarted' : 'would faststart'}:        ${remuxed}`);
  console.log(`  download failed:       ${downloadFail}`);
  console.log(`  no R2 key:             ${skippedNoKey}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
