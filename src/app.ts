import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import { rateLimiter } from './middleware/rateLimiter';
import { authRouter } from './modules/auth/auth.router';
import { userRouter } from './modules/user/user.router';
import { aiRouter } from './modules/ai/ai.router';
import { matchingRouter } from './modules/matching/matching.router';
import { chatRouter } from './modules/chat/chat.router';
import { safetyRouter } from './modules/safety/safety.router';
import { notificationRouter } from './modules/notification/notification.router';
import { subscriptionRouter } from './modules/subscription/subscription.router';
import { callRouter } from './modules/call/call.router';
import { sentryRequestHandler, sentryErrorHandler } from './shared/sentry.service';

const app = express();

const corsOrigin = env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',').map((o) => o.trim());

// Sentry request handler (must be first)
app.use(sentryRequestHandler);

app.use(helmet());
app.use(cors({ origin: corsOrigin }));

// Stripe webhook needs raw body - must be before express.json()
app.use('/api/subscription/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(rateLimiter());

// Serve uploaded files (avatars etc.)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Serve public static files (logo, etc.)
app.use('/public', express.static(path.join(process.cwd(), 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.use('/api/users', userRouter);
app.use('/api/ai', aiRouter);
app.use('/api/matching', matchingRouter);
app.use('/api/chat', chatRouter);
app.use('/api/safety', safetyRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/subscription', subscriptionRouter);
app.use('/api/call', callRouter);

// Sentry error handler (must be before custom error handler)
app.use(sentryErrorHandler);

app.use(errorHandler);

export { app };
