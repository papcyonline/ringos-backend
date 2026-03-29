import { prisma } from '../../config/database';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../shared/errors';

const MAX_FOLDERS = 10;

export async function getFolders(userId: string) {
  return prisma.chatFolder.findMany({
    where: { userId },
    orderBy: { position: 'asc' },
    include: {
      members: { select: { conversationId: true } },
    },
  });
}

export async function createFolder(userId: string, name: string, icon?: string, color?: string) {
  const count = await prisma.chatFolder.count({ where: { userId } });
  if (count >= MAX_FOLDERS) {
    throw new BadRequestError(`Maximum ${MAX_FOLDERS} folders allowed`);
  }

  return prisma.chatFolder.create({
    data: {
      userId,
      name: name.trim(),
      icon: icon ?? null,
      color: color ?? null,
      position: count, // append at end
    },
    include: {
      members: { select: { conversationId: true } },
    },
  });
}

export async function updateFolder(
  userId: string,
  folderId: string,
  updates: { name?: string; icon?: string; color?: string },
) {
  const folder = await prisma.chatFolder.findUnique({ where: { id: folderId } });
  if (!folder) throw new NotFoundError('Folder not found');
  if (folder.userId !== userId) throw new ForbiddenError('Not your folder');

  return prisma.chatFolder.update({
    where: { id: folderId },
    data: {
      ...(updates.name !== undefined ? { name: updates.name.trim() } : {}),
      ...(updates.icon !== undefined ? { icon: updates.icon } : {}),
      ...(updates.color !== undefined ? { color: updates.color } : {}),
    },
    include: {
      members: { select: { conversationId: true } },
    },
  });
}

export async function deleteFolder(userId: string, folderId: string) {
  const folder = await prisma.chatFolder.findUnique({ where: { id: folderId } });
  if (!folder) throw new NotFoundError('Folder not found');
  if (folder.userId !== userId) throw new ForbiddenError('Not your folder');

  await prisma.chatFolder.delete({ where: { id: folderId } });
  return { deleted: true };
}

export async function reorderFolders(userId: string, folderIds: string[]) {
  // Verify all folders belong to the user
  const folders = await prisma.chatFolder.findMany({
    where: { userId },
    select: { id: true },
  });
  const ownedIds = new Set(folders.map((f) => f.id));
  for (const id of folderIds) {
    if (!ownedIds.has(id)) throw new ForbiddenError('Folder not found');
  }

  // Update positions in a transaction
  await prisma.$transaction(
    folderIds.map((id, index) =>
      prisma.chatFolder.update({
        where: { id },
        data: { position: index },
      }),
    ),
  );

  return { success: true };
}

export async function addConversationToFolder(
  userId: string,
  folderId: string,
  conversationId: string,
) {
  const folder = await prisma.chatFolder.findUnique({ where: { id: folderId } });
  if (!folder) throw new NotFoundError('Folder not found');
  if (folder.userId !== userId) throw new ForbiddenError('Not your folder');

  // Remove from any existing folder first (one folder per conversation)
  await prisma.chatFolderMember.deleteMany({
    where: { conversationId },
  });

  await prisma.chatFolderMember.create({
    data: { folderId, conversationId },
  });

  return { folderId, conversationId };
}

export async function removeConversationFromFolder(
  userId: string,
  conversationId: string,
) {
  // Verify the conversation is in a folder owned by this user
  const member = await prisma.chatFolderMember.findUnique({
    where: { conversationId },
    include: { folder: { select: { userId: true } } },
  });
  if (!member) throw new NotFoundError('Conversation not in any folder');
  if (member.folder.userId !== userId) throw new ForbiddenError('Not your folder');

  await prisma.chatFolderMember.delete({ where: { id: member.id } });
  return { removed: true };
}
