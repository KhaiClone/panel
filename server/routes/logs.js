const express = require('express');
const router = express.Router();
const db = require('../db');
const { getBotLogs, streamBotLogs } = require('../services/pm2Service');

/**
 * GET /api/logs/:botId?lines=100
 *
 * Snapshot of the last N lines of PM2 logs for a bot.
 * Used for initial log load.
 */
router.get('/:botId', async (req, res, next) => {
  try {
    const bot = await db.findOne('bots', { _id: req.params.botId });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const lines = Math.min(parseInt(req.query.lines) || 100, 500);
    const logs = await getBotLogs(bot.pm2Name, lines);

    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/logs/:botId/stream
 *
 * Server-Sent Events (SSE) endpoint for live log streaming.
 * The React client uses EventSource to connect and receive log lines in real time.
 *
 * The client should include the token as a query param:
 *   /api/logs/:botId/stream?token=<jwt>
 * (SSE doesn't support custom headers natively in browsers)
 */
router.get('/:botId/stream', async (req, res, next) => {
  try {
    // Auth via query param (EventSource cannot set Authorization header)
    const jwt = require('jsonwebtoken');
    const token = req.query.token;
    if (!token) return res.status(401).end();
    try {
      jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).end();
    }

    const bot = await db.findOne('bots', { _id: req.params.botId });
    if (!bot) return res.status(404).end();

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if behind proxy
    res.flushHeaders();

    // Send a keep-alive comment every 15s to prevent connection timeout
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);

    // Spawn pm2 logs process
    const proc = streamBotLogs(bot.pm2Name, 50);

    // Helper: format and send a chunk as SSE data events
    const sendData = (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) res.write(`data: ${line}\n\n`);
      }
    };

    proc.stdout.on('data', sendData);
    proc.stderr.on('data', sendData);

    // Clean up when client disconnects
    req.on('close', () => {
      clearInterval(keepAlive);
      proc.kill('SIGTERM');
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;
