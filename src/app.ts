import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import { rateLimiter } from './middleware/rateLimiter';
import { authRouter } from './modules/auth/auth.router';
import { userRouter } from './modules/user/user.router';
import { referralRouter } from './modules/referral/referral.router';
import { aiRouter } from './modules/ai/ai.router';
import { matchingRouter } from './modules/matching/matching.router';
import { chatRouter } from './modules/chat/chat.router';
import { postRouter } from './modules/post/post.router';
import { safetyRouter } from './modules/safety/safety.router';
import { notificationRouter } from './modules/notification/notification.router';
import { callRouter } from './modules/call/call.router';
import { spotlightRouter } from './modules/spotlight/spotlight.router';
import { storyRouter } from './modules/story/story.router';
import { highlightRouter } from './modules/story/highlight.router';
import { reelRouter } from './modules/reel/reel.router';
import { mediaRouter } from './modules/media/media.router';
import { adminRouter } from './modules/admin/admin.router';
import { giphyRouter } from './modules/giphy/giphy.router';
import { musicRouter } from './modules/music/music.router';
import { announcementRouter } from './modules/announcement/announcement.router';
import { legalRouter } from './modules/legal/legal.router';
import { widgetRouter } from './modules/widget/widget.router';
import appstoreWebhookRouter from './modules/webhooks/appstore.router';
import { sentryRequestHandler, sentryErrorHandler } from './shared/sentry.service';

const app = express();

// Trust first proxy (Render, etc.) so req.ip returns the real client IP
app.set('trust proxy', 1);

// CORS hardening: reject wildcard in production with credentials enabled.
// Wildcard + credentials is exploitable — any origin can send authenticated requests.
if (env.NODE_ENV === 'production' && (env.CORS_ORIGIN === '*' || !env.CORS_ORIGIN)) {
  throw new Error(
    'SECURITY: CORS_ORIGIN must be set to explicit origins in production (e.g. "https://app.yomeet.com,https://yomeet.app"). Wildcard "*" is not allowed with credentials.'
  );
}
const corsOrigin = env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',').map((o) => o.trim());

// Sentry request handler (must be first)
app.use(sentryRequestHandler);

app.use(helmet());
app.use(cors({ origin: corsOrigin, credentials: true }));

app.use(express.json({ limit: '10mb' }));
app.use(rateLimiter());

// Serve uploaded files (avatars etc.)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Serve public static files (logo, etc.)
app.use('/public', express.static(path.join(process.cwd(), 'public')));

app.get('/health', async (_req, res) => {
  try {
    const { prisma } = await import('./config/database');
    await prisma.$queryRaw`SELECT 1`;

    // Redis cache self-test: write then read back a short-lived key to prove
    // the cache layer is actually reachable and round-tripping in production.
    // 'disabled' = REDIS_URL not set (in-memory fallbacks active).
    let redis: 'connected' | 'disabled' | 'degraded' | 'error' = 'disabled';
    try {
      const { getRedis } = await import('./shared/redis.service');
      const client = getRedis();
      if (client) {
        await client.set('health:ping', '1', 'EX', 10);
        redis = (await client.get('health:ping')) === '1' ? 'connected' : 'degraded';
      }
    } catch {
      redis = 'error';
    }

    res.json({ status: 'ok', redis, timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString() });
  }
});

// Email template previews (open in browser to see rendered emails — dev only)
import { getPreviewHtml } from './shared/email.service';
if (env.NODE_ENV !== 'production') {
  app.get('/preview/:template', (req, res) => {
    const html = getPreviewHtml(req.params.template as string);
    if (!html) return res.status(404).send('Template not found. Use: welcome, otp, reset');
    res.type('html').send(html);
  });
}

app.use('/api/auth', authRouter);
app.use('/api/users', userRouter);
app.use('/api/referrals', referralRouter);
app.use('/api/ai', aiRouter);
app.use('/api/matching', matchingRouter);
app.use('/api/chat', chatRouter);
app.use('/api/posts', postRouter);
app.use('/api/safety', safetyRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/call', callRouter);
app.use('/api/spotlight', spotlightRouter);
app.use('/api/stories', storyRouter);
app.use('/api/highlights', highlightRouter);
app.use('/api/reels', reelRouter);
app.use('/media', mediaRouter);
app.use('/api/admin', adminRouter);
app.use('/api/giphy', giphyRouter);
app.use('/api/music', musicRouter);
app.use('/api/announcements', announcementRouter);
app.use('/api/legal', legalRouter);
app.use('/api/widget', widgetRouter);
// App Store Server Notifications V2 (Apple → us). Authoritative subscription
// lifecycle: purchase, renewal, refund, expiry. Set this URL in App Store
// Connect. Authenticity is the Apple-signed JWS, so no auth middleware.
app.use('/api/webhooks', appstoreWebhookRouter);

// Sentry error handler (must be before custom error handler)
app.use(sentryErrorHandler);

app.use(errorHandler);

export { app };
