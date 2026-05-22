import { ReEngagementHook } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../shared/logger';
import { sendPushToUser } from '../modules/notification/notification.service';

// Inactivity thresholds (days). Picks the *highest* step the user has
// crossed that hasn't been sent yet, so a user who's been inactive
// for 8 days gets the day-7 push (not the day-3 one).
const CADENCE_DAYS = [3, 7, 14, 30] as const;
type CadenceDay = typeof CADENCE_DAYS[number];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CHECK_INTERVAL_MS = HOUR_MS;
const BATCH_SIZE = 200;

// Quiet hours: only fire sends inside this UTC window. Conservative
// default catches the busy hours across most timezones we serve
// (~ Africa / Europe / NA daytime). Refine to per-user TZ later.
const SEND_WINDOW_START_UTC = 9;   // 09:00 UTC
const SEND_WINDOW_END_UTC   = 20;  // 20:00 UTC

// Master switch. Stays OFF in prod until the operator explicitly
// enables it via env. Default safety so a deploy can't accidentally
// blast users.
const ENABLED = process.env.REENGAGEMENT_ENABLED === 'true';
const DRY_RUN = process.env.REENGAGEMENT_DRY_RUN !== 'false';
const ALLOWLIST = (process.env.REENGAGEMENT_USER_ALLOWLIST ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

type Copy = { title: string; body: string };

function copyFor(hook: ReEngagementHook, args: { unreadCount?: number; joinCount?: number }): Copy {
  switch (hook) {
    case 'UNREAD_DM':
      return {
        title: 'Messages waiting for you',
        body:
          (args.unreadCount ?? 0) > 1
            ? `You have ${args.unreadCount} unread messages on Yomeet`
            : 'You have a new message on Yomeet',
      };
    case 'NEW_FOLLOWER':
      return {
        title: 'Someone wants to connect',
        body: 'A new person started following you on Yomeet',
      };
    case 'FOLLOWED_STORY':
      return {
        title: 'Fresh stories are waiting',
        body: "Friends you follow just posted — don't miss them",
      };
    case 'NEW_JOINS':
      return {
        title: 'New people joined Yomeet',
        body:
          (args.joinCount ?? 0) > 1
            ? `${args.joinCount} new people joined this week — come say hi`
            : 'Someone new just joined Yomeet — come say hi',
      };
    case 'GENERIC':
    default:
      return {
        title: 'Your friends are waiting',
        body: 'Open Yomeet to see what you missed',
      };
  }
}

// Picks the strongest personal hook for this user. Cheap to run
// per-user because each lookup is a count-only query.
async function pickHook(userId: string, lastSeenAt: Date): Promise<{ hook: ReEngagementHook; args: { unreadCount?: number; joinCount?: number } }> {
  // 1. Unread DMs since their last visit. We approximate "unread" as
  //    messages sent by someone else, in a conversation they're a
  //    member of, after their lastSeenAt. (Per-participant lastReadAt
  //    would be more accurate but costs another join.)
  const unreadCount = await prisma.message.count({
    where: {
      senderId: { not: userId },
      isSystem: false,
      deletedAt: null,
      createdAt: { gt: lastSeenAt },
      conversation: {
        participants: {
          some: { userId, leftAt: null },
        },
      },
    },
  });
  if (unreadCount > 0) {
    return { hook: 'UNREAD_DM', args: { unreadCount } };
  }

  // 2. New follower since last visit.
  const newFollower = await prisma.follow.findFirst({
    where: { followingId: userId, createdAt: { gt: lastSeenAt } },
    select: { id: true },
  });
  if (newFollower) {
    return { hook: 'NEW_FOLLOWER', args: {} };
  }

  // 3. Followed user posted a story in the last 24h.
  const since = new Date(Date.now() - DAY_MS);
  const followedStory = await prisma.story.findFirst({
    where: {
      createdAt: { gt: since },
      user: {
        followsReceived: { some: { followerId: userId } },
      },
    },
    select: { id: true },
  });
  if (followedStory) {
    return { hook: 'FOLLOWED_STORY', args: {} };
  }

  // 4. N new users joined Yomeet in the last 7 days.
  const joinWindow = new Date(Date.now() - 7 * DAY_MS);
  const joinCount = await prisma.user.count({
    where: {
      isAnonymous: false,
      createdAt: { gt: joinWindow },
      id: { not: userId },
    },
  });
  if (joinCount > 0) {
    return { hook: 'NEW_JOINS', args: { joinCount } };
  }

  return { hook: 'GENERIC', args: {} };
}

function pickCadenceStep(daysInactive: number): CadenceDay | null {
  let chosen: CadenceDay | null = null;
  for (const step of CADENCE_DAYS) {
    if (daysInactive >= step) chosen = step;
  }
  return chosen;
}

async function runOnce() {
  if (!ENABLED) return;

  const nowHourUtc = new Date().getUTCHours();
  const inWindow = nowHourUtc >= SEND_WINDOW_START_UTC && nowHourUtc < SEND_WINDOW_END_UTC;
  if (!inWindow) return;

  // Candidate filter: completed onboarding, has at least one FCM token,
  // and `lastSeenAt` is older than the smallest cadence step. Anonymous
  // users are excluded (they never finished signup and abandoned-signup
  // cleanup will remove them anyway).
  const minInactiveSince = new Date(Date.now() - CADENCE_DAYS[0] * DAY_MS);

  const whereClause: any = {
    isAnonymous: false,
    lastSeenAt: { not: null, lt: minInactiveSince },
    fcmTokens: { some: {} },
  };
  if (ALLOWLIST.length > 0) {
    whereClause.id = { in: ALLOWLIST };
  }

  let processed = 0;
  let sent = 0;
  let cursor: string | undefined;
  while (true) {
    const batch = await prisma.user.findMany({
      where: whereClause,
      select: { id: true, lastSeenAt: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    processed += batch.length;

    for (const user of batch) {
      if (!user.lastSeenAt) continue;
      const daysInactive = Math.floor((Date.now() - user.lastSeenAt.getTime()) / DAY_MS);
      const step = pickCadenceStep(daysInactive);
      if (!step) continue;

      const already = await prisma.reEngagementPush.findUnique({
        where: { userId_cadenceDay: { userId: user.id, cadenceDay: step } },
        select: { id: true },
      });
      if (already) continue;

      const { hook, args } = await pickHook(user.id, user.lastSeenAt);
      const copy = copyFor(hook, args);

      if (DRY_RUN) {
        logger.info(
          { userId: user.id, daysInactive, step, hook, title: copy.title, body: copy.body },
          'reengagement DRY_RUN — would send',
        );
        continue;
      }

      try {
        await sendPushToUser(user.id, {
          title: copy.title,
          body: copy.body,
          data: { type: 'reengagement', hook },
        });
        await prisma.reEngagementPush.create({
          data: { userId: user.id, cadenceDay: step, hookType: hook },
        });
        sent += 1;
      } catch (err) {
        logger.error({ err, userId: user.id }, 'reengagement send failed');
      }
    }
  }

  if (processed > 0 || sent > 0) {
    logger.info(
      { processed, sent, dryRun: DRY_RUN, allowlist: ALLOWLIST.length },
      'reengagement campaign tick complete',
    );
  }
}

export function startReEngagementCampaignJob() {
  if (!ENABLED) {
    logger.info('Re-engagement campaign disabled (REENGAGEMENT_ENABLED != true)');
    return;
  }
  runOnce().catch((err) => logger.error(err, 'reengagement campaign initial run error'));
  setInterval(() => {
    runOnce().catch((err) => logger.error(err, 'reengagement campaign tick error'));
  }, CHECK_INTERVAL_MS);
  logger.info({ dryRun: DRY_RUN, allowlist: ALLOWLIST.length }, 'Re-engagement campaign job started');
}
