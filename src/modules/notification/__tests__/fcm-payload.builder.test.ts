import { describe, it, expect } from 'vitest';
import {
  buildCallPayload,
  buildVoiceNotePayload,
  buildMessagePayload,
} from '../fcm-payload.builder';

// Every field in an FCM data payload must be a string — firebase-admin
// rejects MulticastMessage.data entries that are anything else (Buffer,
// number, null, bool). These tests prove each builder's output is safe
// to pass straight to admin.messaging().sendEachForMulticast().

describe('fcm-payload.builder', () => {
  describe('buildCallPayload', () => {
    it('stringifies every field and defaults isGroup/callerAvatar', () => {
      const payload = buildCallPayload({
        callId: 'call-123',
        conversationId: 'conv-1',
        callType: 'VIDEO',
        callerId: 'user-1',
        callerName: 'Alice',
      });

      expect(payload).toEqual({
        type: 'incoming_call',
        callId: 'call-123',
        conversationId: 'conv-1',
        callType: 'VIDEO',
        callerId: 'user-1',
        callerName: 'Alice',
        callerAvatar: '',
        isGroup: 'false',
      });
      // All values must be strings — FCM data payloads only accept strings.
      for (const v of Object.values(payload)) {
        expect(typeof v).toBe('string');
      }
    });

    it('coerces isGroup=true to the string "true"', () => {
      const payload = buildCallPayload({
        callId: 'c',
        conversationId: 'c',
        callType: 'AUDIO',
        callerId: 'u',
        callerName: 'n',
        isGroup: true,
      });
      expect(payload.isGroup).toBe('true');
    });

    it('preserves callerAvatar when provided', () => {
      const payload = buildCallPayload({
        callId: 'c',
        conversationId: 'c',
        callType: 'AUDIO',
        callerId: 'u',
        callerName: 'n',
        callerAvatar: 'https://cdn.example.com/a.jpg',
      });
      expect(payload.callerAvatar).toBe('https://cdn.example.com/a.jpg');
    });
  });

  describe('buildVoiceNotePayload', () => {
    it('stringifies audioDuration and defaults senderAvatar', () => {
      const payload = buildVoiceNotePayload({
        messageId: 'm-1',
        conversationId: 'c-1',
        senderId: 'u-1',
        senderName: 'Bob',
        audioUrl: 'https://cdn.example.com/v.m4a',
        audioDuration: 7,
      });

      expect(payload).toEqual({
        type: 'voice_note',
        messageId: 'm-1',
        conversationId: 'c-1',
        senderId: 'u-1',
        senderName: 'Bob',
        senderAvatar: '',
        audioUrl: 'https://cdn.example.com/v.m4a',
        audioDuration: '7',
      });
      for (const v of Object.values(payload)) {
        expect(typeof v).toBe('string');
      }
    });
  });

  describe('buildMessagePayload', () => {
    it('omits imageUrl key entirely when not provided', () => {
      const payload = buildMessagePayload({
        conversationId: 'c',
        senderId: 'u',
        senderName: 'n',
        content: 'hello',
      });
      expect(payload.imageUrl).toBeUndefined();
      expect('imageUrl' in payload).toBe(false);
    });

    it('includes imageUrl when provided', () => {
      const payload = buildMessagePayload({
        conversationId: 'c',
        senderId: 'u',
        senderName: 'n',
        content: '',
        imageUrl: 'https://cdn.example.com/p.jpg',
      });
      expect(payload.imageUrl).toBe('https://cdn.example.com/p.jpg');
    });

    it('defaults messageId and senderAvatar to empty strings', () => {
      const payload = buildMessagePayload({
        conversationId: 'c',
        senderId: 'u',
        senderName: 'n',
        content: 'hi',
      });
      expect(payload.messageId).toBe('');
      expect(payload.senderAvatar).toBe('');
    });

    it('marks every payload with the correct type for client routing', () => {
      expect(buildMessagePayload({
        conversationId: 'c', senderId: 'u', senderName: 'n', content: '',
      }).type).toBe('chat_message');

      expect(buildVoiceNotePayload({
        messageId: '', conversationId: 'c', senderId: 'u', senderName: 'n',
        audioUrl: 'x', audioDuration: 0,
      }).type).toBe('voice_note');

      expect(buildCallPayload({
        callId: 'c', conversationId: 'c', callType: 'AUDIO',
        callerId: 'u', callerName: 'n',
      }).type).toBe('incoming_call');
    });
  });
});
