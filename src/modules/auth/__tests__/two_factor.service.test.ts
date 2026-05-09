import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockGenerateSecret, mockGenerateURI, mockVerify, mockToDataURL } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
  mockGenerateSecret: vi.fn(() => 'SECRET-TOPSEKRIT'),
  mockGenerateURI: vi.fn(() => 'otpauth://test'),
  mockVerify: vi.fn(),
  mockToDataURL: vi.fn(async () => 'data:image/png;base64,xxx'),
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('otplib', () => ({
  generate: vi.fn(),
  verify: mockVerify,
  generateSecret: mockGenerateSecret,
  generateURI: mockGenerateURI,
}));
vi.mock('qrcode', () => ({
  default: { toDataURL: mockToDataURL },
}));

import {
  setup2FA, verify2FA, disable2FA, validateLogin2FA, has2FA,
} from '../two_factor.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('two_factor.service', () => {
  describe('setup2FA', () => {
    it('throws when user missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(setup2FA('u-1')).rejects.toThrow(/User not found/);
    });

    it('throws when already enabled', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ twoFactorEnabled: true, email: 'a@b.com' });
      await expect(setup2FA('u-1')).rejects.toThrow(/already enabled/);
    });

    it('creates secret + QR data URL', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        email: 'a@b.com', displayName: 'Alice', twoFactorEnabled: false,
      });
      mockPrisma.user.update.mockResolvedValue({});
      const res = await setup2FA('u-1');
      expect(res.secret).toBe('SECRET-TOPSEKRIT');
      expect(res.qrCodeDataUrl).toMatch(/data:image\/png/);
    });

    it('falls back to displayName when email missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        email: null, displayName: 'Alice', twoFactorEnabled: false,
      });
      mockPrisma.user.update.mockResolvedValue({});
      await setup2FA('u-1');
      expect(mockGenerateURI).toHaveBeenCalledWith(expect.objectContaining({ label: 'Alice' }));
    });
  });

  describe('verify2FA', () => {
    it('throws when user missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(verify2FA('u-1', '123')).rejects.toThrow();
    });

    it('throws when no secret', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ twoFactorSecret: null });
      await expect(verify2FA('u-1', '123')).rejects.toThrow(/setup not started/);
    });

    it('throws on invalid code', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ twoFactorSecret: 'sec', twoFactorEnabled: false });
      mockVerify.mockResolvedValue({ valid: false });
      await expect(verify2FA('u-1', 'wrong')).rejects.toThrow(/Invalid/);
    });

    it('enables 2FA and returns recovery codes', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ twoFactorSecret: 'sec', twoFactorEnabled: false });
      mockVerify.mockResolvedValue({ valid: true });
      mockPrisma.user.update.mockResolvedValue({});
      const res = await verify2FA('u-1', '123456');
      expect(res.enabled).toBe(true);
      expect(res.recoveryCodes).toHaveLength(8);
    });
  });

  describe('disable2FA', () => {
    it('throws when not enabled', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ twoFactorEnabled: false });
      await expect(disable2FA('u-1', '123')).rejects.toThrow(/not enabled/);
    });

    it('disables on valid code', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ twoFactorSecret: 'sec', twoFactorEnabled: true });
      mockVerify.mockResolvedValue({ valid: true });
      mockPrisma.user.update.mockResolvedValue({});
      const res = await disable2FA('u-1', '123');
      expect(res.enabled).toBe(false);
    });

    it('throws on invalid code', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ twoFactorSecret: 'sec', twoFactorEnabled: true });
      mockVerify.mockResolvedValue({ valid: false });
      await expect(disable2FA('u-1', '123')).rejects.toThrow(/Invalid/);
    });
  });

  describe('validateLogin2FA', () => {
    it('returns false when user missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const ok = await validateLogin2FA('u-1', '1');
      expect(ok).toBe(false);
    });

    it('returns false when 2FA not enabled', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ twoFactorEnabled: false });
      const ok = await validateLogin2FA('u-1', '1');
      expect(ok).toBe(false);
    });

    it('accepts valid TOTP', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        twoFactorEnabled: true, twoFactorSecret: 'sec', twoFactorRecovery: [],
      });
      mockVerify.mockResolvedValue({ valid: true });
      const ok = await validateLogin2FA('u-1', '123');
      expect(ok).toBe(true);
    });

    it('accepts and consumes recovery code', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        twoFactorEnabled: true,
        twoFactorSecret: 'sec',
        twoFactorRecovery: ['recA', 'recB'],
      });
      mockVerify.mockResolvedValue({ valid: false });
      mockPrisma.user.update.mockResolvedValue({});
      const ok = await validateLogin2FA('u-1', 'recB');
      expect(ok).toBe(true);
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { twoFactorRecovery: ['recA'] },
        }),
      );
    });

    it('returns false when neither match', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        twoFactorEnabled: true, twoFactorSecret: 'sec', twoFactorRecovery: ['x'],
      });
      mockVerify.mockResolvedValue({ valid: false });
      const ok = await validateLogin2FA('u-1', 'wrong');
      expect(ok).toBe(false);
    });
  });

  describe('has2FA', () => {
    it('returns true when enabled', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ twoFactorEnabled: true });
      expect(await has2FA('u-1')).toBe(true);
    });

    it('returns false when disabled or absent', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      expect(await has2FA('u-1')).toBe(false);
    });
  });
});
