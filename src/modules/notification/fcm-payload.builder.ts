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
  isGroup: string;
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
  // Group context — 'true'/'false'. When 'true', clients render the group
  // name as the title and "senderName: message" as the body.
  isGroup?: string;
  groupName?: string;
  groupAvatar?: string;
  // Conversation type (e.g. 'WIDGET') so clients can tag website-visitor chats.
  conversationType?: string;
}

export interface ChatMessagePayload {
  type: 'chat_message';
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  content: string;
  // Group context — see VoiceNotePayload.
  isGroup?: string;
  groupName?: string;
  groupAvatar?: string;
  // Conversation type (e.g. 'WIDGET') so clients can tag website-visitor chats.
  conversationType?: string;
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
  isGroup?: boolean;
}): Record<string, string> {
  return {
    type: 'incoming_call',
    callId: data.callId,
    conversationId: data.conversationId,
    callType: data.callType,
    callerId: data.callerId,
    callerName: data.callerName,
    callerAvatar: data.callerAvatar ?? '',
    isGroup: String(data.isGroup ?? false),
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
  isVerified?: boolean;
  audioUrl: string;
  audioDuration: number;
  isGroup?: boolean;
  groupName?: string | null;
  groupAvatar?: string | null;
  conversationType?: string;
}): Record<string, string> {
  const payload: Record<string, string> = {
    type: 'voice_note',
    messageId: data.messageId,
    conversationId: data.conversationId,
    senderId: data.senderId,
    senderName: data.senderName,
    senderAvatar: data.senderAvatar ?? '',
    isVerified: String(data.isVerified ?? false),
    audioUrl: data.audioUrl,
    audioDuration: String(data.audioDuration),
  };
  applyGroupFields(payload, data);
  if (data.conversationType) {
    payload.conversationType = data.conversationType;
  }
  return payload;
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
  isVerified?: boolean;
  content: string;
  imageUrl?: string | null;
  isGroup?: boolean;
  groupName?: string | null;
  groupAvatar?: string | null;
  conversationType?: string;
}): Record<string, string> {
  const payload: Record<string, string> = {
    type: 'chat_message',
    messageId: data.messageId ?? '',
    conversationId: data.conversationId,
    senderId: data.senderId,
    senderName: data.senderName,
    senderAvatar: data.senderAvatar ?? '',
    isVerified: String(data.isVerified ?? false),
    content: data.content,
  };

  if (data.imageUrl) {
    payload.imageUrl = data.imageUrl;
  }

  applyGroupFields(payload, data);
  if (data.conversationType) {
    payload.conversationType = data.conversationType;
  }
  return payload;
}

/**
 * Stamp group context onto a chat/voice-note payload. isGroup is always
 * present ('true'/'false') so clients can branch; name/avatar only when set.
 */
function applyGroupFields(
  payload: Record<string, string>,
  data: { isGroup?: boolean; groupName?: string | null; groupAvatar?: string | null },
): void {
  payload.isGroup = String(data.isGroup ?? false);
  if (data.isGroup) {
    if (data.groupName) payload.groupName = data.groupName;
    if (data.groupAvatar) payload.groupAvatar = data.groupAvatar;
  }
}
