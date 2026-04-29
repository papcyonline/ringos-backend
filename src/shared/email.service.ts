import { Resend } from 'resend';
import { env } from '../config/env';
import { logger } from './logger';

// Only initialize Resend if API key is configured
const resend = env.RESEND_API_KEY && env.RESEND_API_KEY !== 're_your_resend_api_key'
  ? new Resend(env.RESEND_API_KEY)
  : null;

const EMAIL_FROM = env.EMAIL_FROM || 'Yomeet <noreply@yomeet.app>';

// Logo URL — hosted image for email compatibility
const LOGO_URL = env.EMAIL_LOGO_URL || 'https://yomeet-backend.onrender.com/public/logo.png';

const APP_STORE_URL = 'https://apps.apple.com/app/yomeet';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.yomeet.app';
const APP_STORE_BADGE = 'https://tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us?size=250x83';
const PLAY_STORE_BADGE = 'https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png';

const SOCIALS = [
  { name: 'Instagram', url: 'https://instagram.com/yomeetapp' },
  { name: 'X',         url: 'https://x.com/yomeetapp' },
  { name: 'TikTok',    url: 'https://tiktok.com/@yomeetapp' },
  { name: 'YouTube',   url: 'https://youtube.com/@yomeetapp' },
  { name: 'LinkedIn',  url: 'https://linkedin.com/company/yomeet' },
];

// ─── Design tokens ──────────────────────────────────────────────────────────────

const C = {
  bg: '#0a0a0b',
  surface: '#121214',
  surfaceAlt: '#17171a',
  border: '#222226',
  brand: '#0FE061',
  brandDeep: '#0BB14E',
  text: '#ffffff',
  textSubtle: '#a1a1a6',
  textMuted: '#5c5c63',
  warning: '#f5a524',
  danger: '#ff5a4e',
};

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;
const MONO = `'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace`;

// ─── Atoms ──────────────────────────────────────────────────────────────────────

function eyebrow(label: string): string {
  return `<p style="margin: 0 0 12px; font-size: 11px; font-weight: 600; letter-spacing: 2.4px; text-transform: uppercase; color: ${C.brand}; text-align: center; font-family: ${FONT};">${label}</p>`;
}

function heading(text: string): string {
  return `<h1 style="margin: 0 0 12px; font-size: 28px; font-weight: 700; color: ${C.text}; text-align: center; font-family: ${FONT}; letter-spacing: -0.5px; line-height: 1.25;">${text}</h1>`;
}

function lede(text: string): string {
  return `<p style="margin: 0 0 36px; font-size: 15px; color: ${C.textSubtle}; line-height: 1.6; text-align: center; font-family: ${FONT};">${text}</p>`;
}

function ctaButton(label: string, href: string): string {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0"><tr>
            <td align="center" style="background-color: ${C.brand}; background-image: linear-gradient(135deg, ${C.brand}, ${C.brandDeep}); border-radius: 999px; padding: 14px 36px;">
              <a href="${href}" target="_blank" style="font-size: 15px; font-weight: 700; color: #000000; text-decoration: none; display: inline-block; font-family: ${FONT}; letter-spacing: 0.2px;">${label}</a>
            </td>
          </tr></table>
        </td>
      </tr>
    </table>`;
}

function buildOtpDigits(code: string): string {
  return code.split('').map(digit =>
    `<td style="padding: 0 4px;">
      <table role="presentation" cellspacing="0" cellpadding="0"><tr>
        <td style="width: 48px; height: 60px; background-color: ${C.surfaceAlt}; border: 1px solid ${C.border}; border-radius: 12px; text-align: center; vertical-align: middle; font-size: 28px; font-weight: 700; color: ${C.text}; font-family: ${MONO};">
          ${digit}
        </td>
      </tr></table>
    </td>`
  ).join('');
}

function buildSocialLinksHtml(): string {
  const dot = `<span style="color: ${C.textMuted}; padding: 0 8px;">&middot;</span>`;
  return SOCIALS.map(s =>
    `<a href="${s.url}" target="_blank" style="color: ${C.textSubtle}; text-decoration: none; font-size: 12px; font-family: ${FONT};">${s.name}</a>`
  ).join(dot);
}

function buildAppStoreBadgesHtml(): string {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0">
      <tr>
        <td style="padding: 0 6px;">
          <a href="${APP_STORE_URL}" target="_blank">
            <img src="${APP_STORE_BADGE}" alt="Download on the App Store" height="40" style="display: block; height: 40px; width: auto; border: 0; outline: 0;">
          </a>
        </td>
        <td style="padding: 0 6px;">
          <a href="${PLAY_STORE_URL}" target="_blank">
            <img src="${PLAY_STORE_BADGE}" alt="Get it on Google Play" height="58" style="display: block; height: 58px; width: auto; border: 0; outline: 0;">
          </a>
        </td>
      </tr>
    </table>`;
}

// ─── Base template ──────────────────────────────────────────────────────────────

interface BaseOptions {
  preheader: string;
  content: string;
  footerText: string;
  showAppBadges?: boolean;
}

function getBaseTemplate({ preheader, content, footerText, showAppBadges }: BaseOptions): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
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
<body style="margin: 0; padding: 0; background-color: ${C.bg}; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;">

  <!-- Inbox preheader (hidden) -->
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; visibility: hidden; mso-hide: all;">
    ${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>

  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: ${C.bg};">
    <tr>
      <td align="center" style="padding: 48px 16px;">

        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 480px;">

          <!-- Header: logo + hairline divider -->
          <tr>
            <td align="center" style="padding: 0 0 40px;">
              <img src="${LOGO_URL}" alt="Yomeet" width="44" height="44" style="display: block; border-radius: 12px; margin-bottom: 20px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="height: 1px; line-height: 1px; font-size: 1px; background: linear-gradient(90deg, transparent, ${C.border} 30%, ${C.border} 70%, transparent);">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body card -->
          <tr>
            <td style="padding: 0 4px 8px;">
              ${content}
            </td>
          </tr>

          ${showAppBadges ? `
          <!-- App store badges -->
          <tr>
            <td align="center" style="padding: 32px 0 0;">
              ${buildAppStoreBadgesHtml()}
            </td>
          </tr>` : ''}

          <!-- Footer: socials -->
          <tr>
            <td align="center" style="padding: 48px 0 12px;">
              ${buildSocialLinksHtml()}
            </td>
          </tr>

          <!-- Footer: meta -->
          <tr>
            <td align="center" style="padding: 0 0 8px;">
              <p style="margin: 0; font-size: 12px; color: ${C.textMuted}; line-height: 1.6; font-family: ${FONT};">
                ${footerText}
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 0;">
              <p style="margin: 0; font-size: 11px; color: ${C.textMuted}; font-family: ${FONT};">
                &copy; 2026 Yomeet Inc. &nbsp;&middot;&nbsp; <a href="https://yomeet.app/privacy" target="_blank" style="color: ${C.textMuted}; text-decoration: none;">Privacy</a> &nbsp;&middot;&nbsp; <a href="https://yomeet.app/terms" target="_blank" style="color: ${C.textMuted}; text-decoration: none;">Terms</a>
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

// ─── Templates ──────────────────────────────────────────────────────────────────

function getWelcomeEmailTemplate(displayName: string): string {
  const features = [
    { num: '01', title: 'Meet', desc: 'Discover real people available right now, on your terms.' },
    { num: '02', title: 'Talk', desc: 'Chat, voice, video — and Kora, your AI companion any time.' },
    { num: '03', title: 'Share', desc: 'Stories, posts, and groups for the people you choose.' },
  ];

  const featureRows = features.map((f, i) => `
    <tr>
      <td style="width: 44px; vertical-align: top; padding: ${i === 0 ? '0' : '20'}px 0 0;">
        <table role="presentation" cellspacing="0" cellpadding="0"><tr>
          <td style="width: 32px; height: 32px; background: rgba(15,224,97,0.12); border-radius: 999px; text-align: center; vertical-align: middle; font-size: 11px; font-weight: 700; color: ${C.brand}; font-family: ${MONO}; letter-spacing: 0.5px;">
            ${f.num}
          </td>
        </tr></table>
      </td>
      <td style="vertical-align: top; padding: ${i === 0 ? '4' : '24'}px 0 0 14px;">
        <p style="margin: 0 0 4px; font-size: 15px; font-weight: 700; color: ${C.text}; font-family: ${FONT};">${f.title}</p>
        <p style="margin: 0; font-size: 14px; color: ${C.textSubtle}; line-height: 1.55; font-family: ${FONT};">${f.desc}</p>
      </td>
    </tr>
  `).join('');

  const content = `
    ${eyebrow('Welcome')}
    ${heading(`You're in, ${escapeHtml(displayName)}.`)}
    ${lede("Yomeet is your space to meet people, talk with Kora, and stay close to the people who matter. Here's where to start.")}

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 36px;">
      ${featureRows}
    </table>

    ${ctaButton('Open Yomeet', 'https://yomeet.app')}
  `;

  return getBaseTemplate({
    preheader: `You're in, ${displayName}. Three things to try first.`,
    content,
    footerText: 'You received this email because you created a Yomeet account.',
    showAppBadges: true,
  });
}

function getOtpEmailTemplate(code: string): string {
  const content = `
    ${eyebrow('Verification code')}
    ${heading('Confirm your email')}
    ${lede('Enter this 6-digit code in the app to finish signing in.')}

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 18px;">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0"><tr>
            ${buildOtpDigits(code)}
          </tr></table>
        </td>
      </tr>
    </table>

    <p style="margin: 0 0 32px; font-size: 13px; color: ${C.warning}; font-weight: 500; text-align: center; font-family: ${FONT};">
      Expires in 5 minutes
    </p>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td style="background-color: ${C.surface}; border: 1px solid ${C.border}; border-radius: 12px; padding: 16px 18px;">
          <p style="margin: 0; font-size: 13px; color: ${C.textSubtle}; line-height: 1.55; font-family: ${FONT};">
            Didn't request this? You can safely ignore this email — no account changes will be made without your code.
          </p>
        </td>
      </tr>
    </table>
  `;

  return getBaseTemplate({
    preheader: `Your Yomeet code is ${code}. Expires in 5 minutes.`,
    content,
    footerText: 'You received this email because someone tried to sign in with this address.',
  });
}

function getPasswordResetEmailTemplate(code: string): string {
  const content = `
    ${eyebrow('Password reset')}
    ${heading('Set a new password')}
    ${lede('Enter this code in the app to choose a new password for your Yomeet account.')}

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 18px;">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0"><tr>
            ${buildOtpDigits(code)}
          </tr></table>
        </td>
      </tr>
    </table>

    <p style="margin: 0 0 32px; font-size: 13px; color: ${C.warning}; font-weight: 500; text-align: center; font-family: ${FONT};">
      Expires in 5 minutes
    </p>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td style="background-color: ${C.surface}; border: 1px solid ${C.border}; border-radius: 12px; padding: 16px 18px;">
          <p style="margin: 0; font-size: 13px; color: ${C.textSubtle}; line-height: 1.55; font-family: ${FONT};">
            Didn't request a reset? Your password is unchanged — you can ignore this email. If you keep getting reset codes you didn't ask for, contact support.
          </p>
        </td>
      </tr>
    </table>
  `;

  return getBaseTemplate({
    preheader: `Your Yomeet password reset code is ${code}.`,
    content,
    footerText: 'You received this email because a password reset was requested for your account.',
  });
}

function getNewDeviceLoginTemplate(details: { deviceName: string; country: string; time: string }): string {
  const detailRow = (label: string, value: string) => `
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid ${C.border};">
        <p style="margin: 0; font-size: 11px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: ${C.textMuted}; font-family: ${FONT};">${label}</p>
        <p style="margin: 4px 0 0; font-size: 14px; color: ${C.text}; font-family: ${FONT};">${escapeHtml(value)}</p>
      </td>
    </tr>`;

  const content = `
    ${eyebrow('Security alert')}
    ${heading('New sign-in detected')}
    ${lede('We noticed a new sign-in to your Yomeet account from a device or location we haven\'t seen before.')}

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 32px;">
      <tr>
        <td style="background-color: ${C.surface}; border: 1px solid ${C.border}; border-radius: 14px; padding: 4px 20px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            ${detailRow('Device', details.deviceName)}
            ${detailRow('Location', details.country)}
            <tr>
              <td style="padding: 10px 0;">
                <p style="margin: 0; font-size: 11px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: ${C.textMuted}; font-family: ${FONT};">Time</p>
                <p style="margin: 4px 0 0; font-size: 14px; color: ${C.text}; font-family: ${FONT};">${escapeHtml(details.time)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td style="background-color: rgba(255,90,78,0.08); border: 1px solid rgba(255,90,78,0.25); border-radius: 12px; padding: 16px 18px;">
          <p style="margin: 0 0 6px; font-size: 13px; font-weight: 700; color: ${C.danger}; font-family: ${FONT};">Wasn't you?</p>
          <p style="margin: 0; font-size: 13px; color: ${C.textSubtle}; line-height: 1.55; font-family: ${FONT};">
            Change your password immediately and turn on two-factor authentication in your account settings.
          </p>
        </td>
      </tr>
    </table>
  `;

  return getBaseTemplate({
    preheader: `New sign-in on ${details.deviceName} from ${details.country}.`,
    content,
    footerText: 'You received this email because of a new sign-in to your Yomeet account.',
  });
}

function getGoodbyeEmailTemplate(displayName: string): string {
  const items = [
    'Your profile, avatar, and bio',
    'All messages and conversations',
    'Stories, media, and uploads',
    'Call history and voice notes',
    'Followers, connections, and groups',
    'All personal data',
  ];

  const itemRows = items.map(it => `
    <tr>
      <td style="padding: 6px 0; vertical-align: top;">
        <span style="display: inline-block; width: 16px; color: ${C.brand}; font-weight: 700;">&#x2713;</span>
        <span style="font-size: 13px; color: ${C.textSubtle}; font-family: ${FONT};">${it}</span>
      </td>
    </tr>
  `).join('');

  const content = `
    ${eyebrow('Account deleted')}
    ${heading(`Goodbye, ${escapeHtml(displayName)}.`)}
    ${lede('Your Yomeet account and everything tied to it has been permanently removed. None of your data is retained.')}

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 32px;">
      <tr>
        <td style="background-color: ${C.surface}; border: 1px solid ${C.border}; border-radius: 14px; padding: 18px 22px;">
          <p style="margin: 0 0 12px; font-size: 12px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: ${C.textMuted}; font-family: ${FONT};">What was deleted</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            ${itemRows}
          </table>
        </td>
      </tr>
    </table>

    <p style="margin: 0 0 28px; font-size: 14px; color: ${C.textSubtle}; line-height: 1.6; text-align: center; font-family: ${FONT};">
      We're sorry to see you go. If you ever change your mind, your seat is still here.
    </p>

    ${ctaButton('Create a new account', 'https://yomeet.app')}
  `;

  return getBaseTemplate({
    preheader: 'Your Yomeet account has been permanently deleted.',
    content,
    footerText: 'This is a confirmation that your account and all associated data have been permanently deleted.',
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

// ─── Public API ─────────────────────────────────────────────────────────────────

export async function sendWelcomeEmail(to: string, displayName: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: `Welcome to Yomeet, ${displayName}`,
    html: getWelcomeEmailTemplate(displayName),
  });
}

export async function sendOtpEmail(to: string, code: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: `Your Yomeet code is ${code}`,
    html: getOtpEmailTemplate(code),
  });
}

export async function sendPasswordResetEmail(to: string, code: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: `Reset your Yomeet password — code ${code}`,
    html: getPasswordResetEmailTemplate(code),
  });
}

export async function sendNewDeviceLoginEmail(
  to: string,
  details: { deviceName: string; country: string; time: string }
): Promise<boolean> {
  return sendEmail({
    to,
    subject: 'New sign-in to your Yomeet account',
    html: getNewDeviceLoginTemplate(details),
  });
}

export async function sendGoodbyeEmail(to: string, displayName: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: 'Your Yomeet account has been deleted',
    html: getGoodbyeEmailTemplate(displayName),
  });
}

// ─── Preview (dev only) ─────────────────────────────────────────────────────────

export function getPreviewHtml(template: string): string | null {
  switch (template) {
    case 'welcome': return getWelcomeEmailTemplate('John');
    case 'otp':     return getOtpEmailTemplate('482916');
    case 'reset':   return getPasswordResetEmailTemplate('739201');
    case 'goodbye': return getGoodbyeEmailTemplate('John');
    case 'device':  return getNewDeviceLoginTemplate({
      deviceName: 'iPhone 16 Pro · Safari',
      country: 'Lagos, Nigeria',
      time: 'April 30, 2026, 8:32 PM (UTC+1)',
    });
    default: return null;
  }
}
