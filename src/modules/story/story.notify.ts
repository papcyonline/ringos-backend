import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import {
  createNotification,
  sendDataPushToUser,
} from '../notification/notification.service';

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

  // Followers = users who follow the author (we notify *them*).
  const follows = await prisma.follow.findMany({
    where: { followingId: authorId },
    select: { followerId: true },
  });
  if (follows.length === 0) return;

  // Exclude users who muted this author's stories.
  const muted = await prisma.storyMute.findMany({
    where: { mutedUserId: authorId },
    select: { muterId: true },
  });
  const mutedSet = new Set(muted.map((m) => m.muterId));

  const targets = follows
    .map((f) => f.followerId)
    .filter((id) => !mutedSet.has(id));
  if (targets.length === 0) return;

  const title = author.displayName;
  const body = 'posted a new story';

  // In-app notification (DB row + socket event) + FCM data push, in parallel.
  // sendDataPushToUser reads `senderName` and `content` from the payload to
  // build the iOS lock-screen alert title/body — without these the push
  // would show "Yomeet / New message" because the fallbacks kick in.
  await Promise.allSettled(
    targets.flatMap((userId) => [
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
    ]),
  );

  logger.info(
    { storyId, authorId, recipientCount: targets.length },
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
