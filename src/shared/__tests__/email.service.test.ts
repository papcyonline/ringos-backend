import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResend } = vi.hoisted(() => {
  const mockSend = vi.fn();
  const mockResend = { emails: { send: mockSend } };
  return { mockResend };
});

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => mockResend),
}));
vi.mock('../../config/env', () => ({
  env: {
    RESEND_API_KEY: 're_test_key',
    EMAIL_FROM: 'Yomeet <test@yomeet.app>',
    EMAIL_LOGO_URL: 'https://yomeet.app/logo.png',
  },
}));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  sendWelcomeEmail,
  sendOtpEmail,
  sendPasswordResetEmail,
  sendNewDeviceLoginEmail,
  sendGoodbyeEmail,
  getPreviewHtml,
} from '../email.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sendWelcomeEmail', () => {
  it('returns true when Resend accepts the email', async () => {
    mockResend.emails.send.mockResolvedValue({ data: { id: 'msg-1' }, error: null });

    const ok = await sendWelcomeEmail('a@b.com', 'Alice');

    expect(ok).toBe(true);
    expect(mockResend.emails.send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'a@b.com',
      subject: expect.stringContaining('Welcome'),
      html: expect.any(String),
    }));
  });

  it('returns false when Resend returns an error', async () => {
    mockResend.emails.send.mockResolvedValue({ data: null, error: { message: 'rate limit' } });

    const ok = await sendWelcomeEmail('a@b.com', 'Alice');
    expect(ok).toBe(false);
  });

  it('returns false on transport exception', async () => {
    mockResend.emails.send.mockRejectedValue(new Error('boom'));
    const ok = await sendWelcomeEmail('a@b.com', 'Alice');
    expect(ok).toBe(false);
  });
});

describe('sendOtpEmail', () => {
  it('embeds the OTP code in the subject', async () => {
    mockResend.emails.send.mockResolvedValue({ data: { id: 'm' }, error: null });

    await sendOtpEmail('a@b.com', '123456');

    expect(mockResend.emails.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining('123456'),
    }));
  });
});

describe('sendPasswordResetEmail', () => {
  it('embeds the reset code in the subject', async () => {
    mockResend.emails.send.mockResolvedValue({ data: { id: 'm' }, error: null });

    await sendPasswordResetEmail('a@b.com', '654321');

    expect(mockResend.emails.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining('654321'),
    }));
  });
});

describe('sendNewDeviceLoginEmail', () => {
  it('renders device, country, and time into the HTML', async () => {
    mockResend.emails.send.mockResolvedValue({ data: { id: 'm' }, error: null });

    await sendNewDeviceLoginEmail('a@b.com', {
      deviceName: 'iPhone 16',
      country: 'Lagos',
      time: 'May 8, 2026',
    });

    const html = (mockResend.emails.send.mock.calls[0][0] as any).html;
    expect(html).toContain('iPhone 16');
    expect(html).toContain('Lagos');
    expect(html).toContain('May 8, 2026');
  });

  it('escapes HTML special chars in details', async () => {
    mockResend.emails.send.mockResolvedValue({ data: { id: 'm' }, error: null });

    await sendNewDeviceLoginEmail('a@b.com', {
      deviceName: '"><script>',
      country: 'Test',
      time: 'now',
    });

    const html = (mockResend.emails.send.mock.calls[0][0] as any).html;
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('sendGoodbyeEmail', () => {
  it('addresses the user by display name', async () => {
    mockResend.emails.send.mockResolvedValue({ data: { id: 'm' }, error: null });

    await sendGoodbyeEmail('a@b.com', 'Alice');

    const html = (mockResend.emails.send.mock.calls[0][0] as any).html;
    expect(html).toContain('Alice');
  });
});

describe('getPreviewHtml', () => {
  it('returns HTML for known template names', () => {
    expect(getPreviewHtml('welcome')).toContain('John');
    expect(getPreviewHtml('otp')).toContain('482916');
    expect(getPreviewHtml('reset')).toContain('739201');
    expect(getPreviewHtml('goodbye')).toContain('John');
    expect(getPreviewHtml('device')).toContain('iPhone 16 Pro');
  });

  it('returns null for unknown template', () => {
    expect(getPreviewHtml('unknown')).toBeNull();
  });
});
