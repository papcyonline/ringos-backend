import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import {
  createNotification,
  sendDataPushToUser,
} from '../notification/notification.service';
import { getBlockedUserIds } from '../spotlight/spotlight.service';

/**
 * Send a "X viewed your story" push + in-app notification to the story
 * owner. Caller is responsible for ensuring this is the FIRST view —
 * markStoryViewed checks `createMany.count > 0` so we never re-notify
 * for a re-view, and silently skips stealth views. Best-effort: errors
 * are logged but never thrown so playback never breaks on push failure.
 */
export async function notifyStoryOwnerOfView(
  storyId: string,
  ownerId: string,
  viewerId: string,
): Promise<void> {
  // Intentionally a no-op. Per-view notifications don't scale: a story
  // with even a few hundred viewers would buzz the owner's phone all
  // day, and at 10k+ views the notification inbox becomes unusable.
  // WhatsApp / Instagram / Snapchat all keep view counts in-app only —
  // the owner sees viewers via the viewer-list panel inside the story
  // (still recorded in markStoryViewed → ReelView). Function kept so
  // existing callers compile; no in-app row + no push goes out.
  if (ownerId === viewerId) return;
  // No-op. View is already persisted by the caller (markStoryViewed).
  return;
}

/**
 * Fan-out a push + in-app notification to every follower of [authorId]
 * announcing they posted a new story. Owner is excluded. Muted users are
 * excluded so unmute is honoured. Best-effort — caller should not await.
 */
export async function notifyFollowersOfNewStory(
  storyId: string,
  authorId: string,
): Promise<void> {
  const author = await prisma.user.findUnique({
    where: { id: authorId },
    select: { displayName: true, avatarUrl: true },
  });
  if (!author) return;

  // Throttle: the story tray shows ONE ring per author, so we announce only
  // the author's first active story. If they already have another live,
  // ephemeral, non-channel story, their audience was already pinged — extra
  // posts just add slides to the same ring and shouldn't re-buzz anyone.
  // Resets naturally ~24h later as that story expires. Mirrors the "notify at
  // most once per window" idiom the engagement digests use.
  //
  // Permanent stories are deliberately excluded from the count: they never
  // expire, so counting them would suppress every future announcement for any
  // user who has ever posted one (a premium feature).
  const now = new Date();
  const priorActive = await prisma.story.count({
    where: {
      userId: authorId,
      channelId: null,
      id: { not: storyId },
      isPermanent: false,
      expiresAt: { gt: now },
    },
  });
  if (priorActive > 0) return;

  // A new story surfaces in TWO different feeds, so it has two audiences:
  //   - people who FOLLOW the author -> see it in GET /stories/following
  //   - people the author FOLLOWS    -> see it in GET /stories/feed
  // We notify both with copy matching where they'll find it. Mutual follows
  // land in both sets; they get the "#1" message only (deduped below) so a
  // single story never double-pings.
  const [followers, following, muted, hidden, blocked] = await Promise.all([
    prisma.follow.findMany({
      where: { followingId: authorId },
      select: { followerId: true },
    }),
    prisma.follow.findMany({
      where: { followerId: authorId },
      select: { followingId: true },
    }),
    prisma.storyMute.findMany({
      where: { mutedUserId: authorId },
      select: { muterId: true },
    }),
    prisma.storyHide.findMany({
      where: { ownerId: authorId },
      select: { hiddenUserId: true },
    }),
    getBlockedUserIds(authorId),
  ]);

  // Recipients the story would never reach anyway — mirror the feed's own
  // audience filters so we never ping someone who muted this author, whom the
  // author blocked (either direction), or whom the author hid their story from.
  const excluded = new Set<string>(blocked);
  for (const m of muted) excluded.add(m.muterId);
  for (const h of hidden) excluded.add(h.hiddenUserId);

  // #1 - "posted a new story" -> users who follow the author (Following feed).
  const followerIds = followers
    .map((f) => f.followerId)
    .filter((id) => !excluded.has(id));

  // #2 - "who follows you posted a story" -> users the author follows (main
  // feed), excluding mutuals already covered by #1 so they're pinged once.
  const followerSet = new Set(followerIds);
  const followingIds = following
    .map((f) => f.followingId)
    .filter((id) => !excluded.has(id) && !followerSet.has(id));

  if (followerIds.length === 0 && followingIds.length === 0) return;

  const title = author.displayName;

  // Fan out one audience with a given body copy. In-app notification (DB row +
  // socket event) + FCM data push, in parallel. sendDataPushToUser reads
  // `senderName` and `content` to build the iOS lock-screen alert title/body -
  // without them the push falls back to "Yomeet / New message".
  const fanOut = (userIds: string[], body: string) =>
    userIds.flatMap((userId) => [
      createNotification({
        userId,
        type: 'NEW_STORY',
        title,
        body,
        imageUrl: author.avatarUrl ?? undefined,
        data: { storyId, authorId, route: '/stories' },
      }),
      sendDataPushToUser(userId, {
        type: 'new_story',
        senderName: title,
        content: body,
        storyId,
        authorId,
        senderAvatar: author.avatarUrl ?? '',
        // Legacy keys kept for in-app banner / older clients that still
        // read authorName / avatarUrl.
        authorName: author.displayName,
        avatarUrl: author.avatarUrl ?? '',
      }),
    ]);

  await Promise.allSettled([
    ...fanOut(followerIds, 'posted a new story'),
    ...fanOut(followingIds, 'who follows you posted a story'),
  ]);

  logger.info(
    {
      storyId,
      authorId,
      followerCount: followerIds.length,
      followingCount: followingIds.length,
    },
    'Notified followers of new story',
  );
}

// ─── Milestone notifications ─────────────────────────────────────────
//
// When a story crosses certain view / like thresholds we send a single
// celebratory notification to the owner. Sparse thresholds, exact
// equality on the count (so duplicate notifications only happen on a
// rare race condition between concurrent writes — acceptable). The
// FIRST tier gets a push so the owner feels the spark; higher tiers
// are in-app only to avoid notification fatigue as a story takes off.

const VIEW_MILESTONES = [50, 100, 500] as const;
const LIKE_MILESTONES = [5, 10, 50] as const;

/** Push only when the owner crosses the smallest tier — "people are
 * noticing your story" moment. Higher tiers stay in-app only. */
function shouldPushFor(kind: 'views' | 'likes', count: number): boolean {
  if (kind === 'views') return count === VIEW_MILESTONES[0];
  return count === LIKE_MILESTONES[0];
}

function viewMilestoneCopy(count: number): { title: string; body: string } {
  switch (count) {
    case 50:
      return { title: '\u{1F525} Your story is taking off', body: '50 people watched your story' };
    case 100:
      return { title: 'Your story reached 100 views', body: 'Tap to see who watched' };
    case 500:
      return { title: '\u{1F680} 500 views and counting', body: 'Your story is on fire' };
    default:
      return { title: `${count} views on your story`, body: 'Tap to see who watched' };
  }
}

function likeMilestoneCopy(count: number): { title: string; body: string } {
  switch (count) {
    case 5:
      return { title: '\u{2764}\u{FE0F} 5 people liked your story', body: 'Your story is getting love' };
    case 10:
      return { title: '10 likes on your story', body: 'Keep posting moments like this' };
    case 50:
      return { title: '\u{1F4AF} 50 likes \u{2014} your story\u{2019}s on fire', body: 'Your audience is loving it' };
    default:
      return { title: `${count} likes on your story`, body: 'Tap to view' };
  }
}

/**
 * Check whether [newCount] crossed a milestone for the given [kind]
 * and, if so, send a single celebratory notification to the story
 * owner. Idempotent in practice: exact-equality check + no-op when
 * not on a threshold. Fire-and-forget; caller should not await.
 */
export async function checkStoryMilestone(
  storyId: string,
  ownerId: string,
  kind: 'views' | 'likes',
  newCount: number,
): Promise<void> {
  // Use a plain `readonly number[]` here so `includes()` doesn't try
  // to constrain its argument to a narrowed literal union — without
  // this widening, TypeScript rejects the call when `milestones` is
  // typed as `readonly [50,100,500] | readonly [5,10,50]`.
  const milestones: readonly number[] =
    kind === 'views' ? VIEW_MILESTONES : LIKE_MILESTONES;
  if (!milestones.includes(newCount)) return;

  const { title, body } = kind === 'views'
      ? viewMilestoneCopy(newCount)
      : likeMilestoneCopy(newCount);

  try {
    await createNotification({
      userId: ownerId,
      type: 'STORY_MILESTONE',
      title,
      body,
      data: { storyId, kind, count: newCount },
    });

    if (shouldPushFor(kind, newCount)) {
      // sendDataPushToUser is flat — it reads senderName (title) and
      // content (body) out of the data record to build the iOS alert.
      await sendDataPushToUser(ownerId, {
        type: 'STORY_MILESTONE',
        senderName: title,
        content: body,
        storyId,
        kind,
        count: String(newCount),
      });
    }
    logger.info({ storyId, ownerId, kind, newCount }, 'Story milestone fired');
  } catch (err) {
    logger.warn({ err, storyId, ownerId, kind, newCount }, 'Failed to fire story milestone');
  }
}
