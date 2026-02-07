import { describe, it, expect } from 'vitest';
import {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  TooManyRequestsError,
} from '../errors';

describe('errors', () => {
  // ── AppError ───────────────────────────────────────────────────────

  describe('AppError', () => {
    it('should set statusCode and message', () => {
      const err = new AppError(500, 'Internal server error');
      expect(err.statusCode).toBe(500);
      expect(err.message).toBe('Internal server error');
    });

    it('should set optional code field', () => {
      const err = new AppError(500, 'fail', 'INTERNAL');
      expect(err.code).toBe('INTERNAL');
    });

    it('should be an instance of Error', () => {
      const err = new AppError(500, 'fail');
      expect(err).toBeInstanceOf(Error);
    });

    it('should have name "AppError"', () => {
      const err = new AppError(500, 'fail');
      expect(err.name).toBe('AppError');
    });
  });

  // ── BadRequestError ────────────────────────────────────────────────

  describe('BadRequestError', () => {
    it('should have statusCode 400', () => {
      const err = new BadRequestError();
      expect(err.statusCode).toBe(400);
    });

    it('should have default message "Bad request"', () => {
      const err = new BadRequestError();
      expect(err.message).toBe('Bad request');
    });

    it('should accept a custom message', () => {
      const err = new BadRequestError('Invalid input');
      expect(err.message).toBe('Invalid input');
    });

    it('should accept an optional code', () => {
      const err = new BadRequestError('fail', 'VALIDATION');
      expect(err.code).toBe('VALIDATION');
    });
  });

  // ── UnauthorizedError ──────────────────────────────────────────────

  describe('UnauthorizedError', () => {
    it('should have statusCode 401', () => {
      const err = new UnauthorizedError();
      expect(err.statusCode).toBe(401);
    });

    it('should have default message "Unauthorized"', () => {
      const err = new UnauthorizedError();
      expect(err.message).toBe('Unauthorized');
    });

    it('should have code "UNAUTHORIZED"', () => {
      const err = new UnauthorizedError();
      expect(err.code).toBe('UNAUTHORIZED');
    });

    it('should accept a custom message', () => {
      const err = new UnauthorizedError('Token expired');
      expect(err.message).toBe('Token expired');
    });
  });

  // ── ForbiddenError ─────────────────────────────────────────────────

  describe('ForbiddenError', () => {
    it('should have statusCode 403', () => {
      const err = new ForbiddenError();
      expect(err.statusCode).toBe(403);
    });

    it('should have default message "Forbidden"', () => {
      const err = new ForbiddenError();
      expect(err.message).toBe('Forbidden');
    });

    it('should have code "FORBIDDEN"', () => {
      const err = new ForbiddenError();
      expect(err.code).toBe('FORBIDDEN');
    });
  });

  // ── NotFoundError ──────────────────────────────────────────────────

  describe('NotFoundError', () => {
    it('should have statusCode 404', () => {
      const err = new NotFoundError();
      expect(err.statusCode).toBe(404);
    });

    it('should have default message "Not found"', () => {
      const err = new NotFoundError();
      expect(err.message).toBe('Not found');
    });

    it('should have code "NOT_FOUND"', () => {
      const err = new NotFoundError();
      expect(err.code).toBe('NOT_FOUND');
    });

    it('should accept a custom message', () => {
      const err = new NotFoundError('User not found');
      expect(err.message).toBe('User not found');
    });
  });

  // ── ConflictError ──────────────────────────────────────────────────

  describe('ConflictError', () => {
    it('should have statusCode 409', () => {
      const err = new ConflictError();
      expect(err.statusCode).toBe(409);
    });

    it('should have default message "Conflict"', () => {
      const err = new ConflictError();
      expect(err.message).toBe('Conflict');
    });

    it('should have code "CONFLICT"', () => {
      const err = new ConflictError();
      expect(err.code).toBe('CONFLICT');
    });
  });

  // ── TooManyRequestsError ───────────────────────────────────────────

  describe('TooManyRequestsError', () => {
    it('should have statusCode 429', () => {
      const err = new TooManyRequestsError();
      expect(err.statusCode).toBe(429);
    });

    it('should have default message "Too many requests"', () => {
      const err = new TooManyRequestsError();
      expect(err.message).toBe('Too many requests');
    });

    it('should have code "RATE_LIMITED"', () => {
      const err = new TooManyRequestsError();
      expect(err.code).toBe('RATE_LIMITED');
    });

    it('should accept a custom message', () => {
      const err = new TooManyRequestsError('Slow down');
      expect(err.message).toBe('Slow down');
    });
  });
});
