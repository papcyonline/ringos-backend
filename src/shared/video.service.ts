import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import ffmpegPath from 'ffmpeg-static';
import { logger } from './logger';

const REMUX_TIMEOUT_MS = 60_000;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg binary not available'));
      return;
    }
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      // Keep only the tail so a failure log stays small.
      stderr = (stderr + d.toString()).slice(-2000);
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg timed out'));
    }, REMUX_TIMEOUT_MS);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
    });
  });
}

/**
 * Rewrite an MP4 so the moov atom sits at the FRONT of the file (faststart),
 * letting players render the first frame after a small initial read instead
 * of downloading the whole file. This is a container remux (`-c copy`) — no
 * re-encode — so it's cheap (I/O-bound, ~1-2s for a 60s 720p clip).
 *
 * Fail-open: if ffmpeg is missing, times out, or errors, the ORIGINAL buffer
 * is returned so a bad clip can never block a post. Worst case the reel plays
 * exactly as it does today (no faststart), never worse.
 */
/**
 * Extract the first frame of a video as a JPEG poster (capped to 720px wide,
 * aspect preserved). Used to give reels a real thumbnail so a profile grid can
 * show a small image instead of decoding video per tile (which OOM-kills iOS).
 *
 * Fail-open: returns null if ffmpeg is missing/errors so it never blocks a post.
 */
export async function extractPosterFrame(input: Buffer, ext = '.mp4'): Promise<Buffer | null> {
  if (!ffmpegPath) {
    logger.warn('extractPosterFrame: ffmpeg binary unavailable');
    return null;
  }
  const dir = os.tmpdir();
  const id = randomUUID();
  const safeExt = /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext : '.mp4';
  const inPath = path.join(dir, `reelposter-in-${id}${safeExt}`);
  const outPath = path.join(dir, `reelposter-out-${id}.jpg`);
  try {
    await fs.writeFile(inPath, input);
    await runFfmpeg([
      '-y',
      '-i', inPath,
      '-frames:v', '1', // first frame only
      '-vf', "scale='min(720,iw)':-2", // cap width 720, keep aspect (even height)
      '-q:v', '3', // good JPEG quality
      '-f', 'image2',
      outPath,
    ]);
    const out = await fs.readFile(outPath);
    return out.length > 0 ? out : null;
  } catch (err) {
    logger.warn({ err }, 'extractPosterFrame failed');
    return null;
  } finally {
    await fs.rm(inPath, { force: true }).catch(() => {});
    await fs.rm(outPath, { force: true }).catch(() => {});
  }
}

export async function faststartRemux(input: Buffer, ext = '.mp4'): Promise<Buffer> {
  if (!ffmpegPath) {
    logger.warn('faststartRemux: ffmpeg binary unavailable, returning original buffer');
    return input;
  }
  const dir = os.tmpdir();
  const id = randomUUID();
  const safeExt = /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext : '.mp4';
  const inPath = path.join(dir, `reel-in-${id}${safeExt}`);
  const outPath = path.join(dir, `reel-out-${id}.mp4`);
  try {
    await fs.writeFile(inPath, input);
    await runFfmpeg([
      '-y',
      '-i', inPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-f', 'mp4',
      outPath,
    ]);
    const out = await fs.readFile(outPath);
    if (out.length === 0) {
      logger.warn('faststartRemux: empty output, returning original buffer');
      return input;
    }
    return out;
  } catch (err) {
    logger.warn({ err }, 'faststartRemux failed, returning original buffer');
    return input;
  } finally {
    await fs.rm(inPath, { force: true }).catch(() => {});
    await fs.rm(outPath, { force: true }).catch(() => {});
  }
}
