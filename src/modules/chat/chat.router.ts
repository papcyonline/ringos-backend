import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { userRateLimit } from '../../middleware/userRateLimit';

import { AuthRequest } from '../../shared/types';
import { logger } from '../../shared/logger';
import { avatarUpload, fileToAvatarUrl, chatImageUpload, fileToChatImageUrl, chatAudioUpload, fileToChatAudioUrl, chatDocumentUpload, fileToChatDocumentUrl } from '../../shared/upload';
import { getIO } from '../../config/socket';
import { sendMessageSchema, editMessageSchema, reactMessageSchema, forwardMessageSchema, searchMessagesSchema } from './chat.schema';
import * as chatService from './chat.service';
import * as groupService from './group.service';
import * as pollService from './poll.service';
import { formatMessagePayload, emitToParticipantRooms, broadcastAndNotifyMessage } from './chat.utils';
import { translateMessage } from './translation.service';
import { transcribeMessage } from './transcription.service';
import { notifyChatMessage } from '../notification/notification.service';
import { prisma } from '../../config/database';
import * as folderService from './folder.service';

const router = Router();

// ─── Chat Folders ────────────────────────────────────────

// GET /folders - List user's chat folders
router.get('/folders', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const folders = await folderService.getFolders(req.user!.userId);
    res.json({ folders });
  } catch (err) { next(err); }
});

// POST /folders - Create a chat folder
router.post('/folders', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, icon, color } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Folder name is required' });
    }
    if (name.trim().length > 30) {
      return res.status(400).json({ error: 'Folder name too long (max 30 characters)' });
    }
    const folder = await folderService.createFolder(req.user!.userId, name, icon, color);
    res.status(201).json(folder);
  } catch (err) { next(err); }
});

// PUT /folders/:folderId - Update a chat folder
router.put('/folders/:folderId', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, icon, color } = req.body;
    const folder = await folderService.updateFolder(req.user!.userId, (req.params.folderId as string), { name, icon, color });
    res.json(folder);
  } catch (err) { next(err); }
});

// DELETE /folders/:folderId - Delete a chat folder
router.delete('/folders/:folderId', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await folderService.deleteFolder(req.user!.userId, (req.params.folderId as string));
    res.json(result);
  } catch (err) { next(err); }
});

// PUT /folders/reorder - Reorder chat folders
router.put('/folders/reorder', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { folderIds } = req.body;
    if (!Array.isArray(folderIds)) {
      return res.status(400).json({ error: 'folderIds array is required' });
    }
    const result = await folderService.reorderFolders(req.user!.userId, folderIds);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /folders/:folderId/conversations/:conversationId - Add conversation to folder
router.post('/folders/:folderId/conversations/:conversationId', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await folderService.addConversationToFolder(
      req.user!.userId, (req.params.folderId as string), (req.params.conversationId as string),
    );
    res.json(result);
  } catch (err) { next(err); }
});

// DELETE /folders/conversations/:conversationId - Remove conversation from its folder
router.delete('/folders/conversations/:conversationId', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await folderService.removeConversationFromFolder(
      req.user!.userId, (req.params.conversationId as string),
    );
    res.json(result);
  } catch (err) { next(err); }
});

// GET /messages/search - Global message search across all conversations
router.get(
  '/messages/search',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const q = (req.query.q as string || '').trim();
      if (q.length < 1) {
        return res.status(400).json({ error: 'Search query is required' });
      }
      const messages = await chatService.searchMessagesGlobal(req.user!.userId, q);
      res.json({ messages });
    } catch (err) { next(err); }
  },
);

// ─── Conversations ───────────────────────────────────────

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

// GET /conversations/channels/recommended - Get recommended channels for user
router.get(
  '/conversations/channels/recommended',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const category = req.query.category as string | undefined;
      const limit = Math.min(50, parseInt(req.query.limit as string, 10) || 20);
      const channels = await chatService.getRecommendedChannels(req.user!.userId, category, limit);
      res.json(channels);
    } catch (err) { next(err); }
  },
);

// GET /conversations/channels/search - Search channels
router.get('/conversations/channels/search', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const query = req.query.q as string || '';
    const results = await chatService.searchChannels(query, req.user!.userId);
    res.json(results);
  } catch (err) { next(err); }
});

// GET /conversations/groups/public - List all active groups (excludes channels)
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

// POST /conversations/channel-dm/:channelId - Create or get a channel DM
router.post(
  '/conversations/channel-dm/:channelId',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const conversation = await chatService.getOrCreateChannelDM(
        req.params.channelId as string,
        req.user!.userId,
      );
      res.json(conversation);
    } catch (err) { next(err); }
  },
);

// GET /conversations/channel-inbox/:channelId - Get channel inbox (admin only)
router.get(
  '/conversations/channel-inbox/:channelId',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const cursor = req.query.cursor as string | undefined;
      const limit = parseInt(req.query.limit as string || '20') || 20;
      const archived = req.query.archived === 'true';
      const result = await chatService.getChannelInbox(
        req.params.channelId as string,
        req.user!.userId,
        cursor,
        limit,
        archived,
      );
      res.json(result);
    } catch (err) { next(err); }
  },
);

// GET /conversations/channel-inbox/:channelId/unread-count - Get total unread count for inbox badge
router.get(
  '/conversations/channel-inbox/:channelId/unread-count',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await chatService.getChannelInboxUnreadCount(
        req.params.channelId as string,
        req.user!.userId,
      );
      res.json(result);
    } catch (err) { next(err); }
  },
);

// POST /conversations/channel-inbox/:channelId/block/:subscriberUserId - Block subscriber
router.post(
  '/conversations/channel-inbox/:channelId/block/:subscriberUserId',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await chatService.blockChannelSubscriber(
        req.params.channelId as string,
        req.user!.userId,
        req.params.subscriberUserId as string,
      );
      res.json(result);
    } catch (err) { next(err); }
  },
);

// DELETE /conversations/channel-inbox/:channelId/:conversationId - Delete channel DM from inbox
router.delete(
  '/conversations/channel-inbox/:channelId/:conversationId',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await chatService.deleteChannelDM(
        req.params.channelId as string,
        req.params.conversationId as string,
        req.user!.userId,
      );
      res.json(result);
    } catch (err) { next(err); }
  },
);

// GET /conversations/channels/public - List all active channels (excludes groups)
router.get(
  '/conversations/channels/public',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const channels = await chatService.getAllChannels(req.user!.userId);
      res.json(channels);
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
  userRateLimit('message-send', 120, 60), // 120 messages per minute (2/sec)
  validate(sendMessageSchema),
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

      broadcastAndNotifyMessage(message, (req.params.conversationId as string), req.user!.userId);
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
      const rawMode = req.query.mode as string;
      const mode: 'me' | 'everyone' | 'unsend' =
        rawMode === 'me' ? 'me' : rawMode === 'unsend' ? 'unsend' : 'everyone';
      const message = await chatService.deleteMessage(
        (req.params.messageId as string),
        req.user!.userId,
        mode,
      );

      if (mode === 'everyone' || mode === 'unsend') {
        const event = mode === 'unsend' ? 'chat:unsent' : 'chat:deleted';
        const io = getIO();
        const convId = req.params.conversationId as string;
        const payload = {
          messageId: message.id,
          conversationId: convId,
          deletedAt: (message as any).deletedAt ?? null,
        };
        io.to(`conversation:${convId}`).emit(event, payload);

        prisma.conversationParticipant.findMany({
          where: { conversationId: convId, leftAt: null },
          select: { userId: true },
        }).then((participants) => {
          for (const p of participants) {
            io.to(`user:${p.userId}`).emit(event, payload);
          }
        }).catch(() => {});
      }

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

      broadcastAndNotifyMessage(message, (req.params.conversationId as string), req.user!.userId);
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
      const viewOnce = req.body.viewOnce === 'true';

      const message = await chatService.sendMessage(
        (req.params.conversationId as string),
        req.user!.userId,
        '',
        { replyToId, audioUrl, audioDuration: duration, viewOnce },
      );

      broadcastAndNotifyMessage(message, (req.params.conversationId as string), req.user!.userId);

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

      broadcastAndNotifyMessage(message, (req.params.conversationId as string), req.user!.userId);

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

// GET /conversations/group/check-name - Check if group/channel name is available
router.get(
  '/conversations/group/check-name',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const name = req.query.name as string;
      const isChannel = req.query.isChannel === 'true';
      if (!name) return res.status(400).json({ error: 'name is required' });
      const available = await groupService.checkNameAvailable(name, isChannel);
      res.json({ available });
    } catch (err) { next(err); }
  },
);

// POST /conversations/group - Create a group conversation
router.post(
  '/conversations/group',
  authenticate,
  userRateLimit('group-create', 5, 3600), // 5 channels/groups per hour
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
      const rawIsChannel = req.body.isChannel;
      const isChannel = rawIsChannel !== undefined
        ? (typeof rawIsChannel === 'boolean' ? rawIsChannel : rawIsChannel === 'true')
        : undefined;
      const conversation = await groupService.createGroup(
        req.user!.userId,
        name,
        memberIds,
        avatarUrl,
        description,
        isPublic,
        isChannel,
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
      const { name, description, category, contactEmail, contactPhone, websiteUrl, location, operatingHours } = req.body;
      const avatarUrl = req.file ? await fileToAvatarUrl(req.file, req.user!.userId) : req.body.avatarUrl;
      const rawIsPublic = req.body.isPublic;
      const isPublic = rawIsPublic !== undefined
        ? (typeof rawIsPublic === 'boolean' ? rawIsPublic : rawIsPublic === 'true')
        : undefined;
      const conversation = await groupService.updateGroup(
        (req.params.conversationId as string),
        req.user!.userId,
        { name, avatarUrl, description, isPublic, category, contactEmail, contactPhone, websiteUrl, location, operatingHours },
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

// PUT /conversations/:id/group/banner - Upload banner image
router.put(
  '/conversations/:conversationId/group/banner',
  authenticate,
  (req: AuthRequest, res: Response, next: NextFunction) => {
    avatarUpload.single('banner')(req, res, next);
  },
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Banner image required' });
      const bannerUrl = await fileToAvatarUrl(req.file, req.user!.userId);
      const conversation = await groupService.updateGroup(
        (req.params.conversationId as string),
        req.user!.userId,
        { bannerUrl },
      );
      res.json(conversation);
    } catch (err) { next(err); }
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

// PUT /conversations/:id/members/:userId/demote - Demote admin to member
router.put(
  '/conversations/:conversationId/members/:userId/demote',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await groupService.demoteAdmin(
        req.params.conversationId as string,
        req.user!.userId,
        req.params.userId as string,
      );
      const io = getIO();
      io.to(`conversation:${req.params.conversationId}`).emit('group:members-changed', {
        conversationId: req.params.conversationId,
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// POST /conversations/:id/invite-code - Generate invite link
router.post(
  '/conversations/:conversationId/invite-code',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await groupService.generateInviteCode(req.params.conversationId as string, req.user!.userId);
      res.json(result);
    } catch (err) { next(err); }
  },
);

// DELETE /conversations/:id/invite-code - Revoke invite link
router.delete(
  '/conversations/:conversationId/invite-code',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await groupService.revokeInviteCode(req.params.conversationId as string, req.user!.userId);
      res.json(result);
    } catch (err) { next(err); }
  },
);

// POST /conversations/join/:inviteCode - Join group via invite code
router.post(
  '/conversations/join/:inviteCode',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await groupService.joinViaInviteCode(req.params.inviteCode as string, req.user!.userId);
      res.json(result);
    } catch (err) { next(err); }
  },
);

// PUT /conversations/:id/group/admin-settings - Update admin settings
router.put(
  '/conversations/:conversationId/group/admin-settings',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await groupService.updateGroupAdminSettings(
        req.params.conversationId as string,
        req.user!.userId,
        req.body,
      );
      const io = getIO();
      io.to(`conversation:${req.params.conversationId}`).emit('group:settings-changed', {
        conversationId: req.params.conversationId,
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// PUT /conversations/:id/members/:userId/ban - Ban a member
router.put(
  '/conversations/:conversationId/members/:userId/ban',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await groupService.banMember(
        req.params.conversationId as string,
        req.user!.userId,
        req.params.userId as string,
      );
      const io = getIO();
      io.to(`conversation:${req.params.conversationId}`).emit('group:members-changed', {
        conversationId: req.params.conversationId,
      });
      io.to(`user:${req.params.userId}`).emit('group:removed', {
        conversationId: req.params.conversationId,
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// DELETE /conversations/:id/members/:userId/ban - Unban a member
router.delete(
  '/conversations/:conversationId/members/:userId/ban',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await groupService.unbanMember(
        req.params.conversationId as string,
        req.user!.userId,
        req.params.userId as string,
      );
      res.json(result);
    } catch (err) { next(err); }
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

// PATCH /conversations/:conversationId/mute - Toggle or set mute.
// Body may be empty (toggle) or { mutedUntil: ISO-8601 | null } for a
// duration-based mute (null = unmute, future timestamp = mute until then).
router.patch(
  '/conversations/:conversationId/mute',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const conversationId = req.params.conversationId as string;

      if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'mutedUntil')) {
        const raw = req.body.mutedUntil;
        let until: Date | null = null;
        if (raw !== null && raw !== undefined) {
          const parsed = new Date(raw);
          if (Number.isNaN(parsed.getTime())) {
            res.status(400).json({ error: 'Invalid mutedUntil' });
            return;
          }
          until = parsed;
        }
        const result = await chatService.setMute(userId, conversationId, until);
        res.json(result);
        return;
      }

      const result = await chatService.toggleMute(userId, conversationId);
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

// PUT /conversations/:conversationId/disappearing - Set disappearing messages timer
router.put(
  '/conversations/:conversationId/disappearing',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { disappearAfterSecs } = req.body;
      const result = await chatService.setDisappearingMessages(
        (req.params.conversationId as string),
        req.user!.userId,
        disappearAfterSecs ?? null,
      );
      res.json(result);
    } catch (err) { next(err); }
  },
);

// POST /conversations/:conversationId/read - Mark conversation as read
router.post(
  '/conversations/:conversationId/read',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // If user has read receipts hidden, skip DB update and broadcast
      const reader = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { hideReadReceipts: true },
      });
      if (reader?.hideReadReceipts) {
        res.json({ success: true });
        return;
      }

      await chatService.markConversationAsRead(
        (req.params.conversationId as string),
        req.user!.userId,
      );

      // Broadcast read receipt so the sender sees blue ticks
      const io = getIO();
      const convId = req.params.conversationId as string;
      const readPayload = { conversationId: convId, userId: req.user!.userId };
      io.to(`conversation:${convId}`).emit('chat:read', readPayload);

      // Also emit to all other participants' personal rooms so the
      // sender sees blue ticks even if they left the chat screen.
      prisma.conversationParticipant.findMany({
        where: { conversationId: convId, userId: { not: req.user!.userId }, leftAt: null },
        select: { userId: true },
      }).then((participants) => {
        for (const p of participants) {
          io.to(`user:${p.userId}`).emit('chat:read', readPayload);
        }
      }).catch(() => {});

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

// POST /conversations/:conversationId/messages/:messageId/forward - Forward a message.
// Body accepts either { targetConversationId } (single-target, legacy) or
// { targetConversationIds: string[] } (multi-target, capped at 5).
router.post(
  '/conversations/:conversationId/messages/:messageId/forward',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const messageId = req.params.messageId as string;

      const targets: string[] = Array.isArray(req.body?.targetConversationIds)
        ? req.body.targetConversationIds
        : req.body?.targetConversationId
          ? [req.body.targetConversationId]
          : [];

      if (targets.length === 0) {
        return res.status(400).json({ error: 'targetConversationId(s) is required' });
      }

      const messages = await chatService.forwardMessageToMany(messageId, targets, userId);

      for (const msg of messages) {
        broadcastAndNotifyMessage(msg, (msg as any).conversationId, userId);
      }

      if (targets.length === 1) {
        res.status(201).json(messages[0]);
      } else {
        res.status(201).json({ messages });
      }
    } catch (err) {
      next(err);
    }
  },
);

// GET /messages/:messageId/info - Per-recipient delivery/read info (sender only)
router.get(
  '/messages/:messageId/info',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const info = await chatService.getMessageInfo(
        req.params.messageId as string,
        req.user!.userId,
      );
      res.json(info);
    } catch (err) {
      next(err);
    }
  },
);

// GET /conversations/:conversationId/messages/search - Search messages
router.get(
  '/conversations/:conversationId/messages/search',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query.q as string;
      if (!q || q.length < 1) {
        return res.status(400).json({ error: 'Search query is required' });
      }
      const messages = await chatService.searchMessages(
        req.params.conversationId as string,
        req.user!.userId,
        q,
      );
      res.json(messages);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /conversations/:conversationId/history - Clear chat history
router.delete(
  '/conversations/:conversationId/history',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      await chatService.clearHistory(
        req.params.conversationId as string,
        req.user!.userId,
      );
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Shared Content (Media / Docs / Links) ──────────────────

/**
 * Lists messages in a conversation filtered by content kind.
 * type=media → messages with imageUrl (photos / videos)
 * type=docs  → messages flagged as document in metadata
 * type=links → messages whose content contains a URL
 */
router.get(
  '/conversations/:conversationId/shared',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const conversationId = req.params.conversationId as string;
      const userId = req.user!.userId;
      const type = String(req.query.type ?? 'media');
      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
      const limit = Math.min(
        50,
        Math.max(1, parseInt(String(req.query.limit ?? '30'), 10) || 30),
      );

      // Participant check
      const participant = await prisma.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
        select: { leftAt: true },
      });
      if (!participant) {
        return res.status(403).json({ message: 'Not a participant' });
      }

      let where: Record<string, unknown>;
      if (type === 'media') {
        where = {
          conversationId,
          deletedAt: null,
          imageUrl: { not: null },
          // Exclude document uploads that happen to have imageUrl
          NOT: { metadata: { path: ['isDocument'], equals: true } },
        };
      } else if (type === 'docs') {
        where = {
          conversationId,
          deletedAt: null,
          metadata: { path: ['isDocument'], equals: true },
        };
      } else if (type === 'links') {
        where = {
          conversationId,
          deletedAt: null,
          content: { contains: 'http', mode: 'insensitive' },
        };
      } else {
        return res.status(400).json({ message: 'Invalid type' });
      }

      const [items, total] = await Promise.all([
        prisma.message.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          select: {
            id: true,
            senderId: true,
            content: true,
            imageUrl: true,
            metadata: true,
            createdAt: true,
            sender: { select: { displayName: true, avatarUrl: true } },
          },
        }),
        prisma.message.count({ where }),
      ]);

      res.json({ items, total, page, limit });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Polls ──────────────────────────────────────────────────

router.post(
  '/conversations/:conversationId/polls',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const poll = await pollService.createPoll({
        conversationId: req.params.conversationId as string,
        creatorId: req.user!.userId,
        question: String(req.body?.question ?? ''),
        options: Array.isArray(req.body?.options) ? req.body.options : [],
        allowMultiple: !!req.body?.allowMultiple,
      });
      res.status(201).json(poll);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/polls/:pollId',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const poll = await pollService.getPollDetails(
        req.params.pollId as string,
        req.user!.userId,
      );
      res.json(poll);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/polls/:pollId/vote',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const optionIds: string[] = Array.isArray(req.body?.optionIds)
        ? req.body.optionIds.map((x: unknown) => String(x))
        : [];
      const poll = await pollService.vote(
        req.params.pollId as string,
        req.user!.userId,
        optionIds,
      );
      res.json(poll);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/polls/:pollId/close',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const poll = await pollService.closePoll(
        req.params.pollId as string,
        req.user!.userId,
      );
      res.json(poll);
    } catch (err) {
      next(err);
    }
  },
);

export { router as chatRouter };
