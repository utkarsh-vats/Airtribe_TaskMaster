import { Router } from 'express';
import { prisma } from '../../db/prisma';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  let db: 'ok' | 'down' = 'ok';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = 'down';
  }

  res.status(db === 'ok' ? 200 : 503).json({
    data: { status: db === 'ok' ? 'ok' : 'degraded', db },
  });
});
