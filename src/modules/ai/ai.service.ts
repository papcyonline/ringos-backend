import { CompanionMode } from '@prisma/client';
import { prisma } from '../../config/database';
import { NotFoundError, BadRequestError } from '../../shared/errors';
import { promptMap } from './prompts';
import { generateAiResponse, streamAiResponse, streamAiResponseWithAudio, classifyMood } from './llm.service';
import { ToolResult } from './tools/kora-tools';
import { transcribeAudio } from './stt.service';
import { extractMood } from './emotion.service';
import { logger } from '../../shared/logger';

/**
 * Fetch full user context for injecting into Kora's system prompt.
 * Single query with includes + counts to keep latency low.
 */
export async function getUserContext(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      displayName: true,
      bio: true,
      profession: true,
      gender: true,
      location: true,
      isVerified: true,
      preference: {
        select: {
          mood: true,
          language: true,
          topics: true,
        },
      },
      _count: {
        select: {
          followsReceived: true,
          followsInitiated: true,
          likesReceived: true,
          conversations: true,
        },
      },
    },
  });

  if (!user) return '';

  const unreadCount = await prisma.notification.count({
    where: { userId, isRead: false },
  });

  const lines: string[] = ['Here is what you know about this user:'];

  lines.push(`- Name: "${user.displayName}"`);
  if (user.bio) lines.push(`- Bio: "${user.bio}"`);
  if (user.profession) lines.push(`- Profession: ${user.profession}`);
  if (user.gender) lines.push(`- Gender: ${user.gender}`);
  if (user.location) lines.push(`- Location: ${user.location}`);
  if (user.isVerified) lines.push(`- Verified: Yes`);
  lines.push(`- Followers: ${user._count.followsReceived} | Following: ${user._count.followsInitiated}`);
  lines.push(`- Likes received: ${user._count.likesReceived}`);
  if (unreadCount > 0) lines.push(`- Unread notifications: ${unreadCount}`);
  lines.push(`- Conversations: ${user._count.conversations}`);
  if (user.preference?.mood) lines.push(`- Mood: ${user.preference.mood}`);
  if (user.preference?.language) lines.push(`- Language: ${user.preference.language}`);
  if (user.preference?.topics && user.preference.topics.length > 0) {
    lines.push(`- Topics they're interested in: ${user.preference.topics.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Build a personalised system prompt by appending user context to the base prompt.
 */
function _buildSystemPrompt(basePrompt: string, userContext: string): string {
  if (!userContext) return basePrompt;
  return `${basePrompt}\n\n${userContext}\n\nUse this information naturally in conversation when relevant — don't force it into every message, but use it the way a friend would.`;
}

export async function startSession(userId: string, mode: CompanionMode) {
  const session = await prisma.aiSession.create({
    data: {
      userId,
      mode,
    },
    include: {
      messages: true,
    },
  });

  return session;
}

export async function sendMessage(
  sessionId: string,
  userId: string,
  content: string,
) {
  const session = await prisma.aiSession.findUnique({
    where: { id: sessionId },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!session) {
    throw new NotFoundError('AI session not found');
  }

  if (session.userId !== userId) {
    throw new NotFoundError('AI session not found');
  }

  if (session.status === 'ENDED') {
    throw new BadRequestError('This session has ended');
  }

  // Save user message
  await prisma.aiMessage.create({
    data: {
      sessionId,
      role: 'USER',
      content,
    },
  });

  // Build message history for the LLM
  const history = session.messages.map((m) => ({
    role: m.role === 'USER' ? 'user' : 'assistant',
    content: m.content,
  }));

  // Add the new user message
  history.push({ role: 'user', content });

  // Get the system prompt for this mode and personalise with user context
  const userContext = await getUserContext(userId);
  const basePrompt = promptMap[session.mode];
  const systemPrompt = _buildSystemPrompt(basePrompt, userContext);

  // Generate AI response
  const aiResult = await generateAiResponse(history, systemPrompt);

  // Extract and validate mood
  const mood = extractMood(aiResult.mood);

  // Save AI response
  await prisma.aiMessage.create({
    data: {
      sessionId,
      role: 'ASSISTANT',
      content: aiResult.reply,
      mood,
    },
  });

  return {
    content: aiResult.reply,
    mood,
    should_handoff: aiResult.shouldSuggestHandoff,
    handoff_reason: aiResult.handoffReason,
  };
}

/**
 * Stream a message response via SSE. Calls `onToken` for each text chunk
 * and `onDone` with the final metadata when complete.
 */
export async function sendMessageStream(
  sessionId: string,
  userId: string,
  content: string,
  onToken: (token: string) => void,
  onDone: (meta: { mood: string; should_handoff: boolean; handoff_reason?: string }) => void,
  onAction?: (action: ToolResult['action']) => void,
) {
  // Fetch session and user context in parallel
  const [session, userContext] = await Promise.all([
    prisma.aiSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    }),
    getUserContext(userId),
  ]);

  if (!session) throw new NotFoundError('AI session not found');
  if (session.userId !== userId) throw new NotFoundError('AI session not found');
  if (session.status === 'ENDED') throw new BadRequestError('This session has ended');

  // Fire-and-forget: save user message (don't block LLM start)
  prisma.aiMessage.create({
    data: { sessionId, role: 'USER', content },
  }).catch((err) => logger.error({ err }, 'Failed to save user message'));

  // Build history
  const history = session.messages.map((m) => ({
    role: m.role === 'USER' ? 'user' : 'assistant',
    content: m.content,
  }));
  history.push({ role: 'user', content });

  // Personalise system prompt with user context
  const basePrompt = promptMap[session.mode];
  const systemPrompt = _buildSystemPrompt(basePrompt, userContext);

  // Stream the reply (with tool support)
  const fullReply = await streamAiResponse(history, systemPrompt, onToken, {
    userId,
    onAction,
  });

  // Save AI response and classify mood in background (don't block SSE)
  classifyMood(content, fullReply)
    .then(async (meta) => {
      const mood = extractMood(meta.mood);
      await prisma.aiMessage.create({
        data: { sessionId, role: 'ASSISTANT', content: fullReply, mood },
      });
      onDone({
        mood,
        should_handoff: meta.shouldSuggestHandoff,
        handoff_reason: meta.handoffReason,
      });
    })
    .catch((err) => {
      logger.error({ err }, 'Background mood classification failed');
      // Still save the message with neutral mood
      prisma.aiMessage.create({
        data: { sessionId, role: 'ASSISTANT', content: fullReply, mood: 'NEUTRAL' },
      }).catch((dbErr) => {
        logger.error({ dbErr, sessionId }, 'Failed to save AI message after mood classification failure');
      });
      onDone({ mood: 'NEUTRAL', should_handoff: false });
    });
}

export async function sendAudio(
  sessionId: string,
  userId: string,
  audioBuffer: Buffer,
  mimeType?: string,
) {
  // Transcribe audio to text
  const transcribedText = await transcribeAudio(audioBuffer, mimeType);

  if (!transcribedText.trim()) {
    throw new BadRequestError('Could not transcribe audio. Please try again.');
  }

  // Process as a regular text message
  const result = await sendMessage(sessionId, userId, transcribedText);
  return { ...result, transcription: transcribedText };
}

/**
 * Send audio directly to GPT-4o (no Whisper transcription) and stream the
 * AI response via SSE.  This eliminates ~1-2 s of STT latency, making
 * voice conversations feel real-time.
 */
export async function sendAudioStream(
  sessionId: string,
  userId: string,
  audioBuffer: Buffer,
  mimeType: string | undefined,
  onToken: (token: string) => void,
  onDone: (meta: { mood: string; should_handoff: boolean; handoff_reason?: string }) => void,
  onAction?: (action: ToolResult['action']) => void,
) {
  // Fetch session and user context in parallel (no STT wait!)
  const [session, userContext] = await Promise.all([
    prisma.aiSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    }),
    getUserContext(userId),
  ]);

  if (!session) throw new NotFoundError('AI session not found');
  if (session.userId !== userId) throw new NotFoundError('AI session not found');
  if (session.status === 'ENDED') throw new BadRequestError('This session has ended');

  // Convert audio to base64 for GPT-4o audio input
  const audioBase64 = audioBuffer.toString('base64');
  const audioFormat = mimeType?.includes('wav') ? 'wav'
    : mimeType?.includes('mp3') ? 'mp3'
    : mimeType?.includes('opus') ? 'opus'
    : 'wav';

  // Fire-and-forget: save user message placeholder
  prisma.aiMessage.create({
    data: { sessionId, role: 'USER', content: '[Voice message]' },
  }).catch((err) => logger.error({ err }, 'Failed to save user voice message'));

  // Build history from previous messages (current message goes as audio)
  const history = session.messages.map((m) => ({
    role: m.role === 'USER' ? 'user' : 'assistant',
    content: m.content,
  }));

  // Personalise system prompt
  const basePrompt = promptMap[session.mode];
  const systemPrompt = _buildSystemPrompt(basePrompt, userContext);

  // Stream the reply — audio goes directly to GPT-4o, no transcription step
  const fullReply = await streamAiResponseWithAudio(
    history,
    systemPrompt,
    audioBase64,
    audioFormat,
    onToken,
    { userId, onAction },
  );

  // Save AI response and classify mood in background
  classifyMood('[Voice message]', fullReply)
    .then(async (meta) => {
      const mood = extractMood(meta.mood);
      await prisma.aiMessage.create({
        data: { sessionId, role: 'ASSISTANT', content: fullReply, mood },
      });
      onDone({
        mood,
        should_handoff: meta.shouldSuggestHandoff,
        handoff_reason: meta.handoffReason,
      });
    })
    .catch((err) => {
      logger.error({ err }, 'Background mood classification failed');
      prisma.aiMessage.create({
        data: { sessionId, role: 'ASSISTANT', content: fullReply, mood: 'NEUTRAL' },
      }).catch((dbErr) => {
        logger.error({ dbErr, sessionId }, 'Failed to save AI message');
      });
      onDone({ mood: 'NEUTRAL', should_handoff: false });
    });
}

export async function endSession(sessionId: string, userId: string) {
  const session = await prisma.aiSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) {
    throw new NotFoundError('AI session not found');
  }

  if (session.userId !== userId) {
    throw new NotFoundError('AI session not found');
  }

  if (session.status === 'ENDED') {
    throw new BadRequestError('This session has already ended');
  }

  await prisma.aiSession.update({
    where: { id: sessionId },
    data: { status: 'ENDED' },
  });
}

export async function getSession(sessionId: string, userId: string) {
  const session = await prisma.aiSession.findUnique({
    where: { id: sessionId },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          role: true,
          content: true,
          mood: true,
          createdAt: true,
        },
      },
    },
  });

  if (!session) {
    throw new NotFoundError('AI session not found');
  }

  if (session.userId !== userId) {
    throw new NotFoundError('AI session not found');
  }

  return session;
}

export async function getSessions(userId: string) {
  const sessions = await prisma.aiSession.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      mode: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: { messages: true },
      },
    },
  });

  return sessions;
}
