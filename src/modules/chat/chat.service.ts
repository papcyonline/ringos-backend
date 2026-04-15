import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { NotFoundError, ForbiddenError } from '../../shared/errors';
import { isBlocked, blockUser } from '../safety/safety.service';
import { getLimits } from '../../shared/usage.service';
import * as cloudinaryService from '../../shared/cloudinary.service';
import ogs from 'open-graph-scraper';
import { promises as dns } from 'dns';
import net from 'net';

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

/**
 * Return true if `ip` is in a range we must never fetch from (loopback,
 * link-local, RFC1918/ULA). Without this guard, any user message can make the
 * server hit internal URLs like http://127.0.0.1:5432 or cloud metadata
 * endpoints (169.254.169.254).
 */
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map((n) => parseInt(n, 10));
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fe80:')) return true; // link-local
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA
    // IPv4-mapped (::ffff:x.x.x.x) — re-check the embedded v4.
    const mapped = normalized.match(/^::ffff:([0-9.]+)$/);
    if (mapped && net.isIPv4(mapped[1])) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

async function fetchLinkPreview(messageId: string, content: string) {
  try {
    const match = content.match(urlRegex);
    if (!match) return;

    const rawUrl = match[0];
    const urlStr = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;

    // Validate scheme + hostname before touching the network. open-graph-scraper
    // follows redirects, but we at least prevent the initial fetch from hitting
    // an internal endpoint.
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

    const host = parsed.hostname;
    if (!host) return;
    // Block bare literal private addresses even without DNS lookup.
    if (net.isIP(host) && isPrivateIp(host)) {
      logger.debug({ messageId, host }, 'Link preview blocked: private literal IP');
      return;
    }

    // Resolve the hostname and reject if any resolved address is private.
    try {
      const addrs = await dns.lookup(host, { all: true });
      for (const { address } of addrs) {
        if (isPrivateIp(address)) {
          logger.debug({ messageId, host, address }, 'Link preview blocked: resolved to private IP');
          return;
        }
      }
    } catch {
      // DNS failure — don't fetch.
      return;
    }

    const { result } = await ogs({ url: urlStr, timeout: 5000 });
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
    select: { id: true, displayName: true, avatarUrl: true, isVerified: true },
  },
  replyTo: {
    select: {
      id: true,
      content: true,
      senderId: true,
      imageUrl: true,
      audioUrl: true,
      audioDuration: true,
      viewOnce: true,
      deletedAt: true,
      metadata: true,
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
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true, lastSeenAt: true },
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
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true, lastSeenAt: true },
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
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true, lastSeenAt: true },
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
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true, lastSeenAt: true },
          },
        },
      },
    },
  });

  logger.info({ conversationId: conversation.id, userId, targetUserId }, 'Created direct conversation');
  return conversation;
}

/**
 * Get or create a DM linked to a channel. Subscriber sees the channel identity.
 */
export async function getOrCreateChannelDM(channelId: string, subscriberUserId: string) {
  // Find the channel
  const channel = await prisma.conversation.findUnique({
    where: { id: channelId },
    select: { id: true, name: true, avatarUrl: true, isChannel: true, status: true },
  });
  if (!channel || !channel.isChannel || channel.status !== 'ACTIVE') {
    throw new NotFoundError('Channel not found');
  }

  // Find the channel's primary admin
  const admin = await prisma.conversationParticipant.findFirst({
    where: { conversationId: channelId, role: 'ADMIN', leftAt: null },
    select: { userId: true },
  });
  if (!admin) throw new NotFoundError('Channel has no admin');

  if (subscriberUserId === admin.userId) {
    throw new ForbiddenError('Cannot message your own channel');
  }

  // Check if blocked
  const blocked = await isBlocked(subscriberUserId, admin.userId);
  if (blocked) {
    throw new ForbiddenError('Cannot message this channel');
  }

  // Check for existing channel DM
  const existing = await prisma.conversation.findFirst({
    where: {
      type: 'HUMAN_MATCHED',
      channelSourceId: channelId,
      status: 'ACTIVE',
      AND: [
        { participants: { some: { userId: subscriberUserId } } },
      ],
    },
    include: {
      participants: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true, lastSeenAt: true },
          },
        },
      },
    },
  });

  if (existing) return existing;

  // Create new channel DM
  const conversation = await prisma.conversation.create({
    data: {
      type: 'HUMAN_MATCHED',
      status: 'ACTIVE',
      channelSourceId: channelId,
      name: channel.name,
      avatarUrl: channel.avatarUrl,
      participants: {
        create: [
          { userId: subscriberUserId },
          { userId: admin.userId },
        ],
      },
    },
    include: {
      participants: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true, lastSeenAt: true },
          },
        },
      },
    },
  });

  logger.info({ conversationId: conversation.id, channelId, subscriberUserId }, 'Created channel DM');
  return conversation;
}

/**
 * Get all channel DMs (inbox) for a channel. Admin only.
 */
export async function getChannelInbox(channelId: string, userId: string, cursor?: string, limit = 20, archived = false) {
  // Verify admin — inline check (verifyAdmin is in group.service.ts, not imported here)
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: channelId, userId } },
  });
  if (!participant || participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only channel admins can view the inbox');
  }

  const where: any = {
    channelSourceId: channelId,
    type: 'HUMAN_MATCHED',
    status: 'ACTIVE',
    // Filter by admin's archive state — match conversations where THIS admin's participant has isArchived = archived
    participants: {
      some: { userId, isArchived: archived },
    },
  };

  if (cursor) {
    const cursorConv = await prisma.conversation.findUnique({
      where: { id: cursor },
      select: { updatedAt: true },
    });
    if (cursorConv) {
      where.updatedAt = { lt: cursorConv.updatedAt };
    }
  }

  const conversations = await prisma.conversation.findMany({
    where,
    include: {
      participants: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true, lastSeenAt: true },
          },
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { id: true, content: true, senderId: true, createdAt: true },
      },
    },
    orderBy: { updatedAt: 'desc' },
    take: limit + 1,
  });

  const hasMore = conversations.length > limit;
  const sliced = hasMore ? conversations.slice(0, limit) : conversations;

  // Batch unread counts — single query instead of N+1 per conversation
  const lastReadMap = new Map<string, Date | null>();
  for (const c of sliced) {
    const myPart = c.participants.find((p: any) => p.userId === userId);
    lastReadMap.set(c.id, myPart?.lastReadAt ?? null);
  }

  const slicedIds = sliced.map((c) => c.id);
  const idsWithLastRead = slicedIds.filter((id) => lastReadMap.get(id) != null);
  const idsWithoutLastRead = slicedIds.filter((id) => lastReadMap.get(id) == null);

  const unreadMap = new Map<string, number>();

  // For conversations without lastReadAt — count all unread
  if (idsWithoutLastRead.length > 0) {
    const counts = await prisma.message.groupBy({
      by: ['conversationId'],
      _count: { id: true },
      where: {
        conversationId: { in: idsWithoutLastRead },
        senderId: { not: userId },
        deletedAt: null,
      },
    });
    for (const g of counts) unreadMap.set(g.conversationId, g._count.id);
  }

  // For conversations with lastReadAt — fetch messages after earliest lastRead, filter in JS
  if (idsWithLastRead.length > 0) {
    const lastReadDates = idsWithLastRead.map((id) => lastReadMap.get(id)!);
    const earliest = new Date(Math.min(...lastReadDates.map((d) => d.getTime())));

    const msgs = await prisma.message.findMany({
      where: {
        conversationId: { in: idsWithLastRead },
        senderId: { not: userId },
        deletedAt: null,
        createdAt: { gt: earliest },
      },
      select: { conversationId: true, createdAt: true },
    });

    for (const msg of msgs) {
      const lastRead = lastReadMap.get(msg.conversationId);
      if (lastRead && msg.createdAt > lastRead) {
        unreadMap.set(msg.conversationId, (unreadMap.get(msg.conversationId) ?? 0) + 1);
      }
    }
  }

  const items = sliced.map((c) => ({
    ...c,
    lastMessage: c.messages[0] ?? null,
    messages: undefined,
    unreadCount: unreadMap.get(c.id) ?? 0,
  }));

  return {
    items,
    hasMore,
    nextCursor: sliced.length > 0 ? sliced[sliced.length - 1].id : undefined,
  };
}

/**
 * Get total unread message count across all channel DMs. Lightweight endpoint for badge display.
 */
export async function getChannelInboxUnreadCount(channelId: string, userId: string) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: channelId, userId } },
  });
  if (!participant || participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only channel admins can view the inbox');
  }

  // Only count from non-archived conversations, with the admin's participant info
  const dmConvs = await prisma.conversation.findMany({
    where: {
      channelSourceId: channelId,
      type: 'HUMAN_MATCHED',
      status: 'ACTIVE',
      participants: { some: { userId, isArchived: false } },
    },
    select: {
      id: true,
      participants: {
        where: { userId },
        select: { lastReadAt: true },
      },
    },
  });

  if (dmConvs.length === 0) return { count: 0 };

  // Batch unread count — single query instead of N+1
  const convIds = dmConvs.map((c) => c.id);
  const lastReadPerConv = new Map<string, Date | null>();
  for (const conv of dmConvs) {
    lastReadPerConv.set(conv.id, conv.participants[0]?.lastReadAt ?? null);
  }

  const idsWithRead = convIds.filter((id) => lastReadPerConv.get(id) != null);
  const idsWithoutRead = convIds.filter((id) => lastReadPerConv.get(id) == null);

  let total = 0;

  // Conversations without lastReadAt — count all unread
  if (idsWithoutRead.length > 0) {
    const result = await prisma.message.count({
      where: {
        conversationId: { in: idsWithoutRead },
        senderId: { not: userId },
        deletedAt: null,
      },
    });
    total += result;
  }

  // Conversations with lastReadAt — fetch after earliest, filter in JS
  if (idsWithRead.length > 0) {
    const dates = idsWithRead.map((id) => lastReadPerConv.get(id)!);
    const earliest = new Date(Math.min(...dates.map((d) => d.getTime())));

    const msgs = await prisma.message.findMany({
      where: {
        conversationId: { in: idsWithRead },
        senderId: { not: userId },
        deletedAt: null,
        createdAt: { gt: earliest },
      },
      select: { conversationId: true, createdAt: true },
    });

    for (const msg of msgs) {
      const lastRead = lastReadPerConv.get(msg.conversationId);
      if (lastRead && msg.createdAt > lastRead) total++;
    }
  }

  return { count: total };
}

/**
 * Block a subscriber from messaging a channel. Admin only.
 * Blocks the user and deactivates their channel DM.
 */
export async function blockChannelSubscriber(channelId: string, adminUserId: string, subscriberUserId: string) {
  // Verify caller is admin of the channel
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: channelId, userId: adminUserId } },
  });
  if (!participant || participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only channel admins can block subscribers');
  }

  // Block the subscriber (uses existing safety service)
  // Ignore ConflictError if already blocked
  try {
    await blockUser(adminUserId, subscriberUserId);
  } catch (err: any) {
    if (err?.statusCode !== 409) throw err;
  }

  // Deactivate the channel DM conversation
  const dm = await prisma.conversation.findFirst({
    where: {
      channelSourceId: channelId,
      type: 'HUMAN_MATCHED',
      status: 'ACTIVE',
      participants: { some: { userId: subscriberUserId } },
    },
  });
  if (dm) {
    await prisma.conversation.update({
      where: { id: dm.id },
      data: { status: 'ENDED' },
    });
  }

  logger.info({ channelId, adminUserId, subscriberUserId }, 'Blocked channel subscriber');
  return { blocked: true };
}

/**
 * Delete (close) a channel DM conversation from the inbox. Admin only.
 */
export async function deleteChannelDM(channelId: string, conversationId: string, adminUserId: string) {
  // Verify caller is admin of the channel
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: channelId, userId: adminUserId } },
  });
  if (!participant || participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only channel admins can delete inbox conversations');
  }

  // Verify the conversation belongs to this channel
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conv || conv.channelSourceId !== channelId) {
    throw new NotFoundError('Conversation not found in this channel');
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: 'ENDED' },
  });

  logger.info({ channelId, conversationId, adminUserId }, 'Deleted channel DM from inbox');
  return { deleted: true };
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

  // Check admin-only messaging for groups
  if (conversation.type === 'GROUP' && conversation.adminsOnlyMessages && participant.role !== 'ADMIN') {
    throw new ForbiddenError('Only admins can send messages in this group');
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

  // Compute message expiry if conversation has disappearing messages enabled
  const disappearSecs = (conversation as any).disappearAfterSecs as number | null;
  const expiresAt = disappearSecs
    ? new Date(Date.now() + disappearSecs * 1000)
    : undefined;

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
        expiresAt,
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
 * Delete a message.
 * mode = 'everyone' → soft-delete for all (sender only). Clears content/media.
 * mode = 'me'       → hide from this user only. Adds userId to deletedFor[].
 */
export async function deleteMessage(messageId: string, userId: string, mode: 'me' | 'everyone' | 'unsend' = 'everyone') {
  const message = await prisma.message.findUnique({ where: { id: messageId } });

  if (!message) {
    throw new NotFoundError('Message not found');
  }

  if (message.deletedAt) {
    throw new ForbiddenError('Message is already deleted');
  }

  if (mode === 'me') {
    // Hide from this user only — no permission check needed
    const deletedFor = message.deletedFor ?? [];
    if (deletedFor.includes(userId)) {
      return message; // already hidden
    }
    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { deletedFor: { push: userId } },
      include: messageInclude,
    });
    logger.debug({ messageId, userId, mode }, 'Message hidden for user');
    return updated;
  }

  // 'unsend' and 'everyone' both require sender ownership (or admin for 'everyone')
  if (mode === 'unsend') {
    // Only the sender can unsend — admins cannot unsend others' messages
    if (message.senderId !== userId) {
      throw new ForbiddenError('You can only unsend your own messages');
    }
  } else if (message.senderId !== userId) {
    // mode === 'everyone' — admin can delete others' messages with a placeholder
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: message.conversationId, userId } },
    });
    if (!participant || participant.role !== 'ADMIN') {
      throw new ForbiddenError('You can only delete your own messages');
    }
  }

  await cleanupMediaUrls([message.imageUrl, message.audioUrl]);

  if (mode === 'unsend') {
    // Hard delete — message vanishes from DB entirely, no trace for recipient
    await prisma.$transaction([
      prisma.messageReaction.deleteMany({ where: { messageId } }),
      prisma.message.delete({ where: { id: messageId } }),
    ]);
    logger.debug({ messageId, userId, mode }, 'Message unsent (hard delete)');
    return { id: messageId, conversationId: message.conversationId, unsent: true };
  }

  const [updated] = await prisma.$transaction([
    prisma.message.update({
      where: { id: messageId },
      data: { content: '', imageUrl: null, audioUrl: null, deletedAt: new Date() },
      include: messageInclude,
    }),
    // Clean up reactions on deleted messages
    prisma.messageReaction.deleteMany({ where: { messageId } }),
  ]);

  logger.debug({ messageId, userId, mode }, 'Message deleted for everyone');
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

  if (message.deletedAt) {
    throw new ForbiddenError('Cannot react to a deleted message');
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

  // Groups and channels: only this participant leaves — the conversation stays
  // alive for everyone else. Direct 1-on-1 conversations end entirely.
  const isGroupLike = conversation.type === 'GROUP';

  if (isGroupLike) {
    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { leftAt: new Date() },
    });
    logger.info({ conversationId, userId }, 'Participant left group/channel');
    return conversation;
  }

  const [updatedConversation] = await prisma.$transaction([
    prisma.conversation.update({
      where: { id: conversationId },
      data: { status: 'ENDED' },
    }),
    prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { leftAt: new Date() },
    }),
  ]);

  logger.info({ conversationId, userId }, 'Direct conversation ended');
  return updatedConversation;
}

/**
 * List all active GROUP conversations, visible to any authenticated user.
 * Includes participant count and whether the requesting user is a member.
 */
/**
 * List all active groups or channels visible to the user (public + joined).
 */
async function listGroupConversations(userId: string, isChannel: boolean, limit = 100) {
  const conversations = await prisma.conversation.findMany({
    where: {
      type: 'GROUP',
      isChannel,
      status: 'ACTIVE',
      OR: [
        { isPublic: true },
        { participants: { some: { userId, leftAt: null } } },
      ],
    },
    include: {
      participants: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true, lastSeenAt: true },
          },
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });

  return conversations.map((c) => {
    const activeParticipants = c.participants.filter((p) => p.leftAt == null);
    const myParticipant = activeParticipants.find((p) => p.userId === userId);
    return {
      ...c,
      memberCount: activeParticipants.length,
      isMember: !!myParticipant,
      isAdmin: myParticipant?.role === 'ADMIN',
    };
  });
}

export async function getAllGroups(userId: string, limit = 100) {
  const results = await listGroupConversations(userId, false, limit);
  logger.debug({ userId, count: results.length }, 'Listed all public groups');
  return results;
}

export async function getAllChannels(userId: string, limit = 100) {
  const results = await listGroupConversations(userId, true, limit);
  logger.debug({ userId, count: results.length }, 'Listed all public channels');
  return results;
}

/**
 * Get recommended channels the user hasn't joined, sorted by subscriber count.
 * Optionally filter by category.
 */
export async function getRecommendedChannels(userId: string, category?: string, limit = 20) {
  const channels = await prisma.conversation.findMany({
    where: {
      type: 'GROUP',
      isChannel: true,
      isPublic: true,
      status: 'ACTIVE',
      ...(category ? { category: { equals: category, mode: 'insensitive' } } : {}),
      // Exclude channels user is already a member of
      NOT: {
        participants: { some: { userId, leftAt: null } },
      },
    },
    include: {
      participants: {
        where: { leftAt: null, bannedAt: null },
        select: { userId: true, role: true },
      },
    },
    orderBy: { updatedAt: 'desc' },
    take: limit * 3, // Fetch extra to sort by subscriber count
  });

  // Sort by subscriber count descending
  const sorted = channels
    .map((c) => {
      const myParticipant = c.participants.find((p) => p.userId === userId);
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        avatarUrl: c.avatarUrl,
        bannerUrl: c.bannerUrl,
        category: c.category,
        isVerified: c.isVerified,
        isChannel: c.isChannel,
        memberCount: c.participants.length,
        subscriberCount: c.participants.length,
        isMember: !!myParticipant,
        isAdmin: myParticipant?.role === 'ADMIN',
      };
    })
    .sort((a, b) => b.subscriberCount - a.subscriberCount)
    .slice(0, limit);

  logger.debug({ userId, count: sorted.length, category }, 'Listed recommended channels');
  return sorted;
}

/**
 * Search channels by name, category, or description.
 */
export async function searchChannels(query: string, userId: string, limit = 20) {
  if (!query || query.length < 2) return [];

  const channels = await prisma.conversation.findMany({
    where: {
      type: 'GROUP',
      isChannel: true,
      status: 'ACTIVE',
      AND: [
        {
          OR: [
            { isPublic: true },
            { participants: { some: { userId, leftAt: null } } },
          ],
        },
        {
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { category: { contains: query, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } },
          ],
        },
      ],
    },
    include: {
      participants: {
        where: { leftAt: null },
        select: { userId: true, role: true },
      },
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });

  return channels.map((c) => {
    const myParticipant = c.participants.find((p) => p.userId === userId);
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      avatarUrl: c.avatarUrl,
      bannerUrl: c.bannerUrl,
      category: c.category,
      isVerified: c.isVerified,
      isChannel: c.isChannel,
      memberCount: c.participants.length,
      isMember: !!myParticipant,
      isAdmin: myParticipant?.role === 'ADMIN',
    };
  });
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

  // Check if user has cleared chat history — hide messages before clearedAt
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { clearedAt: true },
  });

  // Build query: cursor-based if cursor provided, offset-based otherwise
  // Exclude messages the user has deleted for themselves
  const whereClause: any = {
    conversationId,
    NOT: { deletedFor: { has: userId } },
    ...(participant?.clearedAt ? { createdAt: { gt: participant.clearedAt } } : {}),
  };
  let skip: number | undefined;

  if (cursor) {
    // Cursor is a message ID — fetch messages older than it.
    const cursorMsg = await prisma.message.findUnique({
      where: { id: cursor },
      select: { createdAt: true },
    });
    if (cursorMsg) {
      whereClause.createdAt = { lt: cursorMsg.createdAt };
    } else {
      // Cursor was hard-deleted (unsent). Without this, the query would
      // silently return the newest page, causing duplicates on the client.
      // Return an empty page so pagination stops cleanly.
      return { data: [], page, limit, hasMore: false, nextCursor: null };
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
 * Fetch messages newer than `sinceMessageId` (or most recent N if not given).
 * Used by clients to catch up on missed messages after reconnect/app-resume.
 * Returned in ascending chronological order; capped at `limit`.
 */
export async function getMessagesSince(
  conversationId: string,
  userId: string,
  sinceMessageId?: string,
  limit = 100,
): Promise<{ messages: any[]; hasMore: boolean; nextSinceId: string | null; sinceNotFound: boolean }> {
  const callerParticipant = await verifyParticipant(conversationId, userId);

  const whereClause: any = {
    conversationId,
    NOT: { deletedFor: { has: userId } },
    ...(callerParticipant.clearedAt ? { createdAt: { gt: callerParticipant.clearedAt } } : {}),
  };

  let sinceNotFound = false;
  if (sinceMessageId) {
    const cursorMsg = await prisma.message.findUnique({
      where: { id: sinceMessageId },
      select: { createdAt: true },
    });
    if (cursorMsg) {
      whereClause.createdAt = {
        ...(whereClause.createdAt ?? {}),
        gt: cursorMsg.createdAt,
      };
    } else {
      // Cursor message was hard-deleted (unsent). Without this guard the
      // query would return the full history. Fall back to a sane window:
      // the caller's lastReadAt (or clearedAt) — whichever is more recent.
      // If neither is set, return nothing and signal sinceNotFound so the
      // client can re-bootstrap with a fresh page load.
      sinceNotFound = true;
      const floor =
        callerParticipant.lastReadAt && callerParticipant.clearedAt
          ? (callerParticipant.lastReadAt > callerParticipant.clearedAt
              ? callerParticipant.lastReadAt
              : callerParticipant.clearedAt)
          : (callerParticipant.lastReadAt ?? callerParticipant.clearedAt ?? null);
      if (floor) {
        whereClause.createdAt = {
          ...(whereClause.createdAt ?? {}),
          gt: floor,
        };
      } else {
        // No safe floor — return empty. Client should re-fetch via /messages.
        return { messages: [], hasMore: false, nextSinceId: null, sinceNotFound: true };
      }
    }
  }

  const [messages, participants] = await Promise.all([
    prisma.message.findMany({
      where: whereClause,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: messageInclude,
    }),
    prisma.conversationParticipant.findMany({
      where: { conversationId, userId: { not: userId }, leftAt: null },
      select: { lastReadAt: true, lastDeliveredAt: true },
    }),
  ]);

  const hasMore = messages.length > limit;
  const trimmed = hasMore ? messages.slice(0, limit) : messages;
  const nextSinceId = hasMore && trimmed.length > 0 ? trimmed[trimmed.length - 1].id : null;

  return {
    messages: trimmed.map((msg) => ({
      ...msg,
      status: computeMessageStatus(msg, userId, participants),
    })),
    hasMore,
    nextSinceId,
    sinceNotFound,
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

  // Legacy toggle — flips isMuted and clears mutedUntil for a permanent mute.
  const nowMuted = !participant.isMuted;
  const updated = await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { isMuted: nowMuted, mutedUntil: null },
    select: { isMuted: true, mutedUntil: true },
  });

  logger.debug({ conversationId, userId, isMuted: updated.isMuted }, 'Mute toggled');
  return updated;
}

/**
 * Set a time-bounded mute. Pass:
 *   - a future Date to mute until that timestamp
 *   - `null` to unmute immediately
 *
 * `isMuted` is kept in sync as a derived boolean so legacy callers that only
 * read that field continue to work.
 */
export async function setMute(
  userId: string,
  conversationId: string,
  mutedUntil: Date | null,
) {
  await verifyParticipant(conversationId, userId);

  const now = new Date();
  const effectiveUntil = mutedUntil && mutedUntil > now ? mutedUntil : null;
  const updated = await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: {
      mutedUntil: effectiveUntil,
      isMuted: effectiveUntil !== null,
    },
    select: { isMuted: true, mutedUntil: true },
  });

  logger.debug({ conversationId, userId, mutedUntil: effectiveUntil }, 'Mute set');
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

// ─── Disappearing Messages ───────────────────────────────────

const VALID_DISAPPEAR_DURATIONS = [null, 86400, 604800, 2592000]; // off, 24h, 7d, 30d

export async function setDisappearingMessages(
  conversationId: string,
  userId: string,
  disappearAfterSecs: number | null,
) {
  if (!VALID_DISAPPEAR_DURATIONS.includes(disappearAfterSecs)) {
    throw new NotFoundError('Invalid duration. Use null (off), 86400 (24h), 604800 (7d), or 2592000 (30d)');
  }

  await verifyParticipant(conversationId, userId);

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { disappearAfterSecs },
    select: { id: true, disappearAfterSecs: true },
  });

  logger.info({ conversationId, userId, disappearAfterSecs }, 'Disappearing messages updated');
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
  const [result] = await forwardMessageToMany(messageId, [targetConversationId], senderId);
  return result;
}

/**
 * Forward a message to multiple conversations in one request. Capped at
 * MAX_FORWARD_TARGETS to match WhatsApp's anti-spam constraint.
 */
export const MAX_FORWARD_TARGETS = 5;

export async function forwardMessageToMany(
  messageId: string,
  targetConversationIds: string[],
  senderId: string,
) {
  if (!Array.isArray(targetConversationIds) || targetConversationIds.length === 0) {
    throw new NotFoundError('At least one target conversation is required');
  }
  // Dedupe and cap.
  const targets = Array.from(new Set(targetConversationIds));
  if (targets.length > MAX_FORWARD_TARGETS) {
    throw new ForbiddenError(`Cannot forward to more than ${MAX_FORWARD_TARGETS} conversations at once`);
  }

  // Verify source message exists
  const original = await prisma.message.findUnique({
    where: { id: messageId },
    select: { content: true, imageUrl: true, audioUrl: true, audioDuration: true, conversationId: true, deletedAt: true },
  });
  if (!original) throw new NotFoundError('Message not found');
  if (original.deletedAt) throw new ForbiddenError('Cannot forward a deleted message');

  // Verify sender belongs to the source conversation — stops exfiltration
  // of content/media from chats they don't participate in.
  await verifyParticipant(original.conversationId, senderId);

  const forwarded = [];
  for (const target of targets) {
    await verifyParticipant(target, senderId);
    const msg = await sendMessage(target, senderId, original.content ?? '', {
      imageUrl: original.imageUrl ?? undefined,
      audioUrl: original.audioUrl ?? undefined,
      audioDuration: original.audioDuration ?? undefined,
      metadata: { isForwarded: true },
    });
    forwarded.push(msg);
  }

  logger.info({ messageId, targetCount: targets.length, senderId }, 'Message forwarded');
  return forwarded;
}

/**
 * Per-recipient read/delivered timestamps for a single message.
 * Powers the "message info" long-press sheet (who read it, when).
 */
export async function getMessageInfo(messageId: string, userId: string) {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, conversationId: true, senderId: true, createdAt: true },
  });
  if (!message) throw new NotFoundError('Message not found');

  await verifyParticipant(message.conversationId, userId);

  // Only the sender should see per-recipient delivery info.
  if (message.senderId !== userId) {
    throw new ForbiddenError('Only the sender can view message info');
  }

  const participants = await prisma.conversationParticipant.findMany({
    where: {
      conversationId: message.conversationId,
      userId: { not: userId },
      leftAt: null,
    },
    select: {
      userId: true,
      lastReadAt: true,
      lastDeliveredAt: true,
      user: { select: { displayName: true, avatarUrl: true } },
    },
  });

  return participants.map((p) => {
    const deliveredAt = p.lastDeliveredAt && p.lastDeliveredAt >= message.createdAt
      ? p.lastDeliveredAt
      : null;
    const readAt = p.lastReadAt && p.lastReadAt >= message.createdAt
      ? p.lastReadAt
      : null;
    return {
      userId: p.userId,
      displayName: p.user.displayName,
      avatarUrl: p.user.avatarUrl,
      deliveredAt,
      readAt,
    };
  });
}

// ─── Search Messages ──────────────────────────────────────────

/**
 * Search messages across ALL conversations the user participates in.
 */
export async function searchMessagesGlobal(
  userId: string,
  query: string,
) {
  // Get all conversation IDs the user is part of, along with their per-user
  // clearedAt floor so we can honor "Clear chat history".
  const participations = await prisma.conversationParticipant.findMany({
    where: { userId, leftAt: null },
    select: { conversationId: true, clearedAt: true },
  });
  if (participations.length === 0) return [];
  const conversationIds = participations.map((p) => p.conversationId);

  // Build per-conversation clearedAt filter as an OR of (conversationId, createdAt > clearedAt)
  // plus the set of conversations with no clearedAt at all.
  const clearedConvs = participations.filter((p) => p.clearedAt != null);
  const unclearedIds = participations.filter((p) => p.clearedAt == null).map((p) => p.conversationId);

  const convOr: any[] = [];
  if (unclearedIds.length > 0) convOr.push({ conversationId: { in: unclearedIds } });
  for (const p of clearedConvs) {
    convOr.push({ conversationId: p.conversationId, createdAt: { gt: p.clearedAt! } });
  }

  const messages = await prisma.message.findMany({
    where: {
      AND: [
        { conversationId: { in: conversationIds } },
        { deletedAt: null },
        { NOT: { deletedFor: { has: userId } } },
        { content: { contains: query, mode: 'insensitive' } },
        { OR: convOr },
      ],
    },
    include: {
      ...messageInclude,
      conversation: {
        select: {
          id: true,
          type: true,
          name: true,
          participants: {
            select: {
              user: { select: { id: true, displayName: true, avatarUrl: true } },
            },
          },
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: 50,
  });

  return messages;
}

/**
 * Search messages within a conversation by text content.
 */
export async function searchMessages(
  conversationId: string,
  userId: string,
  query: string,
) {
  const participant = await verifyParticipant(conversationId, userId);

  const messages = await prisma.message.findMany({
    where: {
      conversationId,
      deletedAt: null,
      NOT: { deletedFor: { has: userId } },
      content: { contains: query, mode: 'insensitive' },
      ...(participant.clearedAt ? { createdAt: { gt: participant.clearedAt } } : {}),
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

  // Set clearedAt so messages before this point are hidden for this user
  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { clearedAt: new Date(), lastReadAt: new Date() },
  });

  logger.info({ conversationId, userId }, 'Chat history cleared');
}
