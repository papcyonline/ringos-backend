import { logger } from '../../shared/logger';
import { createNotification, sendPostPush } from './notification.service';

interface BatchEntry {
  count: number;
  latestActorName: string;
  latestActorAvatar: string | undefined;
  postId: string;
  channelId: string;
  authorId: string;
  type: 'POST_LIKED' | 'POST_COMMENTED';
  timer: ReturnType<typeof setTimeout>;
}

const BATCH_WINDOW_MS = 30_000; // 30 seconds
const batches = new Map<string, BatchEntry>();

function makeKey(authorId: string, postId: string, type: string): string {
  return `${authorId}:${postId}:${type}`;
}

function flush(key: string) {
  const entry = batches.get(key);
  if (!entry) return;
  batches.delete(key);

  const { count, latestActorName, latestActorAvatar, postId, channelId, authorId, type } = entry;

  const title = count === 1
    ? latestActorName
    : `${latestActorName} and ${count - 1} other${count - 1 > 1 ? 's' : ''}`;

  const body = type === 'POST_LIKED'
    ? 'Liked your post'
    : 'Commented on your post';

  createNotification({
    userId: authorId,
    type,
    title,
    body,
    imageUrl: latestActorAvatar,
    data: { postId, channelId },
  }).catch((err) => logger.error({ err, postId, type }, 'Failed to create batched notification'));

  sendPostPush(authorId, {
    title,
    body,
    imageUrl: latestActorAvatar,
    data: { type, postId, channelId, userId: authorId },
  }).catch((err) => logger.error({ err, postId, type }, 'Failed to send batched push'));
}

export function enqueuePostNotification(params: {
  authorId: string;
  postId: string;
  channelId: string;
  type: 'POST_LIKED' | 'POST_COMMENTED';
  actorName: string;
  actorAvatar: string | undefined;
}) {
  const { authorId, postId, channelId, type, actorName, actorAvatar } = params;
  const key = makeKey(authorId, postId, type);

  const existing = batches.get(key);
  if (existing) {
    existing.count++;
    existing.latestActorName = actorName;
    existing.latestActorAvatar = actorAvatar;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flush(key), BATCH_WINDOW_MS);
  } else {
    batches.set(key, {
      count: 1,
      latestActorName: actorName,
      latestActorAvatar: actorAvatar,
      postId,
      channelId,
      authorId,
      type,
      timer: setTimeout(() => flush(key), BATCH_WINDOW_MS),
    });
  }
}
