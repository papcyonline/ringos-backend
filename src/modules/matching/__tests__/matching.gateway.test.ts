import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockMatchingService } = vi.hoisted(() => ({
  mockMatchingService: {
    getActiveRequest: vi.fn(),
    attemptMatch: vi.fn(),
  },
}));

vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../matching.service', () => mockMatchingService);

import { registerMatchingHandlers } from '../matching.gateway';

function makeSocket(handlers: Record<string, Function> = {}) {
  const socket: any = {
    userId: 'user-1',
    on: vi.fn((event: string, fn: Function) => { handlers[event] = fn; }),
    emit: vi.fn(),
  };
  return { socket, handlers };
}

function makeIO() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { to, emit, _emit: emit };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('matching.gateway', () => {
  it('registers matching:ready handler', () => {
    const { socket } = makeSocket();
    registerMatchingHandlers(makeIO() as any, socket);
    expect(socket.on).toHaveBeenCalledWith('matching:ready', expect.any(Function));
  });

  it('emits matching:error when no active request', async () => {
    const { socket, handlers } = makeSocket();
    registerMatchingHandlers(makeIO() as any, socket);
    mockMatchingService.getActiveRequest.mockResolvedValue(null);
    await handlers['matching:ready']();
    expect(socket.emit).toHaveBeenCalledWith('matching:error', expect.objectContaining({ message: expect.stringContaining('No active') }));
  });

  it('emits matching:found to both users when matched', async () => {
    const io = makeIO();
    const { socket, handlers } = makeSocket();
    registerMatchingHandlers(io as any, socket);
    mockMatchingService.getActiveRequest.mockResolvedValue({ id: 'r-1', userId: 'user-1' });
    mockMatchingService.attemptMatch.mockResolvedValue({
      conversation: { id: 'c-1', participants: [] },
      matchedUserId: 'u-2',
      score: 0.9,
    });
    await handlers['matching:ready']();
    expect(socket.emit).toHaveBeenCalledWith('matching:found', expect.objectContaining({
      conversationId: 'c-1', score: 0.9,
    }));
    expect(io.to).toHaveBeenCalledWith('user:u-2');
  });

  it('emits matching:waiting when no match found', async () => {
    const { socket, handlers } = makeSocket();
    registerMatchingHandlers(makeIO() as any, socket);
    mockMatchingService.getActiveRequest.mockResolvedValue({ id: 'r-1', userId: 'user-1' });
    mockMatchingService.attemptMatch.mockResolvedValue(null);
    await handlers['matching:ready']();
    expect(socket.emit).toHaveBeenCalledWith('matching:waiting', expect.any(Object));
  });

  it('emits matching:error on exception', async () => {
    const { socket, handlers } = makeSocket();
    registerMatchingHandlers(makeIO() as any, socket);
    mockMatchingService.getActiveRequest.mockRejectedValue(new Error('boom'));
    await handlers['matching:ready']();
    expect(socket.emit).toHaveBeenCalledWith('matching:error', expect.objectContaining({ message: expect.stringContaining('error') }));
  });
});
