import { logger } from '../../shared/logger';
import { createNotification, sendPostPush } from './notification.service';

interface BatchEntry {
  count: number;
  latestActorId: string;
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

  const { count, latestActorId, latestActorName, latestActorAvatar, postId, channelId, authorId, type } = entry;

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

  // sender* fields let the iOS NSE upgrade this to a Communication
  // Notification (big avatar circle + Yomeet badge on the lock screen).
  // For batched events we surface the LATEST actor as the "sender" — the
  // title already reads "X and N others" when there are more.
  sendPostPush(authorId, {
    title,
    body,
    imageUrl: latestActorAvatar,
    data: {
      type,
      postId,
      channelId,
      userId: authorId,
      senderId: latestActorId,
      senderName: latestActorName,
      senderAvatar: latestActorAvatar ?? '',
    },
  }).catch((err) => logger.error({ err, postId, type }, 'Failed to send batched push'));
}

export function enqueuePostNotification(params: {
  authorId: string;
  postId: string;
  channelId: string;
  type: 'POST_LIKED' | 'POST_COMMENTED';
  actorId: string;
  actorName: string;
  actorAvatar: string | undefined;
}) {
  const { authorId, postId, channelId, type, actorId, actorName, actorAvatar } = params;
  const key = makeKey(authorId, postId, type);

  const existing = batches.get(key);
  if (existing) {
    existing.count++;
    existing.latestActorId = actorId;
    existing.latestActorName = actorName;
    existing.latestActorAvatar = actorAvatar;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flush(key), BATCH_WINDOW_MS);
  } else {
    batches.set(key, {
      count: 1,
      latestActorId: actorId,
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
