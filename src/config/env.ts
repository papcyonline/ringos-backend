import { z } from 'zod';

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string(),

  // JWT
  JWT_SECRET: z.string(),
  JWT_REFRESH_SECRET: z.string(),
  JWT_EXPIRES_IN: z.string().default('1h'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  // OpenAI (no longer used for AI features, kept optional for legacy)
  OPENAI_API_KEY: z.string().optional(),

  // Google Gemini (all AI features: text, voice, TTS, STT)
  GEMINI_API_KEY: z.string(),

  // Google OAuth
  GOOGLE_CLIENT_ID_WEB: z.string().optional(),
  GOOGLE_CLIENT_ID_IOS: z.string().optional(),
  GOOGLE_CLIENT_ID_ANDROID: z.string().optional(),

  // Apple Sign-In
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  APPLE_PRIVATE_KEY: z.string().optional(),

  // Twilio (SMS + optional TURN via NTS)
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),

  // TURN Server (WebRTC relay — required for calls across different networks)
  // Get free credentials from https://www.metered.ca/stun-turn or any TURN provider.
  // Multiple URLs can be comma-separated.
  TURN_SERVER_URLS: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),

  // Firebase (Push Notifications)
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),

  // APNs (iOS VoIP Push)
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_KEY: z.string().optional(),           // base64-encoded .p8 key content
  APNS_PRODUCTION: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').default('false'),

  // Resend (Email)
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_LOGO_URL: z.string().optional(),

  // Cloudinary (Image Storage)
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // AWS S3 (File Storage)
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),

  // Sentry (Error Tracking)
  SENTRY_DSN: z.string().optional(),

  // Redis
  REDIS_URL: z.string().optional(),

  // Rate Limiting
  CORS_ORIGIN: z.string().default('*'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().default(100),

  // App Store Links
  APP_STORE_URL: z.string().optional(),
  PLAY_STORE_URL: z.string().optional(),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export type Env = z.infer<typeof envSchema>;
