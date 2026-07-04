const express = require("express");
const router = express.Router();

const db = require("../db");
const executor = require("../services/executor");

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

        // Fetch bots — users can only bulk-act on their own bots
        const query = req.user.role === "admin" ? {} : { ownerId: req.user.id };
        const allBots = await db.find("bots", query);
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
                        const proxyConf = await getProxyConf(bot);
                        await executor.startBot(bot, proxyConf);
                        return "Started successfully";
                    }

                    case "stop": {
                        await executor.stopBot(bot);
                        return "Stopped successfully";
                    }

                    case "restart": {
                        if (bot.expiresAt && bot.expiresAt <= Date.now()) {
                            throw new Error("Bot is expired");
                        }
                        // Use startBot so the wrapper script is regenerated with current proxy settings
                        const proxyConf = await getProxyConf(bot);
                        await executor.startBot(bot, proxyConf);
                        return "Restarted successfully";
                    }

                    case "install": {
                        await executor.installDeps(bot, bot.installCommand);
                        return "Dependencies installed";
                    }

                    case "update": {
                        if (bot.expiresAt && bot.expiresAt <= Date.now()) {
                            throw new Error("Bot is expired");
                        }
                        let pullOutput = "(skipped — no git remote)";
                        try {
                            pullOutput = await executor.pullRepo(bot);
                        } catch (err) {
                            pullOutput = `(pull failed or skipped: ${err.message || 'unknown error'})`;
                        }
                        await executor.installDeps(bot, bot.installCommand);

                        const proxyConf = await getProxyConf(bot);
                        await executor.startBot(bot, proxyConf);
                        return "Updated and restarted";
                    }

                    case "remove": {
                        await executor.deleteBot(bot);
                        if (bot.source !== "local") {
                            await executor.removeBotFiles(bot);
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
