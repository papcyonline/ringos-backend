import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { AuthPayload } from '../../shared/types';

export function generateAccessToken(payload: { userId: string; isAnonymous: boolean }): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}

export function generateRefreshToken(payload: { userId: string }): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: env.JWT_REFRESH_EXPIRES_IN });
}

export function verifyAccessToken(token: string): AuthPayload {
  return jwt.verify(token, env.JWT_SECRET) as AuthPayload;
}

export function verifyRefreshToken(token: string): { userId: string } {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as { userId: string };
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
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const number = Math.floor(Math.random() * 100);
  return `${adjective} ${animal} ${number}`;
}
