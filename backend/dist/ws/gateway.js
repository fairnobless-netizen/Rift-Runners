"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startWsGateway = void 0;
const ws_1 = require("ws");
const startWsGateway = (server) => {
    const wss = new ws_1.WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (socket) => {
        socket.send(JSON.stringify({ type: 'connected' }));
    });
    return wss;
};
exports.startWsGateway = startWsGateway;
