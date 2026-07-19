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
// An HLS ladder re-encodes the clip into 3 renditions in one pass, so it needs
// a bigger ceiling than a single transcode.
const HLS_TIMEOUT_MS = 180_000;

/** One output file of an HLS transcode (playlist or segment). */
export interface HlsFile {
  /** File name relative to the HLS directory (e.g. `master.m3u8`, `v0_000.ts`). */
  name: string;
  buffer: Buffer;
  contentType: string;
}

/**
 * Transcode a video into an adaptive-bitrate HLS ladder (240p / 480p / 720p),
 * so the client player can drop to a light rendition on slow/2G networks and
 * step up on wifi. Returns every generated file (master playlist, per-rendition
 * playlists, and .ts segments) as in-memory buffers for the caller to upload
 * under one storage prefix. `master.m3u8` is the entry point.
 *
 * Fail-open: returns null if ffmpeg is missing / errors / times out, so the
 * caller can fall back to a single-MP4 upload and the post still succeeds.
 */
/** True if the file at [inPath] has at least one audio stream (parses `ffmpeg -i`). */
async function probeHasAudio(inPath: string): Promise<boolean> {
  if (!ffmpegPath) return false;
  const stderr = await new Promise<string>((resolve) => {
    const proc = spawn(ffmpegPath!, ['-i', inPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let out = '';
    proc.stderr.on('data', (d) => { out = (out + d.toString()).slice(-8000); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(out); }, 15_000);
    proc.on('error', () => { clearTimeout(timer); resolve(out); });
    proc.on('close', () => { clearTimeout(timer); resolve(out); });
  });
  return /Stream #\d+:\d+.*: Audio:/i.test(stderr);
}

export async function transcodeToHls(input: Buffer, ext = '.mp4'): Promise<HlsFile[] | null> {
  if (!ffmpegPath) {
    logger.warn('transcodeToHls: ffmpeg binary unavailable');
    return null;
  }
  const id = randomUUID();
  const safeExt = /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext : '.mp4';
  const inPath = path.join(os.tmpdir(), `hls-in-${id}${safeExt}`);
  const outDir = path.join(os.tmpdir(), `hls-out-${id}`);
  try {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(inPath, input);

    // Some reels have no audio track (muted clips). Mapping a:0 then would make
    // ffmpeg fail ("Unable to map stream at a:0"), so probe first and build a
    // video-only ladder when there's no audio.
    const hasAudio = await probeHasAudio(inPath);
    const audioMapArgs = hasAudio
      ? ['-map', 'a:0', '-map', 'a:0', '-map', 'a:0', '-c:a', 'aac', '-b:a', '96k', '-ac', '2']
      : [];
    const varStreamMap = hasAudio
      ? 'v:0,a:0 v:1,a:1 v:2,a:2'
      : 'v:0 v:1 v:2';

    await runFfmpeg(
      [
        '-y',
        '-i', inPath,
        // Split into 3 streams, scale each (keep aspect, even dims).
        '-filter_complex',
        '[0:v]split=3[v1][v2][v3];' +
          "[v1]scale=w=426:h=240:force_original_aspect_ratio=decrease:force_divisible_by=2[v1o];" +
          "[v2]scale=w=854:h=480:force_original_aspect_ratio=decrease:force_divisible_by=2[v2o];" +
          "[v3]scale=w=1280:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2[v3o]",
        // 240p ~300kbps — light enough for 2G/EDGE.
        '-map', '[v1o]', '-c:v:0', 'libx264', '-b:v:0', '300k', '-maxrate:v:0', '350k', '-bufsize:v:0', '600k',
        // 480p ~900kbps.
        '-map', '[v2o]', '-c:v:1', 'libx264', '-b:v:1', '900k', '-maxrate:v:1', '1000k', '-bufsize:v:1', '1800k',
        // 720p ~2Mbps.
        '-map', '[v3o]', '-c:v:2', 'libx264', '-b:v:2', '2000k', '-maxrate:v:2', '2200k', '-bufsize:v:2', '4000k',
        ...audioMapArgs,
        // Fixed GOP + no scene-cut so segments align across renditions (clean ABR switching).
        '-preset', 'veryfast', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
        '-pix_fmt', 'yuv420p',
        '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
        '-hls_segment_filename', path.join(outDir, 'v%v_%03d.ts'),
        '-master_pl_name', 'master.m3u8',
        '-var_stream_map', varStreamMap,
        path.join(outDir, 'v%v.m3u8'),
      ],
      HLS_TIMEOUT_MS,
    );

    const names = await fs.readdir(outDir);
    if (!names.includes('master.m3u8')) {
      logger.warn('transcodeToHls: no master.m3u8 produced');
      return null;
    }
    const files: HlsFile[] = [];
    for (const name of names) {
      const buffer = await fs.readFile(path.join(outDir, name));
      files.push({
        name,
        buffer,
        contentType: name.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : 'video/mp2t',
      });
    }
    return files;
  } catch (err) {
    logger.warn({ err }, 'transcodeToHls failed');
    return null;
  } finally {
    await fs.rm(inPath, { force: true }).catch(() => {});
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

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

/**
 * Best-effort probe of a clip's duration (seconds) by parsing ffmpeg's stderr.
 * Returns null if it can't be determined (ffmpeg-static has no ffprobe).
 */
export async function probeDurationSec(input: Buffer, ext = '.mp4'): Promise<number | null> {
  if (!ffmpegPath) return null;
  const dir = os.tmpdir();
  const id = randomUUID();
  const safeExt = /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext : '.mp4';
  const inPath = path.join(dir, `dur-${id}${safeExt}`);
  try {
    await fs.writeFile(inPath, input);
    const stderr = await new Promise<string>((resolve) => {
      const proc = spawn(ffmpegPath!, ['-i', inPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      let out = '';
      // Hard timeout so a malformed clip that hangs `ffmpeg -i` analysis can
      // never stall the (synchronous) reel/post upload request.
      const timer = setTimeout(() => proc.kill('SIGKILL'), 15_000);
      proc.stderr.on('data', (d) => (out += d.toString()));
      proc.on('close', () => { clearTimeout(timer); resolve(out); });
      proc.on('error', () => { clearTimeout(timer); resolve(out); });
    });
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return null;
    const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
    return secs > 0 ? secs : null;
  } catch {
    return null;
  } finally {
    await fs.rm(inPath, { force: true }).catch(() => {});
  }
}

/**
 * Sample up to `maxFrames` JPEG frames spread evenly across the WHOLE video,
 * each downscaled to <=224px wide. Used to feed local/off-server moderation —
 * we check the worst frame. Coverage matters: sampling only the first N seconds
 * would let a clip that turns explicit later slip by.
 *
 * Fail-safe: returns [] if ffmpeg is missing/errors, so callers treat an empty
 * result as "couldn't decode" (moderation unavailable) rather than unsafe.
 */
export async function extractFrames(
  input: Buffer,
  { maxFrames = 16, ext = '.mp4' }: { maxFrames?: number; ext?: string } = {},
): Promise<Buffer[]> {
  if (!ffmpegPath) {
    logger.warn('extractFrames: ffmpeg binary unavailable');
    return [];
  }
  const duration = (await probeDurationSec(input, ext)) ?? 60;
  const fps = Math.min(maxFrames / duration, 1);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modframes-'));
  const id = randomUUID();
  const safeExt = /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext : '.mp4';
  const inPath = path.join(dir, `in-${id}${safeExt}`);
  const outPattern = path.join(dir, 'frame-%03d.jpg');
  try {
    await fs.writeFile(inPath, input);
    await runFfmpeg([
      '-y',
      '-i', inPath,
      '-vf', `fps=${fps.toFixed(4)},scale='min(224,iw)':-2`,
      '-frames:v', String(maxFrames),
      '-q:v', '5',
      '-f', 'image2',
      outPattern,
    ]);
    const names = (await fs.readdir(dir)).filter((n) => n.startsWith('frame-') && n.endsWith('.jpg'));
    const frames = await Promise.all(names.sort().map((n) => fs.readFile(path.join(dir, n))));
    return frames.filter((b) => b.length > 0);
  } catch (err) {
    logger.warn({ err }, 'extractFrames failed');
    return [];
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
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
