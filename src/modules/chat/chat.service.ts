import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { NotFoundError, ForbiddenError } from '../../shared/errors';
import { isBlocked } from '../safety/safety.service';
import { getLimits } from '../../shared/usage.service';
import * as cloudinaryService from '../../shared/cloudinary.service';
import ogs from 'open-graph-scraper';

/**
 * Clean up media files from storage (Google Drive or Cloudinary).
 * Fire-and-forget — errors are silently swallowed.
 */
async function cleanupMediaUrls(urls: (string | null)[]): Promise<void> {
  const validUrls = urls.filter(Boolean) as string[];
  for (const url of validUrls) {
    if (url.includes('drive.google.com')) {
      const match = url.match(/id=([a-zA-Z0-9_-]+)/);
      if (match) {
        const { deleteFromDrive } = await import('../../shared/gdrive.service');
        deleteFromDrive(match[1]).catch(() => {});
      }
    } else if (url.includes('cloudinary.com')) {
      const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
      if (match) {
        const isAudio = url.includes('/video/') || url.endsWith('.m4a') || url.endsWith('.mp3');
        cloudinaryService.deleteFile(match[1], isAudio ? 'video' : 'image').catch(() => {});
      }
    }
  }
}

// ─── Link Preview ───────────────────────────────────────────

const urlRegex = /(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i;

async function fetchLinkPreview(messageId: string, content: string) {
  try {
    const match = content.match(urlRegex);
    if (!match) return;

    const rawUrl = match[0];
    const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;

    const { result } = await ogs({ url, timeout: 5000 });
    if (!result.success) return;

    const ogData: Record<string, string> = {};
    if (result.ogTitle) ogData.ogTitle = result.ogTitle;
    if (result.ogDescription) ogData.ogDescription = result.ogDescription.substring(0, 200);
    if (result.ogImage && result.ogImage.length > 0) {
      ogData.ogImage = (result.ogImage[0] as any).url ?? '';
    }
    if (result.ogSiteName) ogData.ogSiteName = result.ogSiteName;

    if (Object.keys(ogData).length === 0) return;

    // Merge with existing metadata
    const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { metadata: true } });
    const existing = (msg?.metadata as Record<string, any>) ?? {};

    await prisma.message.update({
      where: { id: messageId },
      data: { metadata: { ...existing, ...ogData } },
    });

    logger.debug({ messageId, ogTitle: ogData.ogTitle }, 'Link preview fetched');
  } catch (e) {
    logger.debug({ messageId, error: (e as Error).message }, 'Link preview fetch failed');
  }
}

/**
 * Compute delivery status for a message relative to the current user.
 * Messages from others are 'sent'; own messages are 'read' or 'delivered'
 * based on other participants' lastReadAt timestamps.
 */
function computeMessageStatus(
  msg: { senderId: string; createdAt: Date },
  userId: string,
  otherParticipants: { lastReadAt: Date | null; lastDeliveredAt: Date | null }[],
): 'sent' | 'delivered' | 'read' {
  if (msg.senderId !== userId) return 'sent';
  const isRead = otherParticipants.every(
    (p) => p.lastReadAt && p.lastReadAt >= msg.createdAt,
  );
  if (isRead) return 'read';
  const isDelivered = otherParticipants.some(
    (p) => p.lastDeliveredAt && p.lastDeliveredAt >= msg.createdAt,
  );
  return isDelivered ? 'delivered' : 'sent';
}

const messageInclude = {
  sender: {
    select: { id: true, displayName: true, avatarUrl: true },
  },
  replyTo: {
    select: {
      id: true,
      content: true,
      senderId: true,
      sender: { select: { displayName: true } },
    },
  },
  reactions: {
    select: {
      id: true,
      emoji: true,
      userId: true,
      user: { select: { displayName: true } },
    },
  },
};

/**
 * Verify that a user is a participant in a conversation.
 */
async function verifyParticipant(conversationId: string, userId: string) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: {
      conversationId_userId: { conversationId, userId },
    },
  });

  if (!participant) {
    throw new ForbiddenError('You are not a participant in this conversation');
  }

  if (participant.leftAt !== null) {
    throw new ForbiddenError('You have left this conversation');
  }

  return participant;
}

/**
 * Get a single conversation with its participants.
 */
export async function getConversation(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      participants: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true },
          },
        },
      },
    },
  });

  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }

  // Allow anyone to view GROUP conversations (they are publicly discoverable).
  // For non-group conversations, require the user to be a participant.
  if (conversation.type !== 'GROUP') {
    const isParticipant = conversation.participants.some((p) => p.userId === userId);
    if (!isParticipant) {
      throw new ForbiddenError('You are not a participant in this conversation');
    }
  }

  logger.debug({ conversationId, userId }, 'Fetched conversation');
  return conversation;
}

/**
 * List all conversations for a user, including the last message preview.
 */
export async function getConversations(userId: string) {
  const conversations = await prisma.conversation.findMany({
    where: {
      participants: {
        some: { userId, leftAt: null },
      },
    },
    include: {
      participants: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true },
          },
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          content: true,
          senderId: true,
          createdAt: true,
          isSystem: true,
          deletedAt: true,
          imageUrl: true,
          audioUrl: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  // Batch unread counts and missed calls instead of N+1 per-conversation queries
  const conversationIds = conversations.map((c) => c.id);

  // Build per-conversation lastReadAt lookup
  const lastReadAtMap = new Map<string, Date | null>();
  for (const c of conversations) {
    const myParticipant = c.participants.find((p) => p.userId === userId);
    lastReadAtMap.set(c.id, myParticipant?.lastReadAt ?? null);
  }

  // 1) Batch unread counts: one groupBy query for all conversations
  const unreadGroups = await prisma.message.groupBy({
    by: ['conversationId'],
    _count: { id: true },
    where: {
      conversationId: { in: conversationIds },
      senderId: { not: userId },
      deletedAt: null,
    },
  });

  // For conversations with a lastReadAt, we need a second groupBy with the createdAt filter.
  // Split into two sets: those with lastReadAt (need filtered count) and those without.
  const idsWithLastRead = conversationIds.filter((id) => lastReadAtMap.get(id) != null);

  let filteredUnreadMap = new Map<string, number>();
  if (idsWithLastRead.length > 0) {
    // For conversations with lastReadAt, count only messages after that timestamp.
    // We need per-conversation filtering, but we can still batch by fetching all unread
    // messages for these conversations and filtering in JS (much cheaper than N queries).
    // Use the earliest lastReadAt as a floor to avoid scanning the entire message history.
    const lastReadDates = idsWithLastRead
      .map((id) => lastReadAtMap.get(id))
      .filter((d): d is Date => d != null);
    const earliestLastRead = lastReadDates.length > 0
      ? new Date(Math.min(...lastReadDates.map((d) => d.getTime())))
      : undefined;

    const unreadMessages = await prisma.message.findMany({
      where: {
        conversationId: { in: idsWithLastRead },
        senderId: { not: userId },
        deletedAt: null,
        ...(earliestLastRead ? { createdAt: { gt: earliestLastRead } } : {}),
      },
      select: { conversationId: true, createdAt: true },
    });

    for (const msg of unreadMessages) {
      const lastRead = lastReadAtMap.get(msg.conversationId);
      if (lastRead && msg.createdAt > lastRead) {
        filteredUnreadMap.set(msg.conversationId, (filteredUnreadMap.get(msg.conversationId) ?? 0) + 1);
      }
    }
  }

  // For conversations without lastReadAt, use the groupBy totals
  const unreadCountMap = new Map<string, number>();
  for (const g of unreadGroups) {
    unreadCountMap.set(g.conversationId, g._count.id);
  }

  // 2) Batch missed calls: one query for all conversations (incoming missed only)
  const missedCalls = await prisma.callLog.findMany({
    where: {
      conversationId: { in: conversationIds },
      status: 'MISSED',
      initiatorId: { not: userId },
    },
    orderBy: { startedAt: 'desc' },
    select: { conversationId: true, callType: true, startedAt: true, initiator: { select: { displayName: true } } },
  });

  // Pick latest missed call per conversation
  const missedCallMap = new Map<string, typeof missedCalls[0]>();
  for (const call of missedCalls) {
    if (!missedCallMap.has(call.conversationId)) {
      missedCallMap.set(call.conversationId, call);
    }
  }

  // 2b) Batch latest call log (any status) per conversation
  const recentCalls = await prisma.callLog.findMany({
    where: {
      conversationId: { in: conversationIds },
    },
    orderBy: { startedAt: 'desc' },
    select: {
      conversationId: true,
      callType: true,
      status: true,
      startedAt: true,
      durationSecs: true,
      initiatorId: true,
      initiator: { select: { displayName: true } },
    },
  });

  // Pick latest call per conversation
  const lastCallMap = new Map<string, typeof recentCalls[0]>();
  for (const call of recentCalls) {
    if (!lastCallMap.has(call.conversationId)) {
      lastCallMap.set(call.conversationId, call);
    }
  }

  // 3) Assemble results
  const results = conversations.map((c) => {
    const hasLastRead = lastReadAtMap.get(c.id) != null;
    const unreadCount = hasLastRead
      ? (filteredUnreadMap.get(c.id) ?? 0)
      : (unreadCountMap.get(c.id) ?? 0);

    const missedCall = missedCallMap.get(c.id) ?? null;
    const lastMissedCall = missedCall
      ? { callType: missedCall.callType, startedAt: missedCall.startedAt, initiator: missedCall.initiator }
      : null;

    const recentCall = lastCallMap.get(c.id) ?? null;
    const lastCallLog = recentCall
      ? {
          callType: recentCall.callType,
          status: recentCall.status,
          startedAt: recentCall.startedAt,
          durationSecs: recentCall.durationSecs,
          initiatorId: recentCall.initiatorId,
          initiator: recentCall.initiator,
        }
      : null;

    // Compute delivery status for last message
    const rawLast = c.messages[0] || null;
    let lastMessage = rawLast;
    if (rawLast) {
      const otherParticipants = c.participants.filter((p) => p.userId !== userId);
      const status = computeMessageStatus(rawLast, userId, otherParticipants);
      lastMessage = Object.assign({}, rawLast, { status });
    }

    return {
      ...c,
      lastMessage,
      messages: undefined,
      unreadCount,
      lastMissedCall,
      lastCallLog,
    };
  });

  logger.debug({ userId, count: results.length }, 'Listed conversations');
  return results;
}

/**
 * Mark all messages in a conversation as read for a user.
 */
export async function markConversationAsRead(conversationId: string, userId: string) {
  await verifyParticipant(conversationId, userId);

  const now = new Date();
  // Only update if new timestamp is newer — prevents race condition
  // where out-of-order requests could regress lastReadAt.
  await prisma.conversationParticipant.updateMany({
    where: {
      conversationId,
      userId,
      OR: [
        { lastReadAt: null },
        { lastReadAt: { lt: now } },
      ],
    },
    data: { lastReadAt: now },
  });

  logger.debug({ conversationId, userId }, 'Conversation marked as read');
}

/**
 * Get or create a direct 1-on-1 conversation between two users.
 */
export async function getOrCreateDirectConversation(userId: string, targetUserId: string) {
  if (userId === targetUserId) {
    throw new ForbiddenError('Cannot create a conversation with yourself');
  }

  // Check if either user has blocked the other
  const blocked = await isBlocked(userId, targetUserId);
  if (blocked) {
    throw new ForbiddenError('Cannot message this user');
  }

  const existing = await prisma.conversation.findFirst({
    where: {
      type: 'HUMAN_MATCHED',
      status: 'ACTIVE',
      AND: [
        { participants: { some: { userId } } },
        { participants: { some: { userId: targetUserId } } },
      ],
    },
    include: {
      participants: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true },
          },
        },
      },
    },
  });

  if (existing) {
    logger.debug({ conversationId: existing.id, userId, targetUserId }, 'Found existing direct conversation');
    return existing;
  }

  const conversation = await prisma.conversation.create({
    data: {
      type: 'HUMAN_MATCHED',
      status: 'ACTIVE',
      participants: {
        create: [
          { userId },
          { userId: targetUserId },
        ],
      },
    },
    include: {
      participants: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true },
          },
        },
      },
    },
  });

  logger.info({ conversationId: conversation.id, userId, targetUserId }, 'Created direct conversation');
  return conversation;
}

/**
 * Send a message in a conversation.
 */
export async function sendMessage(
  conversationId: string,
  senderId: string,
  content: string,
  options?: {
    replyToId?: string;
    imageUrl?: string;
    viewOnce?: boolean;
    audioUrl?: string;
    audioDuration?: number;
    metadata?: Record<string, any>;
  },
) {
  const { replyToId, imageUrl, viewOnce, audioUrl, audioDuration, metadata } = options ?? {};

  // Run conversation lookup and participant verification in parallel
  const [conversation, participant] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: conversationId } }),
    prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: senderId } },
    }),
  ]);

  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }
  if (conversation.status !== 'ACTIVE') {
    throw new ForbiddenError('Conversation is no longer active');
  }
  if (!participant) {
    throw new ForbiddenError('You are not a participant in this conversation');
  }
  if (participant.leftAt !== null) {
    throw new ForbiddenError('You have left this conversation');
  }

  // Run block check and reply verification in parallel
  const parallelChecks: Promise<void>[] = [];

  if (conversation.type !== 'GROUP') {
    parallelChecks.push(
      prisma.conversationParticipant.findMany({
        where: { conversationId, leftAt: null },
        select: { userId: true },
      }).then(async (participants) => {
        const partnerId = participants.find((p) => p.userId !== senderId)?.userId;
        if (partnerId) {
          const blocked = await isBlocked(senderId, partnerId);
          if (blocked) {
            throw new ForbiddenError('Cannot message this user');
          }
        }
      }),
    );
  }

  if (replyToId) {
    parallelChecks.push(
      prisma.message.findFirst({
        where: { id: replyToId, conversationId },
      }).then((replyTarget) => {
        if (!replyTarget) {
          throw new NotFoundError('Reply target message not found');
        }
      }),
    );
  }

  if (parallelChecks.length > 0) {
    await Promise.all(parallelChecks);
  }

  // Create message and update conversation timestamp in parallel
  const [message] = await Promise.all([
    prisma.message.create({
      data: {
        conversationId,
        senderId,
        content,
        replyToId: replyToId || undefined,
        imageUrl: imageUrl || undefined,
        viewOnce: viewOnce || false,
        audioUrl: audioUrl || undefined,
        audioDuration: audioDuration ?? undefined,
        metadata: metadata ?? undefined,
      },
      include: messageInclude,
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    }),
  ]);

  logger.debug({ conversationId, senderId, messageId: message.id }, 'Message sent');

  // Auto-unarchive: when a new message arrives, unarchive for all other participants
  prisma.conversationParticipant.updateMany({
    where: {
      conversationId,
      userId: { not: senderId },
      isArchived: true,
    },
    data: { isArchived: false },
  }).catch((err) => {
    logger.error({ err, conversationId }, 'Failed to auto-unarchive participants');
  });

  // Async: fetch link preview if message contains a URL (fire-and-forget)
  if (content && urlRegex.test(content)) {
    fetchLinkPreview(message.id, content).catch(() => {});
  }

  return message;
}

/**
 * Edit a message. Only the sender can edit.
 */
export async function editMessage(messageId: string, userId: string, content: string) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });

  if (!message) {
    throw new NotFoundError('Message not found');
  }

  if (message.senderId !== userId) {
    throw new ForbiddenError('You can only edit your own messages');
  }

  if (message.deletedAt) {
    throw new ForbiddenError('Cannot edit a deleted message');
  }

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { content, editedAt: new Date() },
    include: messageInclude,
  });

  logger.debug({ messageId, userId }, 'Message edited');
  return updated;
}

/**
 * Soft-delete a message. Only the sender can delete.
 */
export async function deleteMessage(messageId: string, userId: string) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });

  if (!message) {
    throw new NotFoundError('Message not found');
  }

  if (message.senderId !== userId) {
    throw new ForbiddenError('You can only delete your own messages');
  }

  if (message.deletedAt) {
    throw new ForbiddenError('Message is already deleted');
  }

  await cleanupMediaUrls([message.imageUrl, message.audioUrl]);

  const [updated] = await prisma.$transaction([
    prisma.message.update({
      where: { id: messageId },
      data: { content: '', imageUrl: null, audioUrl: null, deletedAt: new Date() },
      include: messageInclude,
    }),
    // Clean up reactions on deleted messages
    prisma.messageReaction.deleteMany({ where: { messageId } }),
  ]);

  logger.debug({ messageId, userId }, 'Message deleted');
  return updated;
}

/**
 * Pin or unpin a message. Any participant can pin/unpin.
 */
export async function togglePinMessage(messageId: string, userId: string) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) throw new NotFoundError('Message not found');
  if (message.deletedAt) throw new ForbiddenError('Cannot pin a deleted message');

  // Verify user is an active participant (checks leftAt too)
  await verifyParticipant(message.conversationId, userId);

  const newPinned = !message.isPinned;
  const updated = await prisma.message.update({
    where: { id: messageId },
    data: {
      isPinned: newPinned,
      pinnedAt: newPinned ? new Date() : null,
      pinnedById: newPinned ? userId : null,
    },
    include: messageInclude,
  });

  logger.debug({ messageId, userId, isPinned: newPinned }, 'Message pin toggled');
  return updated;
}

/**
 * Get pinned messages for a conversation.
 */
export async function getPinnedMessages(conversationId: string, userId: string) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!participant) throw new ForbiddenError('You are not a participant in this conversation');

  return prisma.message.findMany({
    where: { conversationId, isPinned: true, deletedAt: null },
    include: messageInclude,
    orderBy: { pinnedAt: 'desc' },
  });
}

/**
 * Mark a view-once message as opened. Only the recipient (non-sender) can open.
 */
export async function openViewOnce(messageId: string, userId: string) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });

  if (!message) {
    throw new NotFoundError('Message not found');
  }

  if (!message.viewOnce) {
    throw new ForbiddenError('This is not a view-once message');
  }

  // Verify participant first — reject unauthorized users before leaking info
  await verifyParticipant(message.conversationId, userId);

  if (message.senderId === userId) {
    throw new ForbiddenError('Sender cannot open their own view-once message');
  }

  if (message.viewOnceOpened) {
    throw new ForbiddenError('This message has already been opened');
  }

  await cleanupMediaUrls([message.imageUrl, message.audioUrl]);

  // Mark as opened and wipe content/media from database
  const updated = await prisma.message.update({
    where: { id: messageId },
    data: {
      viewOnceOpened: true,
      content: '',
      imageUrl: null,
      audioUrl: null,
    },
  });

  logger.debug({ messageId, userId }, 'View-once message opened and content deleted');
  return { messageId: updated.id, conversationId: updated.conversationId };
}

/**
 * Toggle a reaction on a message. Creates if missing, deletes if exists.
 */
export async function toggleReaction(messageId: string, userId: string, emoji: string) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });

  if (!message) {
    throw new NotFoundError('Message not found');
  }

  // Verify user is a participant in the conversation
  await verifyParticipant(message.conversationId, userId);

  const existing = await prisma.messageReaction.findUnique({
    where: {
      messageId_userId_emoji: { messageId, userId, emoji },
    },
  });

  if (existing) {
    await prisma.messageReaction.delete({ where: { id: existing.id } });
    logger.debug({ messageId, userId, emoji, action: 'removed' }, 'Reaction toggled');
    return { action: 'removed' as const, emoji, userId, messageId, conversationId: message.conversationId };
  }

  const reaction = await prisma.messageReaction.create({
    data: { messageId, userId, emoji },
    include: { user: { select: { displayName: true } } },
  });

  logger.debug({ messageId, userId, emoji, action: 'added' }, 'Reaction toggled');
  return { action: 'added' as const, emoji, userId, messageId, conversationId: message.conversationId, displayName: reaction.user.displayName };
}

/**
 * End a conversation.
 */
export async function endConversation(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });

  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }

  if (conversation.status === 'ENDED') {
    throw new ForbiddenError('Conversation is already ended');
  }

  await verifyParticipant(conversationId, userId);

  const [updatedConversation] = await prisma.$transaction([
    prisma.conversation.update({
      where: { id: conversationId },
      data: { status: 'ENDED' },
    }),
    prisma.conversationParticipant.update({
      where: {
        conversationId_userId: { conversationId, userId },
      },
      data: { leftAt: new Date() },
    }),
  ]);

  logger.info({ conversationId, userId }, 'Conversation ended');
  return updatedConversation;
}

/**
 * List all active GROUP conversations, visible to any authenticated user.
 * Includes participant count and whether the requesting user is a member.
 */
export async function getAllGroups(userId: string, limit = 100) {
  const groups = await prisma.conversation.findMany({
    where: {
      type: 'GROUP',
      status: 'ACTIVE',
      isPublic: true,
    },
    include: {
      participants: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true },
          },
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });

  const results = groups.map((g) => {
    const activeParticipants = g.participants.filter((p) => p.leftAt == null);
    const isMember = activeParticipants.some((p) => p.userId === userId);
    return {
      ...g,
      memberCount: activeParticipants.length,
      isMember,
    };
  });

  logger.debug({ userId, count: results.length }, 'Listed all public groups');
  return results;
}

/**
 * Get paginated messages for a conversation.
 * Supports cursor-based pagination (preferred) and offset-based (legacy).
 * Computes read/delivered status for the current user's sent messages.
 */
export async function getMessages(
  conversationId: string,
  userId: string,
  page = 1,
  limit = 50,
  cursor?: string,
) {
  await verifyParticipant(conversationId, userId);

  // Build query: cursor-based if cursor provided, offset-based otherwise
  const whereClause: any = { conversationId };
  let skip: number | undefined;

  if (cursor) {
    // Cursor is a message ID — fetch messages older than it
    const cursorMsg = await prisma.message.findUnique({
      where: { id: cursor },
      select: { createdAt: true },
    });
    if (cursorMsg) {
      whereClause.createdAt = { lt: cursorMsg.createdAt };
    }
  } else {
    skip = (page - 1) * limit;
  }

  const [messages, participants] = await Promise.all([
    prisma.message.findMany({
      where: whereClause,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(skip !== undefined ? { skip } : {}),
      take: limit + 1, // Fetch one extra to determine hasMore
      include: messageInclude,
    }),
    prisma.conversationParticipant.findMany({
      where: { conversationId, userId: { not: userId }, leftAt: null },
      select: { lastReadAt: true, lastDeliveredAt: true },
    }),
  ]);

  const hasMore = messages.length > limit;
  const trimmed = hasMore ? messages.slice(0, limit) : messages;

  // Compute message status for messages sent by the current user
  const data = trimmed.map((msg) => ({
    ...msg,
    status: computeMessageStatus(msg, userId, participants),
  }));

  const nextCursor = hasMore && trimmed.length > 0 ? trimmed[trimmed.length - 1].id : null;

  logger.debug({ conversationId, userId, page, limit, cursor, hasMore }, 'Fetched messages');

  return {
    data,
    page,
    limit,
    hasMore,
    nextCursor,
  };
}

/**
 * Toggle pin status for a conversation participant.
 */
export async function togglePin(userId: string, conversationId: string) {
  const participant = await verifyParticipant(conversationId, userId);

  // Enforce pinned chat limit when pinning (not unpinning)
  if (!participant.isPinned) {
    const limits = await getLimits(userId);
    const pinnedCount = await prisma.conversationParticipant.count({
      where: { userId, isPinned: true, leftAt: null },
    });
    if (pinnedCount >= limits.pinnedChats) {
      throw new ForbiddenError(`Pinned chat limit reached (max ${limits.pinnedChats}). Upgrade to Pro for more.`);
    }
  }

  const updated = await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { isPinned: !participant.isPinned },
    select: { isPinned: true },
  });

  logger.debug({ conversationId, userId, isPinned: updated.isPinned }, 'Pin toggled');
  return updated;
}

/**
 * Toggle mute status for a conversation participant.
 */
export async function toggleMute(userId: string, conversationId: string) {
  const participant = await verifyParticipant(conversationId, userId);

  const updated = await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { isMuted: !participant.isMuted },
    select: { isMuted: true },
  });

  logger.debug({ conversationId, userId, isMuted: updated.isMuted }, 'Mute toggled');
  return updated;
}

/**
 * Toggle archive status for a conversation participant.
 */
export async function toggleArchive(userId: string, conversationId: string) {
  const participant = await verifyParticipant(conversationId, userId);

  const updated = await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { isArchived: !participant.isArchived },
    select: { isArchived: true },
  });

  logger.debug({ conversationId, userId, isArchived: updated.isArchived }, 'Archive toggled');
  return updated;
}

// ─── Forward Message ──────────────────────────────────────────

/**
 * Forward a message to another conversation.
 * Creates a new message in the target conversation with the original content.
 */
export async function forwardMessage(
  messageId: string,
  targetConversationId: string,
  senderId: string,
) {
  // Verify source message exists
  const original = await prisma.message.findUnique({
    where: { id: messageId },
    select: { content: true, imageUrl: true, audioUrl: true, audioDuration: true },
  });
  if (!original) throw new NotFoundError('Message not found');

  // Verify sender is participant in target conversation
  await verifyParticipant(targetConversationId, senderId);

  // Create forwarded message with metadata marking it as forwarded
  const forwarded = await sendMessage(targetConversationId, senderId, original.content ?? '', {
    imageUrl: original.imageUrl ?? undefined,
    audioUrl: original.audioUrl ?? undefined,
    audioDuration: original.audioDuration ?? undefined,
    metadata: { isForwarded: true },
  });

  logger.info({ messageId, targetConversationId, senderId }, 'Message forwarded');
  return forwarded;
}

// ─── Search Messages ──────────────────────────────────────────

/**
 * Search messages within a conversation by text content.
 */
export async function searchMessages(
  conversationId: string,
  userId: string,
  query: string,
) {
  await verifyParticipant(conversationId, userId);

  const messages = await prisma.message.findMany({
    where: {
      conversationId,
      deletedAt: null,
      content: { contains: query, mode: 'insensitive' },
    },
    include: messageInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
  });

  return messages;
}

// ─── Clear Chat History ───────────────────────────────────────

/**
 * Clear chat history for a user — soft-deletes all messages they sent
 * and marks their lastReadAt to now so old messages don't show as unread.
 */
export async function clearHistory(conversationId: string, userId: string) {
  await verifyParticipant(conversationId, userId);

  // Update lastReadAt so cleared messages don't count as unread
  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { lastReadAt: new Date() },
  });

  logger.info({ conversationId, userId }, 'Chat history cleared');
}
