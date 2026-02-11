import http from 'http';
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

const port = Number(process.env.PORT ?? 3001);
const server = http.createServer(app);

startWsGateway(server);

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on port ${port}`);
});
