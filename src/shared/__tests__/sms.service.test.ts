import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockMessagesCreate, mockTwilio } = vi.hoisted(() => {
  const mockMessagesCreate = vi.fn();
  const mockTwilio = vi.fn(() => ({ messages: { create: mockMessagesCreate } }));
  return { mockMessagesCreate, mockTwilio };
});

vi.mock('twilio', () => ({ default: mockTwilio }));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

describe('sms.service (configured)', () => {
  beforeEach(() => {
    vi.doMock('../../config/env', () => ({
      env: {
        TWILIO_ACCOUNT_SID: 'sid',
        TWILIO_AUTH_TOKEN: 'tok',
        TWILIO_PHONE_NUMBER: '+15555550100',
      },
    }));
  });

  it('sends SMS successfully', async () => {
    mockMessagesCreate.mockResolvedValue({ sid: 'msg-1' });
    const { sendSms } = await import('../sms.service');
    const ok = await sendSms({ to: '+15551112222', body: 'hello' });
    expect(ok).toBe(true);
    expect(mockMessagesCreate).toHaveBeenCalledWith({
      to: '+15551112222',
      body: 'hello',
      from: '+15555550100',
    });
  });

  it('returns false on Twilio error', async () => {
    mockMessagesCreate.mockRejectedValue(new Error('twilio-down'));
    const { sendSms } = await import('../sms.service');
    const ok = await sendSms({ to: '+15551112222', body: 'hello' });
    expect(ok).toBe(false);
  });

  it('sendOtpSms formats body and forwards', async () => {
    mockMessagesCreate.mockResolvedValue({ sid: 'msg-1' });
    const { sendOtpSms } = await import('../sms.service');
    const ok = await sendOtpSms('+15551112222', '123456');
    expect(ok).toBe(true);
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.body).toContain('123456');
    expect(call.body).toContain('YoMeet');
  });
});

describe('sms.service (not configured)', () => {
  beforeEach(() => {
    vi.doMock('../../config/env', () => ({
      env: {
        TWILIO_ACCOUNT_SID: 'your_twilio_account_sid',
        TWILIO_AUTH_TOKEN: '',
        TWILIO_PHONE_NUMBER: '',
      },
    }));
  });

  it('returns false when Twilio not configured', async () => {
    const { sendSms } = await import('../sms.service');
    const ok = await sendSms({ to: '+1', body: 'x' });
    expect(ok).toBe(false);
    expect(mockTwilio).not.toHaveBeenCalled();
  });
});
