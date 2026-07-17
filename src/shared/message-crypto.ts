import crypto from 'crypto';
import { env } from '../config/env';

// ─── Message encryption-at-rest ─────────────────────────────
//
// AES-256-GCM encryption for message content stored in the DB. This is
// encryption AT REST, not end-to-end: the server holds the key and decrypts in
// memory so translation, scam detection, link previews, notifications and
// search keep working. It protects against DB dumps / stolen backups.
//
// Rollout is safe and incremental:
//   • No MESSAGE_ENC_KEY set  → everything is a no-op (plaintext in/out).
//   • Key set                 → new writes are encrypted; legacy plaintext
//                               rows still read fine (decrypt passes through
//                               anything without the version marker).
//   • Backfill script         → encrypts the existing plaintext rows.
//
// ⚠️ The key must be backed up and NEVER changed or lost once messages are
//    encrypted with it — rotating/losing it makes those messages unreadable.

const PREFIX = 'v1:'; // version marker on ciphertext; absent = legacy plaintext

const _key: Buffer | null = env.MESSAGE_ENC_KEY
  ? crypto.createHash('sha256').update(env.MESSAGE_ENC_KEY).digest() // 32 bytes
  : null;

export function isMessageEncryptionEnabled(): boolean {
  return _key !== null;
}

/// Encrypt plaintext for storage. No-op when disabled, empty, or already
/// encrypted. Output: "v1:" + base64(iv[12] | authTag[16] | ciphertext).
export function encryptContent(plain: string): string {
  if (!_key || !plain || plain.startsWith(PREFIX)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/// Decrypt a stored value. Anything without the version marker (legacy
/// plaintext) is returned as-is, so this is safe to call on any content field.
export function decryptContent(value: string): string {
  if (!_key || typeof value !== 'string' || !value.startsWith(PREFIX)) {
    return value;
  }
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', _key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    // Corrupt / wrong-key — return as-is rather than throwing on a read path.
    return value;
  }
}
