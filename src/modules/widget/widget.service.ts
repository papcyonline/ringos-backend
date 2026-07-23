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
import { fileToChatImageUrl, fileToChatAudioUrl } from '../../shared/upload';
import { createNotification, sendPushToUser } from '../notification/notification.service';
import { setOnline, setOffline } from '../user/user.service';
import { isPro } from '../../shared/usage.service';

// Visitor session length. Refreshed on activity; a cron prunes past this.
const VISITOR_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Per-visitor send throttle.
const MSG_MAX = 20;
const MSG_WINDOW_SEC = 60;
// Per-origin session-creation throttle (blunts drive-by spam bots).
const SESSION_MAX = 10;
const SESSION_WINDOW_SEC = 60;

// Presence grace window: the owner still reads as "online" to the widget for a
// short window after their socket drops. iOS kills the WebSocket the moment the
// phone locks/backgrounds, so without this a momentary lock flaps the widget to
// "Away". setOffline() stamps lastSeenAt, so a brief absence stays "online" and
// only a sustained one flips to "Away".
const OWNER_PRESENCE_GRACE_MS = 2 * 60 * 1000; // 2 minutes

/** Single source of truth for owner presence as seen by the widget. */
function ownerIsOnline(
  owner: { isOnline: boolean; lastSeenAt: Date | null } | null,
): boolean {
  if (!owner) return false;
  if (owner.isOnline) return true;
  return (
    !!owner.lastSeenAt &&
    Date.now() - owner.lastSeenAt.getTime() < OWNER_PRESENCE_GRACE_MS
  );
}

/**
 * Widget presence as seen by the visitor: the widget is "online" if the owner
 * OR any accepted teammate is online (within the grace window). One query for
 * the owner + accepted member ids, then the shared ownerIsOnline() rule.
 */
async function isTeamOnline(widgetConfigId: string, ownerId: string): Promise<boolean> {
  const members = await prisma.widgetTeamMember.findMany({
    where: { widgetConfigId, status: 'ACCEPTED' },
    select: { userId: true },
  });
  const ids = [ownerId, ...members.map((m) => m.userId)];
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { isOnline: true, lastSeenAt: true },
  });
  return users.some((u) => ownerIsOnline(u));
}

/** Accepted teammate user ids for a widget (used to fan out participants/notifications). */
async function acceptedMemberIds(widgetConfigId: string): Promise<string[]> {
  const members = await prisma.widgetTeamMember.findMany({
    where: { widgetConfigId, status: 'ACCEPTED' },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}

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
  // Free tier is limited to a single website; more than one requires Pro.
  if (data.allowedDomains !== undefined) {
    const unique = Array.from(new Set(data.allowedDomains));
    if (unique.length > 1 && !(await isPro(userId))) {
      throw new ForbiddenError('Adding more than one website requires Yomeet Pro');
    }
  }
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

/** Upload a custom brand avatar and store its URL in the widget theme. */
export async function setBrandAvatar(userId: string, file: Express.Multer.File) {
  const config = await getOrCreateConfig(userId);
  const url = await fileToChatImageUrl(file, config.id);
  const theme = { ...((config.theme as Record<string, unknown>) ?? {}), avatar: url };
  await prisma.widgetConfig.update({
    where: { userId },
    data: { theme: theme as Prisma.InputJsonValue },
  });
  return { url };
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
      country: true, countryCode: true, city: true, pageUrl: true, referrer: true,
      conversationId: true, blockedAt: true, createdAt: true, lastSeenAt: true,
    },
  });
}

/** Block a visitor: they can no longer start sessions or send messages. */
export async function blockVisitor(userId: string, visitorId: string) {
  return setVisitorBlocked(userId, visitorId, new Date());
}

export async function unblockVisitor(userId: string, visitorId: string) {
  return setVisitorBlocked(userId, visitorId, null);
}

/** Block/unblock a visitor, scoped to the owner's own widget config. */
async function setVisitorBlocked(userId: string, visitorId: string, blockedAt: Date | null) {
  const config = await getOrCreateConfig(userId);
  const visitor = await prisma.webVisitor.findFirst({
    where: { id: visitorId, widgetConfigId: config.id },
  });
  if (!visitor) throw new NotFoundError('Visitor not found');
  return prisma.webVisitor.update({ where: { id: visitorId }, data: { blockedAt } });
}

// ─── team (shared inbox) ─────────────────────────────────────────────

/** Owner's team: invited members (pending + accepted) with profile + presence. */
export async function listTeam(ownerId: string) {
  const config = await getOrCreateConfig(ownerId);
  const members = await prisma.widgetTeamMember.findMany({
    where: { widgetConfigId: config.id },
    orderBy: { invitedAt: 'asc' },
    select: {
      status: true,
      invitedAt: true,
      user: {
        select: {
          id: true, displayName: true, avatarUrl: true, isOnline: true, isVerified: true,
        },
      },
    },
  });
  return {
    members: members.map((m) => ({
      id: m.user.id,
      displayName: m.user.displayName,
      avatarUrl: m.user.avatarUrl,
      isOnline: m.user.isOnline,
      isVerified: m.user.isVerified,
      status: m.status,
      invitedAt: m.invitedAt,
    })),
  };
}

/** Invite a Yomeet user to help answer the owner's widget chats. */
export async function inviteTeamMember(ownerId: string, memberUserId: string) {
  if (memberUserId === ownerId) {
    throw new ForbiddenError('You are already on your own team');
  }
  // A shared team is a Pro feature.
  if (!(await isPro(ownerId))) {
    throw new ForbiddenError('Adding teammates requires Yomeet Pro');
  }
  const target = await prisma.user.findUnique({
    where: { id: memberUserId },
    select: { id: true, isWebVisitor: true },
  });
  if (!target || target.isWebVisitor) throw new NotFoundError('User not found');
  const config = await getOrCreateConfig(ownerId);
  const existing = await prisma.widgetTeamMember.findUnique({
    where: { widgetConfigId_userId: { widgetConfigId: config.id, userId: memberUserId } },
  });
  if (existing) throw new ForbiddenError('That user is already invited');
  await prisma.widgetTeamMember.create({
    data: { widgetConfigId: config.id, userId: memberUserId, status: 'PENDING' },
  });
  const owner = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { displayName: true },
  });
  const ownerName = owner?.displayName ?? 'Someone';
  createNotification({
    userId: memberUserId,
    type: 'SYSTEM',
    title: 'Website chat team invite',
    body: `${ownerName} invited you to help answer their website chats`,
    data: { kind: 'widget_team_invite', widgetConfigId: config.id },
  }).catch(() => {});
  sendPushToUser(memberUserId, {
    title: '👥 Team invite',
    body: `${ownerName} invited you to their website chat team`,
    data: { type: 'widget_team_invite', kind: 'widget_team_invite', widgetConfigId: config.id },
  }).catch(() => {});
  return { ok: true };
}

/** Pending invites addressed to the current user. */
export async function listMyInvites(userId: string) {
  const invites = await prisma.widgetTeamMember.findMany({
    where: { userId, status: 'PENDING' },
    orderBy: { invitedAt: 'desc' },
    select: {
      widgetConfigId: true,
      invitedAt: true,
      widgetConfig: {
        select: { user: { select: { id: true, displayName: true, avatarUrl: true } } },
      },
    },
  });
  return invites.map((i) => ({
    widgetConfigId: i.widgetConfigId,
    invitedAt: i.invitedAt,
    owner: {
      id: i.widgetConfig.user.id,
      displayName: i.widgetConfig.user.displayName,
      avatarUrl: i.widgetConfig.user.avatarUrl,
    },
  }));
}

/** Accept or decline an invite. Accepting joins every existing widget conversation. */
export async function respondToInvite(userId: string, widgetConfigId: string, accept: boolean) {
  const membership = await prisma.widgetTeamMember.findUnique({
    where: { widgetConfigId_userId: { widgetConfigId, userId } },
  });
  if (!membership || membership.status !== 'PENDING') {
    throw new NotFoundError('Invite not found');
  }
  if (!accept) {
    await prisma.widgetTeamMember.delete({
      where: { widgetConfigId_userId: { widgetConfigId, userId } },
    });
    return { ok: true, accepted: false };
  }
  await prisma.widgetTeamMember.update({
    where: { widgetConfigId_userId: { widgetConfigId, userId } },
    data: { status: 'ACCEPTED', acceptedAt: new Date() },
  });
  await addMemberToConversations(widgetConfigId, userId);
  return { ok: true, accepted: true };
}

/** Owner removes a member; strips them from the shared conversations. */
export async function removeTeamMember(ownerId: string, memberUserId: string) {
  const config = await getOrCreateConfig(ownerId);
  await prisma.widgetTeamMember.deleteMany({
    where: { widgetConfigId: config.id, userId: memberUserId },
  });
  await removeMemberFromConversations(config.id, memberUserId);
  return { ok: true };
}

/** Add a user as participant to every existing widget conversation (idempotent).
 * New members join CAUGHT-UP (lastReadAt = now) so the existing history is
 * visible but not flagged as a wall of unread messages. */
async function addMemberToConversations(widgetConfigId: string, userId: string) {
  const visitors = await prisma.webVisitor.findMany({
    where: { widgetConfigId, conversationId: { not: null } },
    select: { conversationId: true },
  });
  if (visitors.length === 0) return;
  const now = new Date();
  await prisma.conversationParticipant.createMany({
    data: visitors.map((v) => ({
      conversationId: v.conversationId as string,
      userId,
      lastReadAt: now,
    })),
    skipDuplicates: true,
  });
}

/** Remove a user's participant rows from a widget's conversations. */
async function removeMemberFromConversations(widgetConfigId: string, userId: string) {
  const visitors = await prisma.webVisitor.findMany({
    where: { widgetConfigId, conversationId: { not: null } },
    select: { conversationId: true },
  });
  const convIds = visitors.map((v) => v.conversationId as string);
  if (convIds.length === 0) return;
  await prisma.conversationParticipant.deleteMany({
    where: { conversationId: { in: convIds }, userId },
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
    select: { displayName: true, avatarUrl: true, isOnline: true, lastSeenAt: true, isVerified: true },
  });
  // Identity: default to the owner's profile (name + avatar + verified tick).
  // If the owner set a custom brand name, use that name + brand avatar instead,
  // and drop the verified tick (a brand name isn't the personal account).
  const theme = (config.theme ?? {}) as Record<string, unknown>;
  const brandName = typeof theme.name === 'string' ? theme.name.trim() : '';
  const brandAvatar = typeof theme.avatar === 'string' ? theme.avatar : null;
  const useBrand = brandName.length > 0;
  // Verified tick (personal OR brand mode): only if the account is genuinely
  // verified, the owner is Pro, and they've switched it on (a Pro display perk).
  const showVerified =
    !!owner?.isVerified &&
    theme.showVerified === true &&
    (await isPro(config.userId));
  return {
    handle: config.handle,
    theme: config.theme ?? {},
    offlineCapture: config.offlineCapture,
    owner: {
      displayName: useBrand ? brandName : (owner?.displayName ?? 'Support'),
      avatarUrl: useBrand ? brandAvatar : (owner?.avatarUrl ?? null),
      // Online if the owner OR any accepted teammate is available.
      online: await isTeamOnline(config.id, config.userId),
      verified: showVerified,
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

/** Normalise a CF-IPCountry value to a clean ISO alpha-2 code (or null). */
function normalizeCountryCode(code?: string | null): string | null {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return null;
  const cc = code.toUpperCase();
  return cc === 'XX' || cc === 'T1' ? null : cc;
}

/** ISO alpha-2 code → flag emoji, via Unicode regional-indicator letters. */
function codeToFlag(code?: string | null): string | undefined {
  const cc = normalizeCountryCode(code);
  if (!cc) return undefined;
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
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
  country?: string | null; countryCode?: string | null; city?: string | null;
  userAgent?: string | null; pageUrl?: string | null; referrer?: string | null;
  email?: string | null;
}): string | null {
  const parts: string[] = [];
  if (v.email) parts.push('✉️ ' + v.email);
  const flag = codeToFlag(v.countryCode);
  const loc = [v.city, v.country].filter(Boolean).join(', ');
  if (loc) parts.push('🌍 ' + (flag ? flag + ' ' : '') + loc);
  else if (flag) parts.push('🌍 ' + flag);
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
  const countryCode = normalizeCountryCode(input.country);
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
          ...(countryCode && { countryCode }),
          ...(city && { city }),
          ...(input.pageUrl && { pageUrl: input.pageUrl.slice(0, 2000) }),
          ...(input.referrer && { referrer: input.referrer.slice(0, 2000) }),
        },
      });
      return session(existing.id, input.visitorToken, existing.conversationId, config.userId, config.id);
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
          ...(countryCode && { countryCode }),
          ...(city && { city }),
          ...(input.pageUrl && { pageUrl: input.pageUrl.slice(0, 2000) }),
          ...(input.referrer && { referrer: input.referrer.slice(0, 2000) }),
        },
      });
      return session(byEmail.id, token, byEmail.conversationId, config.userId, config.id);
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
      countryCode: countryCode ?? null,
      city: city ?? null,
      pageUrl: input.pageUrl?.slice(0, 2000) ?? null,
      referrer: input.referrer?.slice(0, 2000) ?? null,
      expiresAt: new Date(Date.now() + VISITOR_TTL_MS),
    },
  });
  logger.info({ visitorId: visitor.id, ownerId: config.userId }, 'Widget: new visitor session');
  return session(visitor.id, token, null, config.userId, config.id);
}

/** Shape the session response, including live team presence. */
async function session(
  visitorId: string,
  visitorToken: string,
  conversationId: string | null,
  ownerId: string,
  widgetConfigId: string,
) {
  return {
    visitorId,
    visitorToken,
    conversationId,
    ownerOnline: await isTeamOnline(widgetConfigId, ownerId),
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
  widgetConfigId: string;
  widgetConfig: { userId: string };
  country?: string | null;
  countryCode?: string | null;
  city?: string | null;
  userAgent?: string | null;
  pageUrl?: string | null;
  referrer?: string | null;
  email?: string | null;
}): Promise<string> {
  if (visitor.conversationId) return visitor.conversationId;
  // Owner + accepted teammates all become participants, so the whole team
  // shares the visitor's inbox and gets message notifications.
  const memberIds = await acceptedMemberIds(visitor.widgetConfigId);
  const staffIds = Array.from(new Set([visitor.widgetConfig.userId, ...memberIds]));
  const conversation = await prisma.conversation.create({
    data: {
      type: 'WIDGET',
      status: 'ACTIVE',
      participants: {
        create: [
          ...staffIds.map((userId) => ({ userId })),
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
          countryCode: visitor.countryCode ?? null,
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
 * any other message.
 */
export async function visitorSendImage(token: string, file: Express.Multer.File) {
  const visitor = await requireVisitor(token);

  const rl = await checkRateLimit(`widget:msg:${visitor.id}`, MSG_MAX, MSG_WINDOW_SEC);
  if (!rl.allowed) throw new ForbiddenError('Too many messages, please slow down');

  const conversationId = await ensureConversation(visitor);
  const imageUrl = await fileToChatImageUrl(file, conversationId);
  const message = await chatService.sendMessage(
    conversationId,
    visitor.shadowUserId,
    '',
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
 * Visitor sends a voice note. The audio is uploaded to R2 (same path/limits as
 * an in-app voice note), then delivered to the owner like any other message.
 * [duration] is the recorded length in whole seconds (best-effort).
 */
export async function visitorSendAudio(
  token: string,
  file: Express.Multer.File,
  duration?: number,
) {
  const visitor = await requireVisitor(token);

  const rl = await checkRateLimit(`widget:msg:${visitor.id}`, MSG_MAX, MSG_WINDOW_SEC);
  if (!rl.allowed) throw new ForbiddenError('Too many messages, please slow down');

  const conversationId = await ensureConversation(visitor);
  const audioUrl = await fileToChatAudioUrl(file, conversationId);
  const message = await chatService.sendMessage(
    conversationId,
    visitor.shadowUserId,
    '',
    { audioUrl, audioDuration: duration && duration > 0 ? Math.round(duration) : undefined },
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
      audioUrl: true,
      audioDuration: true,
    },
  });

  // The owner's read/delivered position drives the visitor's sent/delivered/read
  // ticks. Returned top-level so the widget can advance ticks on every poll,
  // even when no new messages arrived.
  const ownerParticipant = await prisma.conversationParticipant.findFirst({
    where: { conversationId: visitor.conversationId, userId: visitor.widgetConfig.userId },
    select: { lastReadAt: true, lastDeliveredAt: true },
  });

  // Live team presence so the widget header can flip Online ↔ Away on each poll
  // (online if the owner or any teammate is available).
  const ownerOnline = await isTeamOnline(
    visitor.widgetConfigId,
    visitor.widgetConfig.userId,
  );

  // Tag each message from the visitor's perspective without exposing the
  // owner's raw user id.
  return {
    conversationId: visitor.conversationId,
    ownerOnline,
    ownerReadAt: ownerParticipant?.lastReadAt ?? null,
    ownerDeliveredAt: ownerParticipant?.lastDeliveredAt ?? null,
    messages: messages.map((m) => ({
      id: m.id,
      content: m.content,
      createdAt: m.createdAt,
      imageUrl: m.imageUrl,
      audioUrl: m.audioUrl,
      audioDuration: m.audioDuration,
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

  // Alert the owner AND accepted teammates so an offline lead is actionable by
  // whoever's around. All fire-and-forget — a notification failure must not
  // fail the capture.
  const ownerId = visitor.widgetConfig.userId;
  const memberIds = await acceptedMemberIds(visitor.widgetConfigId);
  const recipients = Array.from(new Set([ownerId, ...memberIds]));
  const preview = message.length > 90 ? message.slice(0, 90) + '…' : message;
  for (const uid of recipients) {
    createNotification({
      userId: uid,
      type: 'SYSTEM',
      title: 'New website lead',
      body: `${email} — ${preview}`,
      data: { kind: 'widget_lead' },
    }).catch(() => {});
    sendPushToUser(uid, {
      title: '🌐 New website lead',
      body: `${email}: ${preview}`,
      // `type` is the app's deep-link discriminator; `kind` kept for the in-app
      // list. Both route to the Leads screen on tap.
      data: { type: 'widget_lead', kind: 'widget_lead' },
    }).catch(() => {});
  }

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

/**
 * Delete visitors by id. Owner-scoped to the caller's widget config so one
 * owner can never delete another's visitors. Mirrors the prune path: we delete
 * the shadow user, which cascades the WebVisitor row + participant links (the
 * WIDGET conversation is left for the owner's history). Returns the count.
 */
export async function deleteVisitors(userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const config = await getOrCreateConfig(userId);
  const visitors = await prisma.webVisitor.findMany({
    where: { id: { in: ids }, widgetConfigId: config.id },
    select: { shadowUserId: true },
  });
  if (visitors.length === 0) return 0;
  const { count } = await prisma.user.deleteMany({
    where: {
      id: { in: visitors.map((v) => v.shadowUserId) },
      isWebVisitor: true,
    },
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
