import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockCreateNotification, mockSendPostPush } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn().mockResolvedValue(null),
  mockSendPostPush: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../notification.service', () => ({
  createNotification: mockCreateNotification,
  sendPostPush: mockSendPostPush,
}));

import { enqueuePostNotification } from '../notification-batcher';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('notification-batcher', () => {
  it('flushes a single notification after batch window', async () => {
    enqueuePostNotification({
      authorId: 'a-1', postId: 'p-1', channelId: 'c-1',
      type: 'POST_LIKED', actorId: 'u-2', actorName: 'Bob', actorAvatar: 'avatar',
    });

    expect(mockCreateNotification).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_001);
    await Promise.resolve();
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Bob', body: 'Liked your post' }),
    );
    expect(mockSendPostPush).toHaveBeenCalledTimes(1);
  });

  it('coalesces multiple events into "X and N others"', async () => {
    enqueuePostNotification({
      authorId: 'a-1', postId: 'p-1', channelId: 'c-1',
      type: 'POST_LIKED', actorId: 'u-2', actorName: 'Bob', actorAvatar: undefined,
    });
    enqueuePostNotification({
      authorId: 'a-1', postId: 'p-1', channelId: 'c-1',
      type: 'POST_LIKED', actorId: 'u-3', actorName: 'Carol', actorAvatar: undefined,
    });
    enqueuePostNotification({
      authorId: 'a-1', postId: 'p-1', channelId: 'c-1',
      type: 'POST_LIKED', actorId: 'u-4', actorName: 'Dave', actorAvatar: undefined,
    });

    vi.advanceTimersByTime(30_001);
    await Promise.resolve();

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    const call = mockCreateNotification.mock.calls[0][0];
    expect(call.title).toMatch(/Dave and 2 others/);
  });

  it('uses singular "other" when count is 2', async () => {
    enqueuePostNotification({
      authorId: 'a-1', postId: 'p-2', channelId: 'c-1',
      type: 'POST_COMMENTED', actorId: 'u-2', actorName: 'Bob', actorAvatar: undefined,
    });
    enqueuePostNotification({
      authorId: 'a-1', postId: 'p-2', channelId: 'c-1',
      type: 'POST_COMMENTED', actorId: 'u-3', actorName: 'Carol', actorAvatar: undefined,
    });
    vi.advanceTimersByTime(30_001);
    await Promise.resolve();

    const call = mockCreateNotification.mock.calls[0][0];
    expect(call.title).toMatch(/Carol and 1 other$/);
    expect(call.body).toBe('Commented on your post');
  });

  it('keeps separate batches per type', async () => {
    enqueuePostNotification({
      authorId: 'a-1', postId: 'p-3', channelId: 'c-1',
      type: 'POST_LIKED', actorId: 'u-2', actorName: 'Bob', actorAvatar: undefined,
    });
    enqueuePostNotification({
      authorId: 'a-1', postId: 'p-3', channelId: 'c-1',
      type: 'POST_COMMENTED', actorId: 'u-3', actorName: 'Carol', actorAvatar: undefined,
    });
    vi.advanceTimersByTime(30_001);
    await Promise.resolve();
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });

  it('logs error on createNotification failure but does not throw', async () => {
    mockCreateNotification.mockRejectedValueOnce(new Error('db'));
    enqueuePostNotification({
      authorId: 'a-1', postId: 'p-4', channelId: 'c-1',
      type: 'POST_LIKED', actorId: 'u-2', actorName: 'Bob', actorAvatar: undefined,
    });
    vi.advanceTimersByTime(30_001);
    await Promise.resolve();
    await Promise.resolve();
    // No throw
  });
});
