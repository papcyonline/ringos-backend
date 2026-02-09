import OpenAI from 'openai';
import { listUsers } from '../../user/user.service';
import { getConversations } from '../../chat/chat.service';
import { getNotifications } from '../../notification/notification.service';

// ─── Tool Schemas (OpenAI function-calling format) ──────────────────

export const koraToolSchemas: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'find_people',
      description:
        'Find people the user can talk to on Yomeet. Use when the user wants someone to talk to, wants company, or asks who is online.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max number of people to return (default 5)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_unread_messages',
      description:
        'Check the user\'s unread messages and conversations. Use when the user asks about messages, who wrote them, or wants to check their inbox.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_notifications',
      description:
        'Get the user\'s unread notifications. Use when the user asks about notifications, what they missed, or who liked/followed them.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_matching',
      description:
        'Navigate the user to the matching screen to find someone to connect with. Use when the user explicitly wants to be matched with someone.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

// ─── Tool Result Type ───────────────────────────────────────────────

export interface ToolResult {
  /** Text fed back to the LLM so it can write a conversational response. */
  llmContext: string;
  /** Structured data sent to the frontend as an SSE action event. */
  action: {
    actionType: string;
    data: unknown;
  };
}

// ─── Executors ──────────────────────────────────────────────────────

async function execFindPeople(
  args: { limit?: number },
  userId: string,
): Promise<ToolResult> {
  const limit = args.limit ?? 5;
  const allUsers = await listUsers(userId);

  // Prefer online users, then recently seen
  const people = allUsers.slice(0, limit).map((u) => ({
    id: u.id,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    bio: u.bio,
    profession: u.profession,
    isOnline: u.isOnline,
    status: u.status,
  }));

  const onlineCount = people.filter((p) => p.isOnline).length;
  const names = people.map((p) => p.displayName).join(', ');

  return {
    llmContext:
      `Found ${people.length} people (${onlineCount} currently online): ${names}. ` +
      `Present these warmly to the user and encourage them to connect.`,
    action: {
      actionType: 'user_suggestions',
      data: people,
    },
  };
}

async function execGetUnreadMessages(userId: string): Promise<ToolResult> {
  const conversations = await getConversations(userId);

  const unread = conversations
    .filter((c) => c.unreadCount > 0)
    .map((c) => {
      const other = c.participants.find((p) => p.userId !== userId);
      return {
        conversationId: c.id,
        displayName: other?.user?.displayName ?? 'Someone',
        avatarUrl: other?.user?.avatarUrl ?? null,
        isOnline: other?.user?.isOnline ?? false,
        unreadCount: c.unreadCount,
        lastMessage: c.lastMessage?.content ?? '',
      };
    });

  if (unread.length === 0) {
    return {
      llmContext: 'The user has no unread messages right now.',
      action: { actionType: 'unread_messages', data: [] },
    };
  }

  const summary = unread
    .map((u) => `${u.displayName} (${u.unreadCount} unread)`)
    .join(', ');

  return {
    llmContext:
      `The user has ${unread.length} conversation(s) with unread messages: ${summary}. ` +
      `Mention who wrote and how many unread messages warmly.`,
    action: {
      actionType: 'unread_messages',
      data: unread,
    },
  };
}

async function execGetNotifications(userId: string): Promise<ToolResult> {
  const all = await getNotifications(userId);
  const unread = all.filter((n) => !n.isRead).slice(0, 10);

  if (unread.length === 0) {
    return {
      llmContext: 'The user has no unread notifications right now.',
      action: { actionType: 'notifications', data: [] },
    };
  }

  const summary = unread.map((n) => `${n.type}: "${n.body}"`).join('; ');

  return {
    llmContext:
      `The user has ${unread.length} unread notification(s): ${summary}. ` +
      `Summarize them conversationally.`,
    action: {
      actionType: 'notifications',
      data: unread.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        imageUrl: n.imageUrl,
        data: n.data,
        createdAt: n.createdAt,
      })),
    },
  };
}

function execStartMatching(): ToolResult {
  return {
    llmContext:
      'Opening the matching screen so the user can find someone to connect with. ' +
      'Let them know you\'re taking them there and wish them well.',
    action: {
      actionType: 'navigate',
      data: { route: '/matching' },
    },
  };
}

// ─── Dispatcher ─────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  userId: string,
): Promise<ToolResult> {
  switch (name) {
    case 'find_people':
      return execFindPeople(args as { limit?: number }, userId);
    case 'get_unread_messages':
      return execGetUnreadMessages(userId);
    case 'get_notifications':
      return execGetNotifications(userId);
    case 'start_matching':
      return execStartMatching();
    default:
      return {
        llmContext: `Unknown tool "${name}". Just respond normally.`,
        action: { actionType: 'unknown', data: null },
      };
  }
}
