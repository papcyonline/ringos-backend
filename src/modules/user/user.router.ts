import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AuthRequest } from '../../shared/types';
import { avatarUpload, fileToAvatarUrl } from '../../shared/upload';
import { updatePreferenceSchema, updateAvailabilitySchema } from './user.schema';
import * as userService from './user.service';

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

// DELETE /me - Delete current user's account
router.delete('/me', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await userService.deleteAccount(req.user!.userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export { router as userRouter };
