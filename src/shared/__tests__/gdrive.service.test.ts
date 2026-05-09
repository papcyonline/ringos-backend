import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFilesCreate, mockFilesGet, mockFilesDelete, mockSetCredentials, mockOAuth2Ctor, mockDriveFn } = vi.hoisted(() => {
  const mockFilesCreate = vi.fn();
  const mockFilesGet = vi.fn();
  const mockFilesDelete = vi.fn();
  const mockSetCredentials = vi.fn();
  const mockOAuth2Ctor = vi.fn(() => ({ setCredentials: mockSetCredentials }));
  const driveInstance = {
    files: {
      create: mockFilesCreate,
      get: mockFilesGet,
      delete: mockFilesDelete,
    },
  };
  const mockDriveFn = vi.fn(() => driveInstance);
  return { mockFilesCreate, mockFilesGet, mockFilesDelete, mockSetCredentials, mockOAuth2Ctor, mockDriveFn };
});

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: mockOAuth2Ctor },
    drive: mockDriveFn,
  },
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const originalEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = {
    ...originalEnv,
    GDRIVE_CLIENT_ID: 'cid',
    GDRIVE_CLIENT_SECRET: 'csec',
    GDRIVE_REFRESH_TOKEN: 'rt',
    GDRIVE_FOLDER_ID: 'folder-1',
  };
});

afterEach(() => {
  process.env = originalEnv;
});

describe('gdrive.service', () => {
  describe('initGoogleDrive', () => {
    it('returns true when configured', async () => {
      const mod = await import('../gdrive.service');
      expect(mod.initGoogleDrive()).toBe(true);
      expect(mod.isDriveConfigured()).toBe(true);
    });

    it('returns false when missing env', async () => {
      delete process.env.GDRIVE_CLIENT_ID;
      vi.resetModules();
      const mod = await import('../gdrive.service');
      expect(mod.initGoogleDrive()).toBe(false);
      expect(mod.isDriveConfigured()).toBe(false);
    });

    it('catches errors during init', async () => {
      mockOAuth2Ctor.mockImplementationOnce(() => { throw new Error('boom'); });
      const mod = await import('../gdrive.service');
      expect(mod.initGoogleDrive()).toBe(false);
    });
  });

  describe('uploadToDrive', () => {
    it('returns null when not configured', async () => {
      delete process.env.GDRIVE_CLIENT_ID;
      vi.resetModules();
      const mod = await import('../gdrive.service');
      const res = await mod.uploadToDrive(Buffer.from('x'), 'a.png', 'image/png');
      expect(res).toBeNull();
    });

    it('uploads and returns proxy URL', async () => {
      mockFilesCreate.mockResolvedValue({ data: { id: 'abc-123' } });
      const mod = await import('../gdrive.service');
      mod.initGoogleDrive();
      const res = await mod.uploadToDrive(Buffer.from('x'), 'a.png', 'image/png');
      expect(res?.fileId).toBe('abc-123');
      expect(res?.url).toBe('/media/gdrive/abc-123');
    });

    it('returns null on upload error', async () => {
      mockFilesCreate.mockRejectedValue(new Error('drive-down'));
      const mod = await import('../gdrive.service');
      mod.initGoogleDrive();
      const res = await mod.uploadToDrive(Buffer.from('x'), 'a.png', 'image/png');
      expect(res).toBeNull();
    });

    it('omits parent when no folder configured', async () => {
      delete process.env.GDRIVE_FOLDER_ID;
      vi.resetModules();
      const mod = await import('../gdrive.service');
      mod.initGoogleDrive();
      mockFilesCreate.mockResolvedValue({ data: { id: 'abc' } });
      await mod.uploadToDrive(Buffer.from('x'), 'a.png', 'image/png');
      const arg = mockFilesCreate.mock.calls[0][0];
      expect(arg.requestBody.parents).toBeUndefined();
    });
  });

  describe('streamFromDrive', () => {
    it('returns false when not configured', async () => {
      delete process.env.GDRIVE_CLIENT_ID;
      vi.resetModules();
      const mod = await import('../gdrive.service');
      const res = await mod.streamFromDrive('id-1', {} as any);
      expect(res).toBe(false);
    });

    it('streams successfully', async () => {
      const pipe = vi.fn();
      mockFilesGet.mockResolvedValueOnce({ data: { mimeType: 'audio/mp4', size: '123' } });
      mockFilesGet.mockResolvedValueOnce({ data: { pipe } });
      const setHeader = vi.fn();
      const res: any = { setHeader };
      const mod = await import('../gdrive.service');
      mod.initGoogleDrive();
      const ok = await mod.streamFromDrive('id-1', res);
      expect(ok).toBe(true);
      expect(setHeader).toHaveBeenCalledWith('Content-Type', 'audio/mp4');
      expect(setHeader).toHaveBeenCalledWith('Content-Length', '123');
      expect(pipe).toHaveBeenCalledWith(res);
    });

    it('falls back when mimeType missing', async () => {
      const pipe = vi.fn();
      mockFilesGet.mockResolvedValueOnce({ data: {} });
      mockFilesGet.mockResolvedValueOnce({ data: { pipe } });
      const setHeader = vi.fn();
      const res: any = { setHeader };
      const mod = await import('../gdrive.service');
      mod.initGoogleDrive();
      const ok = await mod.streamFromDrive('id-1', res);
      expect(ok).toBe(true);
      expect(setHeader).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
    });

    it('returns false on stream error', async () => {
      mockFilesGet.mockRejectedValue(new Error('drive-down'));
      const mod = await import('../gdrive.service');
      mod.initGoogleDrive();
      const ok = await mod.streamFromDrive('id-1', { setHeader: vi.fn() } as any);
      expect(ok).toBe(false);
    });
  });

  describe('downloadFromDrive', () => {
    it('returns null when not configured', async () => {
      delete process.env.GDRIVE_CLIENT_ID;
      vi.resetModules();
      const mod = await import('../gdrive.service');
      const res = await mod.downloadFromDrive('id-1');
      expect(res).toBeNull();
    });

    it('downloads and returns Buffer', async () => {
      const ab = new Uint8Array([1, 2, 3]).buffer;
      mockFilesGet.mockResolvedValueOnce({ data: { mimeType: 'audio/mp4' } });
      mockFilesGet.mockResolvedValueOnce({ data: ab });
      const mod = await import('../gdrive.service');
      mod.initGoogleDrive();
      const res = await mod.downloadFromDrive('id-1');
      expect(res?.buffer).toBeInstanceOf(Buffer);
      expect(res?.mimeType).toBe('audio/mp4');
    });

    it('returns null on download error', async () => {
      mockFilesGet.mockRejectedValue(new Error('drive-down'));
      const mod = await import('../gdrive.service');
      mod.initGoogleDrive();
      const res = await mod.downloadFromDrive('id-1');
      expect(res).toBeNull();
    });
  });

  describe('deleteFromDrive', () => {
    it('is no-op when not configured', async () => {
      delete process.env.GDRIVE_CLIENT_ID;
      vi.resetModules();
      const mod = await import('../gdrive.service');
      await mod.deleteFromDrive('id-1');
      expect(mockFilesDelete).not.toHaveBeenCalled();
    });

    it('deletes when configured', async () => {
      mockFilesDelete.mockResolvedValue({});
      const mod = await import('../gdrive.service');
      mod.initGoogleDrive();
      await mod.deleteFromDrive('id-1');
      expect(mockFilesDelete).toHaveBeenCalled();
    });

    it('swallows delete errors', async () => {
      mockFilesDelete.mockRejectedValue(new Error('boom'));
      const mod = await import('../gdrive.service');
      mod.initGoogleDrive();
      await expect(mod.deleteFromDrive('id-1')).resolves.toBeUndefined();
    });
  });
});
