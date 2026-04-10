import jwt from 'jsonwebtoken';
import { randomInt } from 'crypto';
import { env } from '../../config/env';
import { AuthPayload } from '../../shared/types';

/**
 * Try to verify a JWT against the current secret first, then the previous one.
 * This allows seamless secret rotation: set the new secret, move the old to PREVIOUS,
 * leave both for ~30 days, then remove the previous.
 */
function verifyWithRotation<T>(token: string, currentSecret: string, previousSecret?: string): T {
  try {
    return jwt.verify(token, currentSecret) as T;
  } catch (err) {
    if (previousSecret) {
      return jwt.verify(token, previousSecret) as T;
    }
    throw err;
  }
}

export function generateAccessToken(payload: { userId: string; isAnonymous: boolean }): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as any);
}

export function generateRefreshToken(payload: { userId: string }): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: env.JWT_REFRESH_EXPIRES_IN } as any);
}

export function verifyAccessToken(token: string): AuthPayload {
  return verifyWithRotation<AuthPayload>(token, env.JWT_SECRET, env.JWT_SECRET_PREVIOUS);
}

export function verifyRefreshToken(token: string): { userId: string } {
  return verifyWithRotation<{ userId: string }>(token, env.JWT_REFRESH_SECRET, env.JWT_REFRESH_SECRET_PREVIOUS);
}

const ADJECTIVES = [
  'Gentle', 'Brave', 'Calm', 'Kind', 'Wise',
  'Bright', 'Warm', 'Quiet', 'Swift', 'Bold',
  'Happy', 'Shy', 'Soft', 'Cool', 'Mild',
  'True', 'Fair', 'Free', 'Keen', 'Pure',
];

const ANIMALS = [
  'Owl', 'Fox', 'Bear', 'Deer', 'Wolf',
  'Hawk', 'Dove', 'Swan', 'Lynx', 'Hare',
  'Otter', 'Robin', 'Finch', 'Panda', 'Koala',
  'Raven', 'Crane', 'Tiger', 'Eagle', 'Whale',
];

export function generateAnonymousName(): string {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const animal = ANIMALS[randomInt(ANIMALS.length)];
  const number = randomInt(100);
  return `${adjective} ${animal} ${number}`;
}
