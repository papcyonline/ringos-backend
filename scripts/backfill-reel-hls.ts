/**
 * One-off backfill: generate adaptive HLS for existing reels.
 *
 * Older reels were stored as a single progressive MP4, so they buffer on
 * slow/2G networks. This downloads each reel's MP4, transcodes it into the same
 * HLS ladder new reels use (240p/480p/720p), uploads the HLS files to R2, and
 * sets hlsUrl/hlsKey. The MP4 (videoUrl) is left untouched, so older app
 * versions keep working — new clients just prefer the HLS.
 *
 * Idempotent + re-runnable: only touches reels where hlsUrl IS NULL, so a
 * re-run retries whatever failed last time. Processes SEQUENTIALLY to bound CPU.
 *
 * Run it on a machine with spare CPU (e.g. your Mac) pointed at PRODUCTION, so
 * the transcoding doesn't hog the live Render instance. Needs the R2_* creds
 * (already in .env) and the EXTERNAL DATABASE_URL:
 *
 *   # dry run — lists what would be done, no writes
 *   DATABASE_URL="<external-render-postgres-url>" npx tsx scripts/backfill-reel-hls.ts
 *   # apply — transcode + upload + update
 *   DATABASE_URL="<external-render-postgres-url>" npx tsx scripts/backfill-reel-hls.ts --apply
 *
 * Optional: cap how many to process in one run with --limit=N.
 */
import { prisma } from '../src/config/database';
import { fileToReelHls } from '../src/shared/upload';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : undefined;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const limit = arg('limit') ? parseInt(arg('limit')!, 10) : undefined;
  console.log(apply ? '=== APPLY MODE (transcode + upload + update) ===' : '=== DRY RUN (no writes; pass --apply) ===');

  const candidates = await prisma.reel.findMany({
    where: { hlsUrl: null },
    select: { id: true, userId: true, videoUrl: true, cloudinaryId: true },
    orderBy: { createdAt: 'asc' },
    ...(limit ? { take: limit } : {}),
  });
  console.log(`Reels without HLS: ${candidates.length}${limit ? ` (limited to ${limit})` : ''}`);

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let i = 0;

  for (const r of candidates) {
    i++;
    // Guard: skip anything that isn't a plain MP4 source.
    if (!r.videoUrl || r.videoUrl.includes('.m3u8')) { skipped++; continue; }

    if (!apply) {
      console.log(`[${i}/${candidates.length}] would backfill ${r.id}`);
      continue;
    }

    try {
      const res = await fetch(r.videoUrl);
      if (!res.ok) { failed++; console.log(`[${i}] DL ${res.status} ${r.id}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());

      const hls = await fileToReelHls(buf, r.userId);
      if (!hls) { failed++; console.log(`[${i}] HLS transcode failed ${r.id}`); continue; }

      await prisma.reel.update({
        where: { id: r.id },
        data: { hlsUrl: hls.url, hlsKey: hls.key },
      });
      ok++;
      console.log(`[${i}/${candidates.length}] OK ${r.id} (${(buf.length / 1e6).toFixed(1)}MB) → ${hls.key}`);
    } catch (e) {
      failed++;
      console.log(`[${i}] error ${r.id}: ${(e as Error).message}`);
    }
  }

  console.log('--- summary ---');
  console.log(`  ${apply ? 'backfilled' : 'would backfill'}: ${apply ? ok : candidates.length - skipped}`);
  if (apply) console.log(`  failed:     ${failed} (re-run to retry — they stay hlsUrl=null)`);
  console.log(`  skipped:    ${skipped}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
