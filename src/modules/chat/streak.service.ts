import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';

/// Snap-style daily-message streak between two users.
///
/// Storage: a single MessageStreak row per ordered pair (userAId < userBId)
/// holds counter + the last UTC day each side messaged + the last day BOTH
/// sides messaged. The "alive" status is derived at read time:
///   active = (today - lastMutualDay) <= 1 day
/// so we never need a cron to expire stale streaks — the display short-
/// circuits to 0 once a day is skipped, and the stored count remains until
/// the next mutual day either resumes (if yesterday) or resets it.

export interface StreakSnapshot {
  count: number;
  /// True when the streak is currently "alive" — i.e. both users messaged
  /// each other at least once on the same UTC day within the last 24h.
  /// False once a day lapses; a new mutual day resets count to 1.
  isActive: boolean;
}

/// Canonical pair: the smaller userId is always userA. This guarantees
/// exactly one row per friendship-pair regardless of who messages first.
function canonicalPair(a: string, b: string): { userAId: string; userBId: string } {
  return a < b ? { userAId: a, userBId: b } : { userAId: b, userBId: a };
}

/// Truncate a Date to its UTC day (00:00:00.000Z). Used as the unit-of-time
/// for streak math. Comparing day-truncated values avoids timezone drift
/// across servers and avoids partial-day rollover ambiguity.
function utcDay(d: Date = new Date()): Date {
  const day = new Date(d);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

function dayDiff(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

/// Update the streak for a 1-on-1 message. No-op for groups (caller decides).
/// Writes are atomic on the pair row but the call is best-effort: streaks
/// are gamification, not source-of-truth, so any error here is logged and
/// swallowed by the caller — never block a message send on streak math.
export async function recordMessageForStreak(
  senderId: string,
  recipientId: string,
): Promise<void> {
  if (senderId === recipientId) return; // self-DM has no streak meaning
  const { userAId, userBId } = canonicalPair(senderId, recipientId);
  const today = utcDay();
  const senderIsA = senderId === userAId;

  const existing = await prisma.messageStreak.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
  });

  // Update sender's "last messaged today" pointer.
  const senderField = senderIsA ? 'lastUserAMessageDay' : 'lastUserBMessageDay';
  const otherLastDay = senderIsA
    ? existing?.lastUserBMessageDay
    : existing?.lastUserAMessageDay;

  // Determine the new mutual day + count. Rules:
  //   1. Both sides messaged today → today is mutual.
  //      a. Already counted (lastMutualDay == today) → noop.
  //      b. lastMutualDay == yesterday → increment.
  //      c. Else (no streak or lapsed) → reset to 1.
  //   2. Only sender messaged today → no mutual update.
  let newCount = existing?.count ?? 0;
  let newMutual: Date | null = existing?.lastMutualDay ?? null;

  const otherMessagedToday =
    otherLastDay != null && dayDiff(today, utcDay(otherLastDay)) === 0;

  if (otherMessagedToday) {
    const lastMutualDayDiff =
      newMutual != null ? dayDiff(today, utcDay(newMutual)) : Infinity;
    if (lastMutualDayDiff === 0) {
      // already counted today
    } else if (lastMutualDayDiff === 1) {
      newCount = (existing?.count ?? 0) + 1;
      newMutual = today;
    } else {
      newCount = 1;
      newMutual = today;
    }
  }

  await prisma.messageStreak.upsert({
    where: { userAId_userBId: { userAId, userBId } },
    create: {
      userAId,
      userBId,
      count: newCount,
      lastMutualDay: newMutual,
      [senderField]: today,
    },
    update: {
      count: newCount,
      lastMutualDay: newMutual,
      [senderField]: today,
    },
  });
}

/// Fetch the streak between two users for display. Returns count + isActive.
/// `count` is the stored value; isActive tells the FE whether to show it
/// as "alive" (flame icon, vibrant) or "lapsed" (dimmed / hidden).
export async function getStreak(
  userId: string,
  partnerId: string,
): Promise<StreakSnapshot> {
  if (userId === partnerId) return { count: 0, isActive: false };
  const { userAId, userBId } = canonicalPair(userId, partnerId);
  const row = await prisma.messageStreak.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
  });
  if (!row || !row.lastMutualDay) return { count: 0, isActive: false };
  const today = utcDay();
  const diff = dayDiff(today, utcDay(row.lastMutualDay));
  // alive == today (diff 0) or yesterday (diff 1). Older = lapsed.
  return { count: row.count, isActive: diff <= 1 };
}

/// Best-effort wrapper — never throws, used from the message-send hot path.
export async function tryRecordMessageForStreak(
  senderId: string,
  recipientId: string,
): Promise<void> {
  try {
    await recordMessageForStreak(senderId, recipientId);
  } catch (err) {
    logger.error({ err, senderId, recipientId }, 'recordMessageForStreak failed');
  }
}
