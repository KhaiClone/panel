const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");

const db = require("../db");
const pm2Service = require("../services/pm2Service");
const gitService = require("../services/gitService");

const BOTS_ROOT = () => process.env.BOTS_ROOT_DIR;

const botDir = (bot) => {
    if (bot.source === "local" && bot.localPath) return bot.localPath;
    return path.join(BOTS_ROOT(), bot.buyerID, bot.botID);
};

const getProxyConf = async (bot) => {
    if (!bot.proxyEnabled) return null;
    const globalConf = await db.get("proxy_config");
    if (!globalConf || !globalConf.enabled) return null;
    return globalConf; // { type, host, port, username, password }
};

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/bulk/:action
//  Perform a bulk action on multiple bots.
//
//  Supported actions: start, stop, restart, install, update, remove
//  Body: { botIds: string[] }
//  Response: { results: [{ botId, name, status: 'ok'|'error', message }] }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:action", async (req, res, next) => {
    try {
        const { action } = req.params;
        const { botIds } = req.body;

        const ALLOWED = ["start", "stop", "restart", "install", "update", "remove"];
        if (!ALLOWED.includes(action)) {
            return res.status(400).json({ error: `Invalid action "${action}". Allowed: ${ALLOWED.join(", ")}` });
        }

        if (!Array.isArray(botIds) || botIds.length === 0) {
            return res.status(400).json({ error: "botIds must be a non-empty array" });
        }

        // Fetch all requested bots from DB
        const allBots = await db.find("bots");
        const botMap = Object.fromEntries(allBots.map((b) => [b._id, b]));

        const results = await Promise.allSettled(
            botIds.map(async (botId) => {
                const bot = botMap[botId];
                if (!bot) throw new Error("Bot not found");

                switch (action) {
                    case "start": {
                        if (bot.expiresAt && bot.expiresAt <= Date.now()) {
                            throw new Error("Bot is expired");
                        }
                        const dir = botDir(bot);
                        const proxyConf = await getProxyConf(bot);
                        await pm2Service.startBot(bot.pm2Name, dir, bot.startScript, bot.maxMemory || null, proxyConf);
                        return "Started successfully";
                    }

                    case "stop": {
                        await pm2Service.stopBot(bot.pm2Name);
                        return "Stopped successfully";
                    }

                    case "restart": {
                        if (bot.expiresAt && bot.expiresAt <= Date.now()) {
                            throw new Error("Bot is expired");
                        }
                        // Use startBot so the wrapper script is regenerated with current proxy settings
                        const dir = botDir(bot);
                        const proxyConf = await getProxyConf(bot);
                        await pm2Service.startBot(bot.pm2Name, dir, bot.startScript, bot.maxMemory || null, proxyConf);
                        return "Restarted successfully";
                    }

                    case "install": {
                        const dir = botDir(bot);
                        await gitService.installDeps(dir, bot.installCommand);
                        return "Dependencies installed";
                    }

                    case "update": {
                        if (bot.expiresAt && bot.expiresAt <= Date.now()) {
                            throw new Error("Bot is expired");
                        }
                        const dir = botDir(bot);
                        let pullOutput = "(skipped — no git remote)";
                        try {
                            pullOutput = await gitService.pullRepo(dir);
                        } catch (err) {
                            pullOutput = `(pull failed or skipped: ${err.message || 'unknown error'})`;
                        }
                        await gitService.installDeps(dir, bot.installCommand);
                        
                        const proxyConf = await getProxyConf(bot);
                        await pm2Service.startBot(bot.pm2Name, dir, bot.startScript, bot.maxMemory || null, proxyConf);
                        return "Updated and restarted";
                    }

                    case "remove": {
                        await pm2Service.deleteBot(bot.pm2Name);
                        if (bot.source !== "local") {
                            const dir = botDir(bot);
                            if (fs.existsSync(dir)) {
                                fs.rmSync(dir, { recursive: true, force: true });
                            }
                        }
                        await db.findOneAndDelete("bots", { _id: botId });
                        return "Removed successfully";
                    }

                    default:
                        throw new Error("Unknown action");
                }
            }),
        );

        // Format results
        const formatted = botIds.map((botId, i) => {
            const bot = botMap[botId];
            const result = results[i];
            return {
                botId,
                name: bot?.name || botId,
                status: result.status === "fulfilled" ? "ok" : "error",
                message:
                    result.status === "fulfilled"
                        ? result.value
                        : result.reason?.message || "Unknown error",
            };
        });

        console.log(`[Bulk] ${action} on ${botIds.length} bot(s) — ${formatted.filter((r) => r.status === "ok").length} ok, ${formatted.filter((r) => r.status === "error").length} failed`);
        res.json({ results: formatted });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
