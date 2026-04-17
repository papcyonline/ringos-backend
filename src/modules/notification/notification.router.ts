import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import * as notificationService from './notification.service';

const router = Router();

// GET / - List notifications for current user
router.get('/', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const notifications = await notificationService.getNotifications(req.user!.userId);
    res.json(notifications);
  } catch (err) {
    next(err);
  }
});

// GET /unread-count - Get unread notification count
router.get('/unread-count', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await notificationService.getUnreadCount(req.user!.userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/read - Mark a notification as read
router.patch('/:id/read', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await notificationService.markAsRead(req.user!.userId, req.params.id as string);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /read-conversation/:conversationId - Mark all chat notifications for a conversation as read
router.post('/read-conversation/:conversationId', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await notificationService.markConversationNotificationsAsRead(req.user!.userId, (req.params.conversationId as string));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /read-all - Mark all notifications as read
router.post('/read-all', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await notificationService.markAllAsRead(req.user!.userId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /all - Clear every notification for the current user.
// Must be registered before DELETE /:id or Express would match "all"
// as a notification id.
router.delete('/all', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await notificationService.deleteAllNotifications(req.user!.userId);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id - Delete a single notification
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await notificationService.deleteNotification(req.user!.userId, req.params.id as string);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /fcm-token - Register FCM token
router.post('/fcm-token', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { token, platform } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    const plat = platform === 'ios' ? 'ios' : 'android';
    await notificationService.registerFcmToken(req.user!.userId, token, plat);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /fcm-token - Remove FCM token
router.delete('/fcm-token', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    await notificationService.removeFcmToken(token);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /voip-token - Register iOS VoIP push token
router.post('/voip-token', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    await notificationService.registerVoipToken(req.user!.userId, token);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /voip-token - Remove iOS VoIP push token
router.delete('/voip-token', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    await notificationService.removeVoipToken(token);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export { router as notificationRouter };
