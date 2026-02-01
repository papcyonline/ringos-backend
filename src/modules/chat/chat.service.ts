import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { NotFoundError, ForbiddenError } from '../../shared/errors';

const messageInclude = {
  sender: {
    select: { id: true, displayName: true },
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
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true },
          },
        },
      },
    },
  });

  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }

  const isParticipant = conversation.participants.some((p) => p.userId === userId);
  if (!isParticipant) {
    throw new ForbiddenError('You are not a participant in this conversation');
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
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true },
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
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  // Compute unread counts and last missed calls per conversation
  const results = await Promise.all(
    conversations.map(async (c) => {
      const myParticipant = c.participants.find((p) => p.userId === userId);
      const lastReadAt = myParticipant?.lastReadAt;

      // Unread count: messages after lastReadAt not sent by me
      const unreadCount = await prisma.message.count({
        where: {
          conversationId: c.id,
          senderId: { not: userId },
          deletedAt: null,
          ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
        },
      });

      // Last missed call where user is NOT the initiator
      const lastMissedCall = await prisma.callLog.findFirst({
        where: {
          conversationId: c.id,
          status: 'MISSED',
          initiatorId: { not: userId },
        },
        orderBy: { startedAt: 'desc' },
        select: { callType: true, startedAt: true },
      });

      return {
        ...c,
        lastMessage: c.messages[0] || null,
        messages: undefined,
        unreadCount,
        lastMissedCall,
      };
    }),
  );

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
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true },
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
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true },
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
  replyToId?: string,
  imageUrl?: string,
  viewOnce?: boolean,
) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });

  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }

  if (conversation.status !== 'ACTIVE') {
    throw new ForbiddenError('Conversation is no longer active');
  }

  await verifyParticipant(conversationId, senderId);

  // Verify the reply target exists in this conversation
  if (replyToId) {
    const replyTarget = await prisma.message.findFirst({
      where: { id: replyToId, conversationId },
    });
    if (!replyTarget) {
      throw new NotFoundError('Reply target message not found');
    }
  }

  const message = await prisma.message.create({
    data: {
      conversationId,
      senderId,
      content,
      replyToId: replyToId || undefined,
      imageUrl: imageUrl || undefined,
      viewOnce: viewOnce || false,
    },
    include: messageInclude,
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });

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
 * Get paginated messages for a conversation.
 */
export async function getMessages(
  conversationId: string,
  userId: string,
  page = 1,
  limit = 50,
) {
  await verifyParticipant(conversationId, userId);

  const skip = (page - 1) * limit;

  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: messageInclude,
    }),
    prisma.message.count({ where: { conversationId } }),
  ]);

  logger.debug({ conversationId, userId, page, limit, total }, 'Fetched messages');

  return {
    data: messages,
    total,
    page,
    limit,
    hasMore: skip + messages.length < total,
  };
}
