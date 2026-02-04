/**
 * FCM Payload Builder
 *
 * Builds data-only FCM payloads for rich push notifications.
 * All values are stringified for FCM compatibility.
 */

export interface CallPayload {
  type: 'incoming_call';
  callId: string;
  conversationId: string;
  callType: 'AUDIO' | 'VIDEO';
  callerId: string;
  callerName: string;
  callerAvatar: string;
}

export interface VoiceNotePayload {
  type: 'voice_note';
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  audioUrl: string;
  audioDuration: string;
}

export interface ChatMessagePayload {
  type: 'chat_message';
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  content: string;
}

export type FcmDataPayload = CallPayload | VoiceNotePayload | ChatMessagePayload;

/**
 * Build FCM data payload for incoming call notifications.
 */
export function buildCallPayload(data: {
  callId: string;
  conversationId: string;
  callType: 'AUDIO' | 'VIDEO';
  callerId: string;
  callerName: string;
  callerAvatar?: string | null;
}): Record<string, string> {
  return {
    type: 'incoming_call',
    callId: data.callId,
    conversationId: data.conversationId,
    callType: data.callType,
    callerId: data.callerId,
    callerName: data.callerName,
    callerAvatar: data.callerAvatar ?? '',
  };
}

/**
 * Build FCM data payload for voice note notifications.
 */
export function buildVoiceNotePayload(data: {
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatar?: string | null;
  audioUrl: string;
  audioDuration: number;
}): Record<string, string> {
  return {
    type: 'voice_note',
    messageId: data.messageId,
    conversationId: data.conversationId,
    senderId: data.senderId,
    senderName: data.senderName,
    senderAvatar: data.senderAvatar ?? '',
    audioUrl: data.audioUrl,
    audioDuration: String(data.audioDuration),
  };
}

/**
 * Build FCM data payload for chat message notifications.
 */
export function buildMessagePayload(data: {
  messageId?: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatar?: string | null;
  content: string;
  imageUrl?: string | null;
}): Record<string, string> {
  const payload: Record<string, string> = {
    type: 'chat_message',
    messageId: data.messageId ?? '',
    conversationId: data.conversationId,
    senderId: data.senderId,
    senderName: data.senderName,
    senderAvatar: data.senderAvatar ?? '',
    content: data.content,
  };

  if (data.imageUrl) {
    payload.imageUrl = data.imageUrl;
  }

  return payload;
}
