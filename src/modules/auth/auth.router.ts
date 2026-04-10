import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { authRateLimit } from '../../middleware/authRateLimit';
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
  googleAuthSchema,
  appleAuthSchema,
  emailOtpSchema,
  resendOtpSchema,
} from './auth.schema';
import * as authService from './auth.service';

const router = Router();

router.post(
  '/register',
  authRateLimit('register', 5, 900),
  validate(registerSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;
      const result = await authService.register(email, password);
      logger.info({ userId: result.userId }, 'User registered — OTP sent');
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/register/verify-otp',
  authRateLimit('verify-email-otp', 5, 900),
  validate(emailOtpSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { email, code } = req.body;
      const result = await authService.verifyEmailOtp(email, code);
      logger.info({ userId: result.userId }, 'Email OTP verified');
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/register/resend-otp',
  authRateLimit('resend-email-otp', 3, 900),
  validate(resendOtpSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body;
      const result = await authService.resendEmailOtp(email);
      res.status(200).json(result);
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
      const result = await authService.login(email, password, req);
      if ('requires2FA' in result) {
        res.status(200).json({ requires2FA: true, tempToken: result.tempToken });
      } else {
        logger.info({ userId: result.user.id }, 'User logged in');
        res.status(200).json(result);
      }
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/google',
  authRateLimit('google', 10, 900),
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
  authRateLimit('apple', 10, 900),
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
  authRateLimit('anonymous', 10, 900),
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
  authRateLimit('phone', 3, 900),
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
  authRateLimit('reset-password', 5, 900),
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
  authRateLimit('refresh', 20, 900),
  validate(refreshTokenSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { refreshToken } = req.body;
      const result = await authService.refreshTokens(refreshToken, req);
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

router.post(
  '/logout-all',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const result = await authService.logoutAll(userId);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// GET /auth/sessions — List all active sessions for the current user
router.get(
  '/sessions',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const sessions = await authService.getUserSessions(req.user!.userId);
      res.status(200).json({ sessions });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /auth/sessions/:sessionId — Revoke a specific session
router.delete(
  '/sessions/:sessionId',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await authService.revokeSession(
        req.user!.userId,
        req.params.sessionId as string,
        req,
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── Two-Factor Authentication ──

import * as twoFactorService from './two_factor.service';

// POST /auth/2fa/login — Complete login with 2FA code
router.post('/2fa/login', authRateLimit('2fa-login', 5, 300), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tempToken, code } = req.body;
    if (!tempToken || !code) return res.status(400).json({ error: 'tempToken and code are required' });
    const result = await authService.complete2FALogin(tempToken, code, req);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /auth/2fa/setup — Generate TOTP secret + QR code
router.post('/2fa/setup', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await twoFactorService.setup2FA(req.user!.userId);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /auth/2fa/verify — Verify code and enable 2FA
router.post('/2fa/verify', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required' });
    const result = await twoFactorService.verify2FA(req.user!.userId, code);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /auth/2fa/disable — Disable 2FA
router.post('/2fa/disable', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required' });
    const result = await twoFactorService.disable2FA(req.user!.userId, code);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /auth/2fa/status — Check if 2FA is enabled
router.get('/2fa/status', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const enabled = await twoFactorService.has2FA(req.user!.userId);
    res.json({ enabled });
  } catch (err) { next(err); }
});

export { router as authRouter };
