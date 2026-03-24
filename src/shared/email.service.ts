import { Resend } from 'resend';
import { env } from '../config/env';
import { logger } from './logger';

// Only initialize Resend if API key is configured
const resend = env.RESEND_API_KEY && env.RESEND_API_KEY !== 're_your_resend_api_key'
  ? new Resend(env.RESEND_API_KEY)
  : null;

const EMAIL_FROM = env.EMAIL_FROM || 'Yomeet <noreply@yomeet.app>';

// Logo URL - hosted image for email compatibility
const LOGO_URL = env.EMAIL_LOGO_URL || 'https://yomeet-backend.onrender.com/public/logo.png';

// App store links
const APP_STORE_URL = 'https://apps.apple.com/app/yomeet';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.yomeet.app';
const APP_STORE_BADGE = 'https://tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us?size=250x83';
const PLAY_STORE_BADGE = 'https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png';

// Social media links
const SOCIALS = [
  { name: 'Facebook',  url: 'https://facebook.com/yomeetapp' },
  { name: 'Instagram', url: 'https://instagram.com/yomeetapp' },
  { name: 'X',         url: 'https://x.com/yomeetapp' },
  { name: 'LinkedIn',  url: 'https://linkedin.com/company/yomeet' },
  { name: 'YouTube',   url: 'https://youtube.com/@yomeetapp' },
  { name: 'TikTok',    url: 'https://tiktok.com/@yomeetapp' },
];

function buildSocialIconsHtml(): string {
  return SOCIALS.map(s =>
    `<td style="padding: 0 4px;">
                    <a href="${s.url}" target="_blank" style="text-decoration: none; display: inline-block; padding: 5px 10px; border-radius: 16px; border: 1px solid #2a2a2a; font-size: 11px; font-weight: 600; color: #888888; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                      ${s.name}
                    </a>
                  </td>`
  ).join('\n                  ');
}

function buildOtpDigits(code: string): string {
  return code.split('').map(digit =>
    `<td style="padding: 0 4px;">
                        <table role="presentation" cellspacing="0" cellpadding="0"><tr>
                          <td style="width: 48px; height: 56px; border: 2px solid #0FE061; border-radius: 12px; text-align: center; vertical-align: middle; font-size: 28px; font-weight: 600; color: #ffffff; font-family: 'SF Mono', Monaco, 'Courier New', monospace; letter-spacing: 0;">
                            ${digit}
                          </td>
                        </tr></table>
                      </td>`
  ).join('\n                      ');
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
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #0a0a0a; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;">

  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0a0a0a;">
    <tr>
      <td align="center" style="padding: 48px 16px 32px;">

        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 480px;">

          <!-- Logo with glow -->
          <tr>
            <td align="center" style="padding: 0 0 48px;">
              <table role="presentation" cellspacing="0" cellpadding="0"><tr>
                <td align="center" style="padding: 12px; border-radius: 20px; background: radial-gradient(circle, rgba(15,224,97,0.12) 0%, transparent 70%);">
                  <img src="${LOGO_URL}" alt="Yomeet" width="52" height="52" style="display: block; border-radius: 14px;" />
                </td>
              </tr></table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 0 8px;">
              ${content}
            </td>
          </tr>

          <!-- Social icons -->
          <tr>
            <td align="center" style="padding: 48px 0 0;">
              <table role="presentation" cellspacing="0" cellpadding="0">
                <tr>
                  ${socialIcons}
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding: 32px 0 0;">
              <p style="margin: 0 0 8px; font-size: 12px; color: #555555; line-height: 1.6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                ${footerText}
              </p>
              <p style="margin: 0; font-size: 11px; color: #3a3a3a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                &copy; 2026 Yomeet Inc.
              </p>
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
  const features = [
    { emoji: '&#x1F465;', title: 'Meet People', desc: 'Discover others by availability and connect on your terms' },
    { emoji: '&#x1F4E1;', title: 'Go Live', desc: 'Broadcast on Spotlight and connect face-to-face' },
    { emoji: '&#x1F916;', title: 'Talk to Kora', desc: 'Your AI companion, available 24/7' },
    { emoji: '&#x1F4AC;', title: 'Chat &amp; Call', desc: 'Text, voice, and HD video calls' },
    { emoji: '&#x1F4D6;', title: 'Share Stories', desc: 'Post moments that disappear in 24 hours' },
    { emoji: '&#x1F465;', title: 'Join Groups', desc: 'Find communities and make connections' },
  ];

  const featureRows = features.map((f, i) => {
    const separator = i < features.length - 1
      ? `<tr><td colspan="2" style="padding: 0;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="border-top: 1px solid #1a1a1a; height: 1px; font-size: 0; line-height: 0;"></td></tr></table></td></tr>`
      : '';
    return `
          <tr>
            <td style="width: 44px; vertical-align: top; padding: 16px 0; font-size: 22px; text-align: center;">
              ${f.emoji}
            </td>
            <td style="vertical-align: top; padding: 16px 0 16px 8px;">
              <p style="margin: 0 0 2px; font-size: 15px; font-weight: 600; color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${f.title}</p>
              <p style="margin: 0; font-size: 13px; color: #777777; line-height: 1.5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${f.desc}</p>
            </td>
          </tr>
          ${separator}`;
  }).join('');

  const content = `
    <!-- Heading -->
    <h1 style="margin: 0 0 8px; font-size: 30px; font-weight: 300; color: #ffffff; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; letter-spacing: -0.5px; line-height: 1.3;">
      Welcome to Yomeet, <span style="font-weight: 600; color: #0FE061;">${displayName}</span>
    </h1>
    <p style="margin: 0 0 40px; font-size: 15px; color: #777777; line-height: 1.6; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      Your account is ready. Here's what you can do:
    </p>

    <!-- Features -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 40px;">
      ${featureRows}
    </table>

    <!-- CTA Button -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 8px;">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0"><tr>
            <td align="center" style="background: linear-gradient(135deg, #0FE061, #0bc04e); border-radius: 50px; padding: 14px 48px;">
              <a href="https://yomeet.app" target="_blank" style="font-size: 15px; font-weight: 600; color: #000000; text-decoration: none; display: inline-block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Open Yomeet</a>
            </td>
          </tr></table>
        </td>
      </tr>
    </table>
  `;

  const footer = "You received this email because you created a Yomeet account.";
  return getBaseTemplate(content, footer);
}

function getPasswordResetEmailTemplate(code: string): string {
  const otpDigits = buildOtpDigits(code);

  const content = `
    <!-- Heading -->
    <h1 style="margin: 0 0 8px; font-size: 30px; font-weight: 300; color: #ffffff; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; letter-spacing: -0.5px; line-height: 1.3;">
      Reset your password
    </h1>
    <p style="margin: 0 0 40px; font-size: 15px; color: #777777; line-height: 1.6; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      Use this code to set a new password
    </p>

    <!-- OTP Digits -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 20px;">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0">
            <tr>
              ${otpDigits}
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- Expiry -->
    <p style="margin: 0 0 40px; font-size: 13px; color: #d97706; font-weight: 500; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      This code expires in 5 minutes
    </p>

    <!-- Security Notice -->
    <p style="margin: 0; font-size: 13px; color: #555555; line-height: 1.6; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      If you didn't request this, ignore this email. Your password won't change.
    </p>
  `;

  const footer = "You received this email because a password reset was requested for your account.";
  return getBaseTemplate(content, footer);
}

function getOtpEmailTemplate(code: string): string {
  const otpDigits = buildOtpDigits(code);

  const content = `
    <!-- Heading -->
    <h1 style="margin: 0 0 8px; font-size: 30px; font-weight: 300; color: #ffffff; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; letter-spacing: -0.5px; line-height: 1.3;">
      Verify your email
    </h1>
    <p style="margin: 0 0 40px; font-size: 15px; color: #777777; line-height: 1.6; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      Enter this 6-digit code to continue
    </p>

    <!-- OTP Digits -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 20px;">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0">
            <tr>
              ${otpDigits}
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- Expiry -->
    <p style="margin: 0 0 40px; font-size: 13px; color: #d97706; font-weight: 500; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      This code expires in 5 minutes
    </p>

    <!-- Security Notice -->
    <p style="margin: 0; font-size: 13px; color: #555555; line-height: 1.6; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      If you didn't request this, ignore this email.
    </p>
  `;

  const footer = "You received this email because an account was created with this address on Yomeet.";
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

export async function sendOtpEmail(to: string, code: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: 'Verify Your Yomeet Account',
    html: getOtpEmailTemplate(code),
  });
}

function getGoodbyeEmailTemplate(displayName: string): string {
  const content = `
    <h1 style="margin: 0 0 8px; font-size: 28px; font-weight: 300; color: #ffffff; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      Goodbye, <span style="font-weight: 700; color: #0FE061;">${displayName}</span>
    </h1>
    <p style="margin: 0 0 32px; font-size: 15px; color: #888888; line-height: 1.6; text-align: center;">
      Your Yomeet account has been permanently deleted.
    </p>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
      <tr>
        <td style="padding: 20px; background-color: #111111; border-radius: 12px; border-left: 3px solid #0FE061;">
          <p style="margin: 0 0 12px; font-size: 14px; font-weight: 700; color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            What&rsquo;s been deleted:
          </p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr><td style="padding: 4px 0; font-size: 13px; color: #aaaaaa;">&#x2713;&nbsp; Your profile, avatar, and bio</td></tr>
            <tr><td style="padding: 4px 0; font-size: 13px; color: #aaaaaa;">&#x2713;&nbsp; All messages and conversations</td></tr>
            <tr><td style="padding: 4px 0; font-size: 13px; color: #aaaaaa;">&#x2713;&nbsp; Stories, media, and uploads</td></tr>
            <tr><td style="padding: 4px 0; font-size: 13px; color: #aaaaaa;">&#x2713;&nbsp; Call history and voice notes</td></tr>
            <tr><td style="padding: 4px 0; font-size: 13px; color: #aaaaaa;">&#x2713;&nbsp; Followers, connections, and groups</td></tr>
            <tr><td style="padding: 4px 0; font-size: 13px; color: #aaaaaa;">&#x2713;&nbsp; All personal data</td></tr>
          </table>
        </td>
      </tr>
    </table>

    <p style="margin: 0 0 24px; font-size: 14px; color: #888888; line-height: 1.6; text-align: center;">
      None of your data is retained. This action is irreversible.
    </p>

    <p style="margin: 0 0 8px; font-size: 14px; color: #888888; line-height: 1.6; text-align: center;">
      We&rsquo;re sorry to see you go. If you ever want to come back, you&rsquo;re always welcome.
    </p>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 28px;">
      <tr>
        <td align="center">
          <a href="https://yomeet.app" target="_blank" style="display: inline-block; padding: 14px 40px; background: linear-gradient(135deg, #0FE061, #0CBF50); color: #000000; font-size: 15px; font-weight: 700; text-decoration: none; border-radius: 50px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            Create a New Account
          </a>
        </td>
      </tr>
    </table>
  `;

  const footer = "This is a confirmation that your account and all associated data have been permanently deleted.";
  return getBaseTemplate(content, footer);
}

export async function sendGoodbyeEmail(to: string, displayName: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: 'Your Yomeet account has been deleted',
    html: getGoodbyeEmailTemplate(displayName),
  });
}

// ─── Preview (for browser rendering during development) ─────────────────────────

export function getPreviewHtml(template: string): string | null {
  switch (template) {
    case 'welcome': return getWelcomeEmailTemplate('John');
    case 'otp': return getOtpEmailTemplate('482916');
    case 'reset': return getPasswordResetEmailTemplate('739201');
    case 'goodbye': return getGoodbyeEmailTemplate('John');
    default: return null;
  }
}
