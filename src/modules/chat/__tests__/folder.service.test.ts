import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    chatFolder: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    chatFolderMember: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../../config/database', () => ({ prisma: mockPrisma }));

import {
  getFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  reorderFolders,
  addConversationToFolder,
  removeConversationFromFolder,
} from '../folder.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('folder.service', () => {
  describe('getFolders', () => {
    it('returns folders ordered by position', async () => {
      mockPrisma.chatFolder.findMany.mockResolvedValue([{ id: 'f-1', position: 0 }]);
      const res = await getFolders('user-1');
      expect(res).toHaveLength(1);
      expect(mockPrisma.chatFolder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } }),
      );
    });
  });

  describe('createFolder', () => {
    it('creates folder appended at end', async () => {
      mockPrisma.chatFolder.count.mockResolvedValue(2);
      mockPrisma.chatFolder.create.mockResolvedValue({ id: 'f-1', name: 'Work', position: 2 });
      const res = await createFolder('user-1', '  Work  ', '📁', '#fff');
      expect(res.name).toBe('Work');
      expect(mockPrisma.chatFolder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'Work', icon: '📁', color: '#fff', position: 2 }),
        }),
      );
    });

    it('throws when at max folders', async () => {
      mockPrisma.chatFolder.count.mockResolvedValue(10);
      await expect(createFolder('user-1', 'x')).rejects.toThrow(/Maximum/);
    });

    it('uses null defaults for icon and color', async () => {
      mockPrisma.chatFolder.count.mockResolvedValue(0);
      mockPrisma.chatFolder.create.mockResolvedValue({ id: 'f-1' });
      await createFolder('user-1', 'x');
      expect(mockPrisma.chatFolder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ icon: null, color: null }),
        }),
      );
    });
  });

  describe('updateFolder', () => {
    it('updates only provided fields', async () => {
      mockPrisma.chatFolder.findUnique.mockResolvedValue({ id: 'f-1', userId: 'user-1' });
      mockPrisma.chatFolder.update.mockResolvedValue({ id: 'f-1', name: 'New' });
      await updateFolder('user-1', 'f-1', { name: ' New ' });
      expect(mockPrisma.chatFolder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'New' }),
        }),
      );
    });

    it('updates icon and color when provided', async () => {
      mockPrisma.chatFolder.findUnique.mockResolvedValue({ id: 'f-1', userId: 'user-1' });
      mockPrisma.chatFolder.update.mockResolvedValue({});
      await updateFolder('user-1', 'f-1', { icon: '🔥', color: '#000' });
      expect(mockPrisma.chatFolder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ icon: '🔥', color: '#000' }),
        }),
      );
    });

    it('throws when folder not found', async () => {
      mockPrisma.chatFolder.findUnique.mockResolvedValue(null);
      await expect(updateFolder('user-1', 'f-1', {})).rejects.toThrow(/not found/i);
    });

    it('throws when folder belongs to another user', async () => {
      mockPrisma.chatFolder.findUnique.mockResolvedValue({ id: 'f-1', userId: 'other' });
      await expect(updateFolder('user-1', 'f-1', {})).rejects.toThrow(/Not your folder/);
    });
  });

  describe('deleteFolder', () => {
    it('deletes when owner', async () => {
      mockPrisma.chatFolder.findUnique.mockResolvedValue({ id: 'f-1', userId: 'user-1' });
      mockPrisma.chatFolder.delete.mockResolvedValue({});
      const res = await deleteFolder('user-1', 'f-1');
      expect(res.deleted).toBe(true);
    });
  });

  describe('reorderFolders', () => {
    it('reorders folders in transaction', async () => {
      mockPrisma.chatFolder.findMany.mockResolvedValue([{ id: 'f-1' }, { id: 'f-2' }]);
      mockPrisma.$transaction.mockResolvedValue([]);
      const res = await reorderFolders('user-1', ['f-2', 'f-1']);
      expect(res.success).toBe(true);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('rejects unknown folder ids', async () => {
      mockPrisma.chatFolder.findMany.mockResolvedValue([{ id: 'f-1' }]);
      await expect(reorderFolders('user-1', ['f-2'])).rejects.toThrow();
    });
  });

  describe('addConversationToFolder', () => {
    it('removes from existing folder then adds', async () => {
      mockPrisma.chatFolder.findUnique.mockResolvedValue({ id: 'f-1', userId: 'user-1' });
      mockPrisma.chatFolder.findMany.mockResolvedValue([{ id: 'f-1' }, { id: 'f-2' }]);
      mockPrisma.chatFolderMember.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.chatFolderMember.create.mockResolvedValue({});
      const res = await addConversationToFolder('user-1', 'f-1', 'c-1');
      expect(res.folderId).toBe('f-1');
      expect(mockPrisma.chatFolderMember.deleteMany).toHaveBeenCalled();
      expect(mockPrisma.chatFolderMember.create).toHaveBeenCalled();
    });
  });

  describe('removeConversationFromFolder', () => {
    it('removes when owner', async () => {
      mockPrisma.chatFolderMember.findUnique.mockResolvedValue({
        id: 'm-1',
        folder: { userId: 'user-1' },
      });
      mockPrisma.chatFolderMember.delete.mockResolvedValue({});
      const res = await removeConversationFromFolder('user-1', 'c-1');
      expect(res.removed).toBe(true);
    });

    it('throws when conversation not in any folder', async () => {
      mockPrisma.chatFolderMember.findUnique.mockResolvedValue(null);
      await expect(removeConversationFromFolder('user-1', 'c-1')).rejects.toThrow(/not in any/i);
    });

    it('throws when folder belongs to another user', async () => {
      mockPrisma.chatFolderMember.findUnique.mockResolvedValue({
        id: 'm-1',
        folder: { userId: 'other' },
      });
      await expect(removeConversationFromFolder('user-1', 'c-1')).rejects.toThrow(/Not your folder/);
    });
  });
});
