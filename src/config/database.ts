import { PrismaClient } from '@prisma/client';
import { logger } from '../shared/logger';
import { env } from './env';

// Append connection pool params if not already in the URL.
// connection_limit: max connections per instance (Render free tier has 97 max).
// pool_timeout: seconds to wait for a free connection before erroring.
const dbUrl = env.DATABASE_URL;
const pooledUrl = dbUrl.includes('connection_limit')
  ? dbUrl
  : `${dbUrl}${dbUrl.includes('?') ? '&' : '?'}connection_limit=20&pool_timeout=10`;

export const prisma = new PrismaClient({
  datasourceUrl: pooledUrl,
  log: [
    { level: 'error', emit: 'event' },
    { level: 'warn', emit: 'event' },
  ],
});

prisma.$on('error', (e) => {
  logger.error(e, 'Prisma error');
});

prisma.$on('warn', (e) => {
  logger.warn(e, 'Prisma warning');
});

export async function connectDatabase() {
  try {
    await prisma.$connect();
    logger.info('Database connected');
  } catch (error) {
    logger.error(error, 'Failed to connect to database');
    process.exit(1);
  }
}

export async function disconnectDatabase() {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}
