const express = require('express');
const { router: callRouter } = require('./routes/call');
const voiceInputRouter = require('./routes/voice-input');

const app = express();
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '12mb' }));
app.use('/api/call', callRouter);
app.use('/api/voice-input', voiceInputRouter);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
    console.log(`ringdonut reference server listening on :${port}`);
});
