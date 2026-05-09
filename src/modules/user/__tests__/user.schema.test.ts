import { describe, it, expect } from 'vitest';
import {
  updatePreferenceSchema,
  updateAvailabilitySchema,
  updatePrivacySchema,
  updateProfileSchema,
} from '../user.schema';

describe('user.schema', () => {
  it('updatePreferenceSchema accepts partial', () => {
    expect(() => updatePreferenceSchema.parse({ mood: 'HAPPY', language: 'en' })).not.toThrow();
  });

  it('updatePreferenceSchema rejects bad mood', () => {
    expect(() => updatePreferenceSchema.parse({ mood: 'CONFUSED' })).toThrow();
  });

  it('updatePreferenceSchema enforces topic count', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `t${i}`);
    expect(() => updatePreferenceSchema.parse({ topics: tooMany })).toThrow();
  });

  it('updateAvailabilitySchema accepts text/call/video', () => {
    expect(() => updateAvailabilitySchema.parse({
      availableFor: ['text', 'call', 'video'],
    })).not.toThrow();
  });

  it('updateAvailabilitySchema rejects empty list', () => {
    expect(() => updateAvailabilitySchema.parse({ availableFor: [] })).toThrow();
  });

  it('updateAvailabilitySchema rejects bad mode', () => {
    expect(() => updateAvailabilitySchema.parse({ availableFor: ['walk'] })).toThrow();
  });

  it('updatePrivacySchema accepts booleans', () => {
    expect(() => updatePrivacySchema.parse({
      isProfilePublic: false,
      hideOnlineStatus: true,
      hideReadReceipts: false,
    })).not.toThrow();
  });

  it('updateProfileSchema normalizes gender', () => {
    const r = updateProfileSchema.parse({ displayName: 'Alice', gender: 'female' });
    expect(r.gender).toBe('FEMALE');
  });

  it('updateProfileSchema accepts null fields', () => {
    expect(() => updateProfileSchema.parse({
      bio: null, profession: null, location: null,
    })).not.toThrow();
  });

  it('updateProfileSchema rejects bad gender', () => {
    expect(() => updateProfileSchema.parse({ gender: 'unknown' as any })).toThrow();
  });
});
