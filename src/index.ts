import 'dotenv/config';
import http from 'http';
import { app } from './app';
import { env } from './config/env';
import { connectDatabase } from './config/database';
import { initializeSocket } from './config/socket';
import { registerChatHandlers } from './modules/chat/chat.gateway';
import { registerMatchingHandlers } from './modules/matching/matching.gateway';
import { registerCallHandlers } from './modules/call/call.gateway';
import { startMatchExpiryJob } from './jobs/matchExpiry';
import { startSessionCleanupJob } from './jobs/sessionCleanup';
import { startAvailabilityExpiryJob } from './jobs/availabilityExpiry';
import { logger } from './shared/logger';

async function main() {
  await connectDatabase();

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
