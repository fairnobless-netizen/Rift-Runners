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
import { leaderboardRouter } from './api/leaderboard.routes';
import { roomsRouter } from './api/rooms.routes';
import { friendsRouter } from './api/friends.routes';
import { usersRouter } from './api/users.routes';
import { referralsRouter } from './api/referrals.routes';
import { runMigrationsFromSchemaSql } from './db/migrate';
import { startWsGateway } from './ws/gateway';

const app = express();

const rawPort = Number(process.env.PORT ?? 4101);
const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.floor(rawPort) : 4101;
const frontendDistDir = process.env.FRONTEND_DIST_DIR ?? '../dist';
const backendRootPath = path.resolve(__dirname, '..');
const frontendDistPath = path.resolve(backendRootPath, frontendDistDir);
const frontendIndexPath = path.join(frontendDistPath, 'index.html');
const corsOrigin = process.env.CORS_ORIGIN;

if (corsOrigin) {
  app.use(cors({ origin: corsOrigin }));
} else {
  app.use(cors());
}
app.use(express.json());

// public
app.use(healthRouter);

// api
app.use('/api', authRouter);
app.use('/api', campaignRouter);
app.use('/api', profileRouter);
app.use('/api', walletRouter);
app.use('/api', shopRouter);
app.use('/api/leaderboard', leaderboardRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/friends', friendsRouter);
app.use('/api', usersRouter);
app.use('/api', referralsRouter);

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

async function main(): Promise<void> {
  await runMigrationsFromSchemaSql();

  const server = http.createServer(app);
  const wsServer = startWsGateway(server);

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log('Boot summary', {
      port,
      distDir: frontendDistPath,
      nodeEnv: process.env.NODE_ENV ?? 'development',
      wsEnabled: wsServer ? 'yes' : 'no',
    });
    // eslint-disable-next-line no-console
    console.log('[boot] TG_BOT_TOKEN present:', Boolean(process.env.TG_BOT_TOKEN), 'length:', (process.env.TG_BOT_TOKEN ?? '').length);
  });
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal server startup error', error);
  process.exit(1);
});
