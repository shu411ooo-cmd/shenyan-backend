const express = require('express');
const { router: callRouter } = require('./routes/call');
const voiceInputRouter = require('./routes/voice-input');

const app = express();
app.set('trust proxy', 1); // 信任前端代理（Zeabur），使 req.ip 返回真实客户端 IP
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '12mb' }));
app.use('/api/call', callRouter);
app.use('/api/voice-input', voiceInputRouter);

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
    console.log(`ringdonut reference server listening on :${port}`);
});
server.on('error', (err) => {
    console.error('ringdonut server failed to start:', err.message);
    process.exit(1);
});
