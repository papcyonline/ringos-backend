import { prisma } from '../config/database';
import { logger } from '../shared/logger';
import { getIO } from '../config/socket';

const CHECK_INTERVAL_MS = 60 * 1000; // every 60 seconds
const BATCH_LIMIT = 500;

/**
 * Clean up media files for expired messages. Fire-and-forget: errors are
 * logged but don't block the delete.
 */
async function cleanupExpiredMedia(urls: (string | null)[]): Promise<void> {
  const valid = urls.filter((u): u is string => !!u);
  for (const url of valid) {
    try {
      if (url.includes('drive.google.com')) {
        const match = url.match(/id=([a-zA-Z0-9_-]+)/);
        if (match) {
          const { deleteFromDrive } = await import('../shared/gdrive.service');
          deleteFromDrive(match[1]).catch(() => {});
        }
      } else if (url.includes('cloudinary.com')) {
        const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
        if (match) {
          const isAudio = url.includes('/video/') || url.endsWith('.m4a') || url.endsWith('.mp3');
          const { deleteFile } = await import('../shared/cloudinary.service');
          deleteFile(match[1], isAudio ? 'video' : 'image').catch(() => {});
        }
      }
    } catch (err) {
      logger.debug({ err, url }, 'Expired-media cleanup failed');
    }
  }
}

export function startMessageExpiryJob() {
  setInterval(async () => {
    try {
      const now = new Date();
      // Step 1: fetch a batch of expired messages with the metadata we need
      // for media cleanup + broadcast, BEFORE deleting them.
      const expired = await prisma.message.findMany({
        where: { expiresAt: { lte: now } },
        select: {
          id: true,
          conversationId: true,
          senderId: true,
          imageUrl: true,
          audioUrl: true,
        },
        take: BATCH_LIMIT,
      });

      if (expired.length === 0) return;

      const ids = expired.map((m) => m.id);

      // Step 2: hard-delete (reactions cascade via FK onDelete).
      await prisma.$transaction([
        prisma.messageReaction.deleteMany({ where: { messageId: { in: ids } } }),
        prisma.message.deleteMany({ where: { id: { in: ids } } }),
      ]);

      // Step 3: fan out chat:expired so open clients drop the bubbles live.
      try {
        const io = getIO();
        // Group by conversation to minimise the number of emissions.
        const byConv = new Map<string, string[]>();
        for (const m of expired) {
          const arr = byConv.get(m.conversationId) ?? [];
          arr.push(m.id);
          byConv.set(m.conversationId, arr);
        }
        for (const [conversationId, messageIds] of byConv) {
          io.to(`conversation:${conversationId}`).emit('chat:expired', {
            conversationId,
            messageIds,
          });
        }
        // Also notify senders in their personal rooms so the chat list
        // lastMessage preview updates even if the conversation isn't open.
        const senderIds = new Set(expired.map((m) => m.senderId));
        for (const senderId of senderIds) {
          io.to(`user:${senderId}`).emit('chat:expired', {
            messageIds: expired.filter((m) => m.senderId === senderId).map((m) => m.id),
          });
        }
      } catch (err) {
        logger.debug({ err }, 'chat:expired broadcast skipped (socket not ready)');
      }

      // Step 4: clean up media in the background.
      cleanupExpiredMedia(expired.flatMap((m) => [m.imageUrl, m.audioUrl])).catch(() => {});

      logger.info({ count: expired.length }, 'Deleted expired disappearing messages');
    } catch (err) {
      logger.error(err, 'Message expiry job error');
    }
  }, CHECK_INTERVAL_MS);

  logger.info('Message expiry job started');
}
