import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import ffmpegPath from 'ffmpeg-static';
import { logger } from './logger';

const REMUX_TIMEOUT_MS = 60_000;
// A full re-encode (HEVC→H.264) is CPU-bound and much slower than a copy-remux,
// so it gets a longer ceiling. Kept synchronous per-request for simplicity;
// short social clips (reels ≤60s, stories, posts) fit comfortably.
const TRANSCODE_TIMEOUT_MS = 90_000;

function runFfmpeg(args: string[], timeoutMs = REMUX_TIMEOUT_MS): Promise<void> {
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
    }, timeoutMs);
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

/**
 * Probe the primary video codec (e.g. "h264", "hevc") by parsing ffmpeg's
 * stream banner. `ffmpeg -i` with no output prints the stream info to stderr
 * and exits non-zero, so we capture stderr regardless of exit code.
 *
 * Returns the lowercased codec name, or null if it can't be determined (ffmpeg
 * missing / errors / no video stream) — callers treat null as "unknown" and
 * transcode to be safe.
 */
export async function probeVideoCodec(input: Buffer, ext = '.mp4'): Promise<string | null> {
  if (!ffmpegPath) return null;
  const dir = os.tmpdir();
  const id = randomUUID();
  const safeExt = /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext : '.mp4';
  const inPath = path.join(dir, `probe-${id}${safeExt}`);
  try {
    await fs.writeFile(inPath, input);
    const stderr = await new Promise<string>((resolve) => {
      const proc = spawn(ffmpegPath!, ['-i', inPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      let out = '';
      proc.stderr.on('data', (d) => { out = (out + d.toString()).slice(-4000); });
      const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(out); }, 15_000);
      proc.on('error', () => { clearTimeout(timer); resolve(out); });
      proc.on('close', () => { clearTimeout(timer); resolve(out); });
    });
    const m = stderr.match(/Video:\s*([a-z0-9]+)/i);
    return m ? m[1].toLowerCase() : null;
  } catch (err) {
    logger.warn({ err }, 'probeVideoCodec failed');
    return null;
  } finally {
    await fs.rm(inPath, { force: true }).catch(() => {});
  }
}

/**
 * Transcode any video to a broadly-compatible H.264/AAC MP4 (faststart),
 * scaled down to 720p max. This normalizes iPhone HEVC/HDR/4K footage that
 * Sightengine can't decode and that some Android devices can't play — the same
 * "accept anything, serve H.264" approach the big platforms use.
 *
 * Fail-open: returns null if ffmpeg is missing/times out/errors, so callers
 * fall back to the original buffer and a post is never blocked by a transcode
 * failure.
 */
export async function transcodeToH264(input: Buffer, ext = '.mp4'): Promise<Buffer | null> {
  if (!ffmpegPath) {
    logger.warn('transcodeToH264: ffmpeg binary unavailable');
    return null;
  }
  const dir = os.tmpdir();
  const id = randomUUID();
  const safeExt = /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext : '.mp4';
  const inPath = path.join(dir, `tc-in-${id}${safeExt}`);
  const outPath = path.join(dir, `tc-out-${id}.mp4`);
  try {
    await fs.writeFile(inPath, input);
    await runFfmpeg([
      '-y',
      '-i', inPath,
      // Cap at 720p (keep aspect, even dimensions) and force 8-bit yuv420p so
      // HDR/10-bit HEVC collapses to SDR H.264 that plays everywhere.
      '-vf', "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-f', 'mp4',
      outPath,
    ], TRANSCODE_TIMEOUT_MS);
    const out = await fs.readFile(outPath);
    return out.length > 0 ? out : null;
  } catch (err) {
    logger.warn({ err }, 'transcodeToH264 failed');
    return null;
  } finally {
    await fs.rm(inPath, { force: true }).catch(() => {});
    await fs.rm(outPath, { force: true }).catch(() => {});
  }
}

/**
 * Single entry point for making an uploaded video web-safe: a broadly-playable
 * H.264/AAC MP4 with the moov atom at the front (faststart).
 *
 * - Already H.264 → cheap copy-remux (no re-encode, preserves quality).
 * - HEVC / unknown / anything else → full transcode to H.264 720p.
 *
 * Always fail-open: on any error the ORIGINAL buffer is returned so a post is
 * never blocked here. The moderation layer is the safety net for the rare case
 * where an undecodable buffer still slips through.
 */
export async function ensureWebSafeH264(input: Buffer, ext = '.mp4'): Promise<Buffer> {
  const codec = await probeVideoCodec(input, ext);
  if (codec === 'h264') {
    return faststartRemux(input, ext);
  }
  const transcoded = await transcodeToH264(input, ext);
  if (transcoded) return transcoded;
  // Transcode failed — fall back to a plain faststart of the original so we
  // still return a valid container (worst case: same as before this change).
  logger.warn({ codec }, 'ensureWebSafeH264: transcode failed, returning faststart of original');
  return faststartRemux(input, ext);
}
