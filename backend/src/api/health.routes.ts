import { Router } from 'express';

export const healthRouter = Router();

const getVersion = (): string => process.env.GIT_SHA || 'dev';

healthRouter.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

healthRouter.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, ts: new Date().toISOString(), version: getVersion() });
});
