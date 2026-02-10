import { Router } from 'express';

export const campaignRouter = Router();

campaignRouter.get('/campaign', (_req, res) => {
  res.status(200).json({ message: 'campaign stub' });
});
