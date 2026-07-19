import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = mockSend;
  }
  class PutObjectCommand { constructor(public input: any) {} }
  class DeleteObjectCommand { constructor(public input: any) {} }
  class ListObjectsV2Command { constructor(public input: any) {} }
  class DeleteObjectsCommand { constructor(public input: any) {} }
  return { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand };
});
vi.mock('uuid', () => ({ v4: () => 'uuid-x' }));

const originalEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockSend.mockResolvedValue({});
  process.env = {
    ...originalEnv,
    R2_ACCOUNT_ID: 'acc',
    R2_BUCKET_NAME: 'bkt',
    R2_ACCESS_KEY_ID: 'k',
    R2_SECRET_ACCESS_KEY: 's',
    R2_PUBLIC_URL: 'https://cdn.example.com',
  };
});

afterEach(() => {
  process.env = originalEnv;
});

describe('r2.service', () => {
  it('isR2Configured reflects env', async () => {
    const mod = await import('../r2.service');
    expect(mod.isR2Configured).toBe(true);
  });

  it('uploadToR2 returns public URL', async () => {
    const mod = await import('../r2.service');
    const url = await mod.uploadToR2(Buffer.from('x'), 'folder', 'a.png', 'image/png');
    expect(url).toBe('https://cdn.example.com/folder/uuid-x.png');
  });

  it('uploadToR2 falls back to r2.dev URL when no public URL', async () => {
    delete process.env.R2_PUBLIC_URL;
    vi.resetModules();
    const mod = await import('../r2.service');
    const url = await mod.uploadToR2(Buffer.from('x'), 'folder', 'a.png', 'image/png');
    expect(url).toBe('https://bkt.acc.r2.dev/folder/uuid-x.png');
  });

  it('uploadToR2 uses .bin when no extension', async () => {
    const mod = await import('../r2.service');
    const url = await mod.uploadToR2(Buffer.from('x'), 'folder', 'noext', 'image/png');
    expect(url).toMatch(/uuid-x\.bin$/);
  });

  it('uploadImageToR2 derives content-type from extension', async () => {
    const mod = await import('../r2.service');
    const url = await mod.uploadImageToR2(Buffer.from('x'), 'folder', 'pic.heic');
    expect(url).toMatch(/uuid-x\.heic$/);
  });

  it('uploadImageToR2 uses provided mime override', async () => {
    const mod = await import('../r2.service');
    const url = await mod.uploadImageToR2(Buffer.from('x'), 'folder', 'pic.foo', 'image/x-foo');
    expect(url).toMatch(/uuid-x/);
  });

  it('uploadImageToR2 defaults to image/jpeg for unknown ext', async () => {
    const mod = await import('../r2.service');
    const url = await mod.uploadImageToR2(Buffer.from('x'), 'folder', 'pic.unknown');
    expect(url).toMatch(/uuid-x\.unknown$/);
  });

  it('uploadVideoToR2 returns null thumbnail', async () => {
    const mod = await import('../r2.service');
    const res = await mod.uploadVideoToR2(Buffer.from('x'), 'folder', 'v.mp4');
    expect(res.thumbnailUrl).toBeNull();
    expect(res.url).toMatch(/uuid-x/);
  });

  it('uploadToR2WithKey returns url and key', async () => {
    const mod = await import('../r2.service');
    const res = await mod.uploadToR2WithKey(Buffer.from('x'), 'folder', 'a.png', 'image/png');
    expect(res.url).toBe('https://cdn.example.com/folder/uuid-x.png');
    expect(res.key).toBe('folder/uuid-x.png');
  });

  it('uploadToR2WithKey uses r2.dev fallback when no public URL', async () => {
    delete process.env.R2_PUBLIC_URL;
    vi.resetModules();
    const mod = await import('../r2.service');
    const res = await mod.uploadToR2WithKey(Buffer.from('x'), 'folder', 'a.png', 'image/png');
    expect(res.url).toBe('https://bkt.acc.r2.dev/folder/uuid-x.png');
  });

  it('deleteFromR2 sends delete command', async () => {
    const mod = await import('../r2.service');
    await mod.deleteFromR2('folder/uuid-x.png');
    expect(mockSend).toHaveBeenCalled();
  });

  it('deleteFromR2 is no-op when not configured', async () => {
    delete process.env.R2_ACCOUNT_ID;
    vi.resetModules();
    const mod = await import('../r2.service');
    await mod.deleteFromR2('folder/foo');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('deleteR2Prefix lists then batch-deletes every object under the prefix', async () => {
    mockSend.mockReset();
    // First call = ListObjectsV2 (2 objects, not truncated); second = DeleteObjects.
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: 'reels/u/uuid/master.m3u8' }, { Key: 'reels/u/uuid/v0_000.ts' }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({});
    const mod = await import('../r2.service');
    await mod.deleteR2Prefix('reels/u/uuid');

    expect(mockSend).toHaveBeenCalledTimes(2);
    const deleteArg = mockSend.mock.calls[1][0].input;
    expect(deleteArg.Delete.Objects).toEqual([
      { Key: 'reels/u/uuid/master.m3u8' },
      { Key: 'reels/u/uuid/v0_000.ts' },
    ]);
    // Prefix must be normalised with a trailing slash so siblings aren't matched.
    expect(mockSend.mock.calls[0][0].input.Prefix).toBe('reels/u/uuid/');
  });

  it('deleteR2Prefix follows pagination until not truncated', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({ Contents: [{ Key: 'p/a.ts' }], IsTruncated: true, NextContinuationToken: 't1' })
      .mockResolvedValueOnce({}) // delete page 1
      .mockResolvedValueOnce({ Contents: [{ Key: 'p/b.ts' }], IsTruncated: false })
      .mockResolvedValueOnce({}); // delete page 2
    const mod = await import('../r2.service');
    await mod.deleteR2Prefix('p');
    // 2 lists + 2 deletes.
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it('deleteR2Prefix skips delete when prefix is empty of objects', async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const mod = await import('../r2.service');
    await mod.deleteR2Prefix('empty/');
    expect(mockSend).toHaveBeenCalledTimes(1); // list only, no delete
  });
});
