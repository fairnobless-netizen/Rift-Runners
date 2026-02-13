import http from 'http';
import path from 'path';
import cors from 'cors';
import express from 'express';

import { healthRouter } from './api/health.routes';
import { campaignRouter } from './api/campaign.routes';
import { profileRouter } from './api/profile.routes';
import { authRouter } from './api/auth.routes';
import { walletRouter } from './api/wallet.routes';
import { shopRouter } from './api/shop.routes';
import { startWsGateway } from './ws/gateway';

const app = express();
const frontendDistPath = path.resolve(__dirname, '../../dist');
const frontendIndexPath = path.join(frontendDistPath, 'index.html');

app.use(cors());
app.use(express.json());

// public
app.use(healthRouter);

// api
app.use('/api', authRouter);
app.use('/api', campaignRouter);
app.use('/api', profileRouter);
app.use('/api', walletRouter);
app.use('/api', shopRouter);

// frontend static
app.use(express.static(frontendDistPath));

// SPA fallback (without hijacking API routes)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    next();
    return;
  }

  res.sendFile(frontendIndexPath);
});

const port = Number(process.env.PORT ?? 3001);
const server = http.createServer(app);

startWsGateway(server);

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on port ${port}`);
});
