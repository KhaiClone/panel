const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { deleteBot } = require('./pm2Service');
const { sendExpiryWarning, sendExpiryRemoval } = require('./discordService');

// Days before expiry to send a warning notification
// e.g. warn at 7 days left, again at 3, again at 1
const WARNING_DAYS = [7, 3, 1];

// ─────────────────────────────────────────────────────────────────────────────
//  Core Check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a full expiry check across all bots.
 *
 *  - If a bot's expiresAt timestamp is in the past → remove it
 *  - If days left matches a WARNING_DAYS threshold → send Discord alert
 */
const checkExpiry = async () => {
  console.log('[Expiry] Running expiry check...');

  try {
    const bots = await db.find('bots');
    const now = Date.now();

    for (const bot of bots) {
      // Skip bots without an expiry date
      if (!bot.expiresAt) continue;

      const msLeft = bot.expiresAt - now;
      const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));

      if (msLeft <= 0) {
        // ── EXPIRED: remove everything ─────────────────────────────────────
        console.log(`[Expiry] Bot "${bot.botID}" (buyer: ${bot.buyerID}) expired. Removing...`);

        // 1. Stop & unregister from PM2
        await deleteBot(bot.pm2Name);

        // 2. Delete source directory
        const botDir = path.join(process.env.BOTS_ROOT_DIR, bot.buyerID, bot.botID);
        if (fs.existsSync(botDir)) {
          fs.rmSync(botDir, { recursive: true, force: true });
          console.log(`[Expiry] Deleted folder: ${botDir}`);
        }

        // 3. Remove record from DB
        await db.findOneAndDelete('bots', { _id: bot._id });

        // 4. Notify Discord
        await sendExpiryRemoval(bot);

      } else if (WARNING_DAYS.includes(daysLeft)) {
        // ── WARNING: notify but keep bot running ───────────────────────────
        console.log(`[Expiry] Sending ${daysLeft}-day warning for bot "${bot.botID}"`);
        await sendExpiryWarning(bot, daysLeft);
      }
    }
  } catch (err) {
    console.error(`[Expiry] Error during check: ${err.message}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Scheduler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start the expiry cron job.
 * Runs once at startup, then every hour at :00 minutes.
 */
const start = () => {
  // Immediate first run
  checkExpiry();

  // Every hour at minute 0
  cron.schedule('0 * * * *', checkExpiry);
  console.log('[Expiry] Expiry service started — runs every hour');
};

module.exports = { start, checkExpiry };
