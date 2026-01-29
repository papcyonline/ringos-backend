import { Request } from 'express';

export interface AuthPayload {
  userId: string;
  isAnonymous: boolean;
}

export interface AuthRequest extends Request {
  user?: AuthPayload;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface AiCompletionResult {
  reply: string;
  mood: string;
  shouldSuggestHandoff: boolean;
  handoffReason?: string;
}
