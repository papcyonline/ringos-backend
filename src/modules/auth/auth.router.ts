import { Router, Response, NextFunction } from 'express';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { avatarUpload, fileToAvatarUrl } from '../../shared/upload';
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
} from './auth.schema';
import * as authService from './auth.service';

const router = Router();

router.post(
  '/register',
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
  '/username',
  authenticate,
  avatarUpload.single('avatar'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;

      // Validate username from multipart body via Zod
      const parsed = usernameSchema.parse(req.body);

      const avatarUrl = req.file ? fileToAvatarUrl(req.file) : undefined;
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
