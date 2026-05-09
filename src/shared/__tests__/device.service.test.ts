import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockSendEmail, mockLogSecurityEvent } = vi.hoisted(() => ({
  mockPrisma: {
    userDevice: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
  mockSendEmail: vi.fn().mockResolvedValue(undefined),
  mockLogSecurityEvent: vi.fn(),
}));

vi.mock('../../config/database', () => ({ prisma: mockPrisma }));
vi.mock('../email.service', () => ({ sendNewDeviceLoginEmail: mockSendEmail }));
vi.mock('../audit.service', () => ({ logSecurityEvent: mockLogSecurityEvent }));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { trackDeviceAndAlert } from '../device.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('device.service', () => {
  it('returns early when req missing', async () => {
    await trackDeviceAndAlert('u-1', 'a@b.com');
    expect(mockPrisma.userDevice.findUnique).not.toHaveBeenCalled();
  });

  it('updates lastSeenAt when device is known', async () => {
    mockPrisma.userDevice.findUnique.mockResolvedValue({ id: 'd-1' });
    const req: any = {
      headers: { 'user-agent': 'iPhone Yomeet/1.0', 'cf-ipcountry': 'US' },
      ip: '1.1.1.1',
    };
    await trackDeviceAndAlert('u-1', 'a@b.com', req);
    expect(mockPrisma.userDevice.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'd-1' } }),
    );
    expect(mockPrisma.userDevice.create).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('creates new device, logs security event, sends email', async () => {
    mockPrisma.userDevice.findUnique.mockResolvedValue(null);
    mockPrisma.userDevice.create.mockResolvedValue({});
    const req: any = {
      headers: { 'user-agent': 'iPhone', 'cf-ipcountry': 'US' },
      ip: '1.1.1.1',
    };
    await trackDeviceAndAlert('u-1', 'a@b.com', req);
    expect(mockPrisma.userDevice.create).toHaveBeenCalled();
    expect(mockLogSecurityEvent).toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledWith('a@b.com', expect.objectContaining({
      deviceName: 'iPhone', country: 'US',
    }));
  });

  it('skips email when no userEmail', async () => {
    mockPrisma.userDevice.findUnique.mockResolvedValue(null);
    mockPrisma.userDevice.create.mockResolvedValue({});
    const req: any = { headers: { 'user-agent': 'Mozilla' } };
    await trackDeviceAndAlert('u-1', null, req);
    expect(mockLogSecurityEvent).toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('treats CF country XX as unknown', async () => {
    mockPrisma.userDevice.findUnique.mockResolvedValue(null);
    mockPrisma.userDevice.create.mockResolvedValue({});
    const req: any = { headers: { 'user-agent': 'Mac OS X', 'cf-ipcountry': 'XX' } };
    await trackDeviceAndAlert('u-1', 'a@b.com', req);
    expect(mockPrisma.userDevice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ipCountry: 'unknown' }),
      }),
    );
    expect(mockSendEmail).toHaveBeenCalledWith('a@b.com', expect.objectContaining({
      deviceName: 'Mac',
    }));
  });

  it('parses Android, Windows, Linux, iPad, Yomeet, Unknown', async () => {
    mockPrisma.userDevice.findUnique.mockResolvedValue(null);
    mockPrisma.userDevice.create.mockResolvedValue({});

    for (const [ua, expected] of [
      ['Mozilla Yomeet/2.0', 'Yomeet App'],
      ['Mozilla Android 12', 'Android device'],
      ['Mozilla iPad', 'iPad'],
      ['Mozilla Windows NT', 'Windows PC'],
      ['Mozilla Linux x86', 'Linux'],
      ['Random UA', 'Unknown device'],
    ] as const) {
      mockSendEmail.mockClear();
      const req: any = { headers: { 'user-agent': ua } };
      await trackDeviceAndAlert('u-1', 'a@b.com', req);
      expect(mockSendEmail).toHaveBeenCalledWith('a@b.com', expect.objectContaining({
        deviceName: expected,
      }));
    }
  });

  it('catches DB errors silently', async () => {
    mockPrisma.userDevice.findUnique.mockRejectedValue(new Error('db'));
    const req: any = { headers: { 'user-agent': 'iPhone' } };
    await expect(trackDeviceAndAlert('u-1', 'a@b.com', req)).resolves.toBeUndefined();
  });

  it('catches email errors silently', async () => {
    mockPrisma.userDevice.findUnique.mockResolvedValue(null);
    mockPrisma.userDevice.create.mockResolvedValue({});
    mockSendEmail.mockRejectedValue(new Error('smtp'));
    const req: any = { headers: { 'user-agent': 'iPhone' } };
    await expect(trackDeviceAndAlert('u-1', 'a@b.com', req)).resolves.toBeUndefined();
  });
});
