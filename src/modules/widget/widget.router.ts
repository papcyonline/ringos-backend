import { Router, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { AuthRequest } from '../../shared/types';
import { BadRequestError } from '../../shared/errors';
import {
  updateConfigSchema,
  startSessionSchema,
  visitorMessageSchema,
  leadSchema,
  deleteLeadsSchema,
} from './widget.schema';
import * as widget from './widget.service';
import { onWidgetEvent } from './widget.events';
import { chatImageUpload } from '../../shared/upload';

const router = Router();

// ─── helpers ─────────────────────────────────────────────────────────

/** The hostname the request originated from (Origin, falling back to Referer). */
function originHost(req: Request): string | undefined {
  const raw = req.headers.origin || req.headers.referer;
  if (!raw) return undefined;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The visitor's opaque session token, carried out-of-band in a header. */
function visitorToken(req: Request): string {
  const token = req.headers['x-widget-token'];
  if (typeof token !== 'string' || token.length < 10) {
    throw new BadRequestError('Missing widget session token');
  }
  return token;
}

// ─── public (embeddable) routes ──────────────────────────────────────
// Reflect the caller's origin (no credentials — the token travels in a header,
// not a cookie) so the widget works from any allow-listed customer site. The
// per-widget domain allow-list is enforced in the service, not by CORS.
const publicCors = cors({ origin: true, credentials: false });
router.use('/public', publicCors);
router.options('/public/*', publicCors);

// GET /public/:handle/config — bubble render data (no token).
router.get('/public/:handle/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await widget.getPublicConfig(req.params.handle as string, originHost(req)));
  } catch (err) {
    next(err);
  }
});

// POST /public/:handle/session — start or resume a visitor session.
router.post(
  '/public/:handle/session',
  validate(startSessionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await widget.startSession({
        handle: req.params.handle as string,
        originHost: originHost(req),
        visitorToken: req.body.visitorToken,
        name: req.body.name,
        email: req.body.email,
        // Behind Cloudflare→Render: CF-Connecting-IP is the real client IP, and
        // CF-IPCountry the geo country. Fall back to req.ip when not proxied.
        ip: (req.headers['cf-connecting-ip'] as string) || req.ip,
        userAgent: req.headers['user-agent'],
        country: req.headers['cf-ipcountry'] as string | undefined,
        pageUrl: req.body.pageUrl,
        referrer: req.body.referrer,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /public/messages — visitor sends a message (token in header).
router.post(
  '/public/messages',
  validate(visitorMessageSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const message = await widget.visitorSendMessage(
        visitorToken(req),
        req.body.content,
        req.body.clientMsgId,
      );
      res.status(201).json(message);
    } catch (err) {
      next(err);
    }
  },
);

// POST /public/messages/image — visitor sends an image (multipart, token in header).
router.post(
  '/public/messages/image',
  chatImageUpload.single('image'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) throw new BadRequestError('No image uploaded');
      const message = await widget.visitorSendImage(visitorToken(req), req.file);
      res.status(201).json(message);
    } catch (err) {
      next(err);
    }
  },
);

// GET /public/messages?since= — visitor polls their thread.
router.get('/public/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await widget.visitorGetMessages(visitorToken(req), req.query.since as string | undefined));
  } catch (err) {
    next(err);
  }
});

// GET /public/events?t=TOKEN — SSE stream: instant nudge on new message / owner
// typing. EventSource can't set headers, so the token rides in the query (it's
// the visitor's own token). The nudge just tells the widget to refresh — the
// message serialization stays in /public/messages (DRY).
router.get('/public/events', async (req: Request, res: Response) => {
  const token = req.query.t;
  let stream: { conversationId: string | null; shadowUserId: string; ownerId: string } | null = null;
  try {
    if (typeof token === 'string' && token.length >= 10) {
      stream = await widget.resolveVisitorStream(token);
    }
  } catch {
    stream = null;
  }
  if (!stream || !stream.conversationId) {
    res.status(204).end(); // no session/conversation yet → widget falls back to polling
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': (req.headers.origin as string) || '*',
  });
  res.write('retry: 3000\n\n');
  const send = (evt: unknown) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  const off = onWidgetEvent(stream.conversationId, send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  // An open stream = the visitor is present; the owner sees them online, and
  // "left" once the stream closes (with a short grace for reconnects).
  widget.widgetPresenceConnect(stream.shadowUserId, stream.ownerId).catch(() => {});
  req.on('close', () => {
    clearInterval(heartbeat);
    off();
    widget.widgetPresenceDisconnect(stream!.shadowUserId, stream!.ownerId);
  });
});

// POST /public/read — visitor viewed the thread → owner's sent messages go read.
router.post('/public/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await widget.visitorMarkRead(visitorToken(req));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /public/typing — visitor is typing → surfaced in the owner's app chat.
router.post('/public/typing', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await widget.visitorTyping(visitorToken(req));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /public/lead — offline lead capture (email + message).
router.post(
  '/public/lead',
  validate(leadSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(201).json(await widget.captureLead(visitorToken(req), req.body.email, req.body.message));
    } catch (err) {
      next(err);
    }
  },
);

// ─── owner routes (app JWT) ──────────────────────────────────────────

// GET /me — my widget config (created on first read).
router.get('/me', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await widget.getOrCreateConfig(req.user!.userId));
  } catch (err) {
    next(err);
  }
});

// PATCH /me — update settings (enable, domains, theme, offlineCapture).
router.patch(
  '/me',
  authenticate,
  validate(updateConfigSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      res.json(await widget.updateConfig(req.user!.userId, req.body));
    } catch (err) {
      next(err);
    }
  },
);

// POST /me/regenerate-handle — mint a new handle (revokes old embeds).
router.post('/me/regenerate-handle', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await widget.regenerateHandle(req.user!.userId));
  } catch (err) {
    next(err);
  }
});

// GET /me/embed — the copy-paste snippet.
router.get('/me/embed', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const config = await widget.getOrCreateConfig(req.user!.userId);
    res.json({ handle: config.handle, snippet: widget.buildEmbedSnippet(config.handle) });
  } catch (err) {
    next(err);
  }
});

// GET /me/visitors — list web visitors (analytics).
router.get('/me/visitors', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await widget.listVisitors(req.user!.userId));
  } catch (err) {
    next(err);
  }
});

// GET /me/leads — offline lead captures (email + message).
router.get('/me/leads', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await widget.listLeads(req.user!.userId));
  } catch (err) {
    next(err);
  }
});

// POST /me/leads/delete — delete one or many leads by id.
router.post(
  '/me/leads/delete',
  authenticate,
  validate(deleteLeadsSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const deleted = await widget.deleteLeads(req.user!.userId, req.body.ids);
      res.json({ deleted });
    } catch (err) {
      next(err);
    }
  },
);

// POST /me/visitors/:id/block — block a visitor.
router.post('/me/visitors/:id/block', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await widget.blockVisitor(req.user!.userId, req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// POST /me/visitors/:id/unblock — lift a block.
router.post('/me/visitors/:id/unblock', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json(await widget.unblockVisitor(req.user!.userId, req.params.id as string));
  } catch (err) {
    next(err);
  }
});

export { router as widgetRouter };
