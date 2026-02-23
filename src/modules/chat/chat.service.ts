import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { NotFoundError, ForbiddenError } from '../../shared/errors';
import { isBlocked } from '../safety/safety.service';

/**
 * Compute delivery status for a message relative to the current user.
 * Messages from others are 'sent'; own messages are 'read' or 'delivered'
 * based on other participants' lastReadAt timestamps.
 */
function computeMessageStatus(
  msg: { senderId: string; createdAt: Date },
  userId: string,
  otherParticipants: { lastReadAt: Date | null }[],
): 'sent' | 'delivered' | 'read' {
  if (msg.senderId !== userId) return 'sent';
  const isRead = otherParticipants.some(
    (p) => p.lastReadAt && p.lastReadAt >= msg.createdAt,
  );
  return isRead ? 'read' : 'delivered';
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
        some: { userId },
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
    const unreadMessages = await prisma.message.findMany({
      where: {
        conversationId: { in: idsWithLastRead },
        senderId: { not: userId },
        deletedAt: null,
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

  // 2) Batch missed calls: one query for all conversations
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

  await prisma.conversationParticipant.update({
    where: {
      conversationId_userId: { conversationId, userId },
    },
    data: { lastReadAt: new Date() },
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
  },
) {
  const { replyToId, imageUrl, viewOnce, audioUrl, audioDuration } = options ?? {};

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
      },
      include: messageInclude,
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    }),
  ]);

  logger.debug({ conversationId, senderId, messageId: message.id }, 'Message sent');
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

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { content: '', deletedAt: new Date() },
    include: messageInclude,
  });

  logger.debug({ messageId, userId }, 'Message deleted');
  return updated;
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

  if (message.senderId === userId) {
    throw new ForbiddenError('Sender cannot open their own view-once message');
  }

  if (message.viewOnceOpened) {
    throw new ForbiddenError('This message has already been opened');
  }

  await verifyParticipant(message.conversationId, userId);

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { viewOnceOpened: true },
  });

  logger.debug({ messageId, userId }, 'View-once message opened');
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
    return { action: 'removed' as const, emoji, userId, messageId };
  }

  const reaction = await prisma.messageReaction.create({
    data: { messageId, userId, emoji },
    include: { user: { select: { displayName: true } } },
  });

  logger.debug({ messageId, userId, emoji, action: 'added' }, 'Reaction toggled');
  return { action: 'added' as const, emoji, userId, messageId, displayName: reaction.user.displayName };
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
export async function getAllGroups(userId: string) {
  const groups = await prisma.conversation.findMany({
    where: {
      type: 'GROUP',
      status: 'ACTIVE',
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
 * Computes read/delivered status for the current user's sent messages
 * based on other participants' lastReadAt timestamps.
 */
export async function getMessages(
  conversationId: string,
  userId: string,
  page = 1,
  limit = 50,
) {
  await verifyParticipant(conversationId, userId);

  const skip = (page - 1) * limit;

  const [messages, total, participants] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: messageInclude,
    }),
    prisma.message.count({ where: { conversationId } }),
    prisma.conversationParticipant.findMany({
      where: { conversationId, userId: { not: userId }, leftAt: null },
      select: { lastReadAt: true },
    }),
  ]);

  // Compute message status for messages sent by the current user
  const data = messages.map((msg) => ({
    ...msg,
    status: computeMessageStatus(msg, userId, participants),
  }));

  logger.debug({ conversationId, userId, page, limit, total }, 'Fetched messages');

  return {
    data,
    total,
    page,
    limit,
    hasMore: skip + messages.length < total,
  };
}

/**
 * Toggle pin status for a conversation participant.
 */
export async function togglePin(userId: string, conversationId: string) {
  const participant = await verifyParticipant(conversationId, userId);

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
