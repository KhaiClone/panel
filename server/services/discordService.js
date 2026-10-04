const axios = require("axios");

// ─────────────────────────────────────────────────────────────────────────────
//  Core
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a payload to a Discord webhook URL.
 * Errors are caught and logged so they never crash the server.
 *
 * @param {string} webhookUrl
 * @param {Object} payload - Discord webhook body (content, embeds, etc.)
 */
const sendWebhook = async (webhookUrl, payload) => {
    if (!webhookUrl) return;
    try {
        await axios.post(webhookUrl, payload);
    } catch (err) {
        console.error(`[Discord] Webhook error: ${err.message}`);
    }
};

/**
 * Send a Discord DM to a buyer: the bot that announced "dm.send" on the Discord
 * bus delivers it (the panel calls nothing). No such bot = no DM.
 * Errors never crash the caller — webhook alerts remain the source of truth.
 *
 * @param {string} buyerID - Discord user ID
 * @param {Object} payload - { content?, embeds?, components? }
 */
const sendDM = async (buyerID, payload) => {
    if (!buyerID) return;
    const discordBus = require("./discordBus");
    const via = discordBus.handlerOf("dm.send");
    if (!via) return;
    await discordBus.notify(via, "dm.send", { buyerID, ...payload }).catch((err) => console.warn(`[Discord] DM to ${buyerID} not queued: ${err.message}`));
};

// Every message below is a template the Embeds page edits (server/templates/panel.js).
// Lazy: panelTemplates opens the shared store, which this module must not touch on load.
const templates = () => require("./panelTemplates");

// ─────────────────────────────────────────────────────────────────────────────
//  Expiry Notifications — templates panel.expiry.*
// ─────────────────────────────────────────────────────────────────────────────

/** A customer's bot as the templates see it (type hostedBot). */
const botVars = (bot) => ({
    id: bot._id ?? "",
    name: bot.name,
    botID: bot.botID,
    buyerID: bot.buyerID,
    expiresAt: bot.expiresAt ?? null,
    maxMemory: bot.maxMemory || "",
    __text: bot.name,
});

/** One expiry notice: DISCORD_ALERT_WEBHOOK (where = alert) and the buyer's DMs (where = dm). */
const sendExpiry = async (key, bot, extra = {}) => {
    const vars = { customerBot: botVars(bot), ...extra };
    await Promise.all([
        sendWebhook(process.env.DISCORD_ALERT_WEBHOOK, templates().message(key, { ...vars, where: "alert" })),
        sendDM(bot.buyerID, templates().message(key, { ...vars, where: "dm" })),
    ]);
};

/**
 * Expiry warning. The template colours it yellow → orange → red as expiry approaches.
 *
 * @param {Object} bot       - Bot record from DB
 * @param {number} hoursLeft - Hours remaining before expiry
 */
const sendExpiryWarning = (bot, hoursLeft) => sendExpiry("panel.expiry.warning", bot, { hoursLeft });

/**
 * A bot was auto-removed due to expiry.
 *
 * @param {Object} bot - Bot record from DB (before deletion)
 */
const sendExpiryRemoval = (bot) => sendExpiry("panel.expiry.removed", bot);

/**
 * A bot was suspended due to expiry.
 *
 * @param {Object} bot - Bot record from DB
 */
const sendExpirySuspended = (bot) => sendExpiry("panel.expiry.suspended", bot);

// ─────────────────────────────────────────────────────────────────────────────
//  Lavalink — template panel.lavalink.report
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Report the outcome of a Lavalink release check to the log channel.
 *
 * Goes to DISCORD_LAVALINK_WEBHOOK, falling back to DISCORD_ALERT_WEBHOOK so
 * the feature still reports on a panel that never configured a separate one.
 *
 * @param {Object} report
 * @param {string} report.kind         - "available" (auto-update off) | "updated" | "partial"
 * @param {string} report.version      - the release being moved to
 * @param {string} [report.url]        - GitHub release page
 * @param {Array}  report.results      - [{ nodeName, ok (null = not updated), from, version, started, error, rolledBack }]
 * @param {Array}  [report.skipped]    - [{ nodeName, state }] nodes that could not take it
 */
const sendLavalinkReport = async ({ kind, version, url, results = [], skipped = [] }) => {
    const webhookUrl = process.env.DISCORD_LAVALINK_WEBHOOK || process.env.DISCORD_ALERT_WEBHOOK;
    if (!webhookUrl) return;

    const rows = results.slice(0, 12).map((r) => ({
        nodeName: r.nodeName,
        state: r.ok === null ? "pending" : r.ok ? "ok" : "failed",
        from: (r.ok === null ? r.from || r.version : r.from) || "",
        // A node that was stopped keeps its jar swapped but is never started by
        // the scheduled job — the template says so, or "✅" would read as "running".
        started: r.started !== false,
        error: String(r.error || "").slice(0, 180),
        rolledBack: !!r.rolledBack,
        __text: r.nodeName,
    }));
    await sendWebhook(
        webhookUrl,
        templates().message("panel.lavalink.report", {
            kind,
            version,
            url: url || null,
            results: rows,
            skipped: skipped.slice(0, 12).map((s) => ({ nodeName: s.nodeName, state: s.state, __text: s.nodeName })),
            total: results.length,
            okCount: results.filter((r) => r.ok).length,
            outdatedCount: results.length,
        }),
    );
};

module.exports = {
    sendWebhook,
    sendDM,
    sendExpiryWarning,
    sendExpiryRemoval,
    sendExpirySuspended,
    sendLavalinkReport,
};
