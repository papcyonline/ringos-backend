import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockNotifService } = vi.hoisted(() => ({
  mockNotifService: {
    getNotifications: vi.fn().mockResolvedValue([]),
    getUnreadCount: vi.fn().mockResolvedValue({ count: 0 }),
    markAsRead: vi.fn().mockResolvedValue(undefined),
    markConversationNotificationsAsRead: vi.fn().mockResolvedValue(undefined),
    markMissedCallNotificationsAsRead: vi.fn().mockResolvedValue(undefined),
    markAllAsRead: vi.fn().mockResolvedValue(undefined),
    deleteAllNotifications: vi.fn().mockResolvedValue({ deleted: 5 }),
    deleteNotification: vi.fn().mockResolvedValue(undefined),
    registerFcmToken: vi.fn().mockResolvedValue(undefined),
    removeFcmToken: vi.fn().mockResolvedValue(undefined),
    registerVoipToken: vi.fn().mockResolvedValue(undefined),
    removeVoipToken: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../config/database', () => ({ prisma: {} }));
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../notification.service', () => mockNotifService);

import { notificationRouter } from '../notification.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/notifications', notificationRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notification.router', () => {
  it('GET /notifications returns list', async () => {
    const res = await request(makeApp()).get('/notifications');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /notifications/unread-count', async () => {
    const res = await request(makeApp()).get('/notifications/unread-count');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it('PATCH /notifications/:id/read', async () => {
    const res = await request(makeApp()).patch('/notifications/n-1/read');
    expect(res.status).toBe(200);
    expect(mockNotifService.markAsRead).toHaveBeenCalledWith('user-1', 'n-1');
  });

  it('POST /notifications/read-conversation/:cId', async () => {
    const res = await request(makeApp()).post('/notifications/read-conversation/c-1');
    expect(res.status).toBe(200);
    expect(mockNotifService.markConversationNotificationsAsRead).toHaveBeenCalledWith('user-1', 'c-1');
  });

  it('POST /notifications/read-missed-calls', async () => {
    const res = await request(makeApp()).post('/notifications/read-missed-calls');
    expect(res.status).toBe(200);
  });

  it('POST /notifications/read-all', async () => {
    const res = await request(makeApp()).post('/notifications/read-all');
    expect(res.status).toBe(200);
  });

  it('DELETE /notifications/all clears all', async () => {
    const res = await request(makeApp()).delete('/notifications/all');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(5);
  });

  it('DELETE /notifications/:id', async () => {
    const res = await request(makeApp()).delete('/notifications/n-1');
    expect(res.status).toBe(200);
    expect(mockNotifService.deleteNotification).toHaveBeenCalledWith('user-1', 'n-1');
  });

  describe('FCM token', () => {
    it('POST /notifications/fcm-token registers ios', async () => {
      const res = await request(makeApp())
        .post('/notifications/fcm-token')
        .send({ token: 'tok-1', platform: 'ios' });
      expect(res.status).toBe(200);
      expect(mockNotifService.registerFcmToken).toHaveBeenCalledWith('user-1', 'tok-1', 'ios');
    });

    it('POST /notifications/fcm-token defaults to android', async () => {
      const res = await request(makeApp())
        .post('/notifications/fcm-token')
        .send({ token: 'tok-1' });
      expect(res.status).toBe(200);
      expect(mockNotifService.registerFcmToken).toHaveBeenCalledWith('user-1', 'tok-1', 'android');
    });

    it('POST /notifications/fcm-token rejects missing token', async () => {
      const res = await request(makeApp()).post('/notifications/fcm-token').send({});
      expect(res.status).toBe(400);
    });

    it('DELETE /notifications/fcm-token', async () => {
      const res = await request(makeApp())
        .delete('/notifications/fcm-token')
        .send({ token: 'tok-1' });
      expect(res.status).toBe(200);
      expect(mockNotifService.removeFcmToken).toHaveBeenCalledWith('tok-1');
    });

    it('DELETE /notifications/fcm-token rejects missing token', async () => {
      const res = await request(makeApp()).delete('/notifications/fcm-token').send({});
      expect(res.status).toBe(400);
      expect(mockNotifService.removeFcmToken).not.toHaveBeenCalled();
    });

    it('DELETE /notifications/fcm-token surfaces service error', async () => {
      mockNotifService.removeFcmToken.mockRejectedValueOnce(new Error('db'));
      const res = await request(makeApp())
        .delete('/notifications/fcm-token')
        .send({ token: 'tok-1' });
      expect(res.status).toBe(500);
    });
  });

  describe('VoIP token', () => {
    it('POST /notifications/voip-token', async () => {
      const res = await request(makeApp())
        .post('/notifications/voip-token')
        .send({ token: 'voip-1' });
      expect(res.status).toBe(200);
    });

    it('POST /notifications/voip-token rejects missing', async () => {
      const res = await request(makeApp()).post('/notifications/voip-token').send({});
      expect(res.status).toBe(400);
    });

    it('DELETE /notifications/voip-token', async () => {
      const res = await request(makeApp())
        .delete('/notifications/voip-token')
        .send({ token: 'voip-1' });
      expect(res.status).toBe(200);
      expect(mockNotifService.removeVoipToken).toHaveBeenCalledWith('voip-1');
    });

    it('DELETE /notifications/voip-token rejects missing token', async () => {
      const res = await request(makeApp()).delete('/notifications/voip-token').send({});
      expect(res.status).toBe(400);
      expect(mockNotifService.removeVoipToken).not.toHaveBeenCalled();
    });

    it('DELETE /notifications/voip-token surfaces service error', async () => {
      mockNotifService.removeVoipToken.mockRejectedValueOnce(new Error('db'));
      const res = await request(makeApp())
        .delete('/notifications/voip-token')
        .send({ token: 'voip-1' });
      expect(res.status).toBe(500);
    });
  });

  describe('error propagation', () => {
    it('GET /notifications surfaces error', async () => {
      mockNotifService.getNotifications.mockRejectedValueOnce(new Error('db'));
      const res = await request(makeApp()).get('/notifications');
      expect(res.status).toBe(500);
    });

    it('PATCH /notifications/:id/read surfaces error', async () => {
      mockNotifService.markAsRead.mockRejectedValueOnce(new Error('db'));
      const res = await request(makeApp()).patch('/notifications/n-1/read');
      expect(res.status).toBe(500);
    });

    it('DELETE /notifications/all surfaces error', async () => {
      mockNotifService.deleteAllNotifications.mockRejectedValueOnce(new Error('db'));
      const res = await request(makeApp()).delete('/notifications/all');
      expect(res.status).toBe(500);
    });

    it('POST /notifications/fcm-token surfaces error', async () => {
      mockNotifService.registerFcmToken.mockRejectedValueOnce(new Error('db'));
      const res = await request(makeApp())
        .post('/notifications/fcm-token')
        .send({ token: 't', platform: 'android' });
      expect(res.status).toBe(500);
    });

    it('POST /notifications/voip-token surfaces error', async () => {
      mockNotifService.registerVoipToken.mockRejectedValueOnce(new Error('db'));
      const res = await request(makeApp())
        .post('/notifications/voip-token')
        .send({ token: 't' });
      expect(res.status).toBe(500);
    });

  });
});
