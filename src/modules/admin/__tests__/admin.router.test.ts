import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockAdminService } = vi.hoisted(() => ({
  mockAdminService: {
    loginAdmin: vi.fn().mockResolvedValue({ token: 't', admin: { id: 'a-1' } }),
    getAdminById: vi.fn().mockResolvedValue({
      id: 'a-1', email: 'a@b.com', displayName: 'Admin', role: 'OWNER', lastLoginAt: null,
    }),
    getOverview: vi.fn().mockResolvedValue({ users: { total: 0 } }),
  },
}));

vi.mock('../admin.service', () => mockAdminService);
vi.mock('../admin.middleware', () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.admin = { adminId: 'a-1', role: 'OWNER', kind: 'admin' };
    next();
  },
}));

import { adminRouter } from '../admin.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('admin.router', () => {
  it('POST /admin/login returns token', async () => {
    const res = await request(makeApp())
      .post('/admin/login')
      .send({ email: 'a@b.com', password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('t');
  });

  it('POST /admin/login rejects missing fields', async () => {
    const res = await request(makeApp()).post('/admin/login').send({});
    expect(res.status).toBe(400);
  });

  it('GET /admin/me returns admin profile', async () => {
    const res = await request(makeApp()).get('/admin/me');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('a-1');
  });

  it('GET /admin/stats/overview returns overview', async () => {
    const res = await request(makeApp()).get('/admin/stats/overview');
    expect(res.status).toBe(200);
    expect(res.body.users.total).toBe(0);
  });
});
