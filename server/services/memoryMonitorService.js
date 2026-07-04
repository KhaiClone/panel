const cron = require("node-cron");
const executor = require("./executor");
const { createNotification } = require("../routes/notifications");
const db = require("../db");

// Convert "500M", "1G" into bytes
const parseMemory = (memStr) => {
    if (!memStr) return null;
    const match = memStr.match(/^(\d+)(K|M|G)?$/i);
    if (!match) return null;
    const val = parseInt(match[1]);
    const unit = (match[2] || 'M').toUpperCase();
    if (unit === 'K') return val * 1024;
    if (unit === 'M') return val * 1024 * 1024;
    if (unit === 'G') return val * 1024 * 1024 * 1024;
    return val;
};

const checkMemoryOverflow = async () => {
    try {
        const bots = await db.find("bots");
        // One PM2 list per node (local + each agent); offline nodes are skipped
        const resolver = await executor.getStatusResolver(bots);

        for (const bot of bots) {
            if (!bot.maxMemory) continue;
            const limitBytes = parseMemory(bot.maxMemory);
            if (!limitBytes) continue;

            const list = resolver.listFor(bot);
            if (!list) continue; // node offline — nothing to check

            const proc = list.find((p) => p.name === bot.pm2Name);
            if (proc && proc.pm2_env.status === "online") {
                const memUsage = proc.monit?.memory || 0;
                if (memUsage > limitBytes) {
                    console.log(`[MemoryMonitor] Bot "${bot.name}" exceeded memory limit (${memUsage} > ${limitBytes}). Restarting...`);
                    await executor.restartBot(bot);
                    // Also notify the frontend
                    if (createNotification) {
                        await createNotification(`Bot "${bot.name}" exceeded its memory limit and was automatically restarted.`, "warning");
                    }
                }
            }
        }
    } catch (err) {
        console.error(`[MemoryMonitor] Error: ${err.message}`);
    }
};

const start = () => {
    // Check every 1 minute
    cron.schedule("* * * * *", checkMemoryOverflow);
    console.log("[MemoryMonitor] Memory double-check service started — runs every minute");
};

module.exports = { start, checkMemoryOverflow };
