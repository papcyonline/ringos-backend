import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import * as cloudinaryService from './cloudinary.service';

// Use memory storage — files live in buffer until uploaded to Cloudinary
const memoryStorage = multer.memoryStorage();

// Fallback: save buffer to local disk and return local URL
function saveToDisk(buffer: Buffer, dir: string, urlPrefix: string, ext: string): string {
  const fullDir = path.join(process.cwd(), dir);
  if (!fs.existsSync(fullDir)) fs.mkdirSync(fullDir, { recursive: true });
  const filename = `${uuidv4()}${ext}`;
  fs.writeFileSync(path.join(fullDir, filename), buffer);
  return `${urlPrefix}/${filename}`;
}

function imageFilter(_req: unknown, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
  }
}

function audioFilter(_req: unknown, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  if (['audio/mpeg', 'audio/wav', 'audio/m4a', 'audio/aac', 'audio/mp4', 'audio/x-m4a'].includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only MP3, WAV, M4A, and AAC audio files are allowed'));
  }
}

// ── Multer middleware (memory storage, validates types + sizes) ──────────

export const avatarUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
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

// ── Upload helpers — Cloudinary with local disk fallback ────────────────

export async function fileToAvatarUrl(file: Express.Multer.File, userId: string): Promise<string> {
  if (cloudinaryService.isCloudinaryConfigured) {
    const result = await cloudinaryService.uploadAvatar(file.buffer, userId);
    if (result) return result.secureUrl;
  }
  return saveToDisk(file.buffer, 'uploads/avatars', '/uploads/avatars', path.extname(file.originalname) || '.jpg');
}

export async function fileToChatImageUrl(file: Express.Multer.File, conversationId: string): Promise<string> {
  if (cloudinaryService.isCloudinaryConfigured) {
    const result = await cloudinaryService.uploadChatImage(file.buffer, conversationId);
    if (result) return result.secureUrl;
  }
  return saveToDisk(file.buffer, 'uploads/chat', '/uploads/chat', path.extname(file.originalname) || '.jpg');
}

export async function fileToChatAudioUrl(file: Express.Multer.File, conversationId: string): Promise<string> {
  if (cloudinaryService.isCloudinaryConfigured) {
    const result = await cloudinaryService.uploadVoiceNote(file.buffer, conversationId);
    if (result) return result.secureUrl;
  }
  return saveToDisk(file.buffer, 'uploads/audio', '/uploads/audio', path.extname(file.originalname) || '.m4a');
}

function storyMediaFilter(_req: unknown, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  const allowed = [
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/quicktime', 'video/x-m4v',
  ];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, WebP images and MP4, MOV, M4V videos are allowed'));
  }
}

// Keep legacy export name for backward compatibility
export const storyImageUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: storyMediaFilter,
});

export const storyMediaUpload = multer({
  storage: memoryStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: storyMediaFilter,
});

export async function fileToStoryImageUrl(
  file: Express.Multer.File,
  userId: string
): Promise<{ secureUrl: string; publicId: string }> {
  if (cloudinaryService.isCloudinaryConfigured) {
    const result = await cloudinaryService.uploadBuffer(file.buffer, {
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
  const url = saveToDisk(file.buffer, 'uploads/stories', '/uploads/stories', path.extname(file.originalname) || '.jpg');
  return { secureUrl: url, publicId: '' };
}

export async function fileToStoryVideoUrl(
  file: Express.Multer.File,
  userId: string
): Promise<{ secureUrl: string; publicId: string; thumbnailUrl: string | null }> {
  if (cloudinaryService.isCloudinaryConfigured) {
    const result = await cloudinaryService.uploadBuffer(file.buffer, {
      folder: `yomeet/stories/${userId}`,
      resourceType: 'video',
    });
    if (result) {
      // Derive thumbnail URL: replace the video extension with .jpg
      const thumbnailUrl = result.secureUrl.replace(/\.[^.]+$/, '.jpg');
      return { secureUrl: result.secureUrl, publicId: result.publicId, thumbnailUrl };
    }
  }
  const url = saveToDisk(file.buffer, 'uploads/stories', '/uploads/stories', path.extname(file.originalname) || '.mp4');
  return { secureUrl: url, publicId: '', thumbnailUrl: null };
}
