const cron = require("node-cron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { sendBackup } = require("./discordService");
const lifecycle = require("./lifecycle");
const sharedStore = require("./sharedStore");

/**
 * Send the database files to Discord: panel.sqlite, and the bots' shared data
 * (shared.sqlite — a consistent online-backup copy, gzipped: it holds whole
 * collections such as the shop's orders and compresses well).
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

    if (!fs.existsSync(sharedStore.DB_PATH())) return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panel-backup-"));
    try {
        const copy = path.join(tmp, "shared.sqlite");
        await sharedStore.backupTo(copy);
        const gz = `${copy}.gz`;
        fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(copy)));
        await sendBackup(gz, "shared.sqlite.gz");
        console.log(`[Backup] Shared data backup sent`);
    } catch (err) {
        console.error(`[Backup] Shared data backup failed: ${err.message}`);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
};

/**
 * Start the backup cron job.
 * Runs every hour at :30 minutes (offset from expiry check at :00).
 */
const start = () => {
    cron.schedule("30 * * * *", lifecycle.guard(performBackup));
    console.log("[Backup] Backup service started — runs every hour at :30");
};

module.exports = { start, performBackup };
