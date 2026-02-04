import { Resend } from 'resend';
import { env } from '../config/env';
import { logger } from './logger';

// Only initialize Resend if API key is configured
const resend = env.RESEND_API_KEY && env.RESEND_API_KEY !== 're_your_resend_api_key'
  ? new Resend(env.RESEND_API_KEY)
  : null;

const EMAIL_FROM = env.EMAIL_FROM || 'YoMeet <noreply@yomeet.app>';

// Logo URL - hosted image for email compatibility
const LOGO_URL = env.EMAIL_LOGO_URL || 'https://api.yomeet.app/public/logo.png';

// App store links - update these with your actual links
const APP_STORE_URL = 'https://apps.apple.com/app/yomeet';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.yomeet.app';

// Official Apple and Google badge images (universally supported in email clients)
const APP_STORE_BADGE = 'https://tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us?size=250x83';
const PLAY_STORE_BADGE = 'https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png';

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

async function sendEmail({ to, subject, html }: SendEmailOptions): Promise<boolean> {
  // Skip sending if Resend is not configured
  if (!resend) {
    logger.info({ to, subject }, 'Email skipped (no RESEND_API_KEY configured)');
    return false;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject,
      html,
    });

    if (error) {
      logger.error({ error, to, subject }, 'Failed to send email');
      return false;
    }

    logger.info({ emailId: data?.id, to, subject }, 'Email sent successfully');
    return true;
  } catch (error) {
    logger.error({ error, to, subject }, 'Email service error');
    return false;
  }
}

// ─── Email Templates ────────────────────────────────────────────────────────────

function getBaseTemplate(content: string, footerText: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>YoMeet</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5; -webkit-font-smoothing: antialiased;">

  <!-- Outer Wrapper -->
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 32px 16px;">

        <!-- Main Container -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 520px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);">

          <!-- ========== HEADER ========== -->
          <tr>
            <td style="background-color: #16a34a;">
              <!-- Dot pattern overlay -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="padding: 28px 32px; background-image: radial-gradient(circle, rgba(255,255,255,0.08) 1.5px, transparent 1.5px); background-size: 12px 12px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <!-- Logo on left -->
                        <td style="vertical-align: middle;" width="52">
                          <img src="${LOGO_URL}" alt="YoMeet" width="48" height="48" style="display: block; border-radius: 12px;" />
                        </td>
                        <!-- Brand name + verified -->
                        <td style="vertical-align: middle; padding-left: 14px;">
                          <table role="presentation" cellspacing="0" cellpadding="0">
                            <tr>
                              <td style="vertical-align: middle;">
                                <span style="font-size: 22px; font-weight: 700; color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; letter-spacing: -0.3px;">YoMeet</span>
                              </td>
                              <td style="vertical-align: middle; padding-left: 8px;">
                                <!-- Verified badge: white circle with green check -->
                                <table role="presentation" cellspacing="0" cellpadding="0">
                                  <tr>
                                    <td style="width: 18px; height: 18px; background-color: #ffffff; border-radius: 50%; text-align: center; vertical-align: middle; line-height: 18px;">
                                      <span style="font-size: 11px; color: #16a34a; font-family: Arial, sans-serif; font-weight: bold;">&#10004;</span>
                                    </td>
                                  </tr>
                                </table>
                              </td>
                            </tr>
                          </table>
                          <p style="margin: 4px 0 0 0; font-size: 13px; color: rgba(255,255,255,0.85); font-weight: 400;">Connect meaningfully</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ========== BODY ========== -->
          <tr>
            <td style="padding: 32px;">
              ${content}
            </td>
          </tr>

          <!-- ========== FOOTER ========== -->
          <tr>
            <td style="padding: 0;">
              <!-- Top Divider -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="padding: 0 32px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="border-top: 1px solid #e5e7eb;"></td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Footer Content -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="padding: 24px 32px; text-align: center; background-color: #fafafa;">
                    <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280; line-height: 1.5;">
                      ${footerText}
                    </p>
                    <p style="margin: 0; font-size: 12px; color: #9ca3af;">
                      &copy; 2025 YoMeet Inc. All rights reserved.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Bottom Green Accent -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="height: 4px; background: linear-gradient(90deg, #16a34a, #22c55e, #16a34a);"></td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

function getWelcomeEmailTemplate(displayName: string): string {
  const content = `
    <!-- Welcome Message -->
    <h2 style="margin: 0 0 8px; font-size: 24px; font-weight: 700; color: #111827; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      Welcome, ${displayName}!
    </h2>
    <p style="margin: 0 0 24px; font-size: 15px; color: #6b7280; line-height: 1.6; text-align: center;">
      Your account is ready. Start connecting with people who share your interests.
    </p>

    <!-- ═══════ Divider ═══════ -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
      <tr>
        <td style="border-top: 1px solid #e5e7eb;"></td>
      </tr>
    </table>

    <!-- Getting Started Section -->
    <p style="margin: 0 0 20px; font-size: 13px; font-weight: 600; color: #16a34a; text-transform: uppercase; letter-spacing: 1px;">
      Getting Started
    </p>

    <!-- Step 1 -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 14px;">
      <tr>
        <td style="width: 36px; vertical-align: top;">
          <table role="presentation" cellspacing="0" cellpadding="0">
            <tr>
              <td style="width: 28px; height: 28px; background-color: #16a34a; border-radius: 50%; text-align: center; vertical-align: middle;">
                <span style="font-size: 14px; font-weight: 600; color: #ffffff; line-height: 28px; font-family: -apple-system, BlinkMacSystemFont, sans-serif;">1</span>
              </td>
            </tr>
          </table>
        </td>
        <td style="padding-left: 12px; vertical-align: top;">
          <p style="margin: 0 0 2px; font-size: 15px; font-weight: 600; color: #111827;">Complete your profile</p>
          <p style="margin: 0; font-size: 13px; color: #6b7280; line-height: 1.4;">Add a photo and bio so others can know you</p>
        </td>
      </tr>
    </table>

    <!-- Step 2 -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 14px;">
      <tr>
        <td style="width: 36px; vertical-align: top;">
          <table role="presentation" cellspacing="0" cellpadding="0">
            <tr>
              <td style="width: 28px; height: 28px; background-color: #16a34a; border-radius: 50%; text-align: center; vertical-align: middle;">
                <span style="font-size: 14px; font-weight: 600; color: #ffffff; line-height: 28px; font-family: -apple-system, BlinkMacSystemFont, sans-serif;">2</span>
              </td>
            </tr>
          </table>
        </td>
        <td style="padding-left: 12px; vertical-align: top;">
          <p style="margin: 0 0 2px; font-size: 15px; font-weight: 600; color: #111827;">Chat with Kora</p>
          <p style="margin: 0; font-size: 13px; color: #6b7280; line-height: 1.4;">Your AI companion is ready to talk anytime</p>
        </td>
      </tr>
    </table>

    <!-- Step 3 -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
      <tr>
        <td style="width: 36px; vertical-align: top;">
          <table role="presentation" cellspacing="0" cellpadding="0">
            <tr>
              <td style="width: 28px; height: 28px; background-color: #16a34a; border-radius: 50%; text-align: center; vertical-align: middle;">
                <span style="font-size: 14px; font-weight: 600; color: #ffffff; line-height: 28px; font-family: -apple-system, BlinkMacSystemFont, sans-serif;">3</span>
              </td>
            </tr>
          </table>
        </td>
        <td style="padding-left: 12px; vertical-align: top;">
          <p style="margin: 0 0 2px; font-size: 15px; font-weight: 600; color: #111827;">Find your people</p>
          <p style="margin: 0; font-size: 13px; color: #6b7280; line-height: 1.4;">Discover others who share your interests</p>
        </td>
      </tr>
    </table>

    <!-- ═══════ Divider ═══════ -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
      <tr>
        <td style="border-top: 1px solid #e5e7eb;"></td>
      </tr>
    </table>

    <!-- Download Section -->
    <p style="margin: 0 0 20px; font-size: 13px; font-weight: 600; color: #16a34a; text-transform: uppercase; letter-spacing: 1px; text-align: center;">
      Download the App
    </p>

    <!-- App Store Badges -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0">
            <tr>
              <!-- App Store Badge -->
              <td style="padding: 0 6px;">
                <a href="${APP_STORE_URL}" target="_blank" style="text-decoration: none;">
                  <img src="${APP_STORE_BADGE}" alt="Download on the App Store" width="135" height="40" style="display: block; border: 0;" />
                </a>
              </td>
              <!-- Google Play Badge -->
              <td style="padding: 0 6px;">
                <a href="${PLAY_STORE_URL}" target="_blank" style="text-decoration: none;">
                  <img src="${PLAY_STORE_BADGE}" alt="Get it on Google Play" width="135" height="40" style="display: block; border: 0;" />
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;

  const footer = "You received this email because you created a YoMeet account.";
  return getBaseTemplate(content, footer);
}

function getPasswordResetEmailTemplate(code: string): string {
  const content = `
    <!-- Heading -->
    <h2 style="margin: 0 0 8px; font-size: 22px; font-weight: 700; color: #111827; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      Reset Your Password
    </h2>
    <p style="margin: 0 0 24px; font-size: 15px; color: #6b7280; line-height: 1.6; text-align: center;">
      Use the code below to set a new password for your account.
    </p>

    <!-- Divider -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
      <tr>
        <td style="border-top: 1px solid #e5e7eb;"></td>
      </tr>
    </table>

    <!-- OTP Code Box -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0">
            <tr>
              <td style="background-color: #f0fdf4; border: 2px dashed #16a34a; border-radius: 12px; padding: 20px 40px;">
                <span style="font-size: 32px; font-weight: 700; color: #111827; letter-spacing: 8px; font-family: 'SF Mono', Monaco, 'Courier New', monospace;">${code}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- Expiry Notice -->
    <p style="margin: 0 0 24px; font-size: 13px; color: #b45309; font-weight: 500; text-align: center;">
      Code expires in 5 minutes
    </p>

    <!-- Divider -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 20px;">
      <tr>
        <td style="border-top: 1px solid #e5e7eb;"></td>
      </tr>
    </table>

    <!-- Security Notice -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f9fafb; border-radius: 8px; border-left: 3px solid #d1d5db;">
      <tr>
        <td style="padding: 14px 16px;">
          <p style="margin: 0; font-size: 13px; color: #6b7280; line-height: 1.5;">
            <strong style="color: #374151;">Didn't request this?</strong> You can safely ignore this email.
          </p>
        </td>
      </tr>
    </table>
  `;

  const footer = "You received this email because a password reset was requested for your account.";
  return getBaseTemplate(content, footer);
}

// ─── Public API ─────────────────────────────────────────────────────────────────

export async function sendWelcomeEmail(to: string, displayName: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: 'Welcome to YoMeet!',
    html: getWelcomeEmailTemplate(displayName),
  });
}

export async function sendPasswordResetEmail(to: string, code: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: 'Reset Your YoMeet Password',
    html: getPasswordResetEmailTemplate(code),
  });
}
