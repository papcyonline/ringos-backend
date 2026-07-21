import { randomBytes, createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';
import { env } from '../../config/env';
import { ForbiddenError, NotFoundError } from '../../shared/errors';
import { checkRateLimit } from '../../shared/redis.service';
import { getIO } from '../../config/socket';
import * as chatService from '../chat/chat.service';
import { broadcastAndNotifyMessage } from '../chat/chat.utils';
import { fileToChatImageUrl } from '../../shared/upload';
import { createNotification, sendPushToUser } from '../notification/notification.service';
import { setOnline, setOffline } from '../user/user.service';

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
      country: true, city: true, pageUrl: true, referrer: true,
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
    // Device-aware "Powered by Yomeet" target (widget picks by user-agent).
    stores: {
      ios: env.APP_STORE_URL ?? 'https://yomeet.app',
      android: env.PLAY_STORE_URL ?? 'https://yomeet.app',
      web: 'https://yomeet.app',
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

/** Resolve a visitor's live conversation for the SSE stream (throws if invalid). */
export async function resolveVisitorStream(
  token: string,
): Promise<{ conversationId: string | null; shadowUserId: string; ownerId: string }> {
  const visitor = await requireVisitor(token);
  return {
    conversationId: visitor.conversationId,
    shadowUserId: visitor.shadowUserId,
    ownerId: visitor.widgetConfig.userId,
  };
}

// ─── presence + read receipts (owner-facing) ─────────────────────────
// The owner's app treats the visitor's shadow user like any chat peer: it
// reacts to `user:online`/`user:offline` and `chat:read` events keyed by the
// shadow user id. We emit those on the visitor's behalf so the owner sees the
// visitor connect/leave and sees their sent messages turn "read".

// Live SSE connections per shadow user. Presence = "has an open stream". A short
// grace on disconnect absorbs EventSource's auto-reconnect flapping.
const presence = new Map<string, { count: number; offlineTimer?: ReturnType<typeof setTimeout> }>();
const PRESENCE_GRACE_MS = 8000;

export async function widgetPresenceConnect(shadowUserId: string, ownerId: string): Promise<void> {
  let p = presence.get(shadowUserId);
  if (!p) {
    p = { count: 0 };
    presence.set(shadowUserId, p);
  }
  if (p.offlineTimer) {
    clearTimeout(p.offlineTimer);
    p.offlineTimer = undefined;
  }
  p.count += 1;
  if (p.count === 1) {
    await setOnline(shadowUserId).catch(() => {});
    getIO().to(`user:${ownerId}`).emit('user:online', { userId: shadowUserId });
  }
}

export function widgetPresenceDisconnect(shadowUserId: string, ownerId: string): void {
  const p = presence.get(shadowUserId);
  if (!p) return;
  p.count = Math.max(0, p.count - 1);
  if (p.count > 0) return;
  if (p.offlineTimer) clearTimeout(p.offlineTimer);
  p.offlineTimer = setTimeout(() => {
    const cur = presence.get(shadowUserId);
    if (!cur || cur.count > 0) return; // reconnected within the grace window
    presence.delete(shadowUserId);
    setOffline(shadowUserId).catch(() => {});
    getIO()
      .to(`user:${ownerId}`)
      .emit('user:offline', { userId: shadowUserId, lastSeenAt: new Date().toISOString() });
  }, PRESENCE_GRACE_MS);
}

/**
 * Visitor has read the thread → advance the shadow user's read cursor and tell
 * the owner (blue ticks). Mirrors the app's chat:read gateway handler.
 */
export async function visitorMarkRead(token: string): Promise<void> {
  const visitor = await requireVisitor(token);
  if (!visitor.conversationId) return;
  await chatService.markConversationAsRead(visitor.conversationId, visitor.shadowUserId);
  const payload = { conversationId: visitor.conversationId, userId: visitor.shadowUserId };
  getIO().to(`user:${visitor.widgetConfig.userId}`).emit('chat:read', payload);
  getIO().to(`conversation:${visitor.conversationId}`).emit('chat:read', payload);
}

/** Visitor is typing → show it in the owner's app chat (reuses chat:typing). */
export async function visitorTyping(token: string): Promise<void> {
  const visitor = await requireVisitor(token);
  if (!visitor.conversationId) return;
  getIO().to(`conversation:${visitor.conversationId}`).emit('chat:typing', {
    conversationId: visitor.conversationId,
    userId: visitor.shadowUserId,
    activity: 'typing',
  });
}

// ── live-chat visitor context ────────────────────────────────────────

/** CF-IPCountry 2-letter code → country name (built-in Intl, no dep/table). */
function countryName(code?: string): string | undefined {
  if (!code || code === 'XX' || code === 'T1') return undefined;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort city lookup by IP. Non-fatal, short timeout — never blocks a session. */
async function lookupCity(ip?: string): Promise<string | undefined> {
  if (!ip || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip === '::1') return undefined;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city`,
      { signal: ctrl.signal },
    );
    clearTimeout(timer);
    const d = (await r.json()) as { status?: string; city?: string };
    return d.status === 'success' && d.city ? d.city : undefined;
  } catch {
    return undefined;
  }
}

/** Friendly "Chrome on Windows" from a user-agent. */
function parseUA(ua?: string | null): string | undefined {
  if (!ua) return undefined;
  const os = /Windows/.test(ua) ? 'Windows'
    : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Android/.test(ua) ? 'Android'
    : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : '';
  return br && os ? `${br} on ${os}` : (br || os || undefined);
}

/** Compact "site.com/pricing" from a URL. */
function shortUrl(u?: string | null): string | undefined {
  if (!u) return undefined;
  try {
    const x = new URL(u);
    return (x.hostname + x.pathname).replace(/\/$/, '') || x.hostname;
  } catch {
    return undefined;
  }
}

/** The context line shown at the top of the owner's WIDGET conversation. */
function contextLine(v: {
  country?: string | null; city?: string | null; userAgent?: string | null;
  pageUrl?: string | null; referrer?: string | null; email?: string | null;
}): string | null {
  const parts: string[] = [];
  if (v.email) parts.push('✉️ ' + v.email);
  const loc = [v.city, v.country].filter(Boolean).join(', ');
  if (loc) parts.push('🌍 ' + loc);
  const dev = parseUA(v.userAgent);
  if (dev) parts.push('💻 ' + dev);
  const page = shortUrl(v.pageUrl);
  if (page) parts.push('📄 ' + page);
  const ref = shortUrl(v.referrer);
  if (ref) parts.push('🔗 via ' + ref);
  return parts.length ? '👋 New website visitor\n' + parts.join('  ·  ') : null;
}

/**
 * Mint the shadow User that represents a visitor in chat. displayName is a
 * GLOBALLY-unique username (case-insensitive), so anonymous visitors can't all
 * be "Web visitor" — append a random suffix and retry on the rare collision.
 */
async function createShadowUser(name?: string): Promise<string> {
  const base = (name?.trim() || 'Web visitor').slice(0, 40);
  for (let attempt = 0; attempt < 6; attempt++) {
    // Try the clean name first so a visitor who typed "John" shows as "John".
    // Only on an actual collision do we disambiguate with a short suffix.
    const displayName = attempt === 0 ? base : `${base} ${randomBytes(3).toString('hex')}`;
    try {
      const user = await prisma.user.create({
        data: { displayName, isWebVisitor: true, isAnonymous: true, authProvider: 'WIDGET' },
        select: { id: true },
      });
      return user.id;
    } catch (err) {
      // P2002 = unique-constraint violation on displayName → suffix + retry.
      if ((err as { code?: string })?.code === 'P2002') continue;
      throw err;
    }
  }
  throw new Error('Could not allocate a unique visitor name');
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
  country?: string; // CF-IPCountry code
  pageUrl?: string;
  referrer?: string;
}) {
  const config = await requireLiveConfig(input.handle, input.originHost);

  // Throttle session creation per origin/IP to blunt bot storms.
  const rl = await checkRateLimit(
    `widget:session:${config.id}:${hashIp(input.ip) ?? 'noip'}`,
    SESSION_MAX,
    SESSION_WINDOW_SEC,
  );
  if (!rl.allowed) throw new ForbiddenError('Too many attempts, please slow down');

  // Resolve visitor context (best-effort; city lookup is capped + non-fatal).
  const country = countryName(input.country);
  const city = await lookupCity(input.ip);

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
          ...(country && { country }),
          ...(city && { city }),
          ...(input.pageUrl && { pageUrl: input.pageUrl.slice(0, 2000) }),
          ...(input.referrer && { referrer: input.referrer.slice(0, 2000) }),
        },
      });
      return session(existing.id, input.visitorToken, existing.conversationId, config.userId);
    }
  }

  // Returning visitor on a NEW device (no valid token) but a known email →
  // reattach to their existing thread and issue a fresh token, so the
  // conversation continues cross-device instead of forking a new one.
  if (input.email) {
    const byEmail = await prisma.webVisitor.findFirst({
      where: {
        widgetConfigId: config.id,
        email: { equals: input.email.trim(), mode: 'insensitive' },
        blockedAt: null,
      },
      orderBy: { lastSeenAt: 'desc' },
    });
    if (byEmail) {
      const token = newToken();
      await prisma.webVisitor.update({
        where: { id: byEmail.id },
        data: {
          tokenHash: hashToken(token), // rotate to this device (one active token)
          lastSeenAt: new Date(),
          expiresAt: new Date(Date.now() + VISITOR_TTL_MS),
          ...(input.name && { name: input.name }),
          ...(country && { country }),
          ...(city && { city }),
          ...(input.pageUrl && { pageUrl: input.pageUrl.slice(0, 2000) }),
          ...(input.referrer && { referrer: input.referrer.slice(0, 2000) }),
        },
      });
      return session(byEmail.id, token, byEmail.conversationId, config.userId);
    }
  }

  // Fresh session: shadow user + visitor row + new token.
  const token = newToken();
  const shadowId = await createShadowUser(input.name);
  const visitor = await prisma.webVisitor.create({
    data: {
      widgetConfigId: config.id,
      shadowUserId: shadowId,
      tokenHash: hashToken(token),
      name: input.name?.trim() || null,
      email: input.email?.trim() || null,
      ipHash: hashIp(input.ip) ?? null,
      userAgent: input.userAgent?.slice(0, 400) ?? null,
      originDomain: input.originHost ?? null,
      country: country ?? null,
      city: city ?? null,
      pageUrl: input.pageUrl?.slice(0, 2000) ?? null,
      referrer: input.referrer?.slice(0, 2000) ?? null,
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
  country?: string | null;
  city?: string | null;
  userAgent?: string | null;
  pageUrl?: string | null;
  referrer?: string | null;
  email?: string | null;
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

  // Open the thread with a context line so the owner immediately sees where the
  // visitor is, what device/page they're on, and how they got there. System
  // message (isSystem) → rendered as a centred note, not a chat bubble. Created
  // BEFORE the visitor's first message, so it sits at the top of the thread.
  const line = contextLine(visitor);
  if (line) {
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderId: visitor.shadowUserId,
        content: line,
        isSystem: true,
        metadata: {
          widgetContext: true,
          email: visitor.email ?? null,
          country: visitor.country ?? null,
          city: visitor.city ?? null,
          pageUrl: visitor.pageUrl ?? null,
          referrer: visitor.referrer ?? null,
        },
      },
    });
  }
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
 * Visitor sends an image. The file is uploaded to R2 under the conversation
 * (same path/limits as an in-app chat photo), then delivered to the owner like
 * any other message. Optional [caption] rides along as the message content.
 */
export async function visitorSendImage(
  token: string,
  file: Express.Multer.File,
  caption = '',
) {
  const visitor = await requireVisitor(token);

  const rl = await checkRateLimit(`widget:msg:${visitor.id}`, MSG_MAX, MSG_WINDOW_SEC);
  if (!rl.allowed) throw new ForbiddenError('Too many messages, please slow down');

  const conversationId = await ensureConversation(visitor);
  const imageUrl = await fileToChatImageUrl(file, conversationId);
  const message = await chatService.sendMessage(
    conversationId,
    visitor.shadowUserId,
    caption.trim(),
    { imageUrl },
  );

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
      // System messages (e.g. the owner-facing visitor-context line) are for the
      // owner only — never surface them in the visitor's widget.
      isSystem: false,
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

  // The owner's read/delivered position drives the visitor's sent/delivered/read
  // ticks. Returned top-level so the widget can advance ticks on every poll,
  // even when no new messages arrived.
  const ownerParticipant = await prisma.conversationParticipant.findFirst({
    where: { conversationId: visitor.conversationId, userId: visitor.widgetConfig.userId },
    select: { lastReadAt: true, lastDeliveredAt: true },
  });

  // Tag each message from the visitor's perspective without exposing the
  // owner's raw user id.
  return {
    conversationId: visitor.conversationId,
    ownerReadAt: ownerParticipant?.lastReadAt ?? null,
    ownerDeliveredAt: ownerParticipant?.lastDeliveredAt ?? null,
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

  // Alert the owner so an offline lead is actionable, not just stored. Both
  // fire-and-forget — a notification failure must not fail the capture.
  const ownerId = visitor.widgetConfig.userId;
  const preview = message.length > 90 ? message.slice(0, 90) + '…' : message;
  createNotification({
    userId: ownerId,
    type: 'SYSTEM',
    title: 'New website lead',
    body: `${email} — ${preview}`,
    data: { kind: 'widget_lead' },
  }).catch(() => {});
  sendPushToUser(ownerId, {
    title: '🌐 New website lead',
    body: `${email}: ${preview}`,
    data: { kind: 'widget_lead' },
  }).catch(() => {});

  logger.info({ visitorId: visitor.id, ownerId }, 'Widget: offline lead captured');
  return { ok: true };
}

/** Leads (offline email captures) for the owner's widget, newest first. */
export async function listLeads(userId: string, limit = 100) {
  const config = await getOrCreateConfig(userId);
  return prisma.widgetLead.findMany({
    where: { widgetConfigId: config.id },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
    select: { id: true, email: true, message: true, createdAt: true },
  });
}

/**
 * Delete leads by id. Scoped to the caller's own widget config so one owner can
 * never delete another's leads. Returns the number actually removed.
 */
export async function deleteLeads(userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const config = await getOrCreateConfig(userId);
  const { count } = await prisma.widgetLead.deleteMany({
    where: { id: { in: ids }, widgetConfigId: config.id },
  });
  return count;
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
