import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { NotFoundError, ForbiddenError } from '../../shared/errors';

/**
 * Create a GROUP conversation with the creator as ADMIN.
 */
export async function createGroup(
  creatorId: string,
  name: string,
  memberIds: string[],
  avatarUrl?: string,
) {
  // Ensure creator is not in memberIds (they're added separately as ADMIN)
  const uniqueMembers = [...new Set(memberIds.filter((id) => id !== creatorId))];

  const conversation = await prisma.conversation.create({
    data: {
      type: 'GROUP',
      status: 'ACTIVE',
      name,
      avatarUrl: avatarUrl || null,
      participants: {
        create: [
          { userId: creatorId, role: 'ADMIN' },
          ...uniqueMembers.map((userId) => ({ userId, role: 'MEMBER' as const })),
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

  logger.info({ conversationId: conversation.id, creatorId, memberCount: uniqueMembers.length + 1 }, 'Group created');
  return conversation;
}

/**
 * Update group name/avatar. Admin only.
 */
export async function updateGroup(
  conversationId: string,
  userId: string,
  updates: { name?: string; avatarUrl?: string },
) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });

  if (!participant) {
    throw new ForbiddenError('You are not a participant in this conversation');
  }
  if (participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only admins can update group settings');
  }

  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.avatarUrl !== undefined ? { avatarUrl: updates.avatarUrl } : {}),
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

  logger.info({ conversationId, userId, updates }, 'Group updated');
  return conversation;
}

/**
 * Add members to a group. Admin only.
 */
export async function addMembers(
  conversationId: string,
  adminId: string,
  memberIds: string[],
) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId: adminId } },
  });

  if (!participant) {
    throw new ForbiddenError('You are not a participant in this conversation');
  }
  if (participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only admins can add members');
  }

  // Filter out users already in the conversation
  const existing = await prisma.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true },
  });
  const existingIds = new Set(existing.map((e) => e.userId));
  const newMembers = memberIds.filter((id) => !existingIds.has(id));

  if (newMembers.length > 0) {
    await prisma.conversationParticipant.createMany({
      data: newMembers.map((userId) => ({
        conversationId,
        userId,
        role: 'MEMBER' as const,
      })),
    });
  }

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

  logger.info({ conversationId, adminId, added: newMembers }, 'Members added to group');
  return conversation;
}

/**
 * Remove a member from a group. Admin can remove anyone, members can leave themselves.
 */
export async function removeMember(
  conversationId: string,
  requesterId: string,
  targetUserId: string,
) {
  const requester = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId: requesterId } },
  });

  if (!requester) {
    throw new ForbiddenError('You are not a participant in this conversation');
  }

  // Allow self-leave or admin removing others
  if (requesterId !== targetUserId && requester.role !== 'ADMIN') {
    throw new ForbiddenError('Only admins can remove other members');
  }

  const target = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
  });

  if (!target) {
    throw new NotFoundError('Target user is not in this conversation');
  }

  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
    data: { leftAt: new Date() },
  });

  logger.info({ conversationId, requesterId, targetUserId }, 'Member removed from group');
  return { conversationId, removedUserId: targetUserId };
}
