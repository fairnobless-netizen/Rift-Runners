"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.campaignRouter = void 0;
const express_1 = require("express");
exports.campaignRouter = (0, express_1.Router)();
exports.campaignRouter.get('/campaign', (_req, res) => {
    res.status(200).json({ message: 'campaign stub' });
});
