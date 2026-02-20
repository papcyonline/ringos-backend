import { Resend } from 'resend';
import { env } from '../config/env';
import { logger } from './logger';

// Only initialize Resend if API key is configured
const resend = env.RESEND_API_KEY && env.RESEND_API_KEY !== 're_your_resend_api_key'
  ? new Resend(env.RESEND_API_KEY)
  : null;

const EMAIL_FROM = env.EMAIL_FROM || 'Yomeet <noreply@yomeet.app>';

// Logo URL - hosted image for email compatibility
const LOGO_URL = env.EMAIL_LOGO_URL || 'https://api.yomeet.app/public/logo.png';

// App store links
const APP_STORE_URL = 'https://apps.apple.com/app/yomeet';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.yomeet.app';
const APP_STORE_BADGE = 'https://tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us?size=250x83';
const PLAY_STORE_BADGE = 'https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png';

// Social media
const SOCIALS = [
  { name: 'Facebook',  url: 'https://facebook.com/yomeetapp',    icon: 'https://cdn.simpleicons.org/facebook/ffffff' },
  { name: 'Instagram', url: 'https://instagram.com/yomeetapp',   icon: 'https://cdn.simpleicons.org/instagram/ffffff' },
  { name: 'X',         url: 'https://x.com/yomeetapp',           icon: 'https://cdn.simpleicons.org/x/ffffff' },
  { name: 'LinkedIn',  url: 'https://linkedin.com/company/yomeet', icon: 'https://cdn.simpleicons.org/linkedin/ffffff' },
  { name: 'YouTube',   url: 'https://youtube.com/@yomeetapp',    icon: 'https://cdn.simpleicons.org/youtube/ffffff' },
  { name: 'TikTok',    url: 'https://tiktok.com/@yomeetapp',     icon: 'https://cdn.simpleicons.org/tiktok/ffffff' },
];

function buildSocialIconsHtml(): string {
  return SOCIALS.map(s =>
    `<td style="padding: 0 5px;">
                    <a href="${s.url}" target="_blank" style="text-decoration: none;">
                      <table role="presentation" cellspacing="0" cellpadding="0"><tr>
                        <td style="width: 32px; height: 32px; background-color: #16a34a; border-radius: 50%; text-align: center; vertical-align: middle; line-height: 32px;">
                          <img src="${s.icon}" alt="${s.name}" width="14" height="14" style="display: inline-block; vertical-align: middle;" />
                        </td>
                      </tr></table>
                    </a>
                  </td>`
  ).join('\n                  ');
}

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

async function sendEmail({ to, subject, html }: SendEmailOptions): Promise<boolean> {
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
  const socialIcons = buildSocialIconsHtml();

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Yomeet</title>
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
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #0f172a; -webkit-font-smoothing: antialiased;">

  <!-- Dark canvas -->
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0f172a;">
    <tr>
      <td align="center" style="padding: 40px 16px;">

        <!-- White card -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 480px; background-color: #ffffff;">

          <!-- Top accent -->
          <tr>
            <td style="height: 3px; background-color: #16a34a; font-size: 0; line-height: 0;">&nbsp;</td>
          </tr>

          <!-- Masthead -->
          <tr>
            <td align="center" style="padding: 44px 40px 0;">
              <img src="${LOGO_URL}" alt="Yomeet" width="48" height="48" style="display: block; border-radius: 10px;" />
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 16px 40px 0;">
              <span style="font-size: 12px; font-weight: 700; color: #0f172a; letter-spacing: 3px; text-transform: uppercase; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">YOMEET</span>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 12px 0 0;">
              <table role="presentation" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="width: 32px; height: 2px; background-color: #16a34a; font-size: 0; line-height: 0;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 32px 40px 0;">
              ${content}
            </td>
          </tr>

          <!-- Social -->
          <tr>
            <td style="padding: 32px 40px 0;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr><td style="border-top: 1px solid #e5e7eb;"></td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 24px 40px 6px;">
              <p style="margin: 0; font-size: 15px; font-weight: 700; color: #16a34a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">@yomeetapp</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 12px 40px 0;">
              <table role="presentation" cellspacing="0" cellpadding="0">
                <tr>
                  ${socialIcons}
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px 0;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr><td style="border-top: 1px solid #e5e7eb;"></td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 20px 40px;">
              <p style="margin: 0 0 6px; font-size: 12px; color: #9ca3af; line-height: 1.5;">
                ${footerText}
              </p>
              <p style="margin: 0; font-size: 11px; color: #cbd5e1;">
                &copy; 2026 Yomeet Inc.
              </p>
            </td>
          </tr>

          <!-- Bottom accent -->
          <tr>
            <td style="height: 3px; background-color: #16a34a; font-size: 0; line-height: 0;">&nbsp;</td>
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
    <!-- Heading -->
    <h1 style="margin: 0 0 8px; font-size: 28px; font-weight: 800; color: #0f172a; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; letter-spacing: -0.5px; line-height: 1.2;">
      Welcome, ${displayName}.
    </h1>
    <p style="margin: 0 0 32px; font-size: 15px; color: #64748b; line-height: 1.6; text-align: center;">
      Your account is set up and ready to go.
    </p>

    <!-- Section Label -->
    <p style="margin: 0 0 20px; font-size: 11px; font-weight: 700; color: #16a34a; text-transform: uppercase; letter-spacing: 2px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      Getting Started
    </p>

    <!-- Step 1 -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 0;">
      <tr>
        <td style="width: 52px; vertical-align: top; padding-top: 2px;">
          <span style="font-size: 28px; font-weight: 800; color: #dcfce7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; letter-spacing: -1px;">01</span>
        </td>
        <td style="vertical-align: top; padding-left: 4px;">
          <p style="margin: 0 0 2px; font-size: 15px; font-weight: 700; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Complete your profile</p>
          <p style="margin: 0; font-size: 13px; color: #64748b; line-height: 1.5;">Add a photo and bio so others can find you</p>
        </td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 14px 0;">
      <tr><td style="border-top: 1px solid #f1f5f9;"></td></tr>
    </table>

    <!-- Step 2 -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 0;">
      <tr>
        <td style="width: 52px; vertical-align: top; padding-top: 2px;">
          <span style="font-size: 28px; font-weight: 800; color: #dcfce7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; letter-spacing: -1px;">02</span>
        </td>
        <td style="vertical-align: top; padding-left: 4px;">
          <p style="margin: 0 0 2px; font-size: 15px; font-weight: 700; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Chat with Kora</p>
          <p style="margin: 0; font-size: 13px; color: #64748b; line-height: 1.5;">Your AI companion is ready to talk anytime</p>
        </td>
      </tr>
    </table>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 14px 0;">
      <tr><td style="border-top: 1px solid #f1f5f9;"></td></tr>
    </table>

    <!-- Step 3 -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
      <tr>
        <td style="width: 52px; vertical-align: top; padding-top: 2px;">
          <span style="font-size: 28px; font-weight: 800; color: #dcfce7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; letter-spacing: -1px;">03</span>
        </td>
        <td style="vertical-align: top; padding-left: 4px;">
          <p style="margin: 0 0 2px; font-size: 15px; font-weight: 700; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Go live on Spotlight</p>
          <p style="margin: 0; font-size: 13px; color: #64748b; line-height: 1.5;">Broadcast yourself and connect face-to-face</p>
        </td>
      </tr>
    </table>

    <!-- Download Section -->
    <p style="margin: 0 0 20px; font-size: 11px; font-weight: 700; color: #16a34a; text-transform: uppercase; letter-spacing: 2px; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      Download
    </p>

    <!-- App Store Badges -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 8px;">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0">
            <tr>
              <td style="padding: 0 6px;">
                <a href="${APP_STORE_URL}" target="_blank" style="text-decoration: none;">
                  <img src="${APP_STORE_BADGE}" alt="Download on the App Store" width="130" height="38" style="display: block; border: 0;" />
                </a>
              </td>
              <td style="padding: 0 6px;">
                <a href="${PLAY_STORE_URL}" target="_blank" style="text-decoration: none;">
                  <img src="${PLAY_STORE_BADGE}" alt="Get it on Google Play" width="130" height="38" style="display: block; border: 0;" />
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;

  const footer = "You received this email because you created a Yomeet account.";
  return getBaseTemplate(content, footer);
}

function getPasswordResetEmailTemplate(code: string): string {
  const content = `
    <!-- Heading -->
    <h1 style="margin: 0 0 8px; font-size: 28px; font-weight: 800; color: #0f172a; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; letter-spacing: -0.5px; line-height: 1.2;">
      Reset your password
    </h1>
    <p style="margin: 0 0 32px; font-size: 15px; color: #64748b; line-height: 1.6; text-align: center;">
      Enter this code to set a new password for your account.
    </p>

    <!-- OTP Code -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr>
              <td align="center" style="background-color: #0f172a; border-radius: 8px; padding: 28px 20px;">
                <span style="font-size: 36px; font-weight: 700; color: #ffffff; letter-spacing: 10px; font-family: 'SF Mono', Monaco, 'Courier New', monospace;">${code}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- Expiry -->
    <p style="margin: 0 0 28px; font-size: 13px; color: #b45309; font-weight: 600; text-align: center; letter-spacing: 0.3px;">
      Expires in 5 minutes
    </p>

    <!-- Divider -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 20px;">
      <tr><td style="border-top: 1px solid #f1f5f9;"></td></tr>
    </table>

    <!-- Security Notice -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 8px;">
      <tr>
        <td style="border-left: 3px solid #16a34a; padding: 14px 16px; background-color: #f8fafc; border-radius: 0 6px 6px 0;">
          <p style="margin: 0; font-size: 13px; color: #64748b; line-height: 1.5;">
            <strong style="color: #0f172a;">Didn't request this?</strong> You can safely ignore this email. Your password won't change.
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
    subject: 'Welcome to Yomeet!',
    html: getWelcomeEmailTemplate(displayName),
  });
}

export async function sendPasswordResetEmail(to: string, code: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: 'Reset Your Yomeet Password',
    html: getPasswordResetEmailTemplate(code),
  });
}
