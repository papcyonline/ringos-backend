import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { NotFoundError, ForbiddenError, BadRequestError } from '../../shared/errors';
import { isBlocked, blockUser } from '../safety/safety.service';
import { tryRecordMessageForStreak } from './streak.service';
import { getLimits } from '../../shared/usage.service';
import { detectScamSignals } from '../../shared/scam.service';
import * as cloudinaryService from '../../shared/cloudinary.service';

// Anti-scam throttle: accounts younger than this many days may open at most
// NEW_ACCOUNT_MAX_REQUESTS_PER_DAY stranger message-requests in a rolling
// 24h window. Established accounts are never throttled. Tunable.
const NEW_ACCOUNT_DAYS = 7;
const NEW_ACCOUNT_MAX_REQUESTS_PER_DAY = 5;

// Anti-pester: max messages one can send in a 1-on-1 chat WITHOUT the other
// person replying (a reply resets the counter). A pending/declined request's
// original requester gets the tight cap; accepted/mutual chats get the
// generous one that normal double-texting never trips. Tunable.
const UNANSWERED_LIMIT_REQUEST = 3;
const UNANSWERED_LIMIT_ACCEPTED = 10;
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

/** False if `host` is empty, a private literal IP, or resolves to any private address. */
async function isHostPublic(host: string): Promise<boolean> {
  if (!host) return false;
  if (net.isIP(host) && isPrivateIp(host)) return false;
  try {
    const addrs = await dns.lookup(host, { all: true });
    return !addrs.some(({ address }) => isPrivateIp(address));
  } catch {
    // DNS failure — treat as not fetchable.
    return false;
  }
}

const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 1_000_000; // 1 MB — OG tags live in <head>, no need for more.

/**
 * Fetch HTML from a user-supplied URL, re-validating the host at EVERY redirect
 * hop. Letting the scraper follow redirects only checks the first host, so a
 * redirect to 169.254.169.254 (or any internal address) would slip through —
 * this closes that SSRF gap. Returns null on any non-public hop, non-OK/non-HTML
 * response, timeout, or too many redirects.
 */
async function fetchPublicHtml(startUrl: string): Promise<string | null> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!(await isHostPublic(parsed.hostname))) return null;

    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(current, {
        redirect: 'manual', // we follow redirects ourselves to re-validate each host
        signal: AbortSignal.timeout(5000),
        headers: { Accept: 'text/html' },
      });
    } catch {
      return null;
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      res.body?.cancel().catch(() => {});
      if (!loc) return null;
      current = new URL(loc, current).toString(); // resolve relative redirects
      continue;
    }

    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    const ctype = res.headers.get('content-type') ?? '';
    if (ctype && !ctype.includes('text/html') && !ctype.includes('xml')) {
      res.body?.cancel().catch(() => {});
      return null;
    }

    return readCapped(res, MAX_HTML_BYTES);
  }
  return null; // too many redirects
}

/** Read a response body up to `maxBytes`, returning what was read (head is enough for OG tags). */
async function readCapped(
  res: Awaited<ReturnType<typeof fetch>>,
  maxBytes: number,
): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchLinkPreview(messageId: string, content: string) {
  try {
    const match = content.match(urlRegex);
    if (!match) return;

    const rawUrl = match[0];
    const urlStr = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;

    // Fetch the page ourselves, re-validating the host at every redirect hop so
    // a redirect can't bounce the request onto an internal address, then scrape
    // the vetted HTML (never letting the scraper hit the network directly).
    const html = await fetchPublicHtml(urlStr);
    if (!html) {
      logger.debug({ messageId }, 'Link preview skipped: URL not fetchable/public');
      return;
    }

    const { result } = await ogs({ html });
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
    select: { id: true, displayName: true, avatarUrl: true, isVerified: true, isWebVisitor: true },
  },
  replyTo: {
    select: {
      id: true,
      content: true,
      senderId: true,
      imageUrl: true,
      audioUrl: true,
      audioDuration: true,
      videoUrl: true,
      videoThumbnailUrl: true,
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

// In a SHARED widget inbox a teammate's reply must not badge the conversation
// unread for other staff — only the visitor's own messages count as unread.
// Non-widget conversations are unaffected (the first OR branch always matches).
const UNREAD_MESSAGE_FILTER = {
  OR: [
    { conversation: { type: { not: 'WIDGET' as const } } },
    { sender: { isWebVisitor: true } },
  ],
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
            select: {
              id: true,
              displayName: true,
              avatarUrl: true,
              isOnline: true,
              isVerified: true,
              lastSeenAt: true,
              hideOnlineStatus: true,
            },
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

  // Respect hideOnlineStatus — never leak presence of users who opted out.
  for (const p of conversation.participants) {
    if (p.user.hideOnlineStatus) {
      (p.user as { isOnline: boolean }).isOnline = false;
      (p.user as { lastSeenAt: Date | null }).lastSeenAt = null;
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
      status: 'ACTIVE',
      participants: {
        some: { userId, leftAt: null },
      },
      // Hide pending + declined message requests from the main inbox.
      // Requests live in a separate listing (getMessageRequests) so a
      // bad actor's spam can't push real conversations down the list.
      OR: [
        { requestStatus: null },
        { requestStatus: 'ACCEPTED' },
        // Sender's view: when *I* sent the pending request I still
        // see the conversation in my own inbox — they just haven't
        // accepted yet. The recipient is the one who needs the queue.
        { requestStatus: 'PENDING', requestedById: userId },
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
      messages: {
        // Exclude messages the requesting user has deleted-for-me so the
        // last-message preview reflects what THEY can still see.
        where: { NOT: { deletedFor: { has: userId } } },
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
          videoUrl: true,
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
      ...UNREAD_MESSAGE_FILTER,
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
        ...UNREAD_MESSAGE_FILTER,
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

  // 2a2) Website-widget origin domain per conversation, so the inbox tag can
  // name the site a visitor came from (useful when running several sites).
  const widgetVisitors = await prisma.webVisitor.findMany({
    where: { conversationId: { in: conversationIds } },
    select: { conversationId: true, originDomain: true },
  });
  const widgetDomainMap = new Map<string, string | null>();
  for (const v of widgetVisitors) {
    if (v.conversationId) widgetDomainMap.set(v.conversationId, v.originDomain ?? null);
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
      // Origin site for widget conversations (null if unknown).
      widgetDomain: c.type === 'WIDGET' ? (widgetDomainMap.get(c.id) ?? null) : undefined,
    };
  });

  logger.debug({ userId, count: results.length }, 'Listed conversations');
  return results;
}

/**
 * Mark all messages in a conversation as read for a user.
 *
 * Atomic transition: lastReadAt and the user's per-message notifications
 * (CHAT_MESSAGE / VOICE_NOTE for this conversation) are cleared together
 * inside a single DB transaction — either both succeed or both roll back,
 * so the notification inbox can never drift out of sync with the chat's
 * unread state. Mirrors WhatsApp/Telegram: opening a chat collapses both
 * the unread counter and the notification entries in one consistent step.
 */
export async function markConversationAsRead(conversationId: string, userId: string) {
  await verifyParticipant(conversationId, userId);

  const now = new Date();
  // The lastReadAt guard prevents out-of-order requests from regressing it.
  await prisma.$transaction([
    prisma.conversationParticipant.updateMany({
      where: {
        conversationId,
        userId,
        OR: [
          { lastReadAt: null },
          { lastReadAt: { lt: now } },
        ],
      },
      data: { lastReadAt: now },
    }),
    prisma.notification.updateMany({
      where: {
        userId,
        isRead: false,
        type: { in: ['CHAT_MESSAGE', 'VOICE_NOTE'] },
        data: { path: ['conversationId'], equals: conversationId },
      },
      data: { isRead: true },
    }),
  ]);

  // Shared widget inbox: one staff member reading the thread marks it read for
  // the whole team (their unread clears on next sync). The visitor's own read
  // state is irrelevant, so only staff (non web-visitor) participants advance.
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { type: true },
  });
  if (conv?.type === 'WIDGET') {
    const staff = await prisma.conversationParticipant.findMany({
      where: { conversationId, userId: { not: userId }, user: { isWebVisitor: false } },
      select: { userId: true },
    });
    if (staff.length > 0) {
      await prisma.conversationParticipant.updateMany({
        where: {
          conversationId,
          userId: { in: staff.map((s) => s.userId) },
          OR: [{ lastReadAt: null }, { lastReadAt: { lt: now } }],
        },
        data: { lastReadAt: now },
      });
    }
  }

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

  // Gate the new conversation against the recipient's privacy + follow
  // graph. Three outcomes:
  //   NOBODY            → reject outright.
  //   FOLLOWING + not-followed → reject outright.
  //   EVERYONE + not-followed → create as PENDING request (no push).
  //   Otherwise         → create normally (requestStatus stays NULL).
  const [target, recipientFollowsSender] = await Promise.all([
    prisma.user.findUnique({
      where: { id: targetUserId },
      select: { messagePrivacy: true },
    }),
    prisma.follow.findFirst({
      where: { followerId: targetUserId, followingId: userId },
      select: { id: true },
    }),
  ]);
  if (!target) {
    throw new NotFoundError('User not found');
  }
  const privacy = target.messagePrivacy;
  const isFollowedBack = !!recipientFollowsSender;

  if (privacy === 'NOBODY') {
    throw new ForbiddenError('This user does not accept direct messages');
  }
  if (privacy === 'FOLLOWING' && !isFollowedBack) {
    throw new ForbiddenError('This user only accepts messages from people they follow');
  }

  const isRequest = privacy === 'EVERYONE' && !isFollowedBack;

  // Anti-scam throttle: a brand-new account can only open a handful of
  // stranger message-requests per day. This strangles mass DM-blasting
  // without touching established users (they never hit this branch's age
  // gate) or normal follow-back / mutual conversations (not requests).
  if (isRequest) {
    const sender = await prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });
    const ageMs = sender ? Date.now() - sender.createdAt.getTime() : Number.POSITIVE_INFINITY;
    if (ageMs < NEW_ACCOUNT_DAYS * 24 * 60 * 60 * 1000) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentRequests = await prisma.conversation.count({
        where: { requestedById: userId, createdAt: { gte: since } },
      });
      if (recentRequests >= NEW_ACCOUNT_MAX_REQUESTS_PER_DAY) {
        throw new ForbiddenError(
          "You've reached today's limit for new message requests. Please try again tomorrow.",
        );
      }
    }
  }

  const conversation = await prisma.conversation.create({
    data: {
      type: 'HUMAN_MATCHED',
      status: 'ACTIVE',
      ...(isRequest
        ? { requestStatus: 'PENDING' as const, requestedById: userId }
        : {}),
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

  logger.info(
    { conversationId: conversation.id, userId, targetUserId, isRequest },
    isRequest ? 'Created direct conversation as message request' : 'Created direct conversation',
  );
  return conversation;
}

/**
 * Prisma `where` that defines a genuine, recipient-facing message request.
 * Shared by the list query AND the digest count job so the two can never
 * drift (a mismatch is what made the digest report "16" when the screen
 * showed 1). A request only counts when a stranger has actually sent a
 * real, still-visible message — see the inline notes.
 */
export function messageRequestWhere(userId: string) {
  return {
    status: 'ACTIVE' as const,
    requestStatus: 'PENDING' as const,
    // Only return conversations the *recipient* is looking at —
    // a sender's pending request shows up in their normal inbox.
    requestedById: { not: userId },
    participants: { some: { userId, leftAt: null } },
    // Require a real message — a stranger merely *opening* the DM creates
    // a pending conversation, but it isn't a request until they actually
    // send something. Excludes ghost/empty requests.
    messages: {
      some: {
        isSystem: false,
        NOT: { deletedFor: { has: userId } },
      },
    },
  };
}

/**
 * Record that the user just opened their message-requests inbox. Stamps
 * `lastRequestCheckAt` so the "you have N message requests" push digest only
 * counts requests that arrive after this moment (not ones already reviewed).
 */
export async function markMessageRequestsSeen(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { lastRequestCheckAt: new Date() },
  });
}

/**
 * Pending message requests addressed to this user (i.e. someone who
 * doesn't follow them initiated a DM). Mirrors the shape of
 * getConversations so the frontend can render with the same widgets.
 */
export async function getMessageRequests(userId: string) {
  return prisma.conversation.findMany({
    where: messageRequestWhere(userId),
    include: {
      participants: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true, verifiedRole: true, location: true, lastSeenAt: true },
          },
        },
      },
      messages: {
        where: { NOT: { deletedFor: { has: userId } } },
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
          imageUrls: true,
          audioUrl: true,
          videoUrl: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });
}

/**
 * Accept a pending message request. Flips the conversation to a
 * normal accepted state so future messages push, and the conversation
 * appears in the main inbox.
 */
export async function acceptMessageRequest(userId: string, conversationId: string) {
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, requestStatus: true, requestedById: true, participants: { select: { userId: true } } },
  });
  if (!convo) throw new NotFoundError('Conversation not found');
  // Only the *recipient* (not the sender of the original request) can accept.
  const isParticipant = convo.participants.some((p) => p.userId === userId);
  if (!isParticipant || convo.requestedById === userId) {
    throw new ForbiddenError('You cannot accept this request');
  }
  if (convo.requestStatus !== 'PENDING') {
    throw new ForbiddenError('This conversation is not a pending request');
  }
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { requestStatus: 'ACCEPTED', acceptedAt: new Date() },
  });
}

/**
 * Decline a pending message request. The conversation is hidden from
 * the recipient's inbox; the sender still sees it in theirs but can't
 * promote it without the recipient accepting.
 */
export async function declineMessageRequest(userId: string, conversationId: string) {
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, requestStatus: true, requestedById: true, participants: { select: { userId: true } } },
  });
  if (!convo) throw new NotFoundError('Conversation not found');
  const isParticipant = convo.participants.some((p) => p.userId === userId);
  if (!isParticipant || convo.requestedById === userId) {
    throw new ForbiddenError('You cannot decline this request');
  }
  if (convo.requestStatus !== 'PENDING') {
    throw new ForbiddenError('This conversation is not a pending request');
  }
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { requestStatus: 'DECLINED', declinedAt: new Date() },
  });
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
        // Hide messages this user has deleted-for-me from the preview.
        where: { NOT: { deletedFor: { has: userId } } },
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
        ...UNREAD_MESSAGE_FILTER,
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
        ...UNREAD_MESSAGE_FILTER,
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
        ...UNREAD_MESSAGE_FILTER,
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
        ...UNREAD_MESSAGE_FILTER,
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
    /** Client-generated UUID for idempotent send. If a message with this
     *  id already exists from this sender we short-circuit and return it,
     *  so a retried send (flaky network) doesn't create a duplicate row. */
    clientMsgId?: string;
    imageUrl?: string;
    /** Album of 2+ images. When set, imageUrl is forced to imageUrls[0] so
     *  pre-album clients still render the first photo. */
    imageUrls?: string[];
    viewOnce?: boolean;
    audioUrl?: string;
    audioDuration?: number;
    videoUrl?: string;
    videoThumbnailUrl?: string;
    videoDuration?: number;
    metadata?: Record<string, any>;
  },
) {
  const {
    replyToId,
    clientMsgId,
    imageUrl: rawImageUrl,
    imageUrls: rawImageUrls,
    viewOnce,
    audioUrl,
    audioDuration,
    videoUrl,
    videoThumbnailUrl,
    videoDuration,
    metadata,
  } = options ?? {};

  // Idempotency short-circuit. The client retries on flaky networks
  // (mid-send drop, app restart, etc.); without this, every retry would
  // create a duplicate row. We scope by senderId as a belt-and-suspenders
  // check even though clientMsgId is globally unique.
  if (clientMsgId) {
    const existing = await prisma.message.findUnique({
      where: { clientMsgId },
      include: messageInclude,
    });
    if (existing) {
      if (existing.senderId !== senderId) {
        // Same UUID from a different user — astronomically unlikely (it'd
        // mean a UUID collision or a client bug). Refuse to leak someone
        // else's message back.
        throw new ForbiddenError('clientMsgId mismatch');
      }
      logger.debug({ clientMsgId, messageId: existing.id }, 'Idempotent send: returning existing message');
      return existing;
    }
  }

  // Normalize: an album always carries the array; a single image still
  // populates the legacy imageUrl field. Mirroring imageUrls[0] keeps
  // old clients (and existing message-list code paths that read imageUrl)
  // happy without forking every reader.
  const imageUrls = rawImageUrls && rawImageUrls.length > 0 ? rawImageUrls : undefined;
  const imageUrl = imageUrls ? imageUrls[0] : rawImageUrl;

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

  // Group content control: only admins may post links when enabled. Rejected
  // with a permanent code so the client treats it as non-retryable (same as
  // the no-reply gate) instead of re-driving it into the check.
  if (
    conversation.type === 'GROUP' &&
    conversation.adminsOnlyLinks &&
    participant.role !== 'ADMIN' &&
    content &&
    urlRegex.test(content)
  ) {
    throw new BadRequestError(
      'Only admins can post links in this group.',
      'GROUP_RESTRICTED',
    );
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

  // ── Anti-pester: no-reply gating ────────────────────────────
  // Cap how many messages you can send in a row without the other person
  // replying — stops one-sided message-bombing without ever reading content.
  // Skips groups. The idempotency short-circuit above means a retried send of
  // the SAME message (same clientMsgId) never reaches here, so honest retries
  // aren't penalised.
  if (conversation.type !== 'GROUP') {
    const isRequester = conversation.requestedById === senderId;
    const tightTier =
      isRequester &&
      (conversation.requestStatus === 'PENDING' || conversation.requestStatus === 'DECLINED');
    const limit = tightTier ? UNANSWERED_LIMIT_REQUEST : UNANSWERED_LIMIT_ACCEPTED;

    // The other participant's most recent real message is the "reply" that
    // resets the counter. Null if they've never replied.
    const lastPartnerMsg = await prisma.message.findFirst({
      where: { conversationId, senderId: { not: senderId }, isSystem: false },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const unanswered = await prisma.message.count({
      where: {
        conversationId,
        senderId,
        isSystem: false,
        ...(lastPartnerMsg ? { createdAt: { gt: lastPartnerMsg.createdAt } } : {}),
      },
    });
    if (unanswered >= limit) {
      throw new BadRequestError(
        'Wait for a reply before sending more messages.',
        'REPLY_REQUIRED',
      );
    }
  }

  // Compute message expiry if conversation has disappearing messages enabled
  const disappearSecs = (conversation as any).disappearAfterSecs as number | null;
  const expiresAt = disappearSecs
    ? new Date(Date.now() + disappearSecs * 1000)
    : undefined;

  // A declined request that the *recipient* (the one who declined) now
  // replies to is an implicit accept — promote it to ACCEPTED so the
  // conversation reappears in both inboxes (the list query hides DECLINED).
  // The original requester sending again does NOT un-decline it, so
  // declined spam can't force its way back in.
  const promoteDeclined =
    conversation.requestStatus === 'DECLINED' &&
    conversation.requestedById !== senderId;

  // Scam-signal detection. detectScamSignals is pure + synchronous (no I/O),
  // so it rides inline and the warning ships WITH the message in real time —
  // it never blocks or fails the send. Scans all 1-on-1 DMs (not just stranger
  // requests): a scammer who gets a follow-back would otherwise escape, and the
  // warning is a soft recipient-only tip so false positives are low-cost. Group
  // chats are excluded.
  const scam =
    content && conversation.type !== 'GROUP'
      ? detectScamSignals(content)
      : { warn: false, categories: [] as string[] };

  // Create message and update conversation timestamp in parallel
  const [message] = await Promise.all([
    prisma.message.create({
      data: {
        conversationId,
        senderId,
        content,
        scamWarning: scam.warn,
        clientMsgId: clientMsgId || undefined,
        replyToId: replyToId || undefined,
        imageUrl: imageUrl || undefined,
        imageUrls: imageUrls ?? [],
        viewOnce: viewOnce || false,
        audioUrl: audioUrl || undefined,
        audioDuration: audioDuration ?? undefined,
        videoUrl: videoUrl || undefined,
        videoThumbnailUrl: videoThumbnailUrl || undefined,
        videoDuration: videoDuration ?? undefined,
        metadata: metadata ?? undefined,
        expiresAt,
      },
      include: messageInclude,
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: promoteDeclined
        ? { updatedAt: new Date(), requestStatus: 'ACCEPTED', acceptedAt: new Date() }
        : { updatedAt: new Date() },
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

  // Async: persist a ScamFlag for the review queue (fire-and-forget). The
  // recipient-facing warning already shipped via scamWarning above; this is
  // just the internal audit log, so a failure here must not affect the send.
  if (scam.categories.length > 0 && conversation.type !== 'GROUP') {
    void (async () => {
      try {
        const others = await prisma.conversationParticipant.findMany({
          where: { conversationId, userId: { not: senderId }, leftAt: null },
          select: { userId: true },
        });
        const recipientId = others[0]?.userId;
        if (!recipientId) return;
        await prisma.scamFlag.create({
          data: {
            senderId,
            recipientId,
            conversationId,
            messageId: message.id,
            categories: scam.categories,
            snippet: content.slice(0, 280),
          },
        });
        logger.info(
          { messageId: message.id, senderId, categories: scam.categories, warn: scam.warn },
          'Scam signal flagged',
        );
      } catch (err) {
        logger.error({ err, messageId: message.id }, 'Scam flag write failed');
      }
    })();
  }

  // Streak update for 1-on-1 chats only. Group messages don't form
  // pairwise streaks. Best-effort, never blocks the send path.
  if (conversation.type !== 'GROUP') {
    void (async () => {
      const others = await prisma.conversationParticipant.findMany({
        where: { conversationId, userId: { not: senderId }, leftAt: null },
        select: { userId: true },
      });
      const partnerId = others[0]?.userId;
      if (partnerId) await tryRecordMessageForStreak(senderId, partnerId);
    })();
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

  await cleanupMediaUrls([message.imageUrl, ...message.imageUrls, message.audioUrl]);

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

  await cleanupMediaUrls([message.imageUrl, ...message.imageUrls, message.audioUrl]);

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
 * Idempotent reaction setter. The client sends the desired final state
 * ('add' / 'remove') instead of "toggle", so a retried tap after a flaky
 * network can't silently flip the reaction the wrong way. Returns the
 * same payload shape as toggleReaction for the broadcast handler.
 */
export async function setReaction(
  messageId: string,
  userId: string,
  emoji: string,
  desired: 'add' | 'remove',
) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) throw new NotFoundError('Message not found');
  if (message.deletedAt) throw new ForbiddenError('Cannot react to a deleted message');

  await verifyParticipant(message.conversationId, userId);

  const existing = await prisma.messageReaction.findUnique({
    where: { messageId_userId_emoji: { messageId, userId, emoji } },
  });

  if (desired === 'add') {
    if (existing) {
      // Already present — idempotent no-op. Return the current state so
      // the broadcast still confirms to other clients (cheap, and avoids
      // the client wondering why nothing changed).
      const reaction = await prisma.messageReaction.findUnique({
        where: { id: existing.id },
        include: { user: { select: { displayName: true } } },
      });
      return {
        action: 'added' as const,
        emoji,
        userId,
        messageId,
        conversationId: message.conversationId,
        displayName: reaction?.user.displayName,
      };
    }
    const reaction = await prisma.messageReaction.create({
      data: { messageId, userId, emoji },
      include: { user: { select: { displayName: true } } },
    });
    logger.debug({ messageId, userId, emoji, action: 'added' }, 'Reaction set');
    return {
      action: 'added' as const,
      emoji,
      userId,
      messageId,
      conversationId: message.conversationId,
      displayName: reaction.user.displayName,
    };
  }

  // desired === 'remove'
  if (existing) {
    await prisma.messageReaction.delete({ where: { id: existing.id } });
  }
  logger.debug({ messageId, userId, emoji, action: 'removed' }, 'Reaction set');
  return {
    action: 'removed' as const,
    emoji,
    userId,
    messageId,
    conversationId: message.conversationId,
  };
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

  // Idempotent: also accept callers whose participant row already has
  // leftAt set (they tapped delete twice / race with socket refresh).
  // In that case we still want to make sure the conversation is ENDED
  // for DMs and return success.
  const existingParticipant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!existingParticipant) {
    throw new NotFoundError('Conversation not found');
  }

  const isGroupLike = conversation.type === 'GROUP';
  const now = new Date();

  if (isGroupLike) {
    // Groups / channels: caller leaves, the conversation stays alive for
    // everyone else. Idempotent if they already left.
    if (existingParticipant.leftAt == null) {
      await prisma.conversationParticipant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { leftAt: now },
      });
      logger.info({ conversationId, userId }, 'Participant left group/channel');
    }
    return conversation;
  }

  // Direct 1-on-1 conversation: end the conversation (once) and mark the
  // caller as left (once). Either or both may already be true — that's
  // still success, not an error.
  const updates: Promise<unknown>[] = [];
  if (conversation.status !== 'ENDED') {
    updates.push(
      prisma.conversation.update({
        where: { id: conversationId },
        data: { status: 'ENDED' },
      }),
    );
  }
  if (existingParticipant.leftAt == null) {
    updates.push(
      prisma.conversationParticipant.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { leftAt: now },
      }),
    );
  }
  if (updates.length > 0) {
    await prisma.$transaction(updates as any);
    logger.info({ conversationId, userId }, 'Direct conversation ended');
  } else {
    logger.debug({ conversationId, userId }, 'Direct conversation already ended — no-op');
  }

  return { ...conversation, status: 'ENDED' as const };
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

  // Check if user has cleared chat history — hide messages before clearedAt.
  // Also grab lastReadAt (the read boundary) so the client can place the
  // "unread" divider accurately — captured here, BEFORE markAsRead runs.
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { clearedAt: true, lastReadAt: true },
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
    // Flat flag mirroring formatMessagePayload — visitor left, staff right.
    fromVisitor: !!(msg as { sender?: { isWebVisitor?: boolean } }).sender?.isWebVisitor,
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
    // Read boundary at fetch time — the client anchors the unread divider at
    // the first message newer than this (immune to stale conversation counts).
    myLastReadAt: participant?.lastReadAt ?? null,
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

  // Drop a system message into the conversation so both sides see a
  // persistent record of who turned it on/off and at what duration —
  // matches WhatsApp. The frontend already renders isSystem messages
  // as centred grey text. Metadata.type lets the client localise the
  // string later if we want ("You" vs the actor's name).
  const actor = await prisma.user.findUnique({
    where: { id: userId },
    select: { displayName: true },
  });
  const actorName = actor?.displayName ?? 'Someone';
  const durationLabel = _disappearLabel(disappearAfterSecs);
  const content = disappearAfterSecs == null
    ? `${actorName} turned off disappearing messages`
    : `${actorName} turned on disappearing messages. New messages disappear after ${durationLabel}.`;

  const sysMsg = await prisma.message.create({
    data: {
      conversationId,
      senderId: userId,
      content,
      isSystem: true,
      metadata: {
        type: 'disappearing_changed',
        actorId: userId,
        ttl: disappearAfterSecs,
      },
    },
    include: messageInclude,
  });

  logger.info({ conversationId, userId, disappearAfterSecs }, 'Disappearing messages updated');
  return { ...updated, systemMessage: sysMsg };
}

function _disappearLabel(seconds: number | null): string {
  switch (seconds) {
    case 86400:
      return '24 hours';
    case 604800:
      return '7 days';
    case 2592000:
      return '30 days';
    default:
      return '';
  }
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
  clientMsgId?: string,
) {
  const [result] = await forwardMessageToMany(
    messageId,
    [targetConversationId],
    senderId,
    clientMsgId ? [clientMsgId] : undefined,
  );
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
  /** Optional client-generated UUIDs, parallel to targetConversationIds.
   *  Lets a retried forward dedup per target so a flaky network can't
   *  produce duplicate copies in any of the destination chats. */
  clientMsgIds?: string[],
) {
  if (!Array.isArray(targetConversationIds) || targetConversationIds.length === 0) {
    throw new NotFoundError('At least one target conversation is required');
  }
  // Dedupe and cap. We dedupe targets but preserve the original index
  // into clientMsgIds so each surviving target keeps its matching UUID.
  const seen = new Set<string>();
  const targetsWithIds: { target: string; clientMsgId: string | undefined }[] = [];
  for (let i = 0; i < targetConversationIds.length; i++) {
    const target = targetConversationIds[i];
    if (seen.has(target)) continue;
    seen.add(target);
    targetsWithIds.push({ target, clientMsgId: clientMsgIds?.[i] });
  }
  if (targetsWithIds.length > MAX_FORWARD_TARGETS) {
    throw new ForbiddenError(`Cannot forward to more than ${MAX_FORWARD_TARGETS} conversations at once`);
  }

  // Verify source message exists
  const original = await prisma.message.findUnique({
    where: { id: messageId },
    select: { content: true, imageUrl: true, imageUrls: true, audioUrl: true, audioDuration: true, conversationId: true, deletedAt: true },
  });
  if (!original) throw new NotFoundError('Message not found');
  if (original.deletedAt) throw new ForbiddenError('Cannot forward a deleted message');

  // Verify sender belongs to the source conversation — stops exfiltration
  // of content/media from chats they don't participate in.
  await verifyParticipant(original.conversationId, senderId);

  const forwarded = [];
  for (const { target, clientMsgId } of targetsWithIds) {
    await verifyParticipant(target, senderId);
    const msg = await sendMessage(target, senderId, original.content ?? '', {
      clientMsgId,
      imageUrl: original.imageUrl ?? undefined,
      imageUrls: original.imageUrls.length > 0 ? original.imageUrls : undefined,
      audioUrl: original.audioUrl ?? undefined,
      audioDuration: original.audioDuration ?? undefined,
      metadata: { isForwarded: true },
    });
    forwarded.push(msg);
  }

  logger.info({ messageId, targetCount: targetsWithIds.length, senderId }, 'Message forwarded');
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
//
// Message content is encrypted at rest, so we can't filter with a SQL
// `content contains` (that would only match legacy plaintext). Instead we scan
// the most recent messages that pass the non-content filters — content is
// decrypted transparently on read (see config/database middleware) — and match
// in app code. Trade-off: matches older than the scan window aren't returned.
const MESSAGE_SEARCH_SCAN_LIMIT = 5000;
const MESSAGE_SEARCH_RESULT_LIMIT = 50;

/// Scan recent messages matching [where], decrypt, and return the ids of up to
/// [MESSAGE_SEARCH_RESULT_LIMIT] whose content contains [q] (already lowered).
async function _matchMessageIds(where: any, q: string): Promise<string[]> {
  const rows = await prisma.message.findMany({
    where,
    select: { id: true, content: true },
    orderBy: [{ createdAt: 'desc' }],
    take: MESSAGE_SEARCH_SCAN_LIMIT,
  });
  const ids: string[] = [];
  for (const r of rows) {
    if (typeof r.content === 'string' && r.content.toLowerCase().includes(q)) {
      ids.push(r.id);
      if (ids.length >= MESSAGE_SEARCH_RESULT_LIMIT) break;
    }
  }
  return ids;
}

/**
 * Search messages across ALL conversations the user participates in.
 */
export async function searchMessagesGlobal(
  userId: string,
  query: string,
) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

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

  const ids = await _matchMessageIds(
    {
      AND: [
        { conversationId: { in: conversationIds } },
        { deletedAt: null },
        { NOT: { deletedFor: { has: userId } } },
        { OR: convOr },
      ],
    },
    q,
  );
  if (ids.length === 0) return [];

  const messages = await prisma.message.findMany({
    where: { id: { in: ids } },
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
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const ids = await _matchMessageIds(
    {
      conversationId,
      deletedAt: null,
      NOT: { deletedFor: { has: userId } },
      ...(participant.clearedAt ? { createdAt: { gt: participant.clearedAt } } : {}),
    },
    q,
  );
  if (ids.length === 0) return [];

  const messages = await prisma.message.findMany({
    where: { id: { in: ids } },
    include: messageInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
