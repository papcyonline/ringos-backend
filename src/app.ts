import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { errorHandler } from './middleware/errorHandler';
import { rateLimiter } from './middleware/rateLimiter';
import { authRouter } from './modules/auth/auth.router';
import { userRouter } from './modules/user/user.router';
import { aiRouter } from './modules/ai/ai.router';
import { matchingRouter } from './modules/matching/matching.router';
import { chatRouter } from './modules/chat/chat.router';
import { safetyRouter } from './modules/safety/safety.router';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(rateLimiter());

// Serve uploaded files (avatars etc.)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.use('/api/users', userRouter);
app.use('/api/ai', aiRouter);
app.use('/api/matching', matchingRouter);
app.use('/api/chat', chatRouter);
app.use('/api/safety', safetyRouter);

app.use(errorHandler);

export { app };
