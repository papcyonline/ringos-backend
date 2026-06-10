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
