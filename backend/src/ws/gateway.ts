import type { Server as HttpServer } from 'http';
import { WebSocketServer } from 'ws';

import { registerWsHandlers } from './wsServer';

export const startWsGateway = (server: HttpServer): WebSocketServer => {
  const wss = new WebSocketServer({ server, path: '/ws' });

  registerWsHandlers(wss);

  return wss;
};
