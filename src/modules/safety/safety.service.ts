import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { BadRequestError, NotFoundError, ConflictError } from '../../shared/errors';

interface ReportData {
  reportedId: string;
  reason: 'HARASSMENT' | 'SPAM' | 'INAPPROPRIATE_CONTENT' | 'SELF_HARM' | 'THREATS' | 'OTHER';
  details?: string;
}

interface ReportResult {
  report: { id: string; reason: string; status: string };
  crisisResources?: {
    message: string;
    hotline: string;
    text: string;
    chat: string;
  };
}

export async function reportUser(reporterId: string, data: ReportData): Promise<ReportResult> {
  if (reporterId === data.reportedId) {
    throw new BadRequestError('Cannot report yourself');
  }

  const reportedUser = await prisma.user.findUnique({ where: { id: data.reportedId } });
  if (!reportedUser) {
    throw new NotFoundError('Reported user not found');
  }

  // Wrap report + flag + threshold check in a transaction for consistency
  const report = await prisma.$transaction(async (tx) => {
    const report = await tx.report.create({
      data: {
        reporterId,
        reportedId: data.reportedId,
        reason: data.reason,
        details: data.details,
      },
    });

    await recordFlag(data.reportedId, tx);
    await checkAndApplyThresholds(data.reportedId, tx);

    return report;
  });

  logger.info(
    { reportId: report.id, reporterId, reportedId: data.reportedId, reason: data.reason },
    'User report created',
  );

  const result: ReportResult = {
    report: { id: report.id, reason: report.reason, status: report.status },
  };

  // If reason is SELF_HARM, return crisis resources
  if (data.reason === 'SELF_HARM') {
    result.crisisResources = {
      message:
        'If you or someone you know is in crisis, please reach out for help immediately.',
      hotline: '988 Suicide & Crisis Lifeline - Call or text 988',
      text: 'Text HOME to 741741 (Crisis Text Line)',
      chat: 'https://988lifeline.org/chat/',
    };
  }

  return result;
}

export async function blockUser(blockerId: string, blockedId: string) {
  if (blockerId === blockedId) {
    throw new BadRequestError('Cannot block yourself');
  }

  const blockedUser = await prisma.user.findUnique({ where: { id: blockedId } });
  if (!blockedUser) {
    throw new NotFoundError('User not found');
  }

  // Idempotent: upsert the block AND always end any lingering shared
  // conversations + set the blocker's leftAt so the conversation
  // disappears from their chat list. Re-blocking an existing block
  // should still clean up any stale rows left over from before.
  const block = await prisma.$transaction(async (tx) => {
    const block = await tx.block.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      create: { blockerId, blockedId },
      update: {},
    });

    const sharedConversations = await tx.conversation.findMany({
      where: {
        AND: [
          { participants: { some: { userId: blockerId } } },
          { participants: { some: { userId: blockedId } } },
        ],
      },
      select: { id: true, status: true },
    });

    if (sharedConversations.length > 0) {
      const convIds = sharedConversations.map((c) => c.id);
      const stillActive = sharedConversations
        .filter((c) => c.status === 'ACTIVE')
        .map((c) => c.id);

      if (stillActive.length > 0) {
        await tx.conversation.updateMany({
          where: { id: { in: stillActive } },
          data: { status: 'ENDED' },
        });
      }

      // Ensure the blocker's participant row is marked as left, so the
      // conversation no longer surfaces in getConversations (which
      // filters by leftAt: null).
      await tx.conversationParticipant.updateMany({
        where: {
          conversationId: { in: convIds },
          userId: blockerId,
          leftAt: null,
        },
        data: { leftAt: new Date() },
      });

      logger.info(
        { blockerId, blockedId, endedConversations: stillActive.length, hidden: convIds.length },
        'Hid shared conversations due to block',
      );
    }

    return block;
  });

  logger.info({ blockerId, blockedId }, 'User blocked (idempotent)');

  return { id: block.id, blockedId: block.blockedId, createdAt: block.createdAt };
}

export async function unblockUser(blockerId: string, blockedId: string) {
  const block = await prisma.block.findUnique({
    where: { blockerId_blockedId: { blockerId, blockedId } },
  });

  if (!block) {
    throw new NotFoundError('Block record not found');
  }

  await prisma.$transaction(async (tx) => {
    await tx.block.delete({
      where: { blockerId_blockedId: { blockerId, blockedId } },
    });

    // Reactivate shared conversations that were ended by the block,
    // but only if neither party still blocks the other.
    const reverseBlock = await tx.block.findUnique({
      where: { blockerId_blockedId: { blockerId: blockedId, blockedId: blockerId } },
    });

    if (!reverseBlock) {
      const endedConversations = await tx.conversation.findMany({
        where: {
          status: 'ENDED',
          AND: [
            { participants: { some: { userId: blockerId } } },
            { participants: { some: { userId: blockedId } } },
          ],
        },
      });

      if (endedConversations.length > 0) {
        await tx.conversation.updateMany({
          where: { id: { in: endedConversations.map((c) => c.id) } },
          data: { status: 'ACTIVE' },
        });

        logger.info(
          { blockerId, blockedId, reactivatedConversations: endedConversations.length },
          'Reactivated conversations after unblock',
        );
      }
    }
  });

  logger.info({ blockerId, blockedId }, 'User unblocked');

  return { success: true };
}

export async function getBlockedUsers(userId: string) {
  const blocks = await prisma.block.findMany({
    where: { blockerId: userId },
    include: {
      blocked: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          bio: true,
          isVerified: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return blocks.map((b) => ({
    id: b.id,
    blockedUser: b.blocked,
    createdAt: b.createdAt,
  }));
}

export async function isBlocked(userId1: string, userId2: string): Promise<boolean> {
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userId1, blockedId: userId2 },
        { blockerId: userId2, blockedId: userId1 },
      ],
    },
  });

  return !!block;
}

export async function recordFlag(userId: string, tx?: Prisma.TransactionClient) {
  const db = tx ?? prisma;
  await db.userModeration.upsert({
    where: { userId },
    create: { userId, flagCount: 1, lastFlaggedAt: new Date() },
    update: {
      flagCount: { increment: 1 },
      lastFlaggedAt: new Date(),
    },
  });
}

export async function checkBanStatus(
  userId: string,
): Promise<{ banned: boolean; status: string; expiresAt?: Date }> {
  // Verify user exists
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });

  if (!user) {
    throw new NotFoundError('User not found');
  }

  const moderation = await prisma.userModeration.findUnique({
    where: { userId },
    select: { banStatus: true, banExpiresAt: true },
  });

  // No moderation record means no ban
  if (!moderation) {
    return { banned: false, status: 'NONE' };
  }

  // If temp ban has expired, reset it
  if (moderation.banStatus === 'TEMP_BAN' && moderation.banExpiresAt && moderation.banExpiresAt < new Date()) {
    await prisma.userModeration.update({
      where: { userId },
      data: { banStatus: 'NONE', banExpiresAt: null, flagCount: 0 },
    });

    logger.info({ userId }, 'Temp ban expired, status reset');

    return { banned: false, status: 'NONE' };
  }

  const banned = moderation.banStatus === 'TEMP_BAN' || moderation.banStatus === 'PERMANENT_BAN';

  return {
    banned,
    status: moderation.banStatus,
    ...(moderation.banExpiresAt ? { expiresAt: moderation.banExpiresAt } : {}),
  };
}

async function checkAndApplyThresholds(userId: string, tx?: Prisma.TransactionClient) {
  const db = tx ?? prisma;
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  // Count total reports (all-time, never resets — used for escalation)
  const totalReports = await db.report.count({
    where: { reportedId: userId },
  });

  // Count reports in the last 24h and 48h
  const reportsIn24h = await db.report.count({
    where: { reportedId: userId, createdAt: { gte: twentyFourHoursAgo } },
  });
  const reportsIn48h = await db.report.count({
    where: { reportedId: userId, createdAt: { gte: fortyEightHoursAgo } },
  });

  // 5+ total reports ever → PERMANENT_BAN (highest priority, irreversible)
  if (totalReports >= 5) {
    await db.userModeration.upsert({
      where: { userId },
      create: { userId, banStatus: 'PERMANENT_BAN', banExpiresAt: null },
      update: { banStatus: 'PERMANENT_BAN', banExpiresAt: null },
    });
    logger.warn({ userId, totalReports }, 'User permanently banned: 5+ total reports');
    return;
  }

  // 5 reports in 48h → TEMP_BAN (24h) — rapid-fire abuse pattern
  if (reportsIn48h >= 5) {
    await db.userModeration.upsert({
      where: { userId },
      create: { userId, banStatus: 'TEMP_BAN', banExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) },
      update: {
        banStatus: 'TEMP_BAN',
        banExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      },
    });
    logger.warn({ userId, reportsIn48h }, 'User temp-banned: 5+ reports in 48h');
    return;
  }

  // 3+ total reports → TEMP_BAN (24h)
  if (totalReports >= 3) {
    await db.userModeration.upsert({
      where: { userId },
      create: { userId, banStatus: 'TEMP_BAN', banExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) },
      update: {
        banStatus: 'TEMP_BAN',
        banExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      },
    });
    logger.warn({ userId, totalReports }, 'User temp-banned: 3+ total reports');
    return;
  }

  // 3 reports in 24h → WARNING
  if (reportsIn24h >= 3) {
    await db.userModeration.upsert({
      where: { userId },
      create: { userId, banStatus: 'WARNING' },
      update: { banStatus: 'WARNING' },
    });
    logger.warn({ userId, reportsIn24h }, 'User warned: 3+ reports in 24h');
    return;
  }
}
