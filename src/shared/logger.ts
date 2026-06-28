import pino from 'pino';

// Redact PII / secrets from logs. Paths match keys anywhere in a logged object
// (the leading `*` covers nested objects). Censored fields are replaced with
// `[REDACTED]` rather than dropped, so log shape stays intact.
const REDACT_PATHS = [
  'email', '*.email',
  'phone', '*.phone', 'phoneNumber', '*.phoneNumber',
  'code', '*.code', 'otp', '*.otp',
  'password', '*.password',
  'token', '*.token', 'accessToken', '*.accessToken',
  'refreshToken', '*.refreshToken',
  'authorization', '*.authorization',
  'req.headers.authorization', 'req.headers.cookie',
];

export const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});
