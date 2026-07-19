import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import * as cloudinaryService from './cloudinary.service';
import { isDriveConfigured, uploadToDrive } from './gdrive.service';
import {
  isR2Configured,
  uploadImageToR2,
  uploadVideoToR2,
  uploadToR2WithKey,
  uploadToR2WithCustomKey,
} from './r2.service';
import {
  isSupabaseConfigured,
  uploadAvatarToSupabase,
  uploadCoverToSupabase,
  uploadChatImageToSupabase,
  uploadVoiceNoteToSupabase,
} from './supabase.service';
import { moderateImageBuffer } from './moderation.service';
import { ensureWebSafeH264, transcodeToHls } from './video.service';
import { ForbiddenError } from './errors';
import { logger } from './logger';

// Use memory storage — files live in buffer until uploaded to Cloudinary
const memoryStorage = multer.memoryStorage();

// Disk storage for large story videos. Buffering 250MB × up to 10 slides in
// memory would OOM the web instance, so story media lands on a temp disk file
// and is streamed to R2 one slide at a time. story.service.ts reads each file
// from disk into a buffer just before moderation/transcode, then unlinks it.
const storyDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename: (_req, file, cb) =>
    cb(null, `story_${uuidv4()}${path.extname(file.originalname || '')}`),
});

/**
 * Return an uploaded file's bytes as a Buffer. memoryStorage files already
 * carry `.buffer`; diskStorage files (large story media) carry `.path` instead,
 * so read them from the temp file on demand. Callers own temp-file cleanup
 * (story.router unlinks every temp file in a finally block).
 */
export async function ensureBuffer(file: Express.Multer.File): Promise<Buffer> {
  if (file.buffer) return file.buffer;
  if (file.path) return fs.promises.readFile(file.path);
  throw new Error('Uploaded file has neither buffer nor path');
}

/** Best-effort unlink of a temp upload file; never throws. */
export async function cleanupTempFile(file?: Express.Multer.File): Promise<void> {
  if (!file?.path) return;
  try {
    await fs.promises.unlink(file.path);
  } catch { /* already gone / never written */ }
}

// Fallback: save buffer to local disk and return local URL
function saveToDisk(buffer: Buffer, dir: string, urlPrefix: string, ext: string): string {
  const fullDir = path.join(process.cwd(), dir);
  if (!fs.existsSync(fullDir)) fs.mkdirSync(fullDir, { recursive: true });
  const filename = `${uuidv4()}${ext}`;
  fs.writeFileSync(path.join(fullDir, filename), buffer);
  return `${urlPrefix}/${filename}`;
}

function imageFilter(_req: unknown, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
    return;
  }
  const ext = (file.originalname || '').split('.').pop()?.toLowerCase() || '';
  const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'bmp'];
  if (imageExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed'));
  }
}

function audioFilter(_req: unknown, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  if (['audio/mpeg', 'audio/wav', 'audio/m4a', 'audio/aac', 'audio/mp4', 'audio/x-m4a'].includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only MP3, WAV, M4A, and AAC audio files are allowed'));
  }
}

function videoFilter(_req: unknown, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  if (file.mimetype.startsWith('video/')) {
    cb(null, true);
    return;
  }
  // Some pickers mislabel video/quicktime as application/octet-stream; fall
  // back to extension. Same belt-and-suspenders trick we use for HEIC.
  const ext = (file.originalname || '').split('.').pop()?.toLowerCase() || '';
  if (['mp4', 'mov', 'm4v', 'webm', '3gp'].includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only MP4, MOV, M4V, WebM, and 3GP videos are allowed'));
  }
}

// /video sends two parts: `video` (the .mp4) AND `thumbnail` (a jpg
// generated client-side because R2 has no auto-thumbnail). videoFilter
// rejects the jpg, which short-circuits multer.fields() with a 415 even
// though the video itself is fine. Routing by fieldname keeps each
// part on the correct allow-list.
function videoOrThumbnailFilter(
  _req: unknown,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) {
  if (file.fieldname === 'thumbnail') {
    return imageFilter(_req, file, cb);
  }
  return videoFilter(_req, file, cb);
}

// ── Multer middleware (memory storage, validates types + sizes) ──────────

export const avatarUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFilter,
});

// Covers are wider than avatars, so allow a slightly larger source file.
export const coverUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: imageFilter,
});

export const chatImageUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: imageFilter,
});

export const chatAudioUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: audioFilter,
});

// Pre-compressed videos from the client target ~16MB (matches WhatsApp);
// the 60MB server cap leaves headroom for compression slop. Multer
// rejects anything above this BEFORE buffering to memory, so a malicious
// client can't OOM the worker by streaming a giant file.
export const chatVideoUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: videoOrThumbnailFilter,
});

// Live Photo = three files in one message: `preview` (JPEG that renders
// everywhere), `still` (the ORIGINAL HEIC/JPEG, identifier intact) and
// `video` (the paired .mov, identifier intact). Images are validated as
// images; the `video` field as a video.
function livePhotoFilter(
  _req: unknown,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) {
  if (file.fieldname === 'video') {
    return videoFilter(_req, file, cb);
  }
  return imageFilter(_req, file, cb); // preview + still
}

export const chatLivePhotoUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: livePhotoFilter,
});

function documentFilter(_req: unknown, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  const allowed = [
    // Documents
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'application/zip',
    // Images
    'image/jpeg', 'image/png', 'image/webp',
    // Audio
    'audio/mpeg', 'audio/wav', 'audio/m4a', 'audio/aac', 'audio/mp4', 'audio/x-m4a',
  ];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type'));
  }
}

export const chatDocumentUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: documentFilter,
});

// ── Upload helpers ──────────────────────────────────────────────────────

export async function fileToAvatarUrl(file: Express.Multer.File, userId: string): Promise<string> {
  const resized = await sharp(file.buffer)
    .rotate()
    .resize(800, 800, { fit: 'cover' })
    .jpeg({ quality: 90 })
    .toBuffer();

  // Block NSFW / disallowed avatars BEFORE upload. Doing this after
  // upload would leave an unsafe file at the user's canonical avatar
  // URL (uploadAvatarToSupabase / R2 use a stable per-user key, so
  // each upload overwrites the previous one) — even if we later
  // throw, the file is publicly fetchable. Buffer-based check
  // sidesteps that window.
  const verdict = await moderateImageBuffer(resized, `avatar-${userId}.jpg`);
  if (!verdict.safe) {
    logger.warn(
      { userId, reason: verdict.reason, categories: verdict.categories },
      'Avatar upload rejected by moderation',
    );
    throw new ForbiddenError(
      verdict.reason ?? 'This image was rejected by our content policy',
    );
  }

  // 1. Supabase — stable per-user path, upserts on every change
  if (isSupabaseConfigured) {
    try {
      const result = await uploadAvatarToSupabase(resized, userId);
      return result.url;
    } catch (err) { /* fall through */ }
  }
  // 2. R2 fallback
  if (isR2Configured) {
    try {
      const result = await uploadToR2WithCustomKey(resized, `avatars/${userId}.jpg`, 'image/jpeg');
      return result.url;
    } catch (err) { /* fall through */ }
  }
  return saveToDisk(resized, 'uploads/avatars', '/uploads/avatars', '.jpg');
}

export async function fileToCoverUrl(file: Express.Multer.File, userId: string): Promise<string> {
  // Wide 16:9 banner. fit:'cover' crops to fill, matching the client crop.
  const resized = await sharp(file.buffer)
    .rotate()
    .resize(1600, 900, { fit: 'cover' })
    .jpeg({ quality: 85 })
    .toBuffer();

  // Same pre-upload NSFW gate as avatars — the cover is publicly fetchable
  // at a stable per-user URL, so reject unsafe images before they land.
  const verdict = await moderateImageBuffer(resized, `cover-${userId}.jpg`);
  if (!verdict.safe) {
    logger.warn(
      { userId, reason: verdict.reason, categories: verdict.categories },
      'Cover upload rejected by moderation',
    );
    throw new ForbiddenError(
      verdict.reason ?? 'This image was rejected by our content policy',
    );
  }

  // 1. Supabase — stable per-user path, upserts on every change
  if (isSupabaseConfigured) {
    try {
      const result = await uploadCoverToSupabase(resized, userId);
      return result.url;
    } catch (err) { /* fall through */ }
  }
  // 2. R2 fallback
  if (isR2Configured) {
    try {
      const result = await uploadToR2WithCustomKey(resized, `covers/${userId}.jpg`, 'image/jpeg');
      return result.url;
    } catch (err) { /* fall through */ }
  }
  return saveToDisk(resized, 'uploads/covers', '/uploads/covers', '.jpg');
}

/**
 * Group/channel AVATAR upload. MUST be keyed by the group (conversationId) — or
 * a fresh uuid at create time — NOT by the uploader's userId. Reusing
 * fileToAvatarUrl here was a data-corruption bug: that helper writes to a stable
 * per-user key (`<userId>.jpg`), so a group photo overwrote the uploader's own
 * personal avatar. We store under a `group_`-prefixed key / `group-avatars/`
 * folder so it can never collide with a user's avatar object.
 */
export async function fileToGroupAvatarUrl(file: Express.Multer.File, ownerKey: string): Promise<string> {
  const resized = await sharp(file.buffer)
    .rotate()
    .resize(800, 800, { fit: 'cover' })
    .jpeg({ quality: 90 })
    .toBuffer();

  const verdict = await moderateImageBuffer(resized, `group-avatar-${ownerKey}.jpg`);
  if (!verdict.safe) {
    logger.warn({ ownerKey, reason: verdict.reason, categories: verdict.categories }, 'Group avatar upload rejected by moderation');
    throw new ForbiddenError(verdict.reason ?? 'This image was rejected by our content policy');
  }

  const key = `group_${ownerKey}`;
  // 1. Supabase (avatars bucket, group-prefixed key — distinct from any user)
  if (isSupabaseConfigured) {
    try {
      const result = await uploadAvatarToSupabase(resized, key);
      return result.url;
    } catch (err) { /* fall through */ }
  }
  // 2. R2 fallback (separate folder)
  if (isR2Configured) {
    try {
      const result = await uploadToR2WithCustomKey(resized, `group-avatars/${ownerKey}.jpg`, 'image/jpeg');
      return result.url;
    } catch (err) { /* fall through */ }
  }
  return saveToDisk(resized, 'uploads/group-avatars', '/uploads/group-avatars', '.jpg');
}

/**
 * Group/channel BANNER (16:9) upload. Same rationale as fileToGroupAvatarUrl —
 * keyed by the group, never the uploader's userId (which would clobber the
 * user's personal cover photo).
 */
export async function fileToGroupBannerUrl(file: Express.Multer.File, ownerKey: string): Promise<string> {
  const resized = await sharp(file.buffer)
    .rotate()
    .resize(1600, 900, { fit: 'cover' })
    .jpeg({ quality: 85 })
    .toBuffer();

  const verdict = await moderateImageBuffer(resized, `group-banner-${ownerKey}.jpg`);
  if (!verdict.safe) {
    logger.warn({ ownerKey, reason: verdict.reason, categories: verdict.categories }, 'Group banner upload rejected by moderation');
    throw new ForbiddenError(verdict.reason ?? 'This image was rejected by our content policy');
  }

  const key = `group_${ownerKey}`;
  // 1. Supabase (covers bucket, group-prefixed key)
  if (isSupabaseConfigured) {
    try {
      const result = await uploadCoverToSupabase(resized, key);
      return result.url;
    } catch (err) { /* fall through */ }
  }
  // 2. R2 fallback (separate folder)
  if (isR2Configured) {
    try {
      const result = await uploadToR2WithCustomKey(resized, `group-banners/${ownerKey}.jpg`, 'image/jpeg');
      return result.url;
    } catch (err) { /* fall through */ }
  }
  return saveToDisk(resized, 'uploads/group-banners', '/uploads/group-banners', '.jpg');
}

export async function fileToChatImageUrl(file: Express.Multer.File, conversationId: string): Promise<string> {
  // 1. Supabase
  if (isSupabaseConfigured) {
    try {
      const result = await uploadChatImageToSupabase(file.buffer, conversationId, file.originalname || 'image.jpg');
      return result.url;
    } catch (err) { /* fall through */ }
  }
  // 2. Google Drive fallback
  if (isDriveConfigured()) {
    const result = await uploadToDrive(file.buffer, file.originalname || 'image.jpg', file.mimetype || 'image/jpeg');
    if (result) return result.url;
  }
  return saveToDisk(file.buffer, 'uploads/chat', '/uploads/chat', path.extname(file.originalname) || '.jpg');
}

/**
 * Upload the ORIGINAL Live Photo still (HEIC/JPEG) to R2, byte-for-byte.
 * It must NOT be re-encoded: the Live Photo pairing relies on the Apple
 * asset-identifier embedded in the original file's metadata, which any
 * sharp/transcode step would strip. Paired with the original .mov (uploaded
 * via fileToChatVideoUrl) this lets the recipient's iPhone rebuild a real
 * Live Photo (PHLivePhotoView). Falls back to Supabase/disk, which also
 * preserve raw bytes.
 */
export async function fileToChatLivePhotoStillUrl(file: Express.Multer.File, conversationId: string): Promise<string> {
  if (isR2Configured) {
    try {
      return await uploadImageToR2(file.buffer, `chat/${conversationId}/livephotos`, file.originalname || 'still.heic', file.mimetype);
    } catch (err) { /* fall through */ }
  }
  if (isSupabaseConfigured) {
    try {
      const result = await uploadChatImageToSupabase(file.buffer, conversationId, file.originalname || 'still.heic');
      return result.url;
    } catch (err) { /* fall through */ }
  }
  return saveToDisk(file.buffer, 'uploads/chat', '/uploads/chat', path.extname(file.originalname) || '.heic');
}

export async function fileToChatAudioUrl(file: Express.Multer.File, conversationId: string): Promise<string> {
  // 1. Supabase
  if (isSupabaseConfigured) {
    try {
      const result = await uploadVoiceNoteToSupabase(file.buffer, conversationId, file.originalname || 'audio.m4a');
      return result.url;
    } catch (err) { /* fall through */ }
  }
  // 2. Google Drive fallback
  if (isDriveConfigured()) {
    const result = await uploadToDrive(file.buffer, file.originalname || 'audio.m4a', file.mimetype || 'audio/mp4');
    if (result) return result.url;
  }
  return saveToDisk(file.buffer, 'uploads/audio', '/uploads/audio', path.extname(file.originalname) || '.m4a');
}

/**
 * Upload a chat video to R2 (cheap egress, byte-range streaming via
 * Cloudflare's CDN). Falls back to Cloudinary if R2 isn't configured,
 * and to local disk as a last resort. Always returns the public URL
 * for the video; thumbnails are uploaded separately via
 * fileToChatVideoThumbnailUrl since R2 has no auto-thumbnail like
 * Cloudinary.
 */
export async function fileToChatVideoUrl(file: Express.Multer.File, conversationId: string): Promise<string> {
  if (isR2Configured) {
    try {
      const result = await uploadVideoToR2(file.buffer, `chat/${conversationId}/videos`, file.originalname || 'video.mp4');
      return result.url;
    } catch (err) { /* R2 failed, fall back */ }
  }
  if (cloudinaryService.isCloudinaryConfigured) {
    const result = await cloudinaryService.uploadBuffer(file.buffer, {
      folder: `yomeet/chat/${conversationId}/videos`,
      resourceType: 'video',
    });
    if (result) return result.secureUrl;
  }
  return saveToDisk(file.buffer, 'uploads/chat-videos', '/uploads/chat-videos', path.extname(file.originalname) || '.mp4');
}

/**
 * Upload a chat video's poster thumbnail (jpg/png) — same R2 bucket,
 * different folder. Generated client-side because R2 doesn't auto-
 * extract poster frames the way Cloudinary does.
 */
export async function fileToChatVideoThumbnailUrl(file: Express.Multer.File, conversationId: string): Promise<string> {
  if (isR2Configured) {
    try {
      return await uploadImageToR2(file.buffer, `chat/${conversationId}/video-thumbnails`, file.originalname || 'thumb.jpg', file.mimetype);
    } catch (err) { /* R2 failed, fall back */ }
  }
  if (cloudinaryService.isCloudinaryConfigured) {
    const result = await cloudinaryService.uploadChatImage(file.buffer, conversationId);
    if (result) return result.secureUrl;
  }
  return saveToDisk(file.buffer, 'uploads/chat-videos', '/uploads/chat-videos', path.extname(file.originalname) || '.jpg');
}

export async function fileToChatDocumentUrl(file: Express.Multer.File, conversationId: string): Promise<string> {
  // 1. Try Google Drive
  if (isDriveConfigured()) {
    const result = await uploadToDrive(file.buffer, file.originalname || 'document', file.mimetype || 'application/octet-stream');
    if (result) return result.url;
  }
  // 2. Fallback to Cloudinary (raw resource type for non-media files)
  if (cloudinaryService.isCloudinaryConfigured) {
    const result = await cloudinaryService.uploadBuffer(file.buffer, {
      folder: `yomeet/chat/${conversationId}/documents`,
      resourceType: 'raw',
    });
    if (result) return result.secureUrl;
  }
  return saveToDisk(file.buffer, 'uploads/documents', '/uploads/documents', path.extname(file.originalname) || '.bin');
}

function storyMediaFilter(_req: unknown, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  // Check mime type first
  if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
    cb(null, true);
    return;
  }
  // Fallback: check file extension for cases where mime type is application/octet-stream (e.g. HEIC from iOS)
  const ext = (file.originalname || '').split('.').pop()?.toLowerCase() || '';
  const mediaExts = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'bmp', 'tiff', 'dng', 'raw', 'mp4', 'mov', 'm4v', 'avi', 'mkv'];
  if (mediaExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file: ${file.originalname} (${file.mimetype})`));
  }
}

// Keep legacy export name for backward compatibility
export const storyImageUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: storyMediaFilter,
});

export const storyMediaUpload = multer({
  storage: storyDiskStorage,
  limits: { fileSize: 260 * 1024 * 1024 }, // 260MB hard cap (250MB tier + headroom); per-tier limit enforced in story router
  fileFilter: storyMediaFilter,
});

// Reels use memory storage (single video ≤100MB, buffer consumed directly by
// reel.service). Kept separate from storyMediaUpload so the story disk-storage
// change doesn't strip reels' expected `file.buffer`.
export const reelVideoUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: storyMediaFilter,
});

/**
 * Transcode a (web-safe H.264) reel into an adaptive HLS ladder and upload all
 * of its files (master playlist, per-rendition playlists, .ts segments) under
 * one R2 prefix. Returns the master playlist URL + the prefix key (stored for
 * cleanup — delete the whole prefix on reel delete via deleteR2Prefix).
 *
 * Returns null if HLS transcode is unavailable/failed so the caller can fall
 * back to a single-MP4 upload (the reel still posts, just non-adaptive).
 */
export async function fileToReelHls(
  video: Buffer,
  userId: string,
): Promise<{ url: string; key: string } | null> {
  if (!isR2Configured) return null;
  const files = await transcodeToHls(video, '.mp4');
  if (!files || files.length === 0) return null;

  const prefix = `reels/${userId}/${uuidv4()}`;
  let masterUrl: string | null = null;
  // Segments are independent objects — upload concurrently.
  await Promise.all(
    files.map(async (f) => {
      const { url } = await uploadToR2WithCustomKey(
        f.buffer,
        `${prefix}/${f.name}`,
        f.contentType,
      );
      if (f.name === 'master.m3u8') masterUrl = url;
    }),
  );
  if (!masterUrl) return null;
  return { url: masterUrl, key: prefix };
}

export async function fileToStoryImageUrl(
  file: Express.Multer.File,
  userId: string
): Promise<{ secureUrl: string; publicId: string }> {
  // 1. Try R2. publicId here is the R2 key — story.service.ts cleanup
  // discriminates by the `yomeet/` vs `stories/` prefix to route deletes
  // to the right backend (lazy migration: old slides stay on Cloudinary).
  const buffer = await ensureBuffer(file);
  if (isR2Configured) {
    try {
      const resized = await sharp(buffer)
        .rotate()
        .resize(1080, 1920, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();
      const result = await uploadToR2WithKey(
        resized,
        `stories/${userId}`,
        'image.jpg',
        'image/jpeg',
      );
      return { secureUrl: result.url, publicId: result.key };
    } catch (err) { /* R2/sharp failed, fall back */ }
  }
  // 2. Fallback to Cloudinary
  if (cloudinaryService.isCloudinaryConfigured) {
    const result = await cloudinaryService.uploadBuffer(buffer, {
      folder: `yomeet/stories/${userId}`,
      transformation: {
        width: 1080,
        height: 1920,
        crop: 'limit',
        quality: 90,
      },
    });
    if (result) return { secureUrl: result.secureUrl, publicId: result.publicId };
  }
  const url = saveToDisk(buffer, 'uploads/stories', '/uploads/stories', path.extname(file.originalname) || '.jpg');
  return { secureUrl: url, publicId: '' };
}

export async function fileToStoryVideoUrl(
  file: Express.Multer.File,
  userId: string
): Promise<{ secureUrl: string; publicId: string; thumbnailUrl: string | null }> {
  // Normalize to a web-safe H.264 MP4 (transcodes iPhone HEVC/HDR/4K) so the
  // stored story plays on every device. Fail-open → original buffer.
  const normalized = await ensureWebSafeH264(
    await ensureBuffer(file),
    path.extname(file.originalname || '') || '.mp4',
  );
  // 1. Try R2. Frontend renders the first frame as poster (no server thumbnail).
  if (isR2Configured) {
    try {
      const result = await uploadToR2WithKey(
        normalized,
        `stories/${userId}`,
        'video.mp4',
        'video/mp4',
      );
      return { secureUrl: result.url, publicId: result.key, thumbnailUrl: null };
    } catch (err) { /* R2 failed, fall back */ }
  }
  // 2. Fallback to Cloudinary
  if (cloudinaryService.isCloudinaryConfigured) {
    const result = await cloudinaryService.uploadBuffer(normalized, {
      folder: `yomeet/stories/${userId}`,
      resourceType: 'video',
    });
    if (result) {
      // Serve 720p adaptive quality — keeps the original 1080p on Cloudinary
      // but delivers a smaller stream for playback on mobile devices.
      const optimizedUrl = result.secureUrl.replace('/upload/', '/upload/w_720,q_auto,f_auto/');
      const thumbnailUrl = optimizedUrl.replace(/\.[^.]+$/, '.jpg');
      return { secureUrl: optimizedUrl, publicId: result.publicId, thumbnailUrl };
    }
  }
  const url = saveToDisk(normalized, 'uploads/stories', '/uploads/stories', '.mp4');
  return { secureUrl: url, publicId: '', thumbnailUrl: null };
}

// ── Post media upload (images + videos, max 10 files, 100MB) ──────────

export const postMediaUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: storyMediaFilter,
});

export async function fileToPostImageUrl(
  file: Express.Multer.File,
  userId: string
): Promise<{ secureUrl: string; publicId: string }> {
  // 1. Try R2 (cheapest, no egress)
  if (isR2Configured) {
    try {
      const url = await uploadImageToR2(file.buffer, `posts/${userId}`, file.originalname || 'image.jpg', file.mimetype);
      return { secureUrl: url, publicId: '' };
    } catch (err) { /* R2 failed, fall back to next storage */ }
  }
  // 2. Fallback to Cloudinary
  if (cloudinaryService.isCloudinaryConfigured) {
    const result = await cloudinaryService.uploadBuffer(file.buffer, {
      folder: `yomeet/posts/${userId}`,
      transformation: { width: 1080, crop: 'limit', quality: 90 },
    });
    if (result) return { secureUrl: result.secureUrl, publicId: result.publicId };
  }
  const url = saveToDisk(file.buffer, 'uploads/posts', '/uploads/posts', path.extname(file.originalname) || '.jpg');
  return { secureUrl: url, publicId: '' };
}

export async function fileToPostVideoUrl(
  file: Express.Multer.File,
  userId: string
): Promise<{ secureUrl: string; publicId: string; thumbnailUrl: string | null }> {
  // Normalize to a web-safe H.264 MP4 (transcodes iPhone HEVC/HDR/4K) so it
  // plays everywhere and the moderator can decode it. Fail-open → original.
  const normalized = await ensureWebSafeH264(
    file.buffer,
    path.extname(file.originalname || '') || '.mp4',
  );
  // 1. Try R2 (cheapest, no egress)
  if (isR2Configured) {
    try {
      const result = await uploadVideoToR2(normalized, `posts/${userId}`, 'video.mp4');
      return { secureUrl: result.url, publicId: '', thumbnailUrl: result.thumbnailUrl };
    } catch (err) { /* R2 failed, fall back to next storage */ }
  }
  // 2. Fallback to Cloudinary
  if (cloudinaryService.isCloudinaryConfigured) {
    const result = await cloudinaryService.uploadBuffer(normalized, {
      folder: `yomeet/posts/${userId}`,
      resourceType: 'video',
    });
    if (result) {
      const optimizedUrl = result.secureUrl.replace('/upload/', '/upload/w_720,q_auto,f_auto/');
      const thumbnailUrl = optimizedUrl.replace(/\.[^.]+$/, '.jpg');
      return { secureUrl: optimizedUrl, publicId: result.publicId, thumbnailUrl };
    }
  }
  const url = saveToDisk(normalized, 'uploads/posts', '/uploads/posts', '.mp4');
  return { secureUrl: url, publicId: '', thumbnailUrl: null };
}
