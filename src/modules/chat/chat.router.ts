import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { moderateMessage } from '../../middleware/moderation';
import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { avatarUpload, fileToAvatarUrl, chatImageUpload, fileToChatImageUrl, chatAudioUpload, fileToChatAudioUrl, chatDocumentUpload, fileToChatDocumentUrl } from '../../shared/upload';
import { getIO } from '../../config/socket';
import { sendMessageSchema, editMessageSchema, reactMessageSchema } from './chat.schema';
import * as chatService from './chat.service';
import * as groupService from './group.service';
import { formatMessagePayload, emitToParticipantRooms } from './chat.utils';
import { translateMessage } from './translation.service';
import { transcribeMessage } from './transcription.service';
import { notifyChatMessage } from '../notification/notification.service';

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

// GET /conversations/groups/public - List all active groups (publicly discoverable)
router.get(
  '/conversations/groups/public',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const groups = await chatService.getAllGroups(req.user!.userId);
      res.json(groups);
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
        (req.params.conversationId as string) as string,
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
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
      const cursor = (req.query.cursor as string) || undefined;

      const messages = await chatService.getMessages(
        (req.params.conversationId as string),
        req.user!.userId,
        page,
        limit,
        cursor,
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
        (req.params.conversationId as string),
        req.user!.userId,
        req.body.content || '',
        {
          replyToId: req.body.replyToId,
          imageUrl: req.body.imageUrl,
          audioUrl: req.body.audioUrl,
          audioDuration: req.body.audioDuration,
          viewOnce: req.body.viewOnce,
          metadata: req.body.metadata,
        },
      );

      // Broadcast to room so other participants see it in real-time
      const io = getIO();
      const msgPayload = formatMessagePayload(message, (req.params.conversationId as string));
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('chat:message', msgPayload);

      // Also notify each participant's personal room for conversation-list updates
      emitToParticipantRooms(io, (req.params.conversationId as string), msgPayload).catch((err) => {
        logger.error({ err, conversationId: (req.params.conversationId as string) }, 'Failed to emit to participant rooms');
      });

      // Notify other participants (in-app + push)
      notifyChatMessage(
        (req.params.conversationId as string),
        req.user!.userId,
        message.sender.displayName,
        message.content,
        { imageUrl: message.imageUrl ?? undefined, audioUrl: message.audioUrl ?? undefined },
      ).catch((err) => {
        logger.error({ err, conversationId: (req.params.conversationId as string) }, 'Failed to send chat notification');
      });

      // Auto-translate in background
      if (message.content) {
        translateMessage(message.id, (req.params.conversationId as string), message.content).catch(() => {});
      }

      res.status(201).json(message);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /conversations/:conversationId/messages/:messageId - Edit a message
router.put(
  '/conversations/:conversationId/messages/:messageId',
  authenticate,
  validate(editMessageSchema),
  moderateMessage('content'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const message = await chatService.editMessage(
        (req.params.messageId as string),
        req.user!.userId,
        req.body.content,
      );

      // Broadcast edit to room
      const io = getIO();
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('chat:edited', {
        messageId: message.id,
        content: message.content,
        editedAt: message.editedAt,
      });

      res.json(message);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /conversations/:conversationId/messages/:messageId - Delete a message
router.delete(
  '/conversations/:conversationId/messages/:messageId',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const message = await chatService.deleteMessage(
        (req.params.messageId as string),
        req.user!.userId,
      );

      // Broadcast deletion to room
      const io = getIO();
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('chat:deleted', {
        messageId: message.id,
        deletedAt: message.deletedAt,
      });

      res.json(message);
    } catch (err) {
      next(err);
    }
  },
);

// POST /conversations/:conversationId/messages/:messageId/reactions - Toggle reaction
router.post(
  '/conversations/:conversationId/messages/:messageId/reactions',
  authenticate,
  validate(reactMessageSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await chatService.toggleReaction(
        (req.params.messageId as string),
        req.user!.userId,
        req.body.emoji,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /conversations/:conversationId/messages/:messageId/transcribe - Transcribe voice note
router.post(
  '/conversations/:conversationId/messages/:messageId/transcribe',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await transcribeMessage(
        req.params.messageId as string,
        req.params.conversationId as string,
        req.user!.userId,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /conversations/:conversationId/messages/:messageId/pin - Toggle pin on a message
router.patch(
  '/conversations/:conversationId/messages/:messageId/pin',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const message = await chatService.togglePinMessage(
        (req.params.messageId as string),
        req.user!.userId,
      );
      const io = getIO();
      io.to(`conversation:${req.params.conversationId}`).emit('chat:pinned', {
        conversationId: req.params.conversationId,
        message: formatMessagePayload(message, req.user!.userId),
      });
      res.json({ message });
    } catch (err) {
      next(err);
    }
  },
);

// GET /conversations/:conversationId/pinned - Get pinned messages
router.get(
  '/conversations/:conversationId/pinned',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const messages = await chatService.getPinnedMessages(
        (req.params.conversationId as string),
        req.user!.userId,
      );
      res.json({ messages });
    } catch (err) {
      next(err);
    }
  },
);

// POST /conversations/:conversationId/image - Send an image message
router.post(
  '/conversations/:conversationId/image',
  authenticate,
  chatImageUpload.single('image'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded' });
      }
      const imageUrl = await fileToChatImageUrl(req.file, (req.params.conversationId as string));
      const caption = (req.body.caption as string) || '';
      const replyToId = req.body.replyToId as string | undefined;
      const viewOnce = req.body.viewOnce === 'true';

      const message = await chatService.sendMessage(
        (req.params.conversationId as string),
        req.user!.userId,
        caption,
        { replyToId, imageUrl, viewOnce },
      );

      // Broadcast to room so other participants see it
      const io = getIO();
      const imgPayload = formatMessagePayload(message, (req.params.conversationId as string));
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('chat:message', imgPayload);

      // Also notify each participant's personal room for conversation-list updates
      emitToParticipantRooms(io, (req.params.conversationId as string), imgPayload).catch((err) => {
        logger.error({ err, conversationId: (req.params.conversationId as string) }, 'Failed to emit to participant rooms');
      });

      // Notify other participants (in-app + push)
      notifyChatMessage(
        (req.params.conversationId as string),
        req.user!.userId,
        message.sender.displayName,
        message.content,
        { imageUrl: message.imageUrl ?? undefined },
      ).catch((err) => {
        logger.error({ err, conversationId: (req.params.conversationId as string) }, 'Failed to send image notification');
      });

      // Auto-translate caption in background
      if (message.content) {
        translateMessage(message.id, (req.params.conversationId as string), message.content).catch(() => {});
      }

      res.status(201).json(message);
    } catch (err) {
      next(err);
    }
  },
);

// POST /conversations/:conversationId/audio - Send an audio message
router.post(
  '/conversations/:conversationId/audio',
  authenticate,
  chatAudioUpload.single('audio'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No audio file uploaded' });
      }
      const audioUrl = await fileToChatAudioUrl(req.file, (req.params.conversationId as string));
      const duration = parseInt(req.body.duration as string, 10) || 0;
      const replyToId = req.body.replyToId as string | undefined;

      const message = await chatService.sendMessage(
        (req.params.conversationId as string),
        req.user!.userId,
        '',
        { replyToId, audioUrl, audioDuration: duration },
      );

      // Broadcast to room so other participants see it
      const io = getIO();
      const audioPayload = formatMessagePayload(message, (req.params.conversationId as string));
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('chat:message', audioPayload);

      // Also notify each participant's personal room for conversation-list updates
      emitToParticipantRooms(io, (req.params.conversationId as string), audioPayload).catch((err) => {
        logger.error({ err, conversationId: (req.params.conversationId as string) }, 'Failed to emit to participant rooms');
      });

      // Notify other participants (in-app + push)
      notifyChatMessage(
        (req.params.conversationId as string),
        req.user!.userId,
        message.sender.displayName,
        message.content,
        { audioUrl: message.audioUrl ?? undefined },
      ).catch((err) => {
        logger.error({ err, conversationId: (req.params.conversationId as string) }, 'Failed to send audio notification');
      });

      res.status(201).json(message);
    } catch (err) {
      next(err);
    }
  },
);

// POST /conversations/:conversationId/document - Send a document message
router.post(
  '/conversations/:conversationId/document',
  authenticate,
  chatDocumentUpload.single('document'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No document uploaded' });
      }
      const documentUrl = await fileToChatDocumentUrl(req.file, (req.params.conversationId as string));
      const caption = (req.body.caption as string) || '';
      const replyToId = req.body.replyToId as string | undefined;

      const message = await chatService.sendMessage(
        (req.params.conversationId as string),
        req.user!.userId,
        caption,
        {
          replyToId,
          imageUrl: documentUrl,
          metadata: {
            isDocument: true,
            fileName: req.file.originalname,
            fileSize: req.file.size,
            mimeType: req.file.mimetype,
          },
        },
      );

      // Broadcast to room so other participants see it
      const io = getIO();
      const docPayload = formatMessagePayload(message, (req.params.conversationId as string));
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('chat:message', docPayload);

      // Also notify each participant's personal room for conversation-list updates
      emitToParticipantRooms(io, (req.params.conversationId as string), docPayload).catch((err) => {
        logger.error({ err, conversationId: (req.params.conversationId as string) }, 'Failed to emit to participant rooms');
      });

      // Notify other participants (in-app + push)
      notifyChatMessage(
        (req.params.conversationId as string),
        req.user!.userId,
        message.sender.displayName,
        message.content,
        { imageUrl: message.imageUrl ?? undefined },
      ).catch((err) => {
        logger.error({ err, conversationId: (req.params.conversationId as string) }, 'Failed to send document notification');
      });

      // Auto-translate caption in background
      if (message.content) {
        translateMessage(message.id, (req.params.conversationId as string), message.content).catch(() => {});
      }

      res.status(201).json(message);
    } catch (err) {
      next(err);
    }
  },
);

// POST /conversations/:conversationId/messages/:messageId/view-once - Open a view-once message
router.post(
  '/conversations/:conversationId/messages/:messageId/view-once',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await chatService.openViewOnce(
        (req.params.messageId as string),
        req.user!.userId,
      );

      // Notify the room that view-once was opened
      const io = getIO();
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('chat:viewOnceOpened', {
        messageId: result.messageId,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /conversations/:conversationId/join - Self-join a group
router.post(
  '/conversations/:conversationId/join',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const conversation = await groupService.joinGroup(
        (req.params.conversationId as string),
        req.user!.userId,
      );

      const io = getIO();
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('group:members-changed', {
        conversationId: (req.params.conversationId as string),
      });

      res.json(conversation);
    } catch (err) {
      next(err);
    }
  },
);

// POST /conversations/group - Create a group conversation
router.post(
  '/conversations/group',
  authenticate,
  (req: AuthRequest, res: Response, next: NextFunction) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      avatarUpload.single('avatar')(req, res, next);
    } else {
      next();
    }
  },
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { name, description } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }
      let memberIds: string[] = [];
      if (req.body.memberIds) {
        if (Array.isArray(req.body.memberIds)) {
          memberIds = req.body.memberIds;
        } else if (typeof req.body.memberIds === 'string') {
          // Could be JSON array or comma-separated string from FormData
          try {
            const parsed = JSON.parse(req.body.memberIds);
            memberIds = Array.isArray(parsed) ? parsed : [req.body.memberIds];
          } catch {
            memberIds = req.body.memberIds.split(',').filter((id: string) => id.trim());
          }
        }
      }
      const avatarUrl = req.file ? await fileToAvatarUrl(req.file, req.user!.userId) : req.body.avatarUrl || undefined;
      // Parse isPublic: accept boolean or string "true"/"false" (from FormData)
      const rawIsPublic = req.body.isPublic;
      const isPublic = rawIsPublic !== undefined
        ? (typeof rawIsPublic === 'boolean' ? rawIsPublic : rawIsPublic === 'true')
        : undefined;
      const conversation = await groupService.createGroup(
        req.user!.userId,
        name,
        memberIds,
        avatarUrl,
        description,
        isPublic,
      );
      res.status(201).json(conversation);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /conversations/:id/group - Update group name/avatar/description
router.put(
  '/conversations/:conversationId/group',
  authenticate,
  (req: AuthRequest, res: Response, next: NextFunction) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      avatarUpload.single('avatar')(req, res, next);
    } else {
      next();
    }
  },
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { name, description } = req.body;
      const avatarUrl = req.file ? await fileToAvatarUrl(req.file, req.user!.userId) : req.body.avatarUrl;
      // Parse isPublic: accept boolean or string "true"/"false" (from FormData)
      const rawIsPublic = req.body.isPublic;
      const isPublic = rawIsPublic !== undefined
        ? (typeof rawIsPublic === 'boolean' ? rawIsPublic : rawIsPublic === 'true')
        : undefined;
      const conversation = await groupService.updateGroup(
        (req.params.conversationId as string),
        req.user!.userId,
        { name, avatarUrl, description, isPublic },
      );

      const io = getIO();
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('group:updated', {
        conversationId: (req.params.conversationId as string),
      });

      res.json(conversation);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /conversations/:id/group/verify - Toggle group verified (admin only)
router.put(
  '/conversations/:conversationId/group/verify',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await groupService.toggleGroupVerified(
        (req.params.conversationId as string),
        req.user!.userId,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /conversations/:id/group/call-settings - Update group call settings (admin only)
router.put(
  '/conversations/:conversationId/group/call-settings',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { callsEnabled, videoEnabled } = req.body;
      const result = await groupService.updateGroupCallSettings(
        (req.params.conversationId as string),
        req.user!.userId,
        { callsEnabled, videoEnabled },
      );

      const io = getIO();
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('group:updated', {
        conversationId: (req.params.conversationId as string),
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /conversations/:id/group - Delete a group (admin only)
router.delete(
  '/conversations/:conversationId/group',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await groupService.deleteGroup(
        (req.params.conversationId as string),
        req.user!.userId,
      );

      const io = getIO();
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('group:deleted', {
        conversationId: (req.params.conversationId as string),
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /conversations/:id/members - Add members to group
router.post(
  '/conversations/:conversationId/members',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { memberIds } = req.body;
      if (!memberIds || !Array.isArray(memberIds)) {
        return res.status(400).json({ error: 'memberIds array is required' });
      }
      const conversation = await groupService.addMembers(
        (req.params.conversationId as string),
        req.user!.userId,
        memberIds,
      );

      // Emit socket event for member changes
      const io = getIO();
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('group:members-changed', {
        conversationId: (req.params.conversationId as string),
      });

      res.json(conversation);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /conversations/:id/members/:userId - Remove member from group
router.delete(
  '/conversations/:conversationId/members/:userId',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await groupService.removeMember(
        (req.params.conversationId as string),
        req.user!.userId,
        (req.params.userId as string),
      );

      const io = getIO();
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('group:members-changed', {
        conversationId: (req.params.conversationId as string),
      });
      io.to(`user:${(req.params.userId as string)}`).emit('group:removed', {
        conversationId: (req.params.conversationId as string),
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /conversations/:id/members/:userId/role - Promote member to admin
router.put(
  '/conversations/:conversationId/members/:userId/role',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await groupService.makeAdmin(
        (req.params.conversationId as string),
        req.user!.userId,
        (req.params.userId as string),
      );

      const io = getIO();
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('group:members-changed', {
        conversationId: (req.params.conversationId as string),
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /conversations/:conversationId/pin - Toggle pin
router.patch(
  '/conversations/:conversationId/pin',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await chatService.togglePin(
        req.user!.userId,
        req.params.conversationId as string,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /conversations/:conversationId/mute - Toggle mute
router.patch(
  '/conversations/:conversationId/mute',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await chatService.toggleMute(
        req.user!.userId,
        req.params.conversationId as string,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /conversations/:conversationId/archive - Toggle archive
router.patch(
  '/conversations/:conversationId/archive',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await chatService.toggleArchive(
        req.user!.userId,
        req.params.conversationId as string,
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /conversations/:conversationId/read - Mark conversation as read
router.post(
  '/conversations/:conversationId/read',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      await chatService.markConversationAsRead(
        (req.params.conversationId as string),
        req.user!.userId,
      );

      // Broadcast read receipt so the sender sees blue ticks
      const io = getIO();
      io.to(`conversation:${(req.params.conversationId as string)}`).emit('chat:read', {
        conversationId: (req.params.conversationId as string),
        userId: req.user!.userId,
      });

      res.json({ success: true });
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
        (req.params.userId as string),
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
        (req.params.conversationId as string),
        req.user!.userId,
      );
      res.json(conversation);
    } catch (err) {
      next(err);
    }
  },
);

export { router as chatRouter };
