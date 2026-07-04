const express = require("express");
const router = express.Router();

const db = require("../db");
const executor = require("../services/executor");

// ─────────────────────────────────────────────────────────────────────────────
//  External API for Discord Bot (ArnTo-Auto)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/external/bots
 * Query: ?buyerID=xxxx
 * Returns bots belonging to the specified buyer with live PM2 status.
 */
router.get("/bots", async (req, res, next) => {
    try {
        const { buyerID } = req.query;
        if (!buyerID) return res.status(400).json({ error: "buyerID is required" });

        const bots = await db.find("bots");
        const userBots = bots.filter(b => b.buyerID === buyerID);

        // Fetch live PM2 status for each bot (one list fetch per node)
        const resolver = await executor.getStatusResolver(userBots);
        const enriched = await Promise.all(
            userBots.map(async (bot) => {
                const live = await resolver.statusFor(bot);
                return { ...bot, live };
            }),
        );

        res.json(enriched);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/external/bots/:id/action
 * Body: { action: "start" | "stop" | "restart" }
 * Performs a process control action on the bot.
 */
router.post("/bots/:id/action", async (req, res, next) => {
    try {
        const { action } = req.body;
        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        if ((action === "start" || action === "restart") && bot.expiresAt && bot.expiresAt <= Date.now()) {
            return res.status(403).json({ error: "Bot is expired. Please extend to start." });
        }

        let output;
        if (action === "start") {
            output = await executor.startBot(bot);
        } else if (action === "stop") {
            output = await executor.stopBot(bot);
        } else if (action === "restart") {
            output = await executor.restartBot(bot);
        } else {
            return res.status(400).json({ error: "Invalid action" });
        }

        res.json({ message: `Bot ${action}ed successfully`, output });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/external/bots/:id/extend
 * Body: { months: number }
 * Extends the bot's expiry date by the given number of months.
 */
router.post("/bots/:id/extend", async (req, res, next) => {
    try {
        const { months } = req.body;
        if (!months || typeof months !== "number" || months <= 0) {
            return res.status(400).json({ error: "Invalid months" });
        }

        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        const now = Date.now();
        // If expired or missing, start from now. Otherwise extend from current expiry.
        let baseTime = bot.expiresAt && bot.expiresAt > now ? bot.expiresAt : now;
        
        // Add months (approx 30 days per month)
        const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
        const newExpiry = baseTime + (months * ONE_MONTH_MS);

        const updated = await db.findOneAndUpdate(
            "bots",
            { _id: req.params.id },
            // Reset warning history so milestones re-fire against the new deadline
            { expiresAt: newExpiry, warnedHours: [] }
        );

        res.json({ message: "Bot extended successfully", bot: updated });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/external/bots/:id/upgrade
 * Body: { additionalRam: number } (in MB)
 * Upgrades the bot's memory limit.
 */
router.post("/bots/:id/upgrade", async (req, res, next) => {
    try {
        const { additionalRam } = req.body;
        if (!additionalRam || typeof additionalRam !== "number" || additionalRam <= 0) {
            return res.status(400).json({ error: "Invalid additionalRam" });
        }

        const bot = await db.findOne("bots", { _id: req.params.id });
        if (!bot) return res.status(404).json({ error: "Bot not found" });

        // Parse current memory limit (e.g., "128M", "256M") or assume 128
        let currentRam = 128;
        if (bot.maxMemory) {
            const match = bot.maxMemory.match(/^(\d+)/);
            if (match) currentRam = parseInt(match[1], 10);
        }

        const newRam = currentRam + additionalRam;
        const maxMemoryString = `${newRam}M`;

        const updates = { maxMemory: maxMemoryString };
        if (bot.currentPrice) {
            updates.currentPrice = bot.currentPrice + 5000 * (additionalRam / 64);
        }

        const updated = await db.findOneAndUpdate(
            "bots",
            { _id: req.params.id },
            updates
        );

        // Apply new limit to PM2 if running
        const live = await executor.getBotStatus(bot);
        if (live.status === "online") {
            await executor.setMemoryLimit(bot, maxMemoryString);
        }

        res.json({ message: "Bot upgraded successfully", bot: updated });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
