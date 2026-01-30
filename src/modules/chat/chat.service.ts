import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { NotFoundError, ForbiddenError } from '../../shared/errors';

/**
 * Verify that a user is a participant in a conversation.
 * Returns the participant record or throws ForbiddenError.
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
 * Verifies the requesting user is a participant.
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
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  logger.debug({ userId, count: conversations.length }, 'Listed conversations');
  return conversations.map((c) => ({
    ...c,
    lastMessage: c.messages[0] || null,
    messages: undefined,
  }));
}

/**
 * Get or create a direct 1-on-1 conversation between two users.
 */
export async function getOrCreateDirectConversation(userId: string, targetUserId: string) {
  if (userId === targetUserId) {
    throw new ForbiddenError('Cannot create a conversation with yourself');
  }

  // Check if a 1-on-1 conversation already exists between the two users
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

  // Create new conversation with both participants
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
 * Verifies the sender is a participant and the conversation is ACTIVE.
 */
export async function sendMessage(conversationId: string, senderId: string, content: string) {
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

  const message = await prisma.message.create({
    data: {
      conversationId,
      senderId,
      content,
    },
    include: {
      sender: {
        select: { id: true, displayName: true },
      },
    },
  });

  // Touch the conversation's updatedAt
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });

  logger.debug({ conversationId, senderId, messageId: message.id }, 'Message sent');
  return message;
}

/**
 * End a conversation. Sets status to ENDED and records the user's leftAt timestamp.
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
 * Verifies the requesting user is a participant.
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
      include: {
        sender: {
          select: { id: true, displayName: true },
        },
      },
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
