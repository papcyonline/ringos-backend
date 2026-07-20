import { randomBytes, createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { env } from '../../config/env';
import { ForbiddenError, NotFoundError } from '../../shared/errors';
import { checkRateLimit } from '../../shared/redis.service';
import * as chatService from '../chat/chat.service';
import { broadcastAndNotifyMessage } from '../chat/chat.utils';

// Visitor session length. Refreshed on activity; a cron prunes past this.
const VISITOR_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Per-visitor send throttle.
const MSG_MAX = 20;
const MSG_WINDOW_SEC = 60;
// Per-origin session-creation throttle (blunts drive-by spam bots).
const SESSION_MAX = 10;
const SESSION_WINDOW_SEC = 60;

// ─── token/handle helpers ────────────────────────────────────────────

/** Opaque, URL-safe secret handed to the visitor's browser. Never persisted raw. */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
/** Short public slug used in the embed snippet. */
function newHandle(): string {
  return randomBytes(9).toString('base64url'); // ~12 chars
}
function hashIp(ip?: string): string | undefined {
  return ip ? createHash('sha256').update(ip).digest('hex').slice(0, 32) : undefined;
}

// ─── owner-facing (authenticated) ────────────────────────────────────

/** The owner's config, lazily created with a fresh handle on first access. */
export async function getOrCreateConfig(userId: string) {
  const existing = await prisma.widgetConfig.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.widgetConfig.create({
    data: { userId, handle: newHandle() },
  });
}

export async function updateConfig(
  userId: string,
  data: {
    enabled?: boolean;
    allowedDomains?: string[];
    theme?: Record<string, unknown>;
    offlineCapture?: boolean;
  },
) {
  await getOrCreateConfig(userId); // ensure a row exists
  return prisma.widgetConfig.update({
    where: { userId },
    data: {
      ...(data.enabled !== undefined && { enabled: data.enabled }),
      ...(data.allowedDomains !== undefined && {
        // Dedupe; the schema already normalised each host.
        allowedDomains: Array.from(new Set(data.allowedDomains)),
      }),
      ...(data.theme !== undefined && { theme: data.theme as Prisma.InputJsonValue }),
      ...(data.offlineCapture !== undefined && { offlineCapture: data.offlineCapture }),
    },
  });
}

/** New handle — instantly revokes every previously-pasted embed snippet. */
export async function regenerateHandle(userId: string) {
  await getOrCreateConfig(userId);
  return prisma.widgetConfig.update({
    where: { userId },
    data: { handle: newHandle() },
  });
}

/** The copy-paste snippet the owner drops on their site. */
export function buildEmbedSnippet(handle: string): string {
  return `<script src="${env.WIDGET_PUBLIC_URL}/widget.js" data-handle="${handle}" async></script>`;
}

export async function listVisitors(userId: string, limit = 100) {
  const config = await getOrCreateConfig(userId);
  return prisma.webVisitor.findMany({
    where: { widgetConfigId: config.id },
    orderBy: { lastSeenAt: 'desc' },
    take: Math.min(limit, 200),
    select: {
      id: true, name: true, email: true, originDomain: true,
      conversationId: true, blockedAt: true, createdAt: true, lastSeenAt: true,
    },
  });
}

/** Block a visitor: they can no longer start sessions or send messages. */
export async function blockVisitor(userId: string, visitorId: string) {
  const config = await getOrCreateConfig(userId);
  const visitor = await prisma.webVisitor.findFirst({
    where: { id: visitorId, widgetConfigId: config.id },
  });
  if (!visitor) throw new NotFoundError('Visitor not found');
  return prisma.webVisitor.update({
    where: { id: visitorId },
    data: { blockedAt: new Date() },
  });
}

// ─── public helpers ──────────────────────────────────────────────────

function isOriginAllowed(allowedDomains: string[], originHost?: string): boolean {
  // Secure default: no configured domains → the widget serves nobody.
  if (allowedDomains.length === 0 || !originHost) return false;
  const host = originHost.toLowerCase();
  return allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Load an ENABLED, origin-approved config by public handle, or throw. */
async function requireLiveConfig(handle: string, originHost?: string) {
  const config = await prisma.widgetConfig.findUnique({ where: { handle } });
  if (!config || !config.enabled) throw new NotFoundError('Widget not found');
  if (!isOriginAllowed(config.allowedDomains, originHost)) {
    throw new ForbiddenError('This widget is not enabled for this website');
  }
  return config;
}

/** Public bubble render data — no token required. */
export async function getPublicConfig(handle: string, originHost?: string) {
  const config = await requireLiveConfig(handle, originHost);
  const owner = await prisma.user.findUnique({
    where: { id: config.userId },
    select: { displayName: true, avatarUrl: true, isOnline: true },
  });
  return {
    handle: config.handle,
    theme: config.theme ?? {},
    offlineCapture: config.offlineCapture,
    owner: {
      displayName: owner?.displayName ?? 'Support',
      avatarUrl: owner?.avatarUrl ?? null,
      online: owner?.isOnline ?? false,
    },
  };
}

// ─── visitor sessions ────────────────────────────────────────────────

/** Resolve a live (non-blocked, non-expired) visitor by raw token, or throw. */
async function requireVisitor(token: string) {
  const visitor = await prisma.webVisitor.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { widgetConfig: true },
  });
  if (!visitor) throw new NotFoundError('Session not found');
  if (visitor.blockedAt) throw new ForbiddenError('This session has been blocked');
  if (visitor.expiresAt < new Date()) throw new ForbiddenError('Session expired');
  if (!visitor.widgetConfig.enabled) throw new ForbiddenError('Widget is disabled');
  return visitor;
}

/**
 * Start a new visitor session or resume an existing one. On first contact this
 * mints a shadow user (isWebVisitor) that stands in for the visitor in chat;
 * the WIDGET conversation itself is created lazily on the first message.
 */
export async function startSession(input: {
  handle: string;
  originHost?: string;
  visitorToken?: string;
  name?: string;
  email?: string;
  ip?: string;
  userAgent?: string;
}) {
  const config = await requireLiveConfig(input.handle, input.originHost);

  // Throttle session creation per origin/IP to blunt bot storms.
  const rl = await checkRateLimit(
    `widget:session:${config.id}:${hashIp(input.ip) ?? 'noip'}`,
    SESSION_MAX,
    SESSION_WINDOW_SEC,
  );
  if (!rl.allowed) throw new ForbiddenError('Too many attempts, please slow down');

  // Resume path.
  if (input.visitorToken) {
    const existing = await prisma.webVisitor.findUnique({
      where: { tokenHash: hashToken(input.visitorToken) },
    });
    if (existing && !existing.blockedAt && existing.widgetConfigId === config.id) {
      await prisma.webVisitor.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: new Date(),
          expiresAt: new Date(Date.now() + VISITOR_TTL_MS),
          ...(input.name && { name: input.name }),
          ...(input.email && { email: input.email }),
        },
      });
      return session(existing.id, input.visitorToken, existing.conversationId, config.userId);
    }
  }

  // Fresh session: shadow user + visitor row + new token.
  const token = newToken();
  const shadow = await prisma.user.create({
    data: {
      displayName: input.name?.trim() || 'Web visitor',
      isWebVisitor: true,
      isAnonymous: true,
      authProvider: 'WIDGET',
    },
    select: { id: true },
  });
  const visitor = await prisma.webVisitor.create({
    data: {
      widgetConfigId: config.id,
      shadowUserId: shadow.id,
      tokenHash: hashToken(token),
      name: input.name?.trim() || null,
      email: input.email?.trim() || null,
      ipHash: hashIp(input.ip) ?? null,
      userAgent: input.userAgent?.slice(0, 400) ?? null,
      originDomain: input.originHost ?? null,
      expiresAt: new Date(Date.now() + VISITOR_TTL_MS),
    },
  });
  logger.info({ visitorId: visitor.id, ownerId: config.userId }, 'Widget: new visitor session');
  return session(visitor.id, token, null, config.userId);
}

/** Shape the session response, including live owner presence. */
async function session(
  visitorId: string,
  visitorToken: string,
  conversationId: string | null,
  ownerId: string,
) {
  const owner = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { isOnline: true },
  });
  return {
    visitorId,
    visitorToken,
    conversationId,
    ownerOnline: owner?.isOnline ?? false,
  };
}

/**
 * Lazily create the owner ↔ shadow-user WIDGET conversation. The owner opted in
 * by enabling the widget, so this bypasses the normal DM privacy/follow gating.
 */
async function ensureConversation(visitor: {
  id: string;
  conversationId: string | null;
  shadowUserId: string;
  widgetConfig: { userId: string };
}): Promise<string> {
  if (visitor.conversationId) return visitor.conversationId;
  const conversation = await prisma.conversation.create({
    data: {
      type: 'WIDGET',
      status: 'ACTIVE',
      participants: {
        create: [
          { userId: visitor.widgetConfig.userId },
          { userId: visitor.shadowUserId },
        ],
      },
    },
    select: { id: true },
  });
  await prisma.webVisitor.update({
    where: { id: visitor.id },
    data: { conversationId: conversation.id },
  });
  return conversation.id;
}

/** Visitor sends a message → bridged into the owner's inbox (emit + push). */
export async function visitorSendMessage(
  token: string,
  content: string,
  clientMsgId?: string,
) {
  const visitor = await requireVisitor(token);

  const rl = await checkRateLimit(`widget:msg:${visitor.id}`, MSG_MAX, MSG_WINDOW_SEC);
  if (!rl.allowed) throw new ForbiddenError('Too many messages, please slow down');

  const conversationId = await ensureConversation(visitor);
  const message = await chatService.sendMessage(
    conversationId,
    visitor.shadowUserId,
    content,
    { clientMsgId },
  );

  // Deliver to the owner exactly like an app message: conversation room,
  // inbox rooms, push notification, background translation.
  broadcastAndNotifyMessage(message, conversationId, visitor.shadowUserId);

  await prisma.webVisitor.update({
    where: { id: visitor.id },
    data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + VISITOR_TTL_MS) },
  });
  return message;
}

/**
 * Visitor polls their thread. Returns messages after [since] (a message id),
 * oldest→newest, so the widget can append. Socket streaming can layer on later.
 */
export async function visitorGetMessages(token: string, since?: string, limit = 50) {
  const visitor = await requireVisitor(token);
  if (!visitor.conversationId) return { messages: [], conversationId: null };

  let after: Date | undefined;
  if (since) {
    const anchor = await prisma.message.findUnique({
      where: { id: since },
      select: { createdAt: true, conversationId: true },
    });
    // Ignore a cursor that isn't from this thread (can't leak other convos).
    if (anchor && anchor.conversationId === visitor.conversationId) {
      after = anchor.createdAt;
    }
  }

  const messages = await prisma.message.findMany({
    where: {
      conversationId: visitor.conversationId,
      deletedAt: null,
      ...(after && { createdAt: { gt: after } }),
    },
    orderBy: { createdAt: 'asc' },
    take: Math.min(limit, 100),
    select: {
      id: true,
      content: true,
      createdAt: true,
      senderId: true,
      imageUrl: true,
    },
  });

  // Tag each message from the visitor's perspective without exposing the
  // owner's raw user id.
  return {
    conversationId: visitor.conversationId,
    messages: messages.map((m) => ({
      id: m.id,
      content: m.content,
      createdAt: m.createdAt,
      imageUrl: m.imageUrl,
      fromVisitor: m.senderId === visitor.shadowUserId,
    })),
  };
}

/** Offline lead capture: store email + message so the owner can follow up. */
export async function captureLead(token: string, email: string, message: string) {
  const visitor = await requireVisitor(token);
  await prisma.$transaction([
    prisma.widgetLead.create({
      data: {
        widgetConfigId: visitor.widgetConfigId,
        visitorId: visitor.id,
        email,
        message,
      },
    }),
    prisma.webVisitor.update({
      where: { id: visitor.id },
      data: { email },
    }),
  ]);
  logger.info({ visitorId: visitor.id }, 'Widget: offline lead captured');
  return { ok: true };
}

// ─── maintenance ─────────────────────────────────────────────────────

/**
 * Prune visitors whose token has expired past a grace window, and their shadow
 * users (cascades drop the visitor row + participant links; the WIDGET
 * conversation is left for the owner's history). Call from a daily cron.
 */
export async function pruneExpiredVisitors(graceDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);
  const stale = await prisma.webVisitor.findMany({
    where: { expiresAt: { lt: cutoff } },
    select: { shadowUserId: true },
    take: 500,
  });
  if (stale.length === 0) return 0;
  // Deleting the shadow user cascades to the WebVisitor row.
  const { count } = await prisma.user.deleteMany({
    where: { id: { in: stale.map((v) => v.shadowUserId) }, isWebVisitor: true },
  });
  return count;
}
