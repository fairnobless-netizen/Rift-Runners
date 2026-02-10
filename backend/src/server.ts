import http from 'http';
import cors from 'cors';
import express from 'express';

import { campaignRouter } from './api/campaign.routes';
import { healthRouter } from './api/health.routes';
import { startWsGateway } from './ws/gateway';

const app = express();

app.use(cors());
app.use(express.json());

app.use(healthRouter);
app.use('/api', campaignRouter);

const port = Number(process.env.PORT ?? 3001);
const server = http.createServer(app);

startWsGateway(server);

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on port ${port}`);
});
