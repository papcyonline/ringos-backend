import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

const AVATAR_DIR = path.join(process.cwd(), 'uploads', 'avatars');
const CHAT_IMAGE_DIR = path.join(process.cwd(), 'uploads', 'chat');
const ALLOWED_MIMETYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_CHAT_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

function ensureDir(dir: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, ensureDir(AVATAR_DIR));
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});

export const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
  },
});

export function fileToAvatarUrl(file: Express.Multer.File): string {
  return `/uploads/avatars/${file.filename}`;
}

const chatImageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, ensureDir(CHAT_IMAGE_DIR));
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});

export const chatImageUpload = multer({
  storage: chatImageStorage,
  limits: { fileSize: MAX_CHAT_IMAGE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
  },
});

export function fileToChatImageUrl(file: Express.Multer.File): string {
  return `/uploads/chat/${file.filename}`;
}
