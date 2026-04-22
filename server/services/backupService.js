const cron = require("node-cron");
const db = require("../db");
const { sendBackup } = require("./discordService");

/**
 * Dump all database models and send as a JSON file to Discord.
 * Add more models here if you expand the DB in the future.
 */
const performBackup = async () => {
    console.log("[Backup] Running database backup...");
    try {
        const bots = await db.find("bots");

        const backupData = {
            timestamp: new Date().toISOString(),
            bots,
        };

        await sendBackup(backupData);
        console.log(`[Backup] Backup sent — ${bots.length} bot(s) saved`);
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
