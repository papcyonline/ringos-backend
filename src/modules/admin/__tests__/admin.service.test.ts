import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    adminUser: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    subscription: { count: vi.fn().mockResolvedValue(0) },
    userModeration: { count: vi.fn().mockResolvedValue(0) },
    report: { count: vi.fn().mockResolvedValue(0) },
    fcmToken: { groupBy: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../../../config/env', () => ({ env: { JWT_SECRET: 'secret-x' } }));

const { bcryptCompare } = vi.hoisted(() => ({ bcryptCompare: vi.fn() }));

vi.mock('bcryptjs', () => ({
  default: { compare: bcryptCompare },
  compare: bcryptCompare,
}));
vi.mock('jsonwebtoken', () => ({
  default: { sign: vi.fn(() => 'jwt.token'), verify: vi.fn() },
  sign: vi.fn(() => 'jwt.token'),
  verify: vi.fn(),
}));

import { loginAdmin, getAdminById, getOverview } from '../admin.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('admin.service', () => {
  describe('loginAdmin', () => {
    it('returns token + admin info on success', async () => {
      mockPrisma.adminUser.findUnique.mockResolvedValue({
        id: 'a-1', email: 'a@b.com', displayName: 'Admin', role: 'OWNER',
        passwordHash: 'hash', isActive: true,
      });
      bcryptCompare.mockResolvedValue(true);
      mockPrisma.adminUser.update.mockResolvedValue({});

      const res = await loginAdmin('A@B.com', 'pw');
      expect(res.token).toBe('jwt.token');
      expect(res.admin.id).toBe('a-1');
      expect(mockPrisma.adminUser.findUnique).toHaveBeenCalledWith({
        where: { email: 'a@b.com' },
      });
    });

    it('throws when admin not found', async () => {
      mockPrisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(loginAdmin('a@b.com', 'pw')).rejects.toThrow(/Invalid credentials/);
    });

    it('throws when admin inactive', async () => {
      mockPrisma.adminUser.findUnique.mockResolvedValue({ isActive: false, passwordHash: 'h' });
      await expect(loginAdmin('a@b.com', 'pw')).rejects.toThrow(/Invalid credentials/);
    });

    it('throws on wrong password', async () => {
      mockPrisma.adminUser.findUnique.mockResolvedValue({
        id: 'a-1', isActive: true, passwordHash: 'h', role: 'X',
      });
      bcryptCompare.mockResolvedValue(false);
      await expect(loginAdmin('a@b.com', 'wrong')).rejects.toThrow(/Invalid credentials/);
    });
  });

  describe('getAdminById', () => {
    it('returns admin', async () => {
      mockPrisma.adminUser.findUnique.mockResolvedValue({ id: 'a-1', isActive: true });
      const res = await getAdminById('a-1');
      expect(res.id).toBe('a-1');
    });

    it('throws when not found', async () => {
      mockPrisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(getAdminById('a-1')).rejects.toThrow(/not found/i);
    });

    it('throws when inactive', async () => {
      mockPrisma.adminUser.findUnique.mockResolvedValue({ isActive: false });
      await expect(getAdminById('a-1')).rejects.toThrow(/not found/i);
    });
  });

  describe('getOverview', () => {
    it('returns aggregated overview with platforms and country splits', async () => {
      mockPrisma.user.count.mockResolvedValue(100);
      mockPrisma.subscription.count.mockResolvedValue(5);
      mockPrisma.userModeration.count.mockResolvedValue(2);
      mockPrisma.report.count.mockResolvedValue(3);
      mockPrisma.fcmToken.groupBy.mockResolvedValue([
        { platform: 'ios', _count: { userId: 60 } },
        { platform: '', _count: { userId: 5 } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { location: 'NYC, USA' },
        { location: 'LA, USA' },
        { location: 'Tokyo, Japan' },
        { location: 'Mumbai' },
        { location: null },
      ]);

      const res = await getOverview();
      expect(res.users.total).toBe(100);
      expect(res.platforms).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ platform: 'ios', count: 60 }),
          expect.objectContaining({ platform: 'unknown', count: 5 }),
        ]),
      );
      expect(res.topCountries[0].country).toBe('USA');
      expect(res.topCountries[0].count).toBe(2);
    });

    it('handles empty data gracefully', async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.fcmToken.groupBy.mockResolvedValue([]);
      mockPrisma.user.findMany.mockResolvedValue([]);
      const res = await getOverview();
      expect(res.users.total).toBe(0);
      expect(res.topCountries).toEqual([]);
      expect(res.platforms).toEqual([]);
    });
  });
});
