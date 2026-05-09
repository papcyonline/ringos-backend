import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  cloudinaryService,
  mockIsDriveConfigured,
  mockUploadToDrive,
  mockIsR2Configured,
  mockUploadImageToR2,
  mockUploadVideoToR2,
  mockExistsSync,
  mockMkdirSync,
  mockWriteFileSync,
} = vi.hoisted(() => ({
  cloudinaryService: {
    isCloudinaryConfigured: false,
    uploadAvatar: vi.fn(),
    uploadChatImage: vi.fn(),
    uploadVoiceNote: vi.fn(),
    uploadBuffer: vi.fn(),
  },
  mockIsDriveConfigured: vi.fn(),
  mockUploadToDrive: vi.fn(),
  mockIsR2Configured: { value: false },
  mockUploadImageToR2: vi.fn(),
  mockUploadVideoToR2: vi.fn(),
  mockExistsSync: vi.fn(() => true),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

vi.mock('../cloudinary.service', () => cloudinaryService);
vi.mock('../gdrive.service', () => ({
  isDriveConfigured: mockIsDriveConfigured,
  uploadToDrive: mockUploadToDrive,
}));
vi.mock('../r2.service', () => ({
  get isR2Configured() { return mockIsR2Configured.value; },
  uploadImageToR2: mockUploadImageToR2,
  uploadVideoToR2: mockUploadVideoToR2,
}));
vi.mock('uuid', () => ({ v4: () => 'uuid-x' }));
vi.mock('fs', () => ({
  default: {
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
  },
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
}));

import {
  fileToAvatarUrl,
  fileToChatImageUrl,
  fileToChatAudioUrl,
  fileToChatVideoUrl,
  fileToChatVideoThumbnailUrl,
  fileToChatDocumentUrl,
  fileToStoryImageUrl,
  fileToStoryVideoUrl,
  fileToPostImageUrl,
  fileToPostVideoUrl,
  avatarUpload,
  chatImageUpload,
  chatAudioUpload,
  chatVideoUpload,
  chatDocumentUpload,
  storyImageUpload,
  storyMediaUpload,
  postMediaUpload,
} from '../upload';

beforeEach(() => {
  vi.clearAllMocks();
  cloudinaryService.isCloudinaryConfigured = false;
  mockIsDriveConfigured.mockReturnValue(false);
  mockIsR2Configured.value = false;
  mockExistsSync.mockReturnValue(true);
});

function makeFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    buffer: Buffer.from('x'),
    originalname: 'a.jpg',
    mimetype: 'image/jpeg',
    fieldname: 'file',
    encoding: '7bit',
    size: 1,
    destination: '',
    filename: '',
    path: '',
    stream: undefined as any,
    ...overrides,
  } as any;
}

describe('multer file filters', () => {
  function getFilter(uploader: any): any {
    return (uploader as any).fileFilter;
  }

  it('avatar/chatImage filter accepts image/* mime', () => {
    const cb = vi.fn();
    const fn = getFilter(avatarUpload);
    fn({}, { mimetype: 'image/jpeg', originalname: 'a.jpg' }, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('avatar filter accepts heic via extension', () => {
    const cb = vi.fn();
    const fn = getFilter(avatarUpload);
    fn({}, { mimetype: 'application/octet-stream', originalname: 'pic.heic' }, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('avatar filter rejects unknown', () => {
    const cb = vi.fn();
    const fn = getFilter(avatarUpload);
    fn({}, { mimetype: 'application/pdf', originalname: 'x.pdf' }, cb);
    expect(cb).toHaveBeenCalledWith(expect.any(Error));
  });

  it('audio filter accepts m4a', () => {
    const cb = vi.fn();
    const fn = getFilter(chatAudioUpload);
    fn({}, { mimetype: 'audio/m4a', originalname: 'a.m4a' }, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('audio filter rejects video', () => {
    const cb = vi.fn();
    const fn = getFilter(chatAudioUpload);
    fn({}, { mimetype: 'video/mp4', originalname: 'v.mp4' }, cb);
    expect(cb).toHaveBeenCalledWith(expect.any(Error));
  });

  it('document filter accepts pdf', () => {
    const cb = vi.fn();
    const fn = getFilter(chatDocumentUpload);
    fn({}, { mimetype: 'application/pdf', originalname: 'a.pdf' }, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('document filter rejects unknown mime', () => {
    const cb = vi.fn();
    const fn = getFilter(chatDocumentUpload);
    fn({}, { mimetype: 'application/octet-stream', originalname: 'x.bin' }, cb);
    expect(cb).toHaveBeenCalledWith(expect.any(Error));
  });

  it('video filter accepts video/*', () => {
    const cb = vi.fn();
    const fn = getFilter(chatVideoUpload);
    fn({}, { fieldname: 'video', mimetype: 'video/mp4', originalname: 'v.mp4' }, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('video filter accepts mov via extension', () => {
    const cb = vi.fn();
    const fn = getFilter(chatVideoUpload);
    fn({}, { fieldname: 'video', mimetype: 'application/octet-stream', originalname: 'movie.mov' }, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('video filter rejects unknown extension', () => {
    const cb = vi.fn();
    const fn = getFilter(chatVideoUpload);
    fn({}, { fieldname: 'video', mimetype: 'image/jpeg', originalname: 'v.jpg' }, cb);
    expect(cb).toHaveBeenCalledWith(expect.any(Error));
  });

  it('video-or-thumbnail filter accepts thumbnail as image', () => {
    const cb = vi.fn();
    const fn = getFilter(chatVideoUpload);
    fn({}, { fieldname: 'thumbnail', mimetype: 'image/jpeg', originalname: 't.jpg' }, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('storyMedia filter accepts video/* mime', () => {
    const cb = vi.fn();
    const fn = getFilter(storyMediaUpload);
    fn({}, { mimetype: 'video/mp4', originalname: 'v.mp4' }, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('storyMedia filter accepts heic via extension', () => {
    const cb = vi.fn();
    const fn = getFilter(storyMediaUpload);
    fn({}, { mimetype: 'application/octet-stream', originalname: 'pic.heic' }, cb);
    expect(cb).toHaveBeenCalledWith(null, true);
  });

  it('storyMedia filter rejects unknown', () => {
    const cb = vi.fn();
    const fn = getFilter(storyMediaUpload);
    fn({}, { mimetype: 'application/pdf', originalname: 'x.pdf' }, cb);
    expect(cb).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('upload — multer instances exist', () => {
  it('exports configured multer instances', () => {
    expect(avatarUpload).toBeDefined();
    expect(chatImageUpload).toBeDefined();
    expect(chatAudioUpload).toBeDefined();
    expect(chatVideoUpload).toBeDefined();
    expect(chatDocumentUpload).toBeDefined();
    expect(storyImageUpload).toBeDefined();
    expect(storyMediaUpload).toBeDefined();
    expect(postMediaUpload).toBeDefined();
  });
});

describe('fileToAvatarUrl', () => {
  it('uses Cloudinary when configured', async () => {
    cloudinaryService.isCloudinaryConfigured = true;
    cloudinaryService.uploadAvatar.mockResolvedValue({ secureUrl: 'https://cdn/a.jpg' });
    const url = await fileToAvatarUrl(makeFile(), 'u-1');
    expect(url).toBe('https://cdn/a.jpg');
  });

  it('falls back to disk when not configured', async () => {
    const url = await fileToAvatarUrl(makeFile({ originalname: 'pic.png' }), 'u-1');
    expect(url).toBe('/uploads/avatars/uuid-x.png');
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('creates folder if missing', async () => {
    mockExistsSync.mockReturnValue(false);
    await fileToAvatarUrl(makeFile(), 'u-1');
    expect(mockMkdirSync).toHaveBeenCalled();
  });
});

describe('fileToChatImageUrl', () => {
  it('prefers Drive when configured', async () => {
    mockIsDriveConfigured.mockReturnValue(true);
    mockUploadToDrive.mockResolvedValue({ url: '/media/gdrive/abc' });
    const url = await fileToChatImageUrl(makeFile(), 'c-1');
    expect(url).toBe('/media/gdrive/abc');
  });

  it('falls back to Cloudinary', async () => {
    cloudinaryService.isCloudinaryConfigured = true;
    cloudinaryService.uploadChatImage.mockResolvedValue({ secureUrl: 'https://cdn' });
    const url = await fileToChatImageUrl(makeFile(), 'c-1');
    expect(url).toBe('https://cdn');
  });

  it('falls back to disk when neither configured', async () => {
    const url = await fileToChatImageUrl(makeFile(), 'c-1');
    expect(url).toMatch(/^\/uploads\/chat\//);
  });
});

describe('fileToChatAudioUrl', () => {
  it('uses Drive', async () => {
    mockIsDriveConfigured.mockReturnValue(true);
    mockUploadToDrive.mockResolvedValue({ url: '/media/gdrive/aaa' });
    const url = await fileToChatAudioUrl(makeFile({ originalname: 'a.m4a', mimetype: 'audio/m4a' }), 'c-1');
    expect(url).toBe('/media/gdrive/aaa');
  });

  it('falls back to Cloudinary then disk', async () => {
    cloudinaryService.isCloudinaryConfigured = true;
    cloudinaryService.uploadVoiceNote.mockResolvedValue({ secureUrl: 'https://cdn/v.m4a' });
    const url = await fileToChatAudioUrl(makeFile({ originalname: 'a.m4a' }), 'c-1');
    expect(url).toBe('https://cdn/v.m4a');
  });

  it('disk fallback', async () => {
    const url = await fileToChatAudioUrl(makeFile({ originalname: 'a.m4a' }), 'c-1');
    expect(url).toMatch(/^\/uploads\/audio\//);
  });
});

describe('fileToChatVideoUrl', () => {
  it('prefers R2', async () => {
    mockIsR2Configured.value = true;
    mockUploadVideoToR2.mockResolvedValue({ url: 'https://r2/v.mp4' });
    const url = await fileToChatVideoUrl(makeFile({ originalname: 'v.mp4' }), 'c-1');
    expect(url).toBe('https://r2/v.mp4');
  });

  it('falls back to Cloudinary if R2 fails', async () => {
    mockIsR2Configured.value = true;
    mockUploadVideoToR2.mockRejectedValue(new Error('r2-down'));
    cloudinaryService.isCloudinaryConfigured = true;
    cloudinaryService.uploadBuffer.mockResolvedValue({ secureUrl: 'https://cdn/v' });
    const url = await fileToChatVideoUrl(makeFile({ originalname: 'v.mp4' }), 'c-1');
    expect(url).toBe('https://cdn/v');
  });

  it('disk fallback', async () => {
    const url = await fileToChatVideoUrl(makeFile({ originalname: 'v.mp4' }), 'c-1');
    expect(url).toMatch(/^\/uploads\/chat-videos\//);
  });
});

describe('fileToChatVideoThumbnailUrl', () => {
  it('prefers R2', async () => {
    mockIsR2Configured.value = true;
    mockUploadImageToR2.mockResolvedValue('https://r2/t.jpg');
    const url = await fileToChatVideoThumbnailUrl(makeFile(), 'c-1');
    expect(url).toBe('https://r2/t.jpg');
  });

  it('falls back to Cloudinary', async () => {
    mockIsR2Configured.value = true;
    mockUploadImageToR2.mockRejectedValue(new Error('r2'));
    cloudinaryService.isCloudinaryConfigured = true;
    cloudinaryService.uploadChatImage.mockResolvedValue({ secureUrl: 'https://cdn/t.jpg' });
    const url = await fileToChatVideoThumbnailUrl(makeFile(), 'c-1');
    expect(url).toBe('https://cdn/t.jpg');
  });

  it('disk fallback', async () => {
    const url = await fileToChatVideoThumbnailUrl(makeFile(), 'c-1');
    expect(url).toMatch(/^\/uploads\/chat-videos\//);
  });
});

describe('fileToChatDocumentUrl', () => {
  it('uses Drive', async () => {
    mockIsDriveConfigured.mockReturnValue(true);
    mockUploadToDrive.mockResolvedValue({ url: '/media/gdrive/d' });
    const url = await fileToChatDocumentUrl(makeFile({ originalname: 'a.pdf', mimetype: 'application/pdf' }), 'c-1');
    expect(url).toBe('/media/gdrive/d');
  });

  it('falls back to Cloudinary raw', async () => {
    cloudinaryService.isCloudinaryConfigured = true;
    cloudinaryService.uploadBuffer.mockResolvedValue({ secureUrl: 'https://cdn/d' });
    const url = await fileToChatDocumentUrl(makeFile({ originalname: 'a.pdf' }), 'c-1');
    expect(url).toBe('https://cdn/d');
  });

  it('disk fallback', async () => {
    const url = await fileToChatDocumentUrl(makeFile({ originalname: 'a.pdf' }), 'c-1');
    expect(url).toMatch(/^\/uploads\/documents\//);
  });
});

describe('fileToStoryImageUrl', () => {
  it('uses Cloudinary', async () => {
    cloudinaryService.isCloudinaryConfigured = true;
    cloudinaryService.uploadBuffer.mockResolvedValue({ secureUrl: 'https://cdn', publicId: 'p1' });
    const r = await fileToStoryImageUrl(makeFile(), 'u-1');
    expect(r.secureUrl).toBe('https://cdn');
    expect(r.publicId).toBe('p1');
  });

  it('disk fallback', async () => {
    const r = await fileToStoryImageUrl(makeFile(), 'u-1');
    expect(r.publicId).toBe('');
    expect(r.secureUrl).toMatch(/^\/uploads\/stories\//);
  });
});

describe('fileToStoryVideoUrl', () => {
  it('uses Cloudinary with optimized URL', async () => {
    cloudinaryService.isCloudinaryConfigured = true;
    cloudinaryService.uploadBuffer.mockResolvedValue({
      secureUrl: 'https://cdn/upload/v.mp4', publicId: 'p',
    });
    const r = await fileToStoryVideoUrl(makeFile({ originalname: 'v.mp4' }), 'u-1');
    expect(r.secureUrl).toContain('w_720');
    expect(r.thumbnailUrl).toMatch(/\.jpg$/);
  });

  it('disk fallback', async () => {
    const r = await fileToStoryVideoUrl(makeFile({ originalname: 'v.mp4' }), 'u-1');
    expect(r.thumbnailUrl).toBeNull();
  });
});

describe('fileToPostImageUrl', () => {
  it('prefers R2', async () => {
    mockIsR2Configured.value = true;
    mockUploadImageToR2.mockResolvedValue('https://r2/p.jpg');
    const r = await fileToPostImageUrl(makeFile(), 'u-1');
    expect(r.secureUrl).toBe('https://r2/p.jpg');
  });

  it('falls back to Cloudinary if R2 fails', async () => {
    mockIsR2Configured.value = true;
    mockUploadImageToR2.mockRejectedValue(new Error('r2'));
    cloudinaryService.isCloudinaryConfigured = true;
    cloudinaryService.uploadBuffer.mockResolvedValue({ secureUrl: 'https://cdn', publicId: 'p' });
    const r = await fileToPostImageUrl(makeFile(), 'u-1');
    expect(r.secureUrl).toBe('https://cdn');
  });

  it('disk fallback', async () => {
    const r = await fileToPostImageUrl(makeFile(), 'u-1');
    expect(r.secureUrl).toMatch(/^\/uploads\/posts\//);
  });
});

describe('fileToPostVideoUrl', () => {
  it('uses R2 with thumbnail null', async () => {
    mockIsR2Configured.value = true;
    mockUploadVideoToR2.mockResolvedValue({ url: 'https://r2/v.mp4', thumbnailUrl: null });
    const r = await fileToPostVideoUrl(makeFile({ originalname: 'v.mp4' }), 'u-1');
    expect(r.secureUrl).toBe('https://r2/v.mp4');
    expect(r.thumbnailUrl).toBeNull();
  });

  it('falls back to Cloudinary on R2 fail', async () => {
    mockIsR2Configured.value = true;
    mockUploadVideoToR2.mockRejectedValue(new Error('r2'));
    cloudinaryService.isCloudinaryConfigured = true;
    cloudinaryService.uploadBuffer.mockResolvedValue({
      secureUrl: 'https://cdn/upload/v.mp4', publicId: 'p',
    });
    const r = await fileToPostVideoUrl(makeFile({ originalname: 'v.mp4' }), 'u-1');
    expect(r.secureUrl).toContain('w_720');
  });

  it('disk fallback', async () => {
    const r = await fileToPostVideoUrl(makeFile({ originalname: 'v.mp4' }), 'u-1');
    expect(r.thumbnailUrl).toBeNull();
    expect(r.secureUrl).toMatch(/^\/uploads\/posts\//);
  });
});
