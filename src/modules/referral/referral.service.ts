import { randomInt } from 'crypto';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { BadRequestError } from '../../shared/errors';

// Milestone rewards (referrer only — Apple forbids rewarding the new user).
// Granted as the referrer CROSSES each friend count; rewards stack on proUntil.
export const REFERRAL_TIERS: { friends: number; days: number; label: string }[] = [
  { friends: 5, days: 7, label: '1 week Pro' },
  { friends: 10, days: 30, label: '1 month Pro' },
  { friends: 30, days: 365, label: '1 year Pro' },
];

// Cap qualified referrals per referrer per day to blunt farming velocity.
const MAX_QUALIFY_PER_DAY = 15;
// A referral must bring a genuinely NEW user — codes can only be redeemed by
// accounts created within this window (covers users who onboard first, then
// enter a code from the Invite screen).
const NEW_USER_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// Public share-link base. The app also accepts a manually typed code.
const INVITE_LINK_BASE = 'https://yomeet.app/i';

// Unambiguous alphabet (no 0/O/1/I) for human-typable codes.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(len = 7): string {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** Grant `days` of Pro to a user, extending any live grant (never shortening). */
export async function grantProDays(userId: string, days: number): Promise<Date> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { proUntil: true },
  });
  const now = Date.now();
  const base =
    user?.proUntil && user.proUntil.getTime() > now ? user.proUntil.getTime() : now;
  const proUntil = new Date(base + days * DAY_MS);
  await prisma.user.update({ where: { id: userId }, data: { proUntil } });
  return proUntil;
}

// Custom (vanity) code rules.
const CODE_MIN = 4;
const CODE_MAX = 16;
const CODE_RE = /^[A-Z0-9]+$/;

/** Let a user pick their own vanity referral code. Returns the saved code. */
export async function setCustomCode(userId: string, rawCode: string): Promise<string> {
  const code = rawCode.trim().toUpperCase();
  if (code.length < CODE_MIN || code.length > CODE_MAX) {
    throw new BadRequestError(`Code must be ${CODE_MIN}–${CODE_MAX} characters`);
  }
  if (!CODE_RE.test(code)) {
    throw new BadRequestError('Use letters and numbers only');
  }

  const owner = await prisma.user.findUnique({
    where: { referralCode: code },
    select: { id: true },
  });
  if (owner && owner.id !== userId) {
    throw new BadRequestError('That code is already taken');
  }

  await prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
  logger.info({ userId }, 'Custom referral code set');
  return code;
}

/** Ensure the user has a unique referral code, generating one on first need. */
export async function ensureReferralCode(userId: string): Promise<string> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { referralCode: true },
  });
  if (existing?.referralCode) return existing.referralCode;

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    try {
      await prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
      return code;
    } catch {
      // Unique collision — try another code.
    }
  }
  throw new Error('Failed to generate a referral code');
}

/** Reason to reject a referral for fraud, or null if it's clean. */
async function fraudReason(referrerId: string, refereeId: string): Promise<string | null> {
  const [referrer, referee] = await Promise.all([
    prisma.user.findUnique({ where: { id: referrerId }, select: { deviceId: true } }),
    prisma.user.findUnique({ where: { id: refereeId }, select: { deviceId: true } }),
  ]);
  if (!referrer || !referee) return 'missing_user';

  // Same physical device → almost certainly a self-referral farm.
  if (referrer.deviceId && referee.deviceId && referrer.deviceId === referee.deviceId) {
    return 'same_device';
  }

  // Velocity cap: too many qualifications for this referrer in the last day.
  const recent = await prisma.referral.count({
    where: {
      referrerId,
      status: 'qualified',
      qualifiedAt: { gte: new Date(Date.now() - DAY_MS) },
    },
  });
  if (recent >= MAX_QUALIFY_PER_DAY) return 'rate_limited';

  return null;
}

/** Grant any newly-crossed milestone rewards to the referrer. */
async function processMilestones(referrerId: string): Promise<void> {
  const qualified = await prisma.referral.count({
    where: { referrerId, status: 'qualified' },
  });
  const referrer = await prisma.user.findUnique({
    where: { id: referrerId },
    select: { referralRewardTier: true },
  });
  if (!referrer) return;

  const oldTier = referrer.referralRewardTier;
  let newTier = oldTier;
  let daysToGrant = 0;
  for (const t of REFERRAL_TIERS) {
    if (qualified >= t.friends && newTier < t.friends) {
      daysToGrant += t.days;
      newTier = t.friends;
    }
  }
  if (newTier <= oldTier) return;

  // Atomic guard: only the call that actually advances the tier FROM the value
  // it observed grants the reward, so two referrals qualifying at once can't
  // double-pay the same milestone.
  const bumped = await prisma.user.updateMany({
    where: { id: referrerId, referralRewardTier: oldTier },
    data: { referralRewardTier: newTier },
  });
  if (bumped.count !== 1) return;

  await grantProDays(referrerId, daysToGrant);
  logger.info(
    { referrerId, qualified, daysToGrant, newTier },
    'Referral milestone reward granted',
  );
}

/**
 * Qualify a referee's pending referral once they've onboarded and passed the
 * fraud checks, then reward the referrer if a milestone is crossed. Safe to call
 * more than once and for users with no referral — it no-ops.
 */
export async function qualifyReferral(refereeId: string): Promise<void> {
  const ref = await prisma.referral.findUnique({ where: { refereeId } });
  if (!ref || ref.status !== 'pending') return;

  const referee = await prisma.user.findUnique({
    where: { id: refereeId },
    select: { isAnonymous: true },
  });
  if (!referee || referee.isAnonymous) return; // not onboarded yet

  const reject = await fraudReason(ref.referrerId, refereeId);
  if (reject) {
    await prisma.referral.update({
      where: { refereeId },
      data: { status: 'rejected', rejectReason: reject },
    });
    logger.warn({ refereeId, referrerId: ref.referrerId, reject }, 'Referral rejected');
    return;
  }

  await prisma.referral.update({
    where: { refereeId },
    data: { status: 'qualified', qualifiedAt: new Date() },
  });
  await processMilestones(ref.referrerId);
}

/** A new user redeems an invite code. One code per user, set once. */
export async function redeemCode(refereeId: string, rawCode: string): Promise<{ ok: true }> {
  const code = rawCode.trim().toUpperCase();
  if (code.length < 3) throw new BadRequestError('Enter a valid invite code');

  const existing = await prisma.referral.findUnique({ where: { refereeId } });
  if (existing) throw new BadRequestError('You have already used an invite code');

  const me = await prisma.user.findUnique({
    where: { id: refereeId },
    select: { createdAt: true },
  });
  if (me && Date.now() - me.createdAt.getTime() > NEW_USER_WINDOW_DAYS * DAY_MS) {
    throw new BadRequestError('Invite codes are only for new accounts');
  }

  const referrer = await prisma.user.findUnique({
    where: { referralCode: code },
    select: { id: true },
  });
  if (!referrer) throw new BadRequestError('Invalid invite code');
  if (referrer.id === refereeId) throw new BadRequestError("You can't use your own code");

  await prisma.referral.create({
    data: { referrerId: referrer.id, refereeId, status: 'pending' },
  });
  logger.info({ refereeId, referrerId: referrer.id }, 'Referral code redeemed');
  return { ok: true };
}

/** Everything the "Invite & Earn" screen needs. */
export async function getReferralSummary(userId: string) {
  const code = await ensureReferralCode(userId);
  const [friendsJoined, pending, user] = await Promise.all([
    prisma.referral.count({ where: { referrerId: userId, status: 'qualified' } }),
    prisma.referral.count({ where: { referrerId: userId, status: 'pending' } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { referralRewardTier: true, proUntil: true },
    }),
  ]);
  const rewardTier = user?.referralRewardTier ?? 0;
  const nextTier = REFERRAL_TIERS.find((t) => rewardTier < t.friends) ?? null;

  return {
    code,
    link: `${INVITE_LINK_BASE}/${code}`,
    friendsJoined,
    pending,
    rewardTier,
    proUntil: user?.proUntil ?? null,
    tiers: REFERRAL_TIERS,
    nextTier,
  };
}
