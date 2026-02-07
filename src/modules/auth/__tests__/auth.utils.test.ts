import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock env before importing auth.utils ──────────────────────────────
vi.mock('../../../config/env', () => ({
  env: {
    JWT_SECRET: 'test-jwt-secret-key-for-testing',
    JWT_REFRESH_SECRET: 'test-jwt-refresh-secret-key-for-testing',
    JWT_EXPIRES_IN: '1h',
    JWT_REFRESH_EXPIRES_IN: '7d',
  },
}));

import {
  generateAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  generateAnonymousName,
} from '../auth.utils';

import jwt from 'jsonwebtoken';

describe('auth.utils', () => {
  // ── generateAccessToken ─────────────────────────────────────────────

  describe('generateAccessToken', () => {
    it('should return a non-empty string', () => {
      const token = generateAccessToken({ userId: 'user-1', isAnonymous: false });
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it('should return a valid JWT with three dot-separated parts', () => {
      const token = generateAccessToken({ userId: 'user-1', isAnonymous: false });
      expect(token.split('.').length).toBe(3);
    });

    it('should contain userId in the payload', () => {
      const token = generateAccessToken({ userId: 'user-42', isAnonymous: false });
      const decoded = jwt.decode(token) as any;
      expect(decoded.userId).toBe('user-42');
    });

    it('should contain isAnonymous in the payload', () => {
      const token = generateAccessToken({ userId: 'user-1', isAnonymous: true });
      const decoded = jwt.decode(token) as any;
      expect(decoded.isAnonymous).toBe(true);
    });

    it('should be verifiable by verifyAccessToken', () => {
      const token = generateAccessToken({ userId: 'user-1', isAnonymous: false });
      const payload = verifyAccessToken(token);
      expect(payload.userId).toBe('user-1');
      expect(payload.isAnonymous).toBe(false);
    });
  });

  // ── verifyAccessToken ───────────────────────────────────────────────

  describe('verifyAccessToken', () => {
    it('should decode a valid access token', () => {
      const token = generateAccessToken({ userId: 'user-99', isAnonymous: true });
      const payload = verifyAccessToken(token);
      expect(payload.userId).toBe('user-99');
      expect(payload.isAnonymous).toBe(true);
    });

    it('should throw on an invalid token', () => {
      expect(() => verifyAccessToken('not-a-valid-token')).toThrow();
    });

    it('should throw on a token signed with a different secret', () => {
      const token = jwt.sign({ userId: 'user-1', isAnonymous: false }, 'wrong-secret');
      expect(() => verifyAccessToken(token)).toThrow();
    });

    it('should throw on an expired token', () => {
      const token = jwt.sign(
        { userId: 'user-1', isAnonymous: false },
        'test-jwt-secret-key-for-testing',
        { expiresIn: '0s' },
      );
      // Small delay to ensure expiration
      expect(() => verifyAccessToken(token)).toThrow();
    });
  });

  // ── generateRefreshToken / verifyRefreshToken ───────────────────────

  describe('generateRefreshToken', () => {
    it('should return a valid JWT string', () => {
      const token = generateRefreshToken({ userId: 'user-1' });
      expect(token.split('.').length).toBe(3);
    });

    it('should contain userId in the payload', () => {
      const token = generateRefreshToken({ userId: 'user-7' });
      const decoded = jwt.decode(token) as any;
      expect(decoded.userId).toBe('user-7');
    });

    it('should be verifiable by verifyRefreshToken', () => {
      const token = generateRefreshToken({ userId: 'user-1' });
      const payload = verifyRefreshToken(token);
      expect(payload.userId).toBe('user-1');
    });
  });

  describe('verifyRefreshToken', () => {
    it('should decode a valid refresh token', () => {
      const token = generateRefreshToken({ userId: 'user-5' });
      const payload = verifyRefreshToken(token);
      expect(payload.userId).toBe('user-5');
    });

    it('should throw on an invalid token', () => {
      expect(() => verifyRefreshToken('garbage-token')).toThrow();
    });

    it('should throw on a token signed with the access secret (wrong secret)', () => {
      const token = jwt.sign({ userId: 'user-1' }, 'test-jwt-secret-key-for-testing');
      expect(() => verifyRefreshToken(token)).toThrow();
    });

    it('should not accept an access token as a refresh token', () => {
      const accessToken = generateAccessToken({ userId: 'user-1', isAnonymous: false });
      expect(() => verifyRefreshToken(accessToken)).toThrow();
    });
  });

  // ── generateAnonymousName ───────────────────────────────────────────

  describe('generateAnonymousName', () => {
    it('should return a string in "Word Word Number" format', () => {
      const name = generateAnonymousName();
      const parts = name.split(' ');
      expect(parts.length).toBe(3);
      expect(parts[0]).toMatch(/^[A-Z][a-z]+$/);
      expect(parts[1]).toMatch(/^[A-Z][a-z]+$/);
      expect(Number(parts[2])).toBeGreaterThanOrEqual(0);
      expect(Number(parts[2])).toBeLessThan(100);
    });

    it('should produce different names on repeated calls (probabilistic)', () => {
      const names = new Set(Array.from({ length: 20 }, () => generateAnonymousName()));
      // With 20*20*100 = 40000 possibilities, 20 calls should produce at least 2 unique names
      expect(names.size).toBeGreaterThan(1);
    });

    it('should use an adjective from the ADJECTIVES list', () => {
      const adjectives = [
        'Gentle', 'Brave', 'Calm', 'Kind', 'Wise',
        'Bright', 'Warm', 'Quiet', 'Swift', 'Bold',
        'Happy', 'Shy', 'Soft', 'Cool', 'Mild',
        'True', 'Fair', 'Free', 'Keen', 'Pure',
      ];
      const name = generateAnonymousName();
      const firstWord = name.split(' ')[0];
      expect(adjectives).toContain(firstWord);
    });

    it('should use an animal from the ANIMALS list', () => {
      const animals = [
        'Owl', 'Fox', 'Bear', 'Deer', 'Wolf',
        'Hawk', 'Dove', 'Swan', 'Lynx', 'Hare',
        'Otter', 'Robin', 'Finch', 'Panda', 'Koala',
        'Raven', 'Crane', 'Tiger', 'Eagle', 'Whale',
      ];
      const name = generateAnonymousName();
      const secondWord = name.split(' ')[1];
      expect(animals).toContain(secondWord);
    });
  });
});
