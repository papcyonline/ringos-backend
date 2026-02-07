import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z, ZodError } from 'zod';
import { validate } from '../validate';

// ── Helper to build mock req/res/next ────────────────────────────────

function mockReqResNext(overrides: { body?: any; query?: any; params?: any } = {}) {
  const req: any = {
    body: overrides.body ?? {},
    query: overrides.query ?? {},
    params: overrides.params ?? {},
  };
  const res: any = {};
  const next = vi.fn();
  return { req, res, next };
}

describe('validate middleware', () => {
  // ── body (default source) ─────────────────────────────────────────

  describe('body validation (default)', () => {
    const schema = z.object({
      email: z.string().email(),
      age: z.coerce.number().min(0),
    });

    it('should call next() on valid body', () => {
      const { req, res, next } = mockReqResNext({ body: { email: 'a@b.com', age: '25' } });
      validate(schema)(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('should transform req.body with parsed values', () => {
      const { req, res, next } = mockReqResNext({ body: { email: 'a@b.com', age: '25' } });
      validate(schema)(req, res, next);
      expect(req.body.age).toBe(25); // coerced from string to number
      expect(req.body.email).toBe('a@b.com');
    });

    it('should call next(error) on invalid body', () => {
      const { req, res, next } = mockReqResNext({ body: { email: 'not-email', age: -5 } });
      validate(schema)(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err).toBeInstanceOf(ZodError);
    });

    it('should call next(error) when required fields are missing', () => {
      const { req, res, next } = mockReqResNext({ body: {} });
      validate(schema)(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0]).toBeInstanceOf(ZodError);
    });
  });

  // ── query source ──────────────────────────────────────────────────

  describe('query validation', () => {
    const schema = z.object({
      page: z.coerce.number().min(1),
    });

    it('should validate and transform req.query', () => {
      const { req, res, next } = mockReqResNext({ query: { page: '3' } });
      validate(schema, 'query')(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(req.query.page).toBe(3);
    });

    it('should call next(error) on invalid query', () => {
      const { req, res, next } = mockReqResNext({ query: { page: '0' } });
      validate(schema, 'query')(req, res, next);
      expect(next.mock.calls[0][0]).toBeInstanceOf(ZodError);
    });
  });

  // ── params source ─────────────────────────────────────────────────

  describe('params validation', () => {
    const schema = z.object({
      id: z.string().uuid(),
    });

    it('should validate and transform req.params', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const { req, res, next } = mockReqResNext({ params: { id: uuid } });
      validate(schema, 'params')(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(req.params.id).toBe(uuid);
    });

    it('should call next(error) on invalid params', () => {
      const { req, res, next } = mockReqResNext({ params: { id: 'not-a-uuid' } });
      validate(schema, 'params')(req, res, next);
      expect(next.mock.calls[0][0]).toBeInstanceOf(ZodError);
    });
  });
});
