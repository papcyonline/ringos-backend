import { CompanionMode } from '@prisma/client';
import { prisma } from '../../config/database';
import { NotFoundError, BadRequestError } from '../../shared/errors';
import { promptMap } from './prompts';
import { generateAiResponse } from './llm.service';
import { transcribeAudio } from './stt.service';
import { extractMood } from './emotion.service';

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

  // Get the system prompt for this mode
  const systemPrompt = promptMap[session.mode];

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
