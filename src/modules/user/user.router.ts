import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { authenticate } from '../../middleware/auth';
import { userRateLimit } from '../../middleware/userRateLimit';
import { validate } from '../../middleware/validate';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { avatarUpload, fileToAvatarUrl, coverUpload, fileToCoverUrl } from '../../shared/upload';
import { getIO } from '../../config/socket';
import { checkRateLimit } from '../../shared/redis.service';
import { updatePreferenceSchema, updateAvailabilitySchema, updatePrivacySchema, updateProfileSchema } from './user.schema';
import * as userService from './user.service';
import * as followService from './follow.service';
import * as likeService from './like.service';
import { createNotification, sendPostPush } from '../notification/notification.service';
import { prisma } from '../../config/database';
import { validateAppleReceipt, planFromProductId } from '../../shared/appleReceipt.service';
import { validateGooglePlayPurchase } from '../../shared/googlePlay.service';
import { getUsageSummary, isPro } from '../../shared/usage.service';

const router = Router();

/** Parse optional ?limit / ?cursor for follower/following pagination. */
function parseFollowPage(req: AuthRequest): { limit?: number; cursor?: string } {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  return { limit, cursor };
}

// GET / - List users with presence info (excludes current user and blocked), paginated
router.get('/', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const rawQ = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const q = rawQ.length > 0 ? rawQ : undefined;
    const result = await userService.listUsers(req.user!.userId, page, limit, q);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /me - Get current user's profile
router.get('/me', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const profile = await userService.getProfile(req.user!.userId);
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

// GET /me/export - Download all personal data as JSON (GDPR/CCPA right of access)
router.get(
  '/me/export',
  authenticate,
  userRateLimit('data-export', 3, 3600), // 3/hour — the query touches many tables
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const data = await userService.exportUserData(req.user!.userId);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="yomeet-data-export.json"');
      res.status(200).send(JSON.stringify(data, null, 2));
    } catch (err) {
      next(err);
    }
  },
);

// GET /me/usage - Get daily usage limits and current consumption
router.get('/me/usage', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const usage = await getUsageSummary(req.user!.userId);
    res.json(usage);
  } catch (err) {
    next(err);
  }
});

// PUT /me/profile - Update display name, bio, profession, gender, location
router.put(
  '/me/profile',
  authenticate,
  validate(updateProfileSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const profile = await userService.updateProfile(req.user!.userId, req.body);
      res.json(profile);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /me/message-privacy - Set who can DM this user
router.put(
  '/me/message-privacy',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const value = req.body?.messagePrivacy;
      if (value !== 'EVERYONE' && value !== 'FOLLOWING' && value !== 'NOBODY') {
        res.status(400).json({ error: 'messagePrivacy must be EVERYONE, FOLLOWING, or NOBODY' });
        return;
      }
      const updated = await userService.updateMessagePrivacy(req.user!.userId, value);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /me/preferences - Update current user's preferences
router.put(
  '/me/preferences',
  authenticate,
  validate(updatePreferenceSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const preference = await userService.updatePreference(req.user!.userId, req.body);
      res.json(preference);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /me/availability - Update what user is available for
router.put(
  '/me/availability',
  authenticate,
  validate(updateAvailabilitySchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await userService.updateAvailability(req.user!.userId, req.body);
      getIO().emit('user:status-update', {
        userId: req.user!.userId,
        status: result.status,
        availabilityNote: result.availabilityNote,
        availableFor: result.availableFor,
        availableUntil: result.availableUntil,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /me/availability - Stop availability (reset to defaults)
// Pro-only: free users can set themselves available but cannot manually
// hide afterwards. Mirrors the frontend gate in go_live_sheet.dart — kept
// here so a determined caller can't bypass the UI lock by hitting the
// endpoint directly.
router.delete(
  '/me/availability',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      if (!(await isPro(userId))) {
        res.status(403).json({
          error: 'PRO_REQUIRED',
          message: 'Going offline manually is a Yomeet Pro feature.',
        });
        return;
      }
      const result = await userService.stopAvailability(userId);
      getIO().emit('user:status-update', {
        userId,
        status: result.status,
        availabilityNote: result.availabilityNote,
        availableFor: result.availableFor,
        availableUntil: result.availableUntil,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /me/avatar - Upload avatar image
router.post(
  '/me/avatar',
  authenticate,
  avatarUpload.single('avatar'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }
      const avatarUrl = await fileToAvatarUrl(req.file, req.user!.userId);
      const result = await userService.uploadAvatar(req.user!.userId, avatarUrl);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /me/cover - Upload profile cover/banner image
router.post(
  '/me/cover',
  authenticate,
  coverUpload.single('cover'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }
      const coverUrl = await fileToCoverUrl(req.file, req.user!.userId);
      const result = await userService.uploadCover(req.user!.userId, coverUrl);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /me/privacy - Toggle profile privacy
router.put(
  '/me/privacy',
  authenticate,
  validate(updatePrivacySchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await userService.updatePrivacy(req.user!.userId, req.body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// GET /me/following - List who current user follows
router.get('/me/following', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const following = await followService.getFollowing(req.user!.userId, req.user!.userId, parseFollowPage(req));
    res.json(following);
  } catch (err) {
    next(err);
  }
});

// POST /me/followers/seen - the user opened their own followers list. Stamp
// "last checked" (so the new-followers digest only counts follows gained after
// this) and clear their NEW_FOLLOWER bell notifications.
router.post('/me/followers/seen', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await followService.markFollowersSeen(req.user!.userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /me/verify - Grant verification/Pro AFTER validating the store receipt
// server-side. iOS receipts are checked with Apple (never trust the client).
// Body: { platform: 'ios'|'android', receiptData?: string, productId?: string }.
router.post('/me/verify', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const platform = (req.body.platform as string | undefined)?.toLowerCase();
    const receiptData = req.body.receiptData as string | undefined;
    const productId = req.body.productId as string | undefined;

    if (platform === 'ios') {
      const result = await validateAppleReceipt(receiptData ?? '');
      if (!result.valid || !result.active) {
        logger.warn({ userId, reason: result.reason }, 'iOS verify rejected: receipt not valid/active');
        return res.status(402).json({ error: 'Purchase could not be verified', reason: result.reason });
      }
      const verified = await userService.setVerified(userId);
      await userService.recordSubscription(userId, {
        status: 'active',
        plan: planFromProductId(result.productId ?? productId),
        externalId: result.originalTransactionId,
      });
      return res.json(verified);
    }

    if (platform === 'android') {
      const result = await validateGooglePlayPurchase(productId ?? '', receiptData ?? '');
      // Graceful: if Play validation isn't configured yet, keep the current
      // (client-asserted) behaviour so live Android subscribers don't break.
      // Strict validation activates automatically once the service account is
      // set. When it IS configured, reject purchases that don't check out.
      if (result.reason !== 'validation_not_configured') {
        if (!result.valid || !result.active) {
          logger.warn({ userId, reason: result.reason }, 'Android verify rejected: purchase not valid/active');
          return res.status(402).json({ error: 'Purchase could not be verified', reason: result.reason });
        }
        await userService.recordSubscription(userId, {
          status: 'active',
          plan: planFromProductId(result.productId ?? productId),
          externalId: result.orderId,
        });
      } else {
        logger.warn({ userId }, 'Android verify: Play validation not configured — granted without validation');
      }
      const verified = await userService.setVerified(userId);
      return res.json(verified);
    }

    // No/unknown platform — old clients that predate receipt validation. Keep
    // the legacy client-asserted path so they don't break. TODO: once every
    // client sends a platform + receipt, reject this to fully close the hole.
    logger.warn({ userId, platform }, 'verify granted without receipt validation (no/unknown platform)');
    const verified = await userService.setVerified(userId);
    return res.json(verified);
  } catch (err) {
    next(err);
  }
});

// DELETE /me/verify - Remove verification (subscription expired)
router.delete('/me/verify', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await userService.removeVerified(req.user!.userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /admin/verify - Admin: verify or unverify any user by email/id/name
router.post('/admin/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Rate limit: 5 attempts per 15 minutes per IP
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const rl = await checkRateLimit(`admin:verify:${ip}`, 5, 900);
    if (!rl.allowed) {
      return res.status(429).json({ error: 'Too many attempts, try again later' });
    }

    const secret = req.headers['x-admin-secret'] as string | undefined;
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || !secret) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // Timing-safe comparison to prevent timing attacks
    const secretBuf = Buffer.from(secret);
    const adminBuf = Buffer.from(adminSecret);
    if (secretBuf.length !== adminBuf.length || !crypto.timingSafeEqual(secretBuf, adminBuf)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { user: identifier, verified, role } = req.body;
    if (!identifier || typeof identifier !== 'string' || identifier.length > 255) {
      return res.status(400).json({ error: 'Provide a valid "user" (email/id/name)' });
    }
    if (typeof verified !== 'boolean') {
      return res.status(400).json({ error: '"verified" must be a boolean' });
    }
    if (role !== undefined && typeof role !== 'string') {
      return res.status(400).json({ error: '"role" must be a string if provided' });
    }
    const result = await userService.adminSetVerified(identifier, verified, role);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /me - Delete current user's account
router.delete('/me', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { email, displayName } = await userService.deleteAccount(req.user!.userId);
    // Send goodbye email (fire-and-forget — account is already deleted)
    if (email) {
      import('../../shared/email.service').then(({ sendGoodbyeEmail }) => {
        sendGoodbyeEmail(email, displayName || 'there').catch(() => {});
      });
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /:id - Get a user's public profile
router.get('/:id', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = await userService.getUserById((req.params.id as string), req.user!.userId);
    res.json(user);
  } catch (err) {
    next(err);
  }
});

// POST /:id/follow - Follow a user
router.post('/:id/follow', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await followService.followUser(req.user!.userId, (req.params.id as string));

    // Notify the followed user — deduped and off the response path so it
    // never delays the follow. Dedupe suppresses a repeat NEW_FOLLOWER from
    // the same follower within 24h, killing unfollow/refollow spam; a genuine
    // refollow after the window still notifies.
    const followedId = req.params.id as string;
    const followerId = req.user!.userId;
    void (async () => {
      const DEDUPE_MS = 24 * 60 * 60 * 1000;
      const recent = await prisma.notification.findFirst({
        where: {
          userId: followedId,
          type: 'NEW_FOLLOWER',
          createdAt: { gt: new Date(Date.now() - DEDUPE_MS) },
          data: { path: ['userId'], equals: followerId },
        },
        select: { id: true },
      });
      if (recent) return; // already notified by this follower recently — skip

      const follower = await userService.getProfile(followerId);
      const followTitle = follower.displayName;
      const followBody = 'Started following you';
      await createNotification({
        userId: followedId,
        type: 'NEW_FOLLOWER',
        title: followTitle,
        body: followBody,
        imageUrl: follower.avatarUrl ?? undefined,
        data: { userId: followerId, isVerified: follower.isVerified ?? false },
      });
      // Lock-screen push so the recipient sees it even when the app is
      // closed — without this the follow only shows up next time they
      // open Yomeet, which kills engagement.
      await sendPostPush(followedId, {
        title: followTitle,
        body: followBody,
        imageUrl: follower.avatarUrl ?? undefined,
        data: {
          type: 'NEW_FOLLOWER',
          userId: followerId,
          senderId: followerId,
          senderName: followTitle,
          senderAvatar: follower.avatarUrl ?? '',
        },
      });
    })().catch((err) => {
      logger.error({ err, userId: followedId }, 'Failed to send follow notification');
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id/follow - Unfollow a user
router.delete('/:id/follow', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await followService.unfollowUser(req.user!.userId, (req.params.id as string));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /:id/like - Like a user's profile
router.post('/:id/like', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await likeService.likeUser(req.user!.userId, (req.params.id as string));

    // Send notification to the liked user
    const liker = await userService.getProfile(req.user!.userId);
    const likeTitle = liker.displayName;
    const likeBody = 'Liked your profile';
    createNotification({
      userId: (req.params.id as string),
      type: 'PROFILE_LIKED',
      title: likeTitle,
      body: likeBody,
      imageUrl: liker.avatarUrl ?? undefined,
      data: { userId: req.user!.userId, isVerified: liker.isVerified ?? false },
    }).catch((err) => {
      logger.error({ err, userId: (req.params.id as string) }, 'Failed to send like notification');
    });
    sendPostPush((req.params.id as string), {
      title: likeTitle,
      body: likeBody,
      imageUrl: liker.avatarUrl ?? undefined,
      data: {
        type: 'PROFILE_LIKED',
        userId: req.user!.userId,
        senderId: req.user!.userId,
        senderName: likeTitle,
        senderAvatar: liker.avatarUrl ?? '',
      },
    }).catch((err) => {
      logger.error({ err }, 'Failed to send profile-like push');
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id/like - Unlike a user's profile
router.delete('/:id/like', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await likeService.unlikeUser(req.user!.userId, (req.params.id as string));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /:id/followers - List followers of a user
router.get('/:id/followers', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const followers = await followService.getFollowers(req.params.id as string, req.user!.userId, parseFollowPage(req));
    res.json(followers);
  } catch (err) {
    next(err);
  }
});

// GET /:id/following - List who a user follows
router.get('/:id/following', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const following = await followService.getFollowing(req.params.id as string, req.user!.userId, parseFollowPage(req));
    res.json(following);
  } catch (err) {
    next(err);
  }
});

// ─── Phone & Contact Sync ────────────────────────────────

// PUT /me/phone - Add or update phone number for contact discovery
router.put('/me/phone', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { phoneHash } = req.body as { phoneHash?: string };
    if (!phoneHash || typeof phoneHash !== 'string' || phoneHash.length < 10) {
      return res.status(400).json({ error: 'Invalid phone hash' });
    }
    const result = await userService.setPhoneHash(req.user!.userId, phoneHash);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /me/phone - Remove phone number (stop being discoverable)
router.delete('/me/phone', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await userService.removePhoneHash(req.user!.userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /me/contacts/sync - Find Yomeet users from phone contact hashes
router.post('/me/contacts/sync', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { hashes } = req.body as { hashes?: string[] };
    if (!Array.isArray(hashes) || hashes.length === 0) {
      return res.status(400).json({ error: 'Provide an array of phone hashes' });
    }
    // Filter out empty/malformed hashes and limit to 1000
    const limited = hashes
      .filter((h) => typeof h === 'string' && h.length >= 16 && h.length <= 128)
      .slice(0, 1000);
    const matches = await userService.syncContacts(req.user!.userId, limited);
    res.json({ matches });
  } catch (err) {
    next(err);
  }
});

export { router as userRouter };
