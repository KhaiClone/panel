const db = require("../db");
const executor = require("./executor");
const nodeService = require("./nodeService");

// ─────────────────────────────────────────────────────────────────────────────
//  Stale copies — projects left behind on a node that was offline when they
//  were moved away (POST /api/bots/:id/migrate with force).
//
//  The panel could not stop them then, and PM2 resurrects its saved list when
//  that machine boots, so the old copy would run alongside the new one — two
//  instances of one Discord bot on one token. Each entry here is stopped and
//  removed from PM2 the first time its node answers again (nodeService's
//  health poll calls sweepNode). Its files are KEPT: they may hold data the
//  new copy does not have (.env, databases), and only the user knows whether
//  they still need them.
// ─────────────────────────────────────────────────────────────────────────────

const COLLECTION = "stale_copies";

/**
 * Remember that `bot`, as it was on `nodeId`, still exists there.
 * The record is a snapshot of the project on THAT node — it may have been a
 * local import at an absolute path, which the moved copy no longer is.
 */
const add = async (bot, nodeId) => {
    await db.deleteMany(COLLECTION, { botId: bot._id, nodeId });
    return db.create(COLLECTION, {
        botId: bot._id,
        nodeId,
        name: bot.name,
        pm2Name: bot.pm2Name,
        bot: { ...bot, nodeId },
        createdAt: Date.now(),
    });
};

/** The project lives on `nodeId` again — whatever runs there is the live copy. */
const forget = (botId, nodeId) => db.deleteMany(COLLECTION, { botId, nodeId });

/** Every stale copy waiting on `nodeId`. */
const forNode = (nodeId) => db.find(COLLECTION, { nodeId });

/** The node record is going away; nothing can reach these copies anymore. */
const forgetNode = (nodeId) => db.deleteMany(COLLECTION, { nodeId });

/** Same teardown as the source side of a normal migration, minus the files. */
const teardown = async (ref) => {
    await executor.deleteBot(ref);
    const wc = ref.projectType === "website" ? ref.websiteConfig : null;
    if (wc) {
        await executor.nginxRemoveConfig(ref);
        // 80/443 are shared by every domain on the node — only a site's own port closes.
        if (!(wc.mode === "static" && wc.domain)) await executor.ufwClosePort(ref, wc.port);
    } else if (ref.projectType === "service" && ref.serviceConfig?.port) {
        await executor.ufwClosePort(ref, ref.serviceConfig.port);
    }
};

const sweeping = new Set(); // nodeIds with a sweep in progress

/**
 * Stop the stale copies on a node that just answered a health check.
 * Failures keep the entry, so the next poll tries again.
 */
const sweepNode = async (node) => {
    if (sweeping.has(node._id)) return;
    const pending = await forNode(node._id);
    if (pending.length === 0) return;

    sweeping.add(node._id);
    try {
        const { createNotification } = require("../routes/notifications");
        for (const entry of pending) {
            try {
                const current = await db.findOne("bots", { _id: entry.botId });
                const livesHere = current && nodeService.resolveNodeId(current.nodeId) === node._id;
                if (!livesHere) await teardown(entry.bot);
                await db.findOneAndDelete(COLLECTION, { _id: entry._id });
                if (livesHere) continue;

                const where = executor.describeLocation(entry.bot);
                console.log(`[StaleCopies] Stopped the old copy of "${entry.name}" on "${node.name}" (files kept at ${where})`);
                await createNotification(
                    `Node "${node.name}" is back: the old copy of "${entry.name}" left there by a forced move was stopped and removed from PM2. Its files were kept at ${where} — delete them on that machine once you no longer need them.`,
                    "info",
                );
            } catch (err) {
                console.warn(`[StaleCopies] Could not stop the old copy of "${entry.name}" on "${node.name}": ${err.message}`);
            }
        }
    } finally {
        sweeping.delete(node._id);
    }
};

module.exports = { add, forget, forNode, forgetNode, sweepNode };
