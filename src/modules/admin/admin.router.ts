import { NextFunction, Router, Response } from 'express';
import { AuthRequest } from '../../shared/types';
import { BadRequestError } from '../../shared/errors';
import { requireAdmin } from './admin.middleware';
import * as adminService from './admin.service';

const router = Router();

// ── Auth ──

router.post(
  '/login',
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

export { router as adminRouter };
