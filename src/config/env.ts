import { z } from 'zod';

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string(),

  // Message encryption-at-rest key (any string; hashed to a 32-byte AES key).
  // Optional — when unset, message content stays plaintext (no-op). Once set,
  // it must be backed up and never changed or messages become unreadable.
  MESSAGE_ENC_KEY: z.string().optional(),

  // JWT — current secrets used to sign new tokens
  JWT_SECRET: z.string(),
  JWT_REFRESH_SECRET: z.string(),
  // Optional previous secrets — accepted during verification only.
  // Set these during a rotation, leave for ~30 days, then remove.
  JWT_SECRET_PREVIOUS: z.string().optional(),
  JWT_REFRESH_SECRET_PREVIOUS: z.string().optional(),
  JWT_EXPIRES_IN: z.string().default('1h'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  // OpenAI (text chat, mood classification)
  OPENAI_API_KEY: z.string(),

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
  // App-Specific Shared Secret from App Store Connect — required to validate
  // legacy StoreKit 1 receipts (Pro/verification) via /verifyReceipt.
  APPLE_SHARED_SECRET: z.string().optional(),
  // The iOS app's bundle identifier. Used to verify StoreKit 2 signed
  // transactions (the JWS the current in_app_purchase client sends) actually
  // belong to our app. Defaults to the production bundle id.
  APPLE_BUNDLE_ID: z.string().default('com.yomeet.live'),
  // The app's numeric App Store ID (adam id). REQUIRED by Apple's
  // SignedDataVerifier for Production-environment transactions. Default is the
  // live "com.yomeet.live" app id (from the App Store lookup API).
  APPLE_APP_APPLE_ID: z.coerce.number().default(6761489525),
  // Google Cloud service-account JSON (stringified) with androidpublisher
  // access, linked in Play Console — required to validate Android subscription
  // purchases. Fails closed if unset.
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: z.string().optional(),
  // Android application id (Play package name) for purchase validation.
  ANDROID_PACKAGE_NAME: z.string().default('com.yomeet.live'),

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

  // Cloudinary (Image Storage — legacy, kept for deleting old media only)
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // Supabase Storage (avatars + chat media)
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

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

  // Public origin the website chat widget's embed snippet points at (where
  // /widget.js is served). Branded Cloudflare-proxied domain → Render, so the
  // snippet never exposes the onrender.com origin. Override per-env if needed.
  WIDGET_PUBLIC_URL: z.string().default('https://widget.yomeet.app'),

  // Giphy (GIF picker — backend proxies all requests so the key stays server-side)
  GIPHY_API_KEY: z.string().optional(),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Under test (vitest), don't kill the process on missing/invalid env — the
    // test runner has no real .env and tests mock the config they actually use.
    // Exiting here crashes any test that transitively imports config/env (e.g.
    // via config/socket). Production still hard-fails so a misconfig never
    // boots silently.
    if (process.env.VITEST || process.env.NODE_ENV === 'test') {
      return process.env as unknown as Env;
    }
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export type Env = z.infer<typeof envSchema>;
