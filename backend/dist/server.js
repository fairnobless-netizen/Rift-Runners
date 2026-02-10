"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const cors_1 = __importDefault(require("cors"));
const express_1 = __importDefault(require("express"));
const campaign_routes_1 = require("./api/campaign.routes");
const health_routes_1 = require("./api/health.routes");
const gateway_1 = require("./ws/gateway");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use(health_routes_1.healthRouter);
app.use('/api', campaign_routes_1.campaignRouter);
const port = Number(process.env.PORT ?? 3001);
const server = http_1.default.createServer(app);
(0, gateway_1.startWsGateway)(server);
server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Backend listening on port ${port}`);
});
