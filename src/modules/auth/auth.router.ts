import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { avatarUpload, fileToAvatarUrl } from '../../shared/upload';
import { checkRateLimit } from '../../shared/redis.service';
import {
  anonymousAuthSchema,
  registerSchema,
  loginSchema,
  usernameSchema,
  phoneAuthSchema,
  verifyOtpSchema,
  refreshTokenSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  googleAuthSchema,
  appleAuthSchema,
} from './auth.schema';
import * as authService from './auth.service';

const router = Router();

/**
 * Per-route rate limiting middleware for auth endpoints.
 */
function authRateLimit(key: string, maxAttempts: number, windowSeconds: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const result = await checkRateLimit(`auth:${key}:${ip}`, maxAttempts, windowSeconds);
    if (!result.allowed) {
      res.status(429).json({ message: 'Too many attempts, try again later' });
      return;
    }
    next();
  };
}

router.post(
  '/register',
  authRateLimit('register', 5, 900),
  validate(registerSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;
      const result = await authService.register(email, password);
      logger.info({ userId: result.user.id }, 'User registered');
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/login',
  authRateLimit('login', 10, 900),
  validate(loginSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;
      const result = await authService.login(email, password);
      logger.info({ userId: result.user.id }, 'User logged in');
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/google',
  validate(googleAuthSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { idToken } = req.body;
      const result = await authService.googleAuth(idToken);
      logger.info({ userId: result.user.id, isNewUser: result.isNewUser }, 'Google auth');
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/apple',
  validate(appleAuthSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { idToken, fullName } = req.body;
      const result = await authService.appleAuth(idToken, fullName);
      logger.info({ userId: result.user.id, isNewUser: result.isNewUser }, 'Apple auth');
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/check-username',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const username = (req.query.username as string || '').trim();
      if (username.length < 3) {
        res.status(200).json({ available: false });
        return;
      }
      const available = await authService.checkUsernameAvailable(username, req.user!.userId);
      res.status(200).json({ available });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/username',
  authenticate,
  avatarUpload.single('avatar'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;

      // Validate username from multipart body via Zod
      const parsed = usernameSchema.parse(req.body);

      const avatarUrl = req.file ? await fileToAvatarUrl(req.file, userId) : undefined;
      const result = await authService.setUsername(userId, parsed.username, {
        avatarUrl,
        bio: parsed.bio,
        profession: parsed.profession,
        gender: parsed.gender,
        location: parsed.location,
        availabilityNote: parsed.availabilityNote,
        language: parsed.language,
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/anonymous',
  validate(anonymousAuthSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { deviceId } = req.body;
      const result = await authService.anonymousLogin(deviceId);
      logger.info({ userId: result.user.id }, 'Anonymous login');
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/phone',
  validate(phoneAuthSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { phone } = req.body;
      const result = await authService.requestOtp(phone);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/verify-otp',
  authRateLimit('verify-otp', 5, 900),
  validate(verifyOtpSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { phone, code } = req.body;
      const result = await authService.verifyOtp(phone, code);
      logger.info({ userId: result.user.id }, 'OTP verified');
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/forgot-password',
  authRateLimit('forgot-password', 3, 3600),
  validate(forgotPasswordSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body;
      const result = await authService.requestPasswordReset(email);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/reset-password',
  validate(resetPasswordSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { email, code, newPassword } = req.body;
      const result = await authService.resetPassword(email, code, newPassword);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/refresh',
  validate(refreshTokenSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body;
      const result = await authService.refreshTokens(refreshToken);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/logout',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const token = req.body.refreshToken;
      const result = await authService.logout(userId, token);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

export { router as authRouter };
