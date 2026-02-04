import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth';
import { AuthRequest } from '../../shared/types';
import { prisma } from '../../config/database';
import { logger } from '../../shared/logger';

// Metered (primary)
import {
  generateCallCredentials,
  getTurnCredentials,
  getDomain,
  isMeteredConfigured,
} from '../../shared/metered.service';

// Agora (alternative)
import {
  generateCallTokens,
  generateSubscriberTokens,
  getAppId,
  isAgoraConfigured,
} from '../../shared/agora.service';

const router = Router();

// Determine which provider is configured
const provider = isMeteredConfigured ? 'metered' : isAgoraConfigured ? 'agora' : null;

// ─── Schemas ─────────────────────────────────────────────────────────────────

const generateTokenSchema = z.object({
  conversationId: z.string().uuid(),
});

// ─── Get Call Provider Info ──────────────────────────────────────────────────

router.get(
  '/provider',
  authenticate,
  (_req: AuthRequest, res: Response) => {
    if (!provider) {
      res.status(503).json({ error: 'Voice/video calls not configured' });
      return;
    }

    if (provider === 'metered') {
      res.json({
        provider: 'metered',
        domain: getDomain(),
      });
    } else {
      res.json({
        provider: 'agora',
        appId: getAppId(),
      });
    }
  }
);

// ─── Get TURN Credentials (Metered only) ─────────────────────────────────────

router.get(
  '/turn-credentials',
  authenticate,
  async (_req: AuthRequest, res: Response) => {
    if (!isMeteredConfigured) {
      res.status(503).json({ error: 'TURN credentials not available' });
      return;
    }

    const credentials = await getTurnCredentials();
    if (!credentials) {
      res.status(500).json({ error: 'Failed to get TURN credentials' });
      return;
    }

    res.json(credentials);
  }
);

// ─── Generate Call Credentials ───────────────────────────────────────────────

router.post(
  '/token',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    if (!provider) {
      res.status(503).json({ error: 'Voice/video calls not configured' });
      return;
    }

    const parsed = generateTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }

    const { conversationId } = parsed.data;
    const userId = req.user!.userId;

    // Verify user is participant in the conversation
    const participant = await prisma.conversationParticipant.findUnique({
      where: {
        conversationId_userId: {
          conversationId,
          userId,
        },
      },
    });

    if (!participant) {
      res.status(403).json({ error: 'Not a participant in this conversation' });
      return;
    }

    if (participant.leftAt) {
      res.status(403).json({ error: 'You have left this conversation' });
      return;
    }

    // Generate credentials based on provider
    if (provider === 'metered') {
      const credentials = await generateCallCredentials(conversationId, userId);
      if (!credentials) {
        res.status(500).json({ error: 'Failed to generate call credentials' });
        return;
      }

      logger.info({ userId, conversationId, provider: 'metered' }, 'Call credentials generated');
      res.json({ provider: 'metered', ...credentials });
    } else {
      const tokens = generateCallTokens(conversationId, userId);
      if (!tokens) {
        res.status(500).json({ error: 'Failed to generate call tokens' });
        return;
      }

      logger.info({ userId, conversationId, provider: 'agora' }, 'Call tokens generated');
      res.json({ provider: 'agora', ...tokens });
    }
  }
);

// ─── Generate Subscriber Tokens (Agora only) ─────────────────────────────────

router.post(
  '/token/subscriber',
  authenticate,
  async (req: AuthRequest, res: Response) => {
    // Subscriber role is Agora-specific
    if (!isAgoraConfigured) {
      res.status(503).json({ error: 'Subscriber tokens only available with Agora' });
      return;
    }

    const parsed = generateTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
      return;
    }

    const { conversationId } = parsed.data;
    const userId = req.user!.userId;

    // Verify user is participant in the conversation
    const participant = await prisma.conversationParticipant.findUnique({
      where: {
        conversationId_userId: {
          conversationId,
          userId,
        },
      },
    });

    if (!participant) {
      res.status(403).json({ error: 'Not a participant in this conversation' });
      return;
    }

    if (participant.leftAt) {
      res.status(403).json({ error: 'You have left this conversation' });
      return;
    }

    const tokens = generateSubscriberTokens(conversationId, userId);
    if (!tokens) {
      res.status(500).json({ error: 'Failed to generate call tokens' });
      return;
    }

    res.json({ provider: 'agora', ...tokens });
  }
);

export { router as callRouter };
