import * as Sentry from '@sentry/node';
import { env } from '../config/env';
import { logger } from './logger';

// Check if Sentry is configured
const isConfigured = !!env.SENTRY_DSN;

/**
 * Initialize Sentry error tracking
 */
export function initSentry(): void {
  if (!isConfigured) {
    logger.info('Sentry not configured - error tracking disabled');
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    enabled: env.NODE_ENV === 'production',

    // Performance monitoring
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,

    // Set sampling rate for profiling
    profilesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,

    // Capture unhandled rejections
    integrations: [
      Sentry.captureConsoleIntegration({ levels: ['error'] }),
    ],

    // Filter out sensitive data
    beforeSend(event) {
      // Remove sensitive headers
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['cookie'];
      }

      // Remove sensitive data from request body
      if (event.request?.data) {
        const data = typeof event.request.data === 'string'
          ? JSON.parse(event.request.data)
          : event.request.data;

        if (data.password) data.password = '[FILTERED]';
        if (data.token) data.token = '[FILTERED]';
        if (data.refreshToken) data.refreshToken = '[FILTERED]';
        if (data.idToken) data.idToken = '[FILTERED]';

        event.request.data = JSON.stringify(data);
      }

      return event;
    },
  });

  logger.info('Sentry initialized');
}

/**
 * Capture an exception in Sentry
 */
export function captureException(error: Error, context?: Record<string, any>): void {
  if (!isConfigured) {
    return;
  }

  Sentry.withScope((scope) => {
    if (context) {
      scope.setExtras(context);
    }
    Sentry.captureException(error);
  });
}

/**
 * Capture a message in Sentry
 */
export function captureMessage(
  message: string,
  level: 'fatal' | 'error' | 'warning' | 'info' | 'debug' = 'info',
  context?: Record<string, any>
): void {
  if (!isConfigured) {
    return;
  }

  Sentry.withScope((scope) => {
    if (context) {
      scope.setExtras(context);
    }
    scope.setLevel(level);
    Sentry.captureMessage(message);
  });
}

/**
 * Set user context for Sentry
 */
export function setUser(user: { id: string; email?: string; username?: string } | null): void {
  if (!isConfigured) {
    return;
  }

  Sentry.setUser(user);
}

/**
 * Add breadcrumb for debugging
 */
export function addBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, any>,
  level: 'fatal' | 'error' | 'warning' | 'info' | 'debug' = 'info'
): void {
  if (!isConfigured) {
    return;
  }

  Sentry.addBreadcrumb({
    category,
    message,
    data,
    level,
  });
}

/**
 * Start a transaction for performance monitoring
 */
export function startTransaction(name: string, op: string): Sentry.Span | undefined {
  if (!isConfigured) {
    return undefined;
  }

  return Sentry.startInactiveSpan({ name, op });
}

/**
 * Express error handler middleware for Sentry
 */
export const sentryErrorHandler = Sentry.Handlers?.errorHandler?.() || ((err: any, _req: any, _res: any, next: any) => next(err));

/**
 * Express request handler middleware for Sentry
 */
export const sentryRequestHandler = Sentry.Handlers?.requestHandler?.() || ((_req: any, _res: any, next: any) => next());

/**
 * Flush Sentry events (useful before process exit)
 */
export async function flush(timeout: number = 2000): Promise<boolean> {
  if (!isConfigured) {
    return true;
  }

  return Sentry.flush(timeout);
}

export { isConfigured as isSentryConfigured };
