import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

function ensureDir(dir: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

interface UploadConfig {
  directory: string;
  urlPrefix: string;
  allowedMimeTypes: string[];
  maxFileSize: number;
  defaultExt: string;
  errorMessage: string;
}

function createUpload(config: UploadConfig) {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, ensureDir(config.directory));
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || config.defaultExt;
      cb(null, `${uuidv4()}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: config.maxFileSize },
    fileFilter: (_req, file, cb) => {
      if (config.allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(config.errorMessage));
      }
    },
  });

  const fileToUrl = (file: Express.Multer.File): string => {
    return `${config.urlPrefix}/${file.filename}`;
  };

  return { upload, fileToUrl };
}

// ── Avatar upload ────────────────────────────────────────────────────────
const avatar = createUpload({
  directory: path.join(process.cwd(), 'uploads', 'avatars'),
  urlPrefix: '/uploads/avatars',
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  maxFileSize: 5 * 1024 * 1024,
  defaultExt: '.jpg',
  errorMessage: 'Only JPEG, PNG, and WebP images are allowed',
});

export const avatarUpload = avatar.upload;
export const fileToAvatarUrl = avatar.fileToUrl;

// ── Chat image upload ────────────────────────────────────────────────────
const chatImage = createUpload({
  directory: path.join(process.cwd(), 'uploads', 'chat'),
  urlPrefix: '/uploads/chat',
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  maxFileSize: 10 * 1024 * 1024,
  defaultExt: '.jpg',
  errorMessage: 'Only JPEG, PNG, and WebP images are allowed',
});

export const chatImageUpload = chatImage.upload;
export const fileToChatImageUrl = chatImage.fileToUrl;

// ── Chat audio upload ────────────────────────────────────────────────────
const chatAudio = createUpload({
  directory: path.join(process.cwd(), 'uploads', 'audio'),
  urlPrefix: '/uploads/audio',
  allowedMimeTypes: ['audio/mpeg', 'audio/wav', 'audio/m4a', 'audio/aac', 'audio/mp4', 'audio/x-m4a'],
  maxFileSize: 25 * 1024 * 1024,
  defaultExt: '.m4a',
  errorMessage: 'Only MP3, WAV, M4A, and AAC audio files are allowed',
});

export const chatAudioUpload = chatAudio.upload;
export const fileToChatAudioUrl = chatAudio.fileToUrl;
