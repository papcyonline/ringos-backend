import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { ForbiddenError, NotFoundError } from '../../shared/errors';

export interface AdminTokenPayload {
  adminId: string;
  role: string;
  kind: 'admin';
}

/** Sign a short-lived admin JWT (8h). */
function signAdminToken(adminId: string, role: string): string {
  const payload: AdminTokenPayload = { adminId, role, kind: 'admin' };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '8h' });
}

export async function loginAdmin(email: string, password: string) {
  const admin = await prisma.adminUser.findUnique({
    where: { email: email.toLowerCase().trim() },
  });
  if (!admin || !admin.isActive) {
    // Identical error for unknown / disabled to avoid enumeration.
    throw new ForbiddenError('Invalid credentials');
  }
  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) throw new ForbiddenError('Invalid credentials');

  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { lastLoginAt: new Date() },
  });

  return {
    token: signAdminToken(admin.id, admin.role),
    admin: {
      id: admin.id,
      email: admin.email,
      displayName: admin.displayName,
      role: admin.role,
    },
  };
}

export async function getAdminById(adminId: string) {
  const admin = await prisma.adminUser.findUnique({ where: { id: adminId } });
  if (!admin || !admin.isActive) throw new NotFoundError('Admin not found');
  return admin;
}

/**
 * Dashboard overview: counts + platform + top countries.
 * Kept in one round-trip via Promise.all for speed.
 */
export async function getOverview() {
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    newToday,
    newThisWeek,
    newThisMonth,
    dau,
    wau,
    mau,
    proCount,
    bannedCount,
    openReports,
    fcmByPlatform,
    usersWithLocation,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.user.count({ where: { createdAt: { gte: monthAgo } } }),
    prisma.user.count({ where: { lastSeenAt: { gte: dayAgo } } }),
    prisma.user.count({ where: { lastSeenAt: { gte: weekAgo } } }),
    prisma.user.count({ where: { lastSeenAt: { gte: monthAgo } } }),
    prisma.subscription.count({ where: { status: 'ACTIVE' } }),
    prisma.userModeration.count({
      where: { banStatus: { in: ['TEMP_BAN', 'PERMANENT_BAN'] } },
    }),
    prisma.report.count({ where: { status: 'PENDING' } }),
    prisma.fcmToken.groupBy({
      by: ['platform'],
      _count: { userId: true },
    }),
    prisma.user.findMany({
      where: { location: { not: null } },
      select: { location: true },
      take: 50000, // cap in case of runaway data
    }),
  ]);

  // Normalize platform counts — fallback to 'unknown' for missing platform.
  const platforms: { platform: string; count: number }[] = fcmByPlatform.map((p) => ({
    platform: p.platform || 'unknown',
    count: p._count.userId,
  }));

  // Aggregate top countries from free-text `location` field.
  // Assumption: users wrote locations like "City, Country" — we take the last comma-separated segment.
  const countryCounts = new Map<string, number>();
  for (const u of usersWithLocation) {
    if (!u.location) continue;
    const parts = u.location.split(',').map((s) => s.trim()).filter(Boolean);
    const country = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    if (!country) continue;
    countryCounts.set(country, (countryCounts.get(country) ?? 0) + 1);
  }
  const topCountries = [...countryCounts.entries()]
    .map(([country, count]) => ({ country, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    users: {
      total: totalUsers,
      newToday,
      newThisWeek,
      newThisMonth,
    },
    active: { dau, wau, mau },
    pro: { active: proCount },
    moderation: {
      banned: bannedCount,
      openReports,
    },
    platforms,
    topCountries,
  };
}
