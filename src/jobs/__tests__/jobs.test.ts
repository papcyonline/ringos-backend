import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockPrisma, mockGetIO, mockExpireAvail, mockCleanupStories, mockPublishScheduled,
  mockDeleteFromDrive, mockDeleteFromCloudinary,
} = vi.hoisted(() => ({
  mockPrisma: {
    matchRequest: { findMany: vi.fn(), updateMany: vi.fn() },
    user: { deleteMany: vi.fn() },
    aiSession: { updateMany: vi.fn() },
    message: { findMany: vi.fn(), deleteMany: vi.fn() },
    messageReaction: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
  mockGetIO: vi.fn(),
  mockExpireAvail: vi.fn(),
  mockCleanupStories: vi.fn(),
  mockPublishScheduled: vi.fn(),
  mockDeleteFromDrive: vi.fn(),
  mockDeleteFromCloudinary: vi.fn(),
}));

vi.mock('../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../config/socket', () => ({ getIO: mockGetIO }));
vi.mock('../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../modules/user/user.service', () => ({
  expireAvailabilities: mockExpireAvail,
}));
vi.mock('../../modules/story/story.service', () => ({
  cleanupExpiredStories: mockCleanupStories,
}));
vi.mock('../../modules/post/post.service', () => ({
  publishScheduledPosts: mockPublishScheduled,
}));
vi.mock('../../shared/gdrive.service', () => ({
  deleteFromDrive: mockDeleteFromDrive,
}));
vi.mock('../../shared/cloudinary.service', () => ({
  deleteFile: mockDeleteFromCloudinary,
}));

import { startMatchExpiryJob } from '../matchExpiry';
import { startAvailabilityExpiryJob } from '../availabilityExpiry';
import { startStoryCleanupJob } from '../storyCleanup';
import { startSessionCleanupJob } from '../sessionCleanup';
import { startAbandonedSignupCleanupJob } from '../abandonedSignupCleanup';
import { startMessageExpiryJob } from '../messageExpiry';
import { startScheduledPostsJob } from '../scheduledPosts';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  const ioStub: any = { to: vi.fn(() => ({ emit: vi.fn() })), emit: vi.fn() };
  mockGetIO.mockReturnValue(ioStub);
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushAll() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('matchExpiry job', () => {
  it('expires waiting requests and emits matching:timeout', async () => {
    mockPrisma.matchRequest.findMany.mockResolvedValue([
      { id: 'r-1', userId: 'u-1' },
      { id: 'r-2', userId: 'u-2' },
    ]);
    mockPrisma.matchRequest.updateMany.mockResolvedValue({ count: 2 });
    startMatchExpiryJob();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(mockPrisma.matchRequest.updateMany).toHaveBeenCalled();
  });

  it('no-op when no expired requests', async () => {
    mockPrisma.matchRequest.findMany.mockResolvedValue([]);
    startMatchExpiryJob();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(mockPrisma.matchRequest.updateMany).not.toHaveBeenCalled();
  });

  it('catches errors silently', async () => {
    mockPrisma.matchRequest.findMany.mockRejectedValue(new Error('db'));
    startMatchExpiryJob();
    await vi.advanceTimersByTimeAsync(31_000);
    // No throw
  });
});

describe('availabilityExpiry job', () => {
  it('emits status updates for expired users', async () => {
    mockExpireAvail.mockResolvedValue(['u-1', 'u-2']);
    startAvailabilityExpiryJob();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(mockGetIO).toHaveBeenCalled();
  });

  it('no-op when no expired', async () => {
    mockExpireAvail.mockResolvedValue([]);
    startAvailabilityExpiryJob();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(mockGetIO).not.toHaveBeenCalled();
  });

  it('catches errors', async () => {
    mockExpireAvail.mockRejectedValue(new Error('db'));
    startAvailabilityExpiryJob();
    await vi.advanceTimersByTimeAsync(31_000);
  });
});

describe('storyCleanup job', () => {
  it('runs immediately at startup', async () => {
    mockCleanupStories.mockResolvedValue(3);
    startStoryCleanupJob();
    await flushAll();
    expect(mockCleanupStories).toHaveBeenCalledTimes(1);
  });

  it('runs at interval', async () => {
    mockCleanupStories.mockResolvedValue(0);
    startStoryCleanupJob();
    await flushAll();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
    expect(mockCleanupStories).toHaveBeenCalledTimes(2);
  });

  it('catches cleanup errors', async () => {
    mockCleanupStories.mockRejectedValue(new Error('db'));
    startStoryCleanupJob();
    await flushAll();
  });
});

describe('sessionCleanup job', () => {
  it('expires stale ACTIVE sessions', async () => {
    mockPrisma.aiSession.updateMany.mockResolvedValue({ count: 5 });
    startSessionCleanupJob();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1000);
    expect(mockPrisma.aiSession.updateMany).toHaveBeenCalled();
  });

  it('catches errors', async () => {
    mockPrisma.aiSession.updateMany.mockRejectedValue(new Error('db'));
    startSessionCleanupJob();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1000);
  });
});

describe('abandonedSignupCleanup job', () => {
  it('runs at startup and on interval', async () => {
    mockPrisma.user.deleteMany.mockResolvedValue({ count: 2 });
    startAbandonedSignupCleanupJob();
    await flushAll();
    expect(mockPrisma.user.deleteMany).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1000);
    expect(mockPrisma.user.deleteMany).toHaveBeenCalledTimes(2);
  });

  it('catches errors', async () => {
    mockPrisma.user.deleteMany.mockRejectedValue(new Error('db'));
    startAbandonedSignupCleanupJob();
    await flushAll();
  });
});

describe('messageExpiry job', () => {
  it('no-op when nothing expired', async () => {
    mockPrisma.message.findMany.mockResolvedValue([]);
    startMessageExpiryJob();
    await vi.advanceTimersByTimeAsync(60 * 1000 + 1000);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('deletes expired messages and emits chat:expired', async () => {
    mockPrisma.message.findMany.mockResolvedValue([
      {
        id: 'm-1', conversationId: 'c-1', senderId: 's-1',
        imageUrl: 'https://res.cloudinary.com/x/upload/v123/foo.jpg',
        audioUrl: null,
      },
      {
        id: 'm-2', conversationId: 'c-1', senderId: 's-1',
        imageUrl: null,
        audioUrl: 'https://drive.google.com/file?id=abc-123',
      },
    ]);
    mockPrisma.$transaction.mockResolvedValue([{}, { count: 2 }]);
    mockDeleteFromCloudinary.mockResolvedValue({ result: 'ok' });
    mockDeleteFromDrive.mockResolvedValue(undefined);
    startMessageExpiryJob();
    await vi.advanceTimersByTimeAsync(60 * 1000 + 1000);
    await flushAll();
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it('catches errors', async () => {
    mockPrisma.message.findMany.mockRejectedValue(new Error('db'));
    startMessageExpiryJob();
    await vi.advanceTimersByTimeAsync(60 * 1000 + 1000);
  });
});

describe('scheduledPosts job', () => {
  it('runs immediately and on interval', async () => {
    mockPublishScheduled.mockResolvedValue(undefined);
    startScheduledPostsJob();
    await flushAll();
    expect(mockPublishScheduled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 1000 + 1000);
    expect(mockPublishScheduled).toHaveBeenCalledTimes(2);
  });

  it('catches errors', async () => {
    mockPublishScheduled.mockRejectedValue(new Error('boom'));
    startScheduledPostsJob();
    await flushAll();
  });
});
