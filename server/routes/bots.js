const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const db = require('../db');
const pm2Service = require('../services/pm2Service');
const gitService = require('../services/gitService');

// Root directory where all buyer bot folders live (e.g. /root/bots)
const BOTS_ROOT = () => process.env.BOTS_ROOT_DIR;

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve absolute path of a bot's directory */
const botDir = (buyerID, botID) => path.join(BOTS_ROOT(), buyerID, botID);

// ─────────────────────────────────────────────────────────────────────────────
//  List & Read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/bots
 * Returns all bots enriched with live PM2 status.
 */
router.get('/', async (req, res, next) => {
  try {
    const bots = await db.find('bots');

    // Fetch live PM2 status for each bot in parallel
    const enriched = await Promise.all(
      bots.map(async (bot) => {
        const live = await pm2Service.getBotStatus(bot.pm2Name);
        return { ...bot, live };
      })
    );

    res.json(enriched);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/bots/:id
 * Returns a single bot by _id with live status.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const bot = await db.findOne('bots', { _id: req.params.id });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const live = await pm2Service.getBotStatus(bot.pm2Name);
    res.json({ ...bot, live });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Create Bot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/bots
 * Clone a git repo, install deps, and register the bot in the DB.
 *
 * Body: {
 *   buyerID     string  — Discord user ID of the buyer
 *   botID       string  — Short unique slug for the bot (e.g. "mybot")
 *   name        string  — Display name
 *   repoUrl     string  — Git repository URL
 *   branch      string  — Git branch (default: "main")
 *   startScript string  — Entry file (default: "index.js")
 *   expiresAt   string  — ISO date string or ms timestamp (optional)
 * }
 */
router.post('/', async (req, res, next) => {
  try {
    const {
      buyerID,
      botID,
      name,
      repoUrl,
      branch = 'main',
      startScript = 'index.js',
      expiresAt,
    } = req.body;

    // Validate required fields
    if (!buyerID || !botID || !name || !repoUrl) {
      return res.status(400).json({
        error: 'buyerID, botID, name, and repoUrl are required',
      });
    }

    // Prevent duplicate botID under same buyer
    const existing = await db.findOne('bots', { buyerID, botID });
    if (existing) {
      return res.status(409).json({
        error: `Bot "${botID}" already exists for buyer "${buyerID}"`,
      });
    }

    const dir = botDir(buyerID, botID);

    // Ensure buyer directory exists
    fs.mkdirSync(path.join(BOTS_ROOT(), buyerID), { recursive: true });

    // 1. Clone repository
    console.log(`[Bots] Cloning ${repoUrl} → ${dir}`);
    await gitService.cloneRepo(repoUrl, dir, branch);

    // 2. Install npm dependencies
    console.log(`[Bots] Installing deps for ${botID}`);
    await gitService.installDeps(dir);

    // 3. Save to DB — pm2Name is "buyerID-botID" to avoid collisions
    const pm2Name = `${buyerID}-${botID}`;
    const botRecord = await db.create('bots', {
      buyerID,
      botID,
      name,
      repoUrl,
      branch,
      startScript,
      pm2Name,
      expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
      createdAt: Date.now(),
    });

    console.log(`[Bots] Created bot "${name}" (${pm2Name})`);
    res.status(201).json(botRecord);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Update Metadata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PUT /api/bots/:id
 * Update editable metadata fields (name, expiresAt, startScript).
 *
 * Body: { name?, expiresAt?, startScript? }
 */
router.put('/:id', async (req, res, next) => {
  try {
    const { name, expiresAt, startScript } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (startScript !== undefined) updates.startScript = startScript;
    if (expiresAt !== undefined) {
      updates.expiresAt = expiresAt ? new Date(expiresAt).getTime() : null;
    }

    const updated = await db.findOneAndUpdate('bots', { _id: req.params.id }, updates);
    if (!updated) return res.status(404).json({ error: 'Bot not found' });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Delete Bot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DELETE /api/bots/:id
 * Stop the bot, remove from PM2, delete source directory, and DB record.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const bot = await db.findOne('bots', { _id: req.params.id });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    // Stop & unregister from PM2
    await pm2Service.deleteBot(bot.pm2Name);

    // Delete source directory
    const dir = botDir(bot.buyerID, bot.botID);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // Remove from DB
    await db.findOneAndDelete('bots', { _id: req.params.id });

    console.log(`[Bots] Deleted bot "${bot.name}" (${bot.pm2Name})`);
    res.json({ message: `Bot "${bot.name}" deleted successfully` });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Process Control
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/bots/:id/start */
router.post('/:id/start', async (req, res, next) => {
  try {
    const bot = await db.findOne('bots', { _id: req.params.id });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const dir = botDir(bot.buyerID, bot.botID);
    const output = await pm2Service.startBot(bot.pm2Name, dir, bot.startScript);
    res.json({ message: 'Bot started', output });
  } catch (err) {
    next(err);
  }
});

/** POST /api/bots/:id/stop */
router.post('/:id/stop', async (req, res, next) => {
  try {
    const bot = await db.findOne('bots', { _id: req.params.id });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const output = await pm2Service.stopBot(bot.pm2Name);
    res.json({ message: 'Bot stopped', output });
  } catch (err) {
    next(err);
  }
});

/** POST /api/bots/:id/restart */
router.post('/:id/restart', async (req, res, next) => {
  try {
    const bot = await db.findOne('bots', { _id: req.params.id });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const output = await pm2Service.restartBot(bot.pm2Name);
    res.json({ message: 'Bot restarted', output });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Git Update
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/bots/:id/update
 * Pull latest git changes, reinstall deps, and restart the bot.
 */
router.post('/:id/update', async (req, res, next) => {
  try {
    const bot = await db.findOne('bots', { _id: req.params.id });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const dir = botDir(bot.buyerID, bot.botID);

    const pullOutput = await gitService.pullRepo(dir);
    await gitService.installDeps(dir);
    const restartOutput = await pm2Service.restartBot(bot.pm2Name);

    console.log(`[Bots] Updated bot "${bot.name}"`);
    res.json({ message: 'Bot updated and restarted', pullOutput, restartOutput });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  .env Editor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/bots/:id/env
 * Read the .env file of the bot. Returns empty string if no .env exists.
 */
router.get('/:id/env', async (req, res, next) => {
  try {
    const bot = await db.findOne('bots', { _id: req.params.id });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const envPath = path.join(botDir(bot.buyerID, bot.botID), '.env');
    const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    res.json({ content });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/bots/:id/env
 * Overwrite the .env file with new content.
 *
 * Body: { content: string }   e.g. "TOKEN=abc\nPREFIX=!"
 */
router.put('/:id/env', async (req, res, next) => {
  try {
    const bot = await db.findOne('bots', { _id: req.params.id });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const { content } = req.body;
    if (content === undefined) return res.status(400).json({ error: 'content is required' });

    const envPath = path.join(botDir(bot.buyerID, bot.botID), '.env');
    fs.writeFileSync(envPath, content, 'utf8');

    res.json({ message: '.env saved successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
