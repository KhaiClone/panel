const cron = require("node-cron");
const path = require("path");
const fs = require("fs");
const db = require("../db");
const { flushLogs } = require("./pm2Service");
const executor = require("./executor");
const { sendExpiryWarning, sendExpiryRemoval, sendExpirySuspended } = require("./discordService");
const { createNotification } = require("../routes/notifications");

// Hours before expiry to send a warning notification
// e.g. warn at 72 hours, 47 hours, 24 hours left
const WARNING_HOURS = [72, 47, 24];

// ─────────────────────────────────────────────────────────────────────────────
//  Core Check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a full expiry check across all bots.
 *
 *  - If a bot's expiresAt timestamp is > 7 days in the past → remove it
 *  - If a bot's expiresAt timestamp is in the past → stop it and notify
 *  - If days left matches a WARNING_DAYS threshold → send Discord alert
 */
const checkExpiry = async () => {
    console.log("[Expiry] Running expiry check...");

    try {
        const bots = await db.find("bots");
        const now = Date.now();

        for (const bot of bots) {
            // Skip bots without an expiry date
            if (!bot.expiresAt) continue;

            const msLeft = bot.expiresAt - now;
            const hoursLeft = Math.ceil(msLeft / (1000 * 60 * 60));

            if (msLeft <= -7 * 24 * 60 * 60 * 1000) {
                // ── EXPIRED 7 DAYS AGO: remove everything ────────────────────────
                console.log(
                    `[Expiry] Bot "${bot.botID}" (buyer: ${bot.buyerID}) expired 7 days ago. Removing...`,
                );

                // 1. Stop & unregister from PM2 (on whichever node the bot lives)
                await executor.deleteBot(bot);

                // 2. Delete source directory (never touch imported local folders)
                if (executor.isRemote(bot)) {
                    await executor.removeBotFiles(bot).catch((err) =>
                        console.error(`[Expiry] Could not delete remote folder: ${err.message}`),
                    );
                } else {
                    const botDir = path.join(
                        process.env.BOTS_ROOT_DIR,
                        bot.buyerID,
                        bot.botID,
                    );
                    if (fs.existsSync(botDir)) {
                        fs.rmSync(botDir, { recursive: true, force: true });
                        console.log(`[Expiry] Deleted folder: ${botDir}`);
                    }
                }

                // 3. Remove record from DB
                await db.findOneAndDelete("bots", { _id: bot._id });

                // 4. Notify Discord
                await sendExpiryRemoval(bot);
            } else if (msLeft <= 0) {
                // ── JUST EXPIRED: stop bot but keep data ─────────────────────────
                const live = await executor.getBotStatus(bot);
                if (live.status === "online" || live.status === "launching") {
                    console.log(
                        `[Expiry] Bot "${bot.botID}" (buyer: ${bot.buyerID}) expired. Stopping...`,
                    );
                    await executor.stopBot(bot);
                    await sendExpirySuspended(bot);
                    await createNotification(`Bot "${bot.name}" has expired and was stopped.`, "expired");
                }
            } else if (WARNING_HOURS.includes(hoursLeft)) {
                // ── WARNING: notify but keep bot running ───────────────────────────
                console.log(
                    `[Expiry] Sending ${hoursLeft}h warning for bot "${bot.botID}"`,
                );
                await sendExpiryWarning(bot, hoursLeft);
            }
        }

        // ── NOTIFICATION CLEANUP ───────────────────────────────────────────────
        const oldTime = now - (24 * 60 * 60 * 1000); // 24 hours ago
        const notifs = await db.find("notifications") || [];
        for (const n of notifs) {
            if (n.createdAt < oldTime) {
                await db.findOneAndDelete("notifications", { _id: n._id });
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
    cron.schedule("0 * * * *", checkExpiry);
    
    // Auto remove hosting logs every 3 days (midnight on every 3rd day)
    cron.schedule("0 0 */3 * *", async () => {
        console.log("[Logs] Auto flushing PM2 hosting logs (3-day cycle)...");
        await flushLogs();
    });

    console.log("[Expiry] Expiry service started — runs every hour");
};

module.exports = { start, checkExpiry };
