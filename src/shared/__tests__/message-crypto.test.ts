import { describe, it, expect, vi } from 'vitest';

// Key set → encryption enabled for these tests.
vi.mock('../../config/env', () => ({
  env: { MESSAGE_ENC_KEY: 'unit-test-secret' },
}));

import {
  encryptContent,
  decryptContent,
  isMessageEncryptionEnabled,
} from '../message-crypto';

describe('message-crypto', () => {
  it('is enabled when a key is set', () => {
    expect(isMessageEncryptionEnabled()).toBe(true);
  });

  it('round-trips content and hides the plaintext', () => {
    const plain = 'Hello 👋 https://x.com secret';
    const enc = encryptContent(plain);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('Hello');
    expect(decryptContent(enc)).toBe(plain);
  });

  it('uses a random IV (different ciphertext each call)', () => {
    expect(encryptContent('same')).not.toBe(encryptContent('same'));
  });

  it('passes legacy plaintext through decrypt untouched', () => {
    expect(decryptContent('just plaintext')).toBe('just plaintext');
  });

  it('no-ops on empty and already-encrypted input', () => {
    expect(encryptContent('')).toBe('');
    const enc = encryptContent('x');
    expect(encryptContent(enc)).toBe(enc);
  });

  it('returns corrupt ciphertext as-is instead of throwing', () => {
    expect(decryptContent('v1:not-valid-base64!!')).toBe('v1:not-valid-base64!!');
  });
});
