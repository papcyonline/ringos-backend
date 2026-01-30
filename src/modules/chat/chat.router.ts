import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { moderateMessage } from '../../middleware/moderation';
import { AuthRequest } from '../../shared/types';
import { sendMessageSchema } from './chat.schema';
import * as chatService from './chat.service';

const router = Router();

// GET /conversations - List user's conversations
router.get(
  '/conversations',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const conversations = await chatService.getConversations(req.user!.userId);
      res.json(conversations);
    } catch (err) {
      next(err);
    }
  },
);

// GET /conversations/:conversationId - Get a single conversation
router.get(
  '/conversations/:conversationId',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const conversation = await chatService.getConversation(
        req.params.conversationId,
        req.user!.userId,
      );
      res.json(conversation);
    } catch (err) {
      next(err);
    }
  },
);

// GET /conversations/:conversationId/messages - Get paginated messages
router.get(
  '/conversations/:conversationId/messages',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 50;

      const messages = await chatService.getMessages(
        req.params.conversationId,
        req.user!.userId,
        page,
        limit,
      );
      res.json(messages);
    } catch (err) {
      next(err);
    }
  },
);

// POST /conversations/:conversationId/messages - Send a message
router.post(
  '/conversations/:conversationId/messages',
  authenticate,
  validate(sendMessageSchema),
  moderateMessage('content'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const message = await chatService.sendMessage(
        req.params.conversationId,
        req.user!.userId,
        req.body.content,
      );
      res.status(201).json(message);
    } catch (err) {
      next(err);
    }
  },
);

// POST /conversations/direct/:userId - Get or create a direct conversation
router.post(
  '/conversations/direct/:userId',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const conversation = await chatService.getOrCreateDirectConversation(
        req.user!.userId,
        req.params.userId,
      );
      res.json(conversation);
    } catch (err) {
      next(err);
    }
  },
);

// POST /conversations/:conversationId/end - End a conversation
router.post(
  '/conversations/:conversationId/end',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const conversation = await chatService.endConversation(
        req.params.conversationId,
        req.user!.userId,
      );
      res.json(conversation);
    } catch (err) {
      next(err);
    }
  },
);

export { router as chatRouter };
