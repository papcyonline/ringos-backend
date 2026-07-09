import { prisma } from '../config/database';
import { logger } from '../shared/logger';
import { messageRequestWhere } from '../modules/chat/chat.service';
import {
  createNotification,
  sendPushToUser,
} from '../modules/notification/notification.service';

// Engagement-digest job: a sparse, capped reminder for two signals
// the per-event push path can't cover well:
//
//   1. MESSAGE_REQUESTS_DIGEST — pending message requests sit silent by
//      design (no per-event push for stranger DMs), so without this
//      nudge a user could miss them indefinitely.
//
//   2. NEW_FOLLOWERS_DIGEST — when a user is away for hours and 2+
//      people follow them, a single "3 people followed you" digest is
//      more useful than the individual NEW_FOLLOWER pushes piling up.
//
// Both fire at most once per 24 h per user; we use the existing
// Notification table as the audit + dedupe log (no schema state to
// maintain). Mirrors reengagementCampaign.ts: hourly tick, batched
// scan, env-gated rollout (dry-run by default).

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CHECK_INTERVAL_MS = HOUR_MS;
const BATCH_SIZE = 200;

// Quiet hours — only send between 09:00 and 20:00 UTC. Conservative
// default that catches Europe / Africa / NA daytime. Refine to
// per-user TZ later if abuse complaints come up.
const SEND_WINDOW_START_UTC = 9;
const SEND_WINDOW_END_UTC = 20;

// Master switch. OFF by default — operator must flip ENGAGEMENT_DIGEST_ENABLED=true
// to roll out, and the dry-run guard is ON unless explicitly disabled.
const ENABLED = process.env.ENGAGEMENT_DIGEST_ENABLED === 'true';
const DRY_RUN = process.env.ENGAGEMENT_DIGEST_DRY_RUN !== 'false';
const ALLOWLIST = (process.env.ENGAGEMENT_DIGEST_ALLOWLIST ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Followers digest only fires once the user has 2+ NEW followers
// since their last digest (or 24 h, whichever is shorter). Below
// that, the per-event NEW_FOLLOWER notification already covers it.
const FOLLOWERS_DIGEST_MIN = 2;

function isWithinSendWindow(now = new Date()): boolean {
  const hour = now.getUTCHours();
  return hour >= SEND_WINDOW_START_UTC && hour < SEND_WINDOW_END_UTC;
}

function requestsCopy(count: number): { title: string; body: string } {
  if (count === 1) {
    return {
      title: 'You have a message request',
      body: 'Someone new wants to message you — tap to review',
    };
  }
  return {
    title: `You have ${count} message requests`,
    body: 'Tap to see who wants to message you',
  };
}

function followersCopy(count: number): { title: string; body: string } {
  return {
    title: `${count} new followers`,
    body: 'People are noticing you — tap to see who followed you',
  };
}

/**
 * Returns the user's most recent notification of [type], or null. Used
 * to enforce per-user-per-type cooldowns without adding a new table.
 */
async function lastDigestAt(
  userId: string,
  type: 'MESSAGE_REQUESTS_DIGEST' | 'NEW_FOLLOWERS_DIGEST',
): Promise<Date | null> {
  const row = await prisma.notification.findFirst({
    where: { userId, type },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

/**
 * Count message requests that are NEW since [since] — i.e. a real (non-system,
 * not-deleted) message from the stranger arrived after the user last opened
 * their Requests inbox. Builds on the SAME base filter as the on-screen list
 * (messageRequestWhere) so the two never drift; it just adds the "arrived
 * after [since]" constraint so the digest stops re-nagging about requests the
 * user has already reviewed.
 */
async function newRequestCount(userId: string, since: Date): Promise<number> {
  return prisma.conversation.count({
    where: {
      ...messageRequestWhere(userId),
      messages: {
        some: {
          isSystem: false,
          NOT: { deletedFor: { has: userId } },
          createdAt: { gt: since },
        },
      },
    },
  });
}

/**
 * Number of new followers since [since]. Used to gate the
 * NEW_FOLLOWERS_DIGEST so the user only sees it when the pile-up is
 * meaningful (2+).
 */
async function newFollowerCount(userId: string, since: Date): Promise<number> {
  return prisma.follow.count({
    where: { followingId: userId, createdAt: { gt: since } },
  });
}

async function maybeFireRequestsDigest(userId: string): Promise<boolean> {
  const last = await lastDigestAt(userId, 'MESSAGE_REQUESTS_DIGEST');
  if (last && Date.now() - last.getTime() < DAY_MS) return false;

  // Only count requests that arrived since the user last opened their Requests
  // inbox (falling back to the last digest, then a 24h floor) so we never
  // re-nag about requests they've already reviewed.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lastRequestCheckAt: true },
  });
  const candidates: number[] = [Date.now() - DAY_MS];
  if (last) candidates.push(last.getTime());
  if (user?.lastRequestCheckAt) candidates.push(user.lastRequestCheckAt.getTime());
  const since = new Date(Math.max(...candidates));
  const count = await newRequestCount(userId, since);
  if (count <= 0) return false;

  const copy = requestsCopy(count);
  if (DRY_RUN) {
    logger.info(
      { userId, count, title: copy.title, body: copy.body },
      'engagementDigest DRY_RUN — would send MESSAGE_REQUESTS_DIGEST',
    );
    return false;
  }

  try {
    await createNotification({
      userId,
      type: 'MESSAGE_REQUESTS_DIGEST',
      title: copy.title,
      body: copy.body,
      data: { count },
    });
    await sendPushToUser(userId, {
      title: copy.title,
      body: copy.body,
      data: { type: 'message_requests_digest', count: String(count) },
    });
    return true;
  } catch (err) {
    logger.warn({ err, userId }, 'engagementDigest: requests digest send failed');
    return false;
  }
}

async function maybeFireFollowersDigest(userId: string): Promise<boolean> {
  const last = await lastDigestAt(userId, 'NEW_FOLLOWERS_DIGEST');
  if (last && Date.now() - last.getTime() < DAY_MS) return false;

  // "New since" = the MOST RECENT of: when the user last opened their followers
  // list, the last digest, and a 24h floor. Using lastFollowerCheckAt is what
  // stops the digest from re-reporting followers the user already scrolled
  // through in-app. The 24h floor caps a first-time / long-idle user so they
  // don't get a week's worth reported at once.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lastFollowerCheckAt: true },
  });
  const candidates: number[] = [Date.now() - DAY_MS];
  if (last) candidates.push(last.getTime());
  if (user?.lastFollowerCheckAt) candidates.push(user.lastFollowerCheckAt.getTime());
  const since = new Date(Math.max(...candidates));
  const count = await newFollowerCount(userId, since);
  if (count < FOLLOWERS_DIGEST_MIN) return false;

  const copy = followersCopy(count);
  if (DRY_RUN) {
    logger.info(
      { userId, count, title: copy.title, body: copy.body },
      'engagementDigest DRY_RUN — would send NEW_FOLLOWERS_DIGEST',
    );
    return false;
  }

  try {
    await createNotification({
      userId,
      type: 'NEW_FOLLOWERS_DIGEST',
      title: copy.title,
      body: copy.body,
      data: { count },
    });
    await sendPushToUser(userId, {
      title: copy.title,
      body: copy.body,
      data: { type: 'new_followers_digest', count: String(count) },
    });
    return true;
  } catch (err) {
    logger.warn({ err, userId }, 'engagementDigest: followers digest send failed');
    return false;
  }
}

async function runOnce(): Promise<void> {
  if (!isWithinSendWindow()) return;

  const whereClause: any = {
    // Must have at least one FCM token, otherwise the push is wasted.
    fcmTokens: { some: {} },
  };
  if (ALLOWLIST.length > 0) {
    whereClause.id = { in: ALLOWLIST };
  }

  let processed = 0;
  let sentRequests = 0;
  let sentFollowers = 0;
  let cursor: string | undefined;

  while (true) {
    const batch = await prisma.user.findMany({
      where: whereClause,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    processed += batch.length;

    for (const user of batch) {
      if (await maybeFireRequestsDigest(user.id)) sentRequests += 1;
      if (await maybeFireFollowersDigest(user.id)) sentFollowers += 1;
    }
  }

  if (processed > 0 || sentRequests > 0 || sentFollowers > 0) {
    logger.info(
      {
        processed,
        sentRequests,
        sentFollowers,
        dryRun: DRY_RUN,
        allowlist: ALLOWLIST.length,
      },
      'engagementDigest tick complete',
    );
  }
}

export function startEngagementDigestJob(): void {
  if (!ENABLED) {
    logger.info('Engagement digest job disabled (ENGAGEMENT_DIGEST_ENABLED != true)');
    return;
  }
  runOnce().catch((err) => logger.error(err, 'engagementDigest initial run error'));
  setInterval(() => {
    runOnce().catch((err) => logger.error(err, 'engagementDigest tick error'));
  }, CHECK_INTERVAL_MS);
  logger.info(
    { dryRun: DRY_RUN, allowlist: ALLOWLIST.length },
    'Engagement digest job started',
  );
}
