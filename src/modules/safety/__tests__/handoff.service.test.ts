import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    aiSession: { findUnique: vi.fn(), update: vi.fn() },
    userPreference: { findUnique: vi.fn() },
    matchRequest: { create: vi.fn() },
  },
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@prisma/client', () => ({
  MatchIntent: { CASUAL_CHAT: 'CASUAL_CHAT', VENT: 'VENT', ADVICE: 'ADVICE' },
  MoodTag: { NEUTRAL: 'NEUTRAL', SAD: 'SAD', LONELY: 'LONELY', ANXIOUS: 'ANXIOUS', HAPPY: 'HAPPY' },
}));

import { createHandoffRequest } from '../handoff.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handoff.service', () => {
  it('throws when AI session not found', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue(null);
    await expect(createHandoffRequest('u-1', 's-1')).rejects.toThrow(/not found/i);
  });

  it('throws when session belongs to different user', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({ userId: 'other', status: 'ACTIVE' });
    await expect(createHandoffRequest('u-1', 's-1')).rejects.toThrow(/does not belong/);
  });

  it('throws when session is not active', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({ userId: 'u-1', status: 'ENDED' });
    await expect(createHandoffRequest('u-1', 's-1')).rejects.toThrow(/not active/);
  });

  it('derives VENT intent from SAD mood', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({ userId: 'u-1', status: 'ACTIVE' });
    mockPrisma.aiSession.update.mockResolvedValue({});
    mockPrisma.userPreference.findUnique.mockResolvedValue(null);
    mockPrisma.matchRequest.create.mockResolvedValue({
      id: 'r-1', intent: 'VENT', mood: 'SAD', status: 'WAITING', fromAiSession: 's-1',
    });
    const res = await createHandoffRequest('u-1', 's-1', 'SAD');
    expect(res.intent).toBe('VENT');
    expect(res.mood).toBe('SAD');
  });

  it('derives ADVICE intent from ANXIOUS mood', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({ userId: 'u-1', status: 'ACTIVE' });
    mockPrisma.userPreference.findUnique.mockResolvedValue(null);
    mockPrisma.matchRequest.create.mockResolvedValue({
      id: 'r-1', intent: 'ADVICE', mood: 'ANXIOUS', status: 'WAITING', fromAiSession: 's-1',
    });
    const res = await createHandoffRequest('u-1', 's-1', 'ANXIOUS');
    expect(res.intent).toBe('ADVICE');
  });

  it('uses CASUAL_CHAT as default when no mood', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({ userId: 'u-1', status: 'ACTIVE' });
    mockPrisma.userPreference.findUnique.mockResolvedValue(null);
    mockPrisma.matchRequest.create.mockResolvedValue({
      id: 'r-1', intent: 'CASUAL_CHAT', mood: 'NEUTRAL', status: 'WAITING', fromAiSession: 's-1',
    });
    const res = await createHandoffRequest('u-1', 's-1');
    expect(res.intent).toBe('CASUAL_CHAT');
    expect(res.mood).toBe('NEUTRAL');
  });

  it('uses explicit intent override', async () => {
    mockPrisma.aiSession.findUnique.mockResolvedValue({ userId: 'u-1', status: 'ACTIVE' });
    mockPrisma.userPreference.findUnique.mockResolvedValue({ language: 'fr', timezone: 'PT', topics: ['x'] });
    mockPrisma.matchRequest.create.mockResolvedValue({
      id: 'r-1', intent: 'VENT', mood: 'NEUTRAL', status: 'WAITING', fromAiSession: 's-1',
    });
    const res = await createHandoffRequest('u-1', 's-1', undefined, 'vent');
    expect(res.intent).toBe('VENT');
    expect(mockPrisma.matchRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ language: 'fr', timezone: 'PT', topics: ['x'] }),
      }),
    );
  });
});
