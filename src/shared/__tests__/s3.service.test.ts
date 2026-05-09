import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend, mockGetSignedUrl } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockGetSignedUrl: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = mockSend;
  }
  class PutObjectCommand { constructor(public input: any) {} }
  class DeleteObjectCommand { constructor(public input: any) {} }
  class GetObjectCommand { constructor(public input: any) {} }
  return { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

vi.mock('uuid', () => ({ v4: () => 'uuid-x' }));

vi.mock('../../config/env', () => ({
  env: {
    AWS_ACCESS_KEY_ID: 'k',
    AWS_SECRET_ACCESS_KEY: 's',
    AWS_REGION: 'us-east-1',
    AWS_S3_BUCKET: 'bkt',
  },
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  uploadBuffer,
  uploadAvatar,
  uploadChatImage,
  uploadVoiceNote,
  deleteFile,
  getSignedDownloadUrl,
  getSignedUploadUrl,
  isS3Configured,
} from '../s3.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({});
  mockGetSignedUrl.mockResolvedValue('https://signed.url/key');
});

describe('s3.service', () => {
  it('isS3Configured exposes the configured flag', () => {
    expect(isS3Configured).toBe(true);
  });

  describe('uploadBuffer', () => {
    it('uploads with default folder + ACL private and returns signed url', async () => {
      const res = await uploadBuffer(Buffer.from('x'));
      expect(res).not.toBeNull();
      expect(res?.key).toBe('uploads/uuid-x');
      expect(res?.bucket).toBe('bkt');
      expect(res?.url).toBe('https://signed.url/key');
    });

    it('uploads public-read with direct URL', async () => {
      const res = await uploadBuffer(Buffer.from('x'), { acl: 'public-read', folder: 'pub' });
      expect(res?.url).toBe('https://bkt.s3.us-east-1.amazonaws.com/pub/uuid-x');
    });

    it('throws on send error', async () => {
      mockSend.mockRejectedValueOnce(new Error('s3-down'));
      await expect(uploadBuffer(Buffer.from('x'))).rejects.toThrow(/s3-down/);
    });

    it('respects custom filename', async () => {
      const res = await uploadBuffer(Buffer.from('x'), { filename: 'foo.png', folder: 'a' });
      expect(res?.key).toBe('a/foo.png');
    });
  });

  describe('uploadAvatar', () => {
    it('uses avatars folder + userId.ext', async () => {
      const res = await uploadAvatar(Buffer.from('x'), 'u-1', 'image/png');
      expect(res?.key).toBe('avatars/u-1.png');
    });

    it('defaults extension when contentType has no slash', async () => {
      const res = await uploadAvatar(Buffer.from('x'), 'u-1', 'weird');
      expect(res?.key).toBe('avatars/u-1.jpg');
    });
  });

  describe('uploadChatImage', () => {
    it('uses chats/{cid}/uuid.ext', async () => {
      const res = await uploadChatImage(Buffer.from('x'), 'c-1', 'image/jpeg');
      expect(res?.key).toBe('chats/c-1/uuid-x.jpeg');
    });
  });

  describe('uploadVoiceNote', () => {
    it('uses voice/{cid}/uuid.ext', async () => {
      const res = await uploadVoiceNote(Buffer.from('x'), 'c-1', 'audio/mpeg');
      expect(res?.key).toBe('voice/c-1/uuid-x.mpeg');
    });
  });

  describe('deleteFile', () => {
    it('returns true on success', async () => {
      const res = await deleteFile('k1');
      expect(res).toBe(true);
    });

    it('returns false on error', async () => {
      mockSend.mockRejectedValueOnce(new Error('boom'));
      const res = await deleteFile('k1');
      expect(res).toBe(false);
    });
  });

  describe('getSignedDownloadUrl', () => {
    it('returns signed url', async () => {
      const u = await getSignedDownloadUrl('k1', 600);
      expect(u).toBe('https://signed.url/key');
    });
  });

  describe('getSignedUploadUrl', () => {
    it('returns signed put url', async () => {
      const u = await getSignedUploadUrl('k1', 'image/jpeg');
      expect(u).toBe('https://signed.url/key');
    });
  });
});
