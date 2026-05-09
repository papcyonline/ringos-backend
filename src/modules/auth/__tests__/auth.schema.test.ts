import { describe, it, expect } from 'vitest';
import {
  anonymousAuthSchema, registerSchema, loginSchema, usernameSchema,
  phoneAuthSchema, verifyOtpSchema, refreshTokenSchema, forgotPasswordSchema,
  resetPasswordSchema, emailOtpSchema, resendOtpSchema,
  googleAuthSchema, appleAuthSchema,
} from '../auth.schema';

describe('auth.schema', () => {
  it('anonymousAuthSchema accepts valid uuid', () => {
    expect(() => anonymousAuthSchema.parse({ deviceId: '123e4567-e89b-12d3-a456-426614174000' })).not.toThrow();
  });

  it('anonymousAuthSchema rejects non-uuid', () => {
    expect(() => anonymousAuthSchema.parse({ deviceId: 'not-uuid' })).toThrow();
  });

  it('registerSchema accepts strong password', () => {
    expect(() => registerSchema.parse({ email: 'a@b.com', password: 'GoodPass123' })).not.toThrow();
  });

  it('registerSchema rejects weak password (no digit)', () => {
    expect(() => registerSchema.parse({ email: 'a@b.com', password: 'Lowercase' })).toThrow();
  });

  it('registerSchema rejects weak password (no uppercase)', () => {
    expect(() => registerSchema.parse({ email: 'a@b.com', password: 'lowercase1' })).toThrow();
  });

  it('registerSchema rejects weak password (no lowercase)', () => {
    expect(() => registerSchema.parse({ email: 'a@b.com', password: 'UPPERCASE1' })).toThrow();
  });

  it('registerSchema rejects short password', () => {
    expect(() => registerSchema.parse({ email: 'a@b.com', password: 'Aa1' })).toThrow();
  });

  it('loginSchema accepts valid email/password', () => {
    expect(() => loginSchema.parse({ email: 'a@b.com', password: 'x' })).not.toThrow();
  });

  describe('usernameSchema', () => {
    it('accepts readable bio', () => {
      expect(() => usernameSchema.parse({
        username: 'alice',
        bio: 'Hello there friend',
      })).not.toThrow();
    });

    it('rejects keyboard-mash bio (4 same chars)', () => {
      expect(() => usernameSchema.parse({
        username: 'alice',
        bio: 'aaaaa rest of bio is fine',
      })).toThrow();
    });

    it('rejects 4 consecutive consonants', () => {
      expect(() => usernameSchema.parse({
        username: 'alice',
        bio: 'qwrtbio is broken',
      })).toThrow();
    });

    it('rejects no-vowel words', () => {
      expect(() => usernameSchema.parse({
        username: 'alice',
        bio: 'hmm bcd is great word',
      })).toThrow();
    });

    it('rejects single letter dominating', () => {
      expect(() => usernameSchema.parse({
        username: 'alice',
        bio: 'aerareee',
      })).toThrow();
    });

    it('accepts gender male and lowercases to upper', () => {
      const r = usernameSchema.parse({ username: 'alice', bio: 'Hello there bio is good', gender: 'male' });
      expect(r.gender).toBe('MALE');
    });

    it('rejects too many languages', () => {
      expect(() => usernameSchema.parse({
        username: 'alice',
        bio: 'Hello there bio is good',
        language: 'en,fr,es',
      })).toThrow();
    });

    it('accepts 1 or 2 languages', () => {
      expect(() => usernameSchema.parse({
        username: 'alice',
        bio: 'Hello there bio is good',
        language: 'en,fr',
      })).not.toThrow();
    });
  });

  it('phoneAuthSchema requires phone', () => {
    expect(() => phoneAuthSchema.parse({ phone: '1234567890' })).not.toThrow();
    expect(() => phoneAuthSchema.parse({ phone: '123' })).toThrow();
  });

  it('verifyOtpSchema requires 6-digit code', () => {
    expect(() => verifyOtpSchema.parse({ phone: '1234567890', code: '123456' })).not.toThrow();
    expect(() => verifyOtpSchema.parse({ phone: '1234567890', code: '123' })).toThrow();
  });

  it('refreshTokenSchema requires token', () => {
    expect(() => refreshTokenSchema.parse({ refreshToken: 'x' })).not.toThrow();
  });

  it('forgotPasswordSchema requires email', () => {
    expect(() => forgotPasswordSchema.parse({ email: 'a@b.com' })).not.toThrow();
    expect(() => forgotPasswordSchema.parse({ email: 'invalid' })).toThrow();
  });

  it('resetPasswordSchema validates all fields', () => {
    expect(() => resetPasswordSchema.parse({
      email: 'a@b.com', code: '123456', newPassword: 'GoodPass1',
    })).not.toThrow();
  });

  it('emailOtpSchema validates', () => {
    expect(() => emailOtpSchema.parse({ email: 'a@b.com', code: '123456' })).not.toThrow();
  });

  it('resendOtpSchema validates', () => {
    expect(() => resendOtpSchema.parse({ email: 'a@b.com' })).not.toThrow();
  });

  it('googleAuthSchema validates', () => {
    expect(() => googleAuthSchema.parse({ idToken: 'abc' })).not.toThrow();
  });

  it('appleAuthSchema validates with optional fullName', () => {
    expect(() => appleAuthSchema.parse({
      idToken: 'tok',
      fullName: { givenName: 'A', familyName: 'B' },
    })).not.toThrow();
    expect(() => appleAuthSchema.parse({ idToken: 'tok' })).not.toThrow();
  });
});
