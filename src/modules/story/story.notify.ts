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
        title,
        body,
        storyId,
        authorId,
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
