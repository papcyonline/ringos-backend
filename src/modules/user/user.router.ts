import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { avatarUpload, fileToAvatarUrl } from '../../shared/upload';
import { getIO } from '../../config/socket';
import { checkRateLimit } from '../../shared/redis.service';
import { updatePreferenceSchema, updateAvailabilitySchema, updatePrivacySchema, updateProfileSchema } from './user.schema';
import * as userService from './user.service';
import * as followService from './follow.service';
import * as likeService from './like.service';
import { createNotification } from '../notification/notification.service';
import { getUsageSummary } from '../../shared/usage.service';

const router = Router();

// GET / - List users with presence info (excludes current user and blocked), paginated
router.get('/', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const result = await userService.listUsers(req.user!.userId, page, limit);
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
router.delete(
  '/me/availability',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await userService.stopAvailability(req.user!.userId);
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
    const following = await followService.getFollowing(req.user!.userId);
    res.json(following);
  } catch (err) {
    next(err);
  }
});

// POST /me/verify - Set user as verified (subscription active)
router.post('/me/verify', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await userService.setVerified(req.user!.userId);
    res.json(result);
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

    // Send notification to the followed user
    const follower = await userService.getProfile(req.user!.userId);
    createNotification({
      userId: (req.params.id as string),
      type: 'NEW_FOLLOWER',
      title: follower.displayName,
      body: 'Started following you',
      imageUrl: follower.avatarUrl ?? undefined,
      data: { userId: req.user!.userId, isVerified: follower.isVerified ?? false },
    }).catch((err) => {
      logger.error({ err, userId: (req.params.id as string) }, 'Failed to send follow notification');
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
    createNotification({
      userId: (req.params.id as string),
      type: 'PROFILE_LIKED',
      title: liker.displayName,
      body: 'Liked your profile',
      imageUrl: liker.avatarUrl ?? undefined,
      data: { userId: req.user!.userId, isVerified: liker.isVerified ?? false },
    }).catch((err) => {
      logger.error({ err, userId: (req.params.id as string) }, 'Failed to send like notification');
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
    const followers = await followService.getFollowers((req.params.id as string));
    res.json(followers);
  } catch (err) {
    next(err);
  }
});

// GET /:id/following - List who a user follows
router.get('/:id/following', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const following = await followService.getFollowing((req.params.id as string));
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
    // Limit to 1000 contacts per request
    const limited = hashes.slice(0, 1000);
    const matches = await userService.syncContacts(req.user!.userId, limited);
    res.json({ matches });
  } catch (err) {
    next(err);
  }
});

export { router as userRouter };
