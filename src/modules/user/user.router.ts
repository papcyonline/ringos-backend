import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AuthRequest } from '../../shared/types';
import { avatarUpload, fileToAvatarUrl } from '../../shared/upload';
import { getIO } from '../../config/socket';
import { updatePreferenceSchema, updateAvailabilitySchema, updatePrivacySchema, updateProfileSchema } from './user.schema';
import * as userService from './user.service';
import * as followService from './follow.service';
import { createNotification } from '../notification/notification.service';

const router = Router();

// GET / - List all users with presence info (excludes current user and blocked)
router.get('/', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const users = await userService.listUsers(req.user!.userId);
    res.json(users);
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
      const result = await userService.uploadAvatar(req.user!.userId, fileToAvatarUrl(req.file));
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

// DELETE /me - Delete current user's account
router.delete('/me', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await userService.deleteAccount(req.user!.userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /:id/follow - Follow a user
router.post('/:id/follow', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await followService.followUser(req.user!.userId, req.params.id);

    // Send notification to the followed user
    const follower = await userService.getProfile(req.user!.userId);
    createNotification({
      userId: req.params.id,
      type: 'new_follower',
      title: 'New Follower',
      body: `${follower.displayName} started following you`,
      imageUrl: follower.avatarUrl ?? undefined,
      data: { userId: req.user!.userId },
    }).catch(() => {}); // fire-and-forget

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id/follow - Unfollow a user
router.delete('/:id/follow', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await followService.unfollowUser(req.user!.userId, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /:id/followers - List followers of a user
router.get('/:id/followers', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const followers = await followService.getFollowers(req.params.id);
    res.json(followers);
  } catch (err) {
    next(err);
  }
});

// GET /:id/following - List who a user follows
router.get('/:id/following', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const following = await followService.getFollowing(req.params.id);
    res.json(following);
  } catch (err) {
    next(err);
  }
});

export { router as userRouter };
