import 'dotenv/config';
import http from 'http';
import { app } from './app';
import { env } from './config/env';
import { connectDatabase } from './config/database';
import { initializeSocket } from './config/socket';
import { initializeFirebase } from './config/firebase';
import { registerChatHandlers } from './modules/chat/chat.gateway';
import { registerMatchingHandlers } from './modules/matching/matching.gateway';
import { registerCallHandlers } from './modules/call/call.gateway';
import { startMatchExpiryJob } from './jobs/matchExpiry';
import { startSessionCleanupJob } from './jobs/sessionCleanup';
import { startAvailabilityExpiryJob } from './jobs/availabilityExpiry';
import { logger } from './shared/logger';
import { initSentry } from './shared/sentry.service';
import { initRedis, closeRedis } from './shared/redis.service';

async function main() {
  // Initialize error tracking first
  initSentry();

  await connectDatabase();
  initializeFirebase();
  initRedis();

  const server = http.createServer(app);
  const io = initializeSocket(server);

  io.on('connection', (socket) => {
    registerChatHandlers(io, socket);
    registerMatchingHandlers(io, socket);
    registerCallHandlers(io, socket);
  });

  startMatchExpiryJob();
  startSessionCleanupJob();
  startAvailabilityExpiryJob();

  server.listen(env.PORT, () => {
    logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  });
}

main().catch((err) => {
  logger.fatal(err, 'Failed to start server');
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  await closeRedis();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
  await closeRedis();
  process.exit(0);
});
