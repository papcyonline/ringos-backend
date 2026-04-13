import crypto from 'crypto';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { NotFoundError, ForbiddenError, ConflictError } from '../../shared/errors';
import { isPro } from '../../shared/usage.service';

/**
 * Verify that a user is an admin in a conversation. Throws if not.
 */
async function verifyAdmin(conversationId: string, userId: string) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!participant || participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only admins can perform this action');
  }
  return participant;
}

/**
 * Create a GROUP conversation with the creator as ADMIN.
 */
export async function createGroup(
  creatorId: string,
  name: string,
  memberIds: string[],
  avatarUrl?: string,
  description?: string,
  isPublic?: boolean,
  isChannel?: boolean,
) {
  // Free users can only create 1 channel
  if (isChannel) {
    const pro = await isPro(creatorId);
    if (!pro) {
      const channelCount = await prisma.conversation.count({
        where: {
          type: 'GROUP',
          isChannel: true,
          status: 'ACTIVE',
          participants: { some: { userId: creatorId, role: 'ADMIN', leftAt: null } },
        },
      });
      if (channelCount >= 1) {
        throw new ForbiddenError('Free users can create 1 channel. Upgrade to Pro for unlimited channels.');
      }
    }
  }

  // Check name uniqueness for active groups/channels
  const existing = await prisma.conversation.findFirst({
    where: {
      type: 'GROUP',
      status: 'ACTIVE',
      name: { equals: name, mode: 'insensitive' },
      ...(isChannel ? { isChannel: true } : { isChannel: false }),
    },
  });
  if (existing) {
    throw new ConflictError(
      isChannel ? 'A channel with this name already exists' : 'A group with this name already exists',
    );
  }

  // Ensure creator is not in memberIds (they're added separately as ADMIN)
  const uniqueMembers = [...new Set(memberIds.filter((id) => id !== creatorId))];

  // Auto-verify channel if creator is a verified user
  let autoVerify = false;
  if (isChannel) {
    const creator = await prisma.user.findUnique({ where: { id: creatorId }, select: { isVerified: true } });
    autoVerify = creator?.isVerified ?? false;
  }

  const conversation = await prisma.conversation.create({
    data: {
      type: 'GROUP',
      status: 'ACTIVE',
      name,
      description: description || null,
      avatarUrl: avatarUrl || null,
      isPublic: isPublic !== undefined ? isPublic : true,
      // Channels default to admins-only messaging and public
      isChannel: isChannel ?? false,
      isVerified: autoVerify,
      adminsOnlyMessages: isChannel ?? false,
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
  updates: {
    name?: string; avatarUrl?: string; description?: string; isPublic?: boolean;
    category?: string; contactEmail?: string; contactPhone?: string;
    websiteUrl?: string; location?: string; operatingHours?: string; bannerUrl?: string;
    pinnedPostId?: string | null;
  },
) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });

  if (!participant || participant.leftAt !== null) {
    throw new ForbiddenError('You are not a participant in this conversation');
  }

  if (participant.role !== 'ADMIN') {
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { adminsOnlyEditInfo: true } });
    if (conv?.adminsOnlyEditInfo) {
      throw new ForbiddenError('Only admins can update group info');
    }
  }

  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { status: true } });
  if (!conv || conv.status !== 'ACTIVE') {
    throw new ForbiddenError('This group is no longer active');
  }

  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.description !== undefined ? { description: updates.description } : {}),
      ...(updates.avatarUrl !== undefined ? { avatarUrl: updates.avatarUrl } : {}),
      ...(updates.isPublic !== undefined ? { isPublic: updates.isPublic } : {}),
      ...(updates.category !== undefined ? { category: updates.category } : {}),
      ...(updates.contactEmail !== undefined ? { contactEmail: updates.contactEmail } : {}),
      ...(updates.contactPhone !== undefined ? { contactPhone: updates.contactPhone } : {}),
      ...(updates.websiteUrl !== undefined ? { websiteUrl: updates.websiteUrl } : {}),
      ...(updates.location !== undefined ? { location: updates.location } : {}),
      ...(updates.operatingHours !== undefined ? { operatingHours: updates.operatingHours } : {}),
      ...(updates.bannerUrl !== undefined ? { bannerUrl: updates.bannerUrl } : {}),
      ...(updates.pinnedPostId !== undefined ? { pinnedPostId: updates.pinnedPostId } : {}),
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
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { adminsOnlyAddMembers: true } });
    if (conv?.adminsOnlyAddMembers) {
      throw new ForbiddenError('Only admins can add members');
    }
  }

  // Find existing participants (both active and those who left)
  const existing = await prisma.conversationParticipant.findMany({
    where: { conversationId, userId: { in: memberIds } },
    select: { userId: true, leftAt: true },
  });
  const existingMap = new Map(existing.map((e) => [e.userId, e]));

  // Members who previously left — re-add by clearing leftAt
  const rejoining = memberIds.filter((id) => existingMap.get(id)?.leftAt != null);
  if (rejoining.length > 0) {
    await prisma.conversationParticipant.updateMany({
      where: { conversationId, userId: { in: rejoining } },
      data: { leftAt: null, joinedAt: new Date() },
    });
  }

  // Truly new members who never joined before
  const newMembers = memberIds.filter((id) => !existingMap.has(id));
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

/**
 * Delete a group/channel permanently. Admin only.
 * For channels: deletes all posts, media, participants, messages, then the conversation.
 * For groups: soft-deletes (status ENDED) to preserve chat history.
 */
export async function deleteGroup(conversationId: string, userId: string) {
  await verifyAdmin(conversationId, userId);

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });

  if (!conversation || conversation.type !== 'GROUP') {
    throw new NotFoundError('Group not found');
  }

  if (conversation.isChannel) {
    // Channel: hard delete everything
    // 1. Collect media file references for cleanup
    const postMedia = await prisma.postMedia.findMany({
      where: { post: { channelId: conversationId } },
      select: { cloudinaryId: true, url: true },
    });

    // 2. Delete the conversation (cascades: participants, messages, posts, stories)
    await prisma.conversation.delete({ where: { id: conversationId } });

    // 3. Clean up external media storage (fire-and-forget)
    _cleanupChannelMedia(postMedia, conversation.avatarUrl, conversation.bannerUrl).catch((err) =>
      logger.error({ err, conversationId }, 'Failed to clean up channel media'));

    logger.info({ conversationId, userId, type: 'channel' }, 'Channel permanently deleted');
  } else {
    // Group: soft delete to preserve history
    const now = new Date();
    await prisma.$transaction([
      prisma.conversation.update({
        where: { id: conversationId },
        data: { status: 'ENDED' },
      }),
      prisma.conversationParticipant.updateMany({
        where: { conversationId, leftAt: null },
        data: { leftAt: now },
      }),
    ]);
    logger.info({ conversationId, userId, type: 'group' }, 'Group soft-deleted');
  }

  return { conversationId, deleted: true };
}


/**
 * Self-join a group conversation. Any user can join any active group.
 */
export async function joinGroup(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });

  if (!conversation || conversation.type !== 'GROUP') {
    throw new NotFoundError('Group not found');
  }

  if (conversation.status !== 'ACTIVE') {
    throw new ForbiddenError('This group is no longer active');
  }

  // Private groups can only be joined via explicit invite (addMembers)
  if (!conversation.isPublic) {
    throw new ForbiddenError('This is a private group. You must be invited to join.');
  }

  // Check if user is banned
  const existing = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (existing?.bannedAt) {
    throw new ForbiddenError('You have been banned from this group');
  }

  // Upsert to prevent race condition on concurrent join requests
  await prisma.conversationParticipant.upsert({
    where: { conversationId_userId: { conversationId, userId } },
    create: { conversationId, userId, role: 'MEMBER' },
    update: { leftAt: null, joinedAt: new Date() },
  });

  const updated = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      participants: {
        where: { leftAt: null },
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true },
          },
        },
      },
    },
  });

  logger.info({ conversationId, userId }, 'User joined group');
  return updated;
}

/**
 * Toggle isVerified on a group conversation. Admin only.
 */
export async function toggleGroupVerified(conversationId: string, userId: string) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });

  if (!participant) {
    throw new ForbiddenError('You are not a participant in this conversation');
  }
  if (participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only admins can toggle group verification');
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });

  if (!conversation || conversation.type !== 'GROUP') {
    throw new NotFoundError('Group not found');
  }

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { isVerified: !conversation.isVerified },
    include: {
      participants: {
        where: { leftAt: null },
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true },
          },
        },
      },
    },
  });

  logger.info({ conversationId, userId, isVerified: updated.isVerified }, 'Group verified status toggled');
  return updated;
}

/**
 * Update call/video settings for a group. Admin only.
 */
export async function updateGroupCallSettings(
  conversationId: string,
  userId: string,
  settings: { callsEnabled?: boolean; videoEnabled?: boolean },
) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });

  if (!participant) {
    throw new ForbiddenError('You are not a participant in this conversation');
  }
  if (participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only admins can update call settings');
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });

  if (!conversation || conversation.type !== 'GROUP') {
    throw new NotFoundError('Group not found');
  }

  const data: Record<string, boolean> = {};
  if (settings.callsEnabled !== undefined) data.callsEnabled = settings.callsEnabled;
  if (settings.videoEnabled !== undefined) data.videoEnabled = settings.videoEnabled;

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data,
    include: {
      participants: {
        where: { leftAt: null },
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true },
          },
        },
      },
    },
  });

  logger.info({ conversationId, userId, ...settings }, 'Group call settings updated');
  return updated;
}

/**
 * Promote a member to admin. Requester must be admin.
 */
export async function makeAdmin(
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
  if (requester.role !== 'ADMIN') {
    throw new ForbiddenError('Only admins can promote members');
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });

  if (!conversation || conversation.type !== 'GROUP') {
    throw new NotFoundError('Group not found');
  }

  const target = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
  });

  if (!target || target.leftAt !== null) {
    throw new NotFoundError('Member not found in this group');
  }
  if (target.role === 'ADMIN') {
    throw new ForbiddenError('User is already an admin');
  }

  await prisma.conversationParticipant.update({
    where: { id: target.id },
    data: { role: 'ADMIN' },
  });

  // Re-fetch with participants included
  const updated = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    include: {
      participants: {
        where: { leftAt: null },
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true },
          },
        },
      },
    },
  });

  logger.info({ conversationId, requesterId, targetUserId }, 'Member promoted to admin');
  return updated;
}

/**
 * Check if a group/channel name is available.
 */
export async function checkNameAvailable(name: string, isChannel: boolean): Promise<boolean> {
  const existing = await prisma.conversation.findFirst({
    where: {
      type: 'GROUP',
      status: 'ACTIVE',
      name: { equals: name, mode: 'insensitive' },
      isChannel,
    },
  });
  return !existing;
}

/**
 * Demote an admin to member. Requester must be admin. Cannot demote yourself.
 */
export async function demoteAdmin(
  conversationId: string,
  requesterId: string,
  targetUserId: string,
) {
  if (requesterId === targetUserId) {
    throw new ForbiddenError('You cannot demote yourself');
  }

  const requester = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId: requesterId } },
  });
  if (!requester || requester.role !== 'ADMIN') {
    throw new ForbiddenError('Only admins can demote other admins');
  }

  const target = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
  });
  if (!target || target.leftAt !== null) {
    throw new NotFoundError('Member not found in this group');
  }
  if (target.role !== 'ADMIN') {
    throw new ForbiddenError('User is not an admin');
  }

  await prisma.conversationParticipant.update({
    where: { id: target.id },
    data: { role: 'MEMBER' },
  });

  logger.info({ conversationId, requesterId, targetUserId }, 'Admin demoted to member');
  return { conversationId, demotedUserId: targetUserId };
}

/**
 * Generate or regenerate an invite link code for a group. Admin only.
 */
export async function generateInviteCode(conversationId: string, userId: string) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!participant || participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only admins can generate invite links');
  }

  const code = crypto.randomBytes(8).toString('base64url');

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { inviteCode: code },
  });

  logger.info({ conversationId, userId }, 'Invite code generated');
  return { inviteCode: code };
}

/**
 * Revoke the invite link for a group. Admin only.
 */
export async function revokeInviteCode(conversationId: string, userId: string) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!participant || participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only admins can revoke invite links');
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { inviteCode: null },
  });

  logger.info({ conversationId, userId }, 'Invite code revoked');
  return { success: true };
}

/**
 * Join a group via invite code. Any user can use a valid code.
 */
export async function joinViaInviteCode(inviteCode: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { inviteCode },
  });

  if (!conversation || conversation.type !== 'GROUP' || conversation.status !== 'ACTIVE') {
    throw new NotFoundError('Invalid or expired invite link');
  }

  // Check if user is banned
  const existing = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: conversation.id, userId } },
  });
  if (existing?.bannedAt) {
    throw new ForbiddenError('You have been banned from this group');
  }

  await prisma.conversationParticipant.upsert({
    where: { conversationId_userId: { conversationId: conversation.id, userId } },
    create: { conversationId: conversation.id, userId, role: 'MEMBER' },
    update: { leftAt: null, joinedAt: new Date() },
  });

  logger.info({ conversationId: conversation.id, userId, inviteCode }, 'User joined via invite code');
  return conversation;
}

/**
 * Update group admin settings (announcement mode, edit restrictions, add member restrictions).
 * Admin only.
 */
export async function updateGroupAdminSettings(
  conversationId: string,
  userId: string,
  settings: {
    adminsOnlyMessages?: boolean;
    adminsOnlyEditInfo?: boolean;
    adminsOnlyAddMembers?: boolean;
    disappearAfterSecs?: number | null;
  },
) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!participant || participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only admins can update these settings');
  }

  const data: Record<string, any> = {};
  if (settings.adminsOnlyMessages !== undefined) data.adminsOnlyMessages = settings.adminsOnlyMessages;
  if (settings.adminsOnlyEditInfo !== undefined) data.adminsOnlyEditInfo = settings.adminsOnlyEditInfo;
  if (settings.adminsOnlyAddMembers !== undefined) data.adminsOnlyAddMembers = settings.adminsOnlyAddMembers;
  if (settings.disappearAfterSecs !== undefined) data.disappearAfterSecs = settings.disappearAfterSecs;

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data,
  });

  logger.info({ conversationId, userId, ...settings }, 'Group admin settings updated');
  return updated;
}

/**
 * Ban a member from a group/channel. Admin only. Removes them and prevents rejoining.
 */
export async function banMember(conversationId: string, adminId: string, targetUserId: string) {
  await verifyAdmin(conversationId, adminId);

  const target = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
  });
  if (!target) throw new NotFoundError('User is not in this group');
  if (target.role === 'ADMIN') throw new ForbiddenError('Cannot ban an admin');

  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
    data: { leftAt: new Date(), bannedAt: new Date() },
  });

  logger.info({ conversationId, adminId, targetUserId }, 'Member banned');
  return { conversationId, bannedUserId: targetUserId };
}

/**
 * Unban a member from a group/channel. Admin only.
 */
export async function unbanMember(conversationId: string, adminId: string, targetUserId: string) {
  await verifyAdmin(conversationId, adminId);

  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId: targetUserId } },
    data: { bannedAt: null },
  });

  logger.info({ conversationId, adminId, targetUserId }, 'Member unbanned');
  return { conversationId, unbannedUserId: targetUserId };
}

/**
 * Clean up Cloudinary media for a deleted channel.
 */
async function _cleanupChannelMedia(
  postMedia: { cloudinaryId: string; url: string }[],
  avatarUrl: string | null,
  bannerUrl: string | null,
) {
  const { deleteFile } = await import('../../shared/cloudinary.service');
  for (const m of postMedia) {
    if (m.cloudinaryId) {
      const isVideo = m.url.includes('/video/') || m.url.endsWith('.mp4');
      deleteFile(m.cloudinaryId, isVideo ? 'video' : 'image').catch(() => {});
    }
  }
  for (const url of [avatarUrl, bannerUrl]) {
    if (url && url.includes('cloudinary.com')) {
      const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
      if (match) deleteFile(match[1]).catch(() => {});
    }
  }
}
