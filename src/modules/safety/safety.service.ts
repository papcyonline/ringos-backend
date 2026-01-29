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

  // Create the report
  const report = await prisma.report.create({
    data: {
      reporterId,
      reportedId: data.reportedId,
      reason: data.reason,
      details: data.details,
    },
  });

  // Increment flag count on reported user
  await recordFlag(data.reportedId);

  // Check thresholds for auto-moderation
  await checkAndApplyThresholds(data.reportedId);

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

  // Check if already blocked
  const existing = await prisma.block.findUnique({
    where: { blockerId_blockedId: { blockerId, blockedId } },
  });
  if (existing) {
    throw new ConflictError('User is already blocked');
  }

  // Create block record
  const block = await prisma.block.create({
    data: { blockerId, blockedId },
  });

  // End any active conversations between the two users
  const sharedConversations = await prisma.conversation.findMany({
    where: {
      status: 'ACTIVE',
      AND: [
        { participants: { some: { userId: blockerId } } },
        { participants: { some: { userId: blockedId } } },
      ],
    },
  });

  if (sharedConversations.length > 0) {
    await prisma.conversation.updateMany({
      where: { id: { in: sharedConversations.map((c) => c.id) } },
      data: { status: 'ENDED' },
    });

    logger.info(
      { blockerId, blockedId, endedConversations: sharedConversations.length },
      'Ended active conversations due to block',
    );
  }

  logger.info({ blockerId, blockedId }, 'User blocked');

  return { id: block.id, blockedId: block.blockedId, createdAt: block.createdAt };
}

export async function unblockUser(blockerId: string, blockedId: string) {
  const block = await prisma.block.findUnique({
    where: { blockerId_blockedId: { blockerId, blockedId } },
  });

  if (!block) {
    throw new NotFoundError('Block record not found');
  }

  await prisma.block.delete({
    where: { blockerId_blockedId: { blockerId, blockedId } },
  });

  logger.info({ blockerId, blockedId }, 'User unblocked');

  return { success: true };
}

export async function getBlockedUsers(userId: string) {
  const blocks = await prisma.block.findMany({
    where: { blockerId: userId },
    include: {
      blocked: {
        select: { id: true, displayName: true },
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

export async function recordFlag(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      flagCount: { increment: 1 },
      lastFlaggedAt: new Date(),
    },
  });
}

export async function checkBanStatus(
  userId: string,
): Promise<{ banned: boolean; status: string; expiresAt?: Date }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { banStatus: true, banExpiresAt: true },
  });

  if (!user) {
    throw new NotFoundError('User not found');
  }

  // If temp ban has expired, reset it
  if (user.banStatus === 'TEMP_BAN' && user.banExpiresAt && user.banExpiresAt < new Date()) {
    await prisma.user.update({
      where: { id: userId },
      data: { banStatus: 'NONE', banExpiresAt: null, flagCount: 0 },
    });

    logger.info({ userId }, 'Temp ban expired, status reset');

    return { banned: false, status: 'NONE' };
  }

  const banned = user.banStatus === 'TEMP_BAN' || user.banStatus === 'PERMANENT_BAN';

  return {
    banned,
    status: user.banStatus,
    ...(user.banExpiresAt ? { expiresAt: user.banExpiresAt } : {}),
  };
}

async function checkAndApplyThresholds(userId: string) {
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  // Count reports in the last 24h
  const reportsIn24h = await prisma.report.count({
    where: {
      reportedId: userId,
      createdAt: { gte: twentyFourHoursAgo },
    },
  });

  // Count reports in the last 48h
  const reportsIn48h = await prisma.report.count({
    where: {
      reportedId: userId,
      createdAt: { gte: fortyEightHoursAgo },
    },
  });

  // Count total reports
  const totalReports = await prisma.report.count({
    where: { reportedId: userId },
  });

  // 5 flags in 48h → TEMP_BAN
  if (reportsIn48h >= 5) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        banStatus: 'TEMP_BAN',
        banExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      },
    });
    logger.warn({ userId, reportsIn48h }, 'User temp-banned: 5+ flags in 48h');
    return;
  }

  // 3 flags in 24h → WARNING
  if (reportsIn24h >= 3) {
    await prisma.user.update({
      where: { id: userId },
      data: { banStatus: 'WARNING' },
    });
    logger.warn({ userId, reportsIn24h }, 'User warned: 3+ flags in 24h');
    return;
  }

  // 3+ total reports → auto TEMP_BAN
  if (totalReports >= 3) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        banStatus: 'TEMP_BAN',
        banExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      },
    });
    logger.warn({ userId, totalReports }, 'User temp-banned: 3+ total reports');
    return;
  }
}
