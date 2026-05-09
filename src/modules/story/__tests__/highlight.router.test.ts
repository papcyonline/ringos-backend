import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockHighlight } = vi.hoisted(() => ({
  mockHighlight: {
    listHighlights: vi.fn().mockResolvedValue([]),
    createHighlight: vi.fn().mockResolvedValue({ id: 'h-1' }),
    addSlidesToHighlight: vi.fn().mockResolvedValue({ added: 2 }),
    updateHighlight: vi.fn().mockResolvedValue({}),
    deleteHighlight: vi.fn().mockResolvedValue({}),
    removeHighlightSlide: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../../config/database', () => ({ prisma: {} }));
vi.mock('../../../config/env', () => ({ env: {} }));
vi.mock('../../../shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1' };
    next();
  },
}));
vi.mock('../highlight.service', () => mockHighlight);

import { highlightRouter } from '../highlight.router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/highlights', highlightRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('highlight.router', () => {
  it('GET /highlights/user/:userId', async () => {
    const res = await request(makeApp()).get('/highlights/user/u-2');
    expect(res.status).toBe(200);
    expect(res.body.highlights).toEqual([]);
  });

  it('GET /highlights/user/:userId returns 500 on service error', async () => {
    mockHighlight.listHighlights.mockRejectedValueOnce(new Error('boom'));
    const res = await request(makeApp()).get('/highlights/user/u-2');
    expect(res.status).toBe(500);
  });

  it('POST /highlights creates', async () => {
    const res = await request(makeApp())
      .post('/highlights')
      .send({ title: 'My', slideIds: ['s-1'] });
    expect(res.status).toBe(201);
  });

  it('POST /highlights surfaces 400 from service', async () => {
    const e: any = new Error('Title required');
    e.statusCode = 400;
    mockHighlight.createHighlight.mockRejectedValueOnce(e);
    const res = await request(makeApp())
      .post('/highlights')
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST /highlights/:id/slides 400 when no slideIds', async () => {
    const res = await request(makeApp())
      .post('/highlights/h-1/slides')
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST /highlights/:id/slides adds', async () => {
    const res = await request(makeApp())
      .post('/highlights/h-1/slides')
      .send({ slideIds: ['s-1', 's-2'] });
    expect(res.status).toBe(200);
  });

  it('PATCH /highlights/:id updates', async () => {
    const res = await request(makeApp())
      .patch('/highlights/h-1')
      .send({ title: 'New' });
    expect(res.status).toBe(200);
  });

  it('PATCH /highlights/:id surfaces 403', async () => {
    const e: any = new Error('Not your highlight');
    e.statusCode = 403;
    mockHighlight.updateHighlight.mockRejectedValueOnce(e);
    const res = await request(makeApp())
      .patch('/highlights/h-1')
      .send({ title: 'X' });
    expect(res.status).toBe(403);
  });

  it('DELETE /highlights/:id', async () => {
    const res = await request(makeApp()).delete('/highlights/h-1');
    expect(res.status).toBe(200);
  });

  it('DELETE /highlights/:id surfaces 404', async () => {
    const e: any = new Error('Not found');
    e.statusCode = 404;
    mockHighlight.deleteHighlight.mockRejectedValueOnce(e);
    const res = await request(makeApp()).delete('/highlights/h-1');
    expect(res.status).toBe(404);
  });

  it('DELETE /highlights/:id/slides/:slideId', async () => {
    const res = await request(makeApp()).delete('/highlights/h-1/slides/s-1');
    expect(res.status).toBe(200);
  });

  it('POST /highlights surfaces 500 on generic error', async () => {
    mockHighlight.createHighlight.mockRejectedValueOnce(new Error('db'));
    const res = await request(makeApp()).post('/highlights').send({ title: 'X' });
    expect(res.status).toBe(500);
  });

  it('POST /highlights/:id/slides surfaces 400', async () => {
    const e: any = new Error('Bad');
    e.statusCode = 400;
    mockHighlight.addSlidesToHighlight.mockRejectedValueOnce(e);
    const res = await request(makeApp())
      .post('/highlights/h-1/slides')
      .send({ slideIds: ['s-1'] });
    expect(res.status).toBe(400);
  });

  it('POST /highlights/:id/slides surfaces 403', async () => {
    const e: any = new Error('Forbidden');
    e.statusCode = 403;
    mockHighlight.addSlidesToHighlight.mockRejectedValueOnce(e);
    const res = await request(makeApp())
      .post('/highlights/h-1/slides')
      .send({ slideIds: ['s-1'] });
    expect(res.status).toBe(403);
  });

  it('POST /highlights/:id/slides surfaces 404', async () => {
    const e: any = new Error('Not found');
    e.statusCode = 404;
    mockHighlight.addSlidesToHighlight.mockRejectedValueOnce(e);
    const res = await request(makeApp())
      .post('/highlights/h-1/slides')
      .send({ slideIds: ['s-1'] });
    expect(res.status).toBe(404);
  });

  it('POST /highlights/:id/slides surfaces 500', async () => {
    mockHighlight.addSlidesToHighlight.mockRejectedValueOnce(new Error('boom'));
    const res = await request(makeApp())
      .post('/highlights/h-1/slides')
      .send({ slideIds: ['s-1'] });
    expect(res.status).toBe(500);
  });

  it('PATCH /highlights/:id surfaces 400', async () => {
    const e: any = new Error('Bad');
    e.statusCode = 400;
    mockHighlight.updateHighlight.mockRejectedValueOnce(e);
    const res = await request(makeApp()).patch('/highlights/h-1').send({ title: 'x' });
    expect(res.status).toBe(400);
  });

  it('PATCH /highlights/:id surfaces 404', async () => {
    const e: any = new Error('Not found');
    e.statusCode = 404;
    mockHighlight.updateHighlight.mockRejectedValueOnce(e);
    const res = await request(makeApp()).patch('/highlights/h-1').send({ title: 'x' });
    expect(res.status).toBe(404);
  });

  it('PATCH /highlights/:id surfaces 500', async () => {
    mockHighlight.updateHighlight.mockRejectedValueOnce(new Error('boom'));
    const res = await request(makeApp()).patch('/highlights/h-1').send({ title: 'x' });
    expect(res.status).toBe(500);
  });

  it('DELETE /highlights/:id surfaces 403', async () => {
    const e: any = new Error('Forbidden');
    e.statusCode = 403;
    mockHighlight.deleteHighlight.mockRejectedValueOnce(e);
    const res = await request(makeApp()).delete('/highlights/h-1');
    expect(res.status).toBe(403);
  });

  it('DELETE /highlights/:id surfaces 500', async () => {
    mockHighlight.deleteHighlight.mockRejectedValueOnce(new Error('boom'));
    const res = await request(makeApp()).delete('/highlights/h-1');
    expect(res.status).toBe(500);
  });

  it('DELETE /highlights/:id/slides/:slideId surfaces 403', async () => {
    const e: any = new Error('Forbidden');
    e.statusCode = 403;
    mockHighlight.removeHighlightSlide.mockRejectedValueOnce(e);
    const res = await request(makeApp()).delete('/highlights/h-1/slides/s-1');
    expect(res.status).toBe(403);
  });

  it('DELETE /highlights/:id/slides/:slideId surfaces 404', async () => {
    const e: any = new Error('Not found');
    e.statusCode = 404;
    mockHighlight.removeHighlightSlide.mockRejectedValueOnce(e);
    const res = await request(makeApp()).delete('/highlights/h-1/slides/s-1');
    expect(res.status).toBe(404);
  });

  it('DELETE /highlights/:id/slides/:slideId surfaces 500', async () => {
    mockHighlight.removeHighlightSlide.mockRejectedValueOnce(new Error('boom'));
    const res = await request(makeApp()).delete('/highlights/h-1/slides/s-1');
    expect(res.status).toBe(500);
  });
});
