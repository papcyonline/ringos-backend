import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCloudinary } = vi.hoisted(() => {
  const mockCloudinary = {
    config: vi.fn(),
    url: vi.fn((id: string) => `https://cdn/${id}.jpg`),
    uploader: {
      upload_stream: vi.fn(),
      upload: vi.fn(),
      destroy: vi.fn(),
    },
  };
  return { mockCloudinary };
});

vi.mock('cloudinary', () => ({ v2: mockCloudinary }));
vi.mock('../../config/env', () => ({
  env: {
    CLOUDINARY_CLOUD_NAME: 'test',
    CLOUDINARY_API_KEY: 'key',
    CLOUDINARY_API_SECRET: 'secret',
  },
}));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  uploadBuffer,
  uploadUrl,
  uploadAvatar,
  uploadChatImage,
  uploadVoiceNote,
  deleteFile,
  getTransformedUrl,
} from '../cloudinary.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('uploadBuffer', () => {
  it('streams buffer through upload_stream and resolves with normalized shape', async () => {
    mockCloudinary.uploader.upload_stream.mockImplementation((_opts: any, cb: any) => {
      // Simulate Cloudinary calling the callback after .end()
      const stream = {
        end: () => cb(null, {
          url: 'http://x', secure_url: 'https://x',
          public_id: 'pid', width: 100, height: 100, format: 'jpg', bytes: 1000,
        }),
      };
      return stream;
    });

    const res = await uploadBuffer(Buffer.from('img'), { folder: 'custom' });

    expect(res).toEqual({
      url: 'http://x', secureUrl: 'https://x', publicId: 'pid',
      width: 100, height: 100, format: 'jpg', bytes: 1000,
    });
  });

  it('passes transformation options when provided', async () => {
    mockCloudinary.uploader.upload_stream.mockImplementation((opts: any, cb: any) => {
      expect(opts.transformation[0]).toEqual({
        width: 200, height: 200, crop: 'fill', quality: 90,
      });
      return { end: () => cb(null, { url: 'u', secure_url: 's', public_id: 'p' }) };
    });

    await uploadBuffer(Buffer.from('x'), {
      transformation: { width: 200, height: 200, crop: 'fill', quality: 90 },
    });
  });

  it('rejects on stream error', async () => {
    mockCloudinary.uploader.upload_stream.mockImplementation((_opts: any, cb: any) => {
      return { end: () => cb(new Error('upload failed')) };
    });

    await expect(uploadBuffer(Buffer.from('x'))).rejects.toThrow('upload failed');
  });
});

describe('uploadUrl', () => {
  it('passes URL to cloudinary.uploader.upload and returns normalized shape', async () => {
    mockCloudinary.uploader.upload.mockResolvedValue({
      url: 'http://x', secure_url: 'https://x', public_id: 'pid',
    });

    const res = await uploadUrl('https://src/image.jpg', { folder: 'custom' });

    expect(res!.publicId).toBe('pid');
    expect(mockCloudinary.uploader.upload).toHaveBeenCalledWith(
      'https://src/image.jpg',
      expect.objectContaining({ folder: 'custom' }),
    );
  });

  it('throws on Cloudinary error', async () => {
    mockCloudinary.uploader.upload.mockRejectedValue(new Error('boom'));
    await expect(uploadUrl('https://src/img.jpg')).rejects.toThrow('boom');
  });
});

describe('uploadAvatar', () => {
  it('delegates to uploadBuffer with avatar folder + 800x800 fill', async () => {
    mockCloudinary.uploader.upload_stream.mockImplementation((opts: any, cb: any) => {
      expect(opts.folder).toBe('yomeet/avatars');
      expect(opts.public_id).toBe('avatar_user-1');
      expect(opts.transformation[0].width).toBe(800);
      return { end: () => cb(null, { url: 'u', secure_url: 's', public_id: 'p' }) };
    });

    await uploadAvatar(Buffer.from('x'), 'user-1');
  });
});

describe('uploadChatImage', () => {
  it('uses chat folder + 1920 limit transform', async () => {
    mockCloudinary.uploader.upload_stream.mockImplementation((opts: any, cb: any) => {
      expect(opts.folder).toBe('yomeet/chats/conv-1');
      expect(opts.transformation[0].crop).toBe('limit');
      return { end: () => cb(null, { url: 'u', secure_url: 's', public_id: 'p' }) };
    });

    await uploadChatImage(Buffer.from('x'), 'conv-1');
  });
});

describe('uploadVoiceNote', () => {
  it('uploads as video resource type (Cloudinary audio convention)', async () => {
    mockCloudinary.uploader.upload_stream.mockImplementation((opts: any, cb: any) => {
      expect(opts.resource_type).toBe('video');
      expect(opts.folder).toBe('yomeet/voice/conv-1');
      return { end: () => cb(null, { url: 'u', secure_url: 's', public_id: 'p' }) };
    });

    await uploadVoiceNote(Buffer.from('x'), 'conv-1');
  });
});

describe('deleteFile', () => {
  it('calls destroy with default image resource type', async () => {
    mockCloudinary.uploader.destroy.mockResolvedValue({ result: 'ok' });

    expect(await deleteFile('pid-1')).toBe(true);
    expect(mockCloudinary.uploader.destroy).toHaveBeenCalledWith('pid-1', { resource_type: 'image' });
  });

  it('passes through video resource type', async () => {
    mockCloudinary.uploader.destroy.mockResolvedValue({ result: 'ok' });

    await deleteFile('pid-2', 'video');

    expect(mockCloudinary.uploader.destroy).toHaveBeenCalledWith('pid-2', { resource_type: 'video' });
  });

  it('returns false on Cloudinary error', async () => {
    mockCloudinary.uploader.destroy.mockRejectedValue(new Error('boom'));
    expect(await deleteFile('pid-x')).toBe(false);
  });
});

describe('getTransformedUrl', () => {
  it('builds a secure transformation URL', () => {
    const url = getTransformedUrl('pid-1', { width: 100, height: 100 });
    expect(url).toContain('pid-1');
    expect(mockCloudinary.url).toHaveBeenCalledWith('pid-1', expect.objectContaining({
      secure: true,
    }));
  });
});
