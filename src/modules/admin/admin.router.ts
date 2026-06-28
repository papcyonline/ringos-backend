import { NextFunction, Router, Response } from 'express';
import { AuthRequest } from '../../shared/types';
import { BadRequestError, NotFoundError } from '../../shared/errors';
import { requireAdmin } from './admin.middleware';
import { authRateLimit } from '../../middleware/authRateLimit';
import * as adminService from './admin.service';
import { prisma } from '../../config/database';
import { checkUsernameAvailable } from '../auth/auth.service';
import {
  createAnnouncement,
  deactivateAnnouncement,
} from '../announcement/announcement.service';
import { getIO } from '../../config/socket';

const router = Router();

// ── Auth ──

router.post(
  '/login',
  authRateLimit('admin-login', 5, 900),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const email = String(req.body?.email ?? '').trim();
      const password = String(req.body?.password ?? '');
      if (!email || !password) {
        throw new BadRequestError('Email and password are required');
      }
      const result = await adminService.loginAdmin(email, password);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/me',
  requireAdmin,
  async (req: AuthRequest & { admin?: { adminId: string } }, res: Response, next: NextFunction) => {
    try {
      const admin = await adminService.getAdminById(req.admin!.adminId);
      res.json({
        id: admin.id,
        email: admin.email,
        displayName: admin.displayName,
        role: admin.role,
        lastLoginAt: admin.lastLoginAt,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── Users ──

/** GET /admin/users/search?q=apple  — find a user by username or ID */
router.get(
  '/users/search',
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const q = String(req.query.q ?? '').trim();
      if (!q) throw new BadRequestError('q is required');
      const user = await prisma.user.findFirst({
        where: {
          OR: [
            { id: q },
            { displayName: { equals: q, mode: 'insensitive' } },
          ],
        },
        select: { id: true, displayName: true, email: true, isVerified: true, createdAt: true },
      });
      if (!user) throw new NotFoundError('User not found');
      res.json(user);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * PUT /admin/users/:userId/username
 * Body: { username: string, verify?: boolean }
 *
 * Bypasses the reserved-username blocklist and the 20-day cooldown so you
 * can assign any name to the real owner (e.g. the real Apple Inc.).
 * Optionally flips isVerified = true at the same time.
 */
router.put(
  '/users/:userId/username',
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = String(req.params.userId);
      const username = String(req.body?.username ?? '').trim();
      const verify = req.body?.verify === true;

      if (!username) throw new BadRequestError('username is required');
      if (username.length < 1 || username.length > 50) {
        throw new BadRequestError('username must be 1–50 characters');
      }

      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true } });
      if (!user) throw new NotFoundError('User not found');

      const available = await checkUsernameAvailable(username, userId);
      if (!available) throw new BadRequestError(`Username "${username}" is already taken by another account`);

      const updated = await prisma.user.update({
        where: { id: userId },
        data: {
          displayName: username,
          lastNameChangeAt: new Date(),
          ...(verify ? { isVerified: true } : {}),
        },
        select: { id: true, displayName: true, isVerified: true },
      });

      res.json({ ok: true, user: updated });
    } catch (err) {
      next(err);
    }
  },
);

// ── Stats ──

router.get(
  '/stats/overview',
  requireAdmin,
  async (_req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const overview = await adminService.getOverview();
      res.json(overview);
    } catch (err) {
      next(err);
    }
  },
);

// ── Announcements ──

/// Publish an app-wide announcement (maintenance notice, outage, etc.).
/// Persists it (so launching clients fetch it via GET /announcements/active)
/// AND broadcasts a socket `announcement` event to every connected client for
/// instant display.
router.post(
  '/announcements',
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const title = String(req.body?.title ?? '').trim();
      const body = String(req.body?.body ?? '').trim();
      if (!title || !body) {
        throw new BadRequestError('title and body are required');
      }
      const severityRaw = String(req.body?.severity ?? 'INFO').toUpperCase();
      const severity =
        severityRaw === 'WARNING' || severityRaw === 'CRITICAL'
          ? (severityRaw as 'WARNING' | 'CRITICAL')
          : ('INFO' as const);
      const parseDate = (v: unknown): Date | null => {
        if (typeof v !== 'string' || v.trim() === '') return null;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
      };

      const announcement = await createAnnouncement({
        title,
        body,
        severity,
        dismissible: req.body?.dismissible !== false,
        startsAt: parseDate(req.body?.startsAt),
        endsAt: parseDate(req.body?.endsAt),
        ctaText:
          typeof req.body?.ctaText === 'string' ? req.body.ctaText : null,
        ctaUrl: typeof req.body?.ctaUrl === 'string' ? req.body.ctaUrl : null,
      });

      // Instant delivery to in-app users. Clients not connected pick it up on
      // their next launch/foreground fetch.
      try {
        getIO().emit('announcement', announcement);
      } catch (e) {
        // Socket layer not ready — non-fatal; the fetch path still covers it.
      }

      res.status(201).json({ announcement });
    } catch (err) {
      next(err);
    }
  },
);

/// Pull an announcement early.
router.post(
  '/announcements/:id/deactivate',
  requireAdmin,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      await deactivateAnnouncement(String(req.params.id));
      // Tell clients to clear any showing banner for this id.
      try {
        getIO().emit('announcement:clear', { id: String(req.params.id) });
      } catch (e) {
        /* non-fatal */
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

export { router as adminRouter };
