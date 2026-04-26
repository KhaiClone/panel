const cron = require("node-cron");
const path = require("path");
const db = require("../db");
const { sendBackup } = require("./discordService");

/**
 * Send the database file backup to Discord.
 */
const performBackup = async () => {
    console.log("[Backup] Running database backup...");
    try {
        const dbPath = path.join(__dirname, "../../data/panel.sqlite");
        await sendBackup(dbPath);
        console.log(`[Backup] Database file backup sent`);
    } catch (err) {
        console.error(`[Backup] Backup failed: ${err.message}`);
    }
};

/**
 * Start the backup cron job.
 * Runs every hour at :30 minutes (offset from expiry check at :00).
 */
const start = () => {
    cron.schedule("30 * * * *", performBackup);
    console.log("[Backup] Backup service started — runs every hour at :30");
};

module.exports = { start, performBackup };
