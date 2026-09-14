const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");

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
 * Send a Discord DM to a buyer via the arnto-auto DM API.
 * No-op if ARNTO_DM_URL or ARNTO_DM_API_KEY is not configured.
 * Errors never crash the caller — webhook alerts remain the source of truth.
 *
 * @param {string} buyerID - Discord user ID
 * @param {Object} payload - { content?, embeds?, components? }
 */
const sendDM = async (buyerID, payload) => {
    const url = process.env.ARNTO_DM_URL;
    const key = process.env.ARNTO_DM_API_KEY;
    if (!url || !key || !buyerID) return;

    try {
        await axios.post(
            `${url.replace(/\/$/, "")}/api/dm`,
            { buyerID, ...payload },
            { headers: { "x-api-key": key }, timeout: 5000 },
        );
    } catch (err) {
        const detail = err.response?.data?.error || err.message;
        console.warn(`[Discord] DM to ${buyerID} failed: ${detail}`);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Expiry Notifications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send an expiry warning embed to DISCORD_ALERT_WEBHOOK.
 * Color scales from yellow → orange → red as expiry approaches.
 *
 * @param {Object} bot       - Bot record from DB
 * @param {number} hoursLeft - Hours remaining before expiry
 */
const sendExpiryWarning = async (bot, hoursLeft) => {
    const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK;

    // Color: red (<= 24h), orange (<= 72h), yellow (> 72h)
    const color =
        hoursLeft <= 24 ? 0xff4444 : hoursLeft <= 72 ? 0xff8c00 : 0xffd700;

    const embed = {
        title: "⚠️ Bot Expiry Warning",
        color,
        description: "**Bot is expiring soon!**",
        fields: [
            { name: "🤖 Bot Name", value: bot.name, inline: true },
            { name: "🆔 Bot ID", value: `\`${bot.botID}\``, inline: true },
            {
                name: "⏳ Time Left",
                value: `**${hoursLeft}** hour(s)`,
                inline: true,
            },
            {
                name: "📅 Expires At",
                value: `<t:${Math.floor(bot.expiresAt / 1000)}:F>`,
                inline: true,
            },
            {
                name: "🔗 Extend This Bot",
                value: `<#1480431381808152586> or create ticket at <#1246028759597846650> for a support.`,
                inline: false,
            },
        ],
        timestamp: new Date().toISOString(),
    };

    await Promise.all([
        sendWebhook(webhookUrl, {
            content: `<@${bot.buyerID}>`,
            embeds: [embed],
        }),
        sendDM(bot.buyerID, { embeds: [embed] }),
    ]);
};

/**
 * Send a notification that a bot was auto-removed due to expiry.
 *
 * @param {Object} bot - Bot record from DB (before deletion)
 */
const sendExpiryRemoval = async (bot) => {
    const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK;

    const embed = {
        title: "🗑️ Bot Expired & Auto-Removed",
        color: 0xff0000,
        fields: [
            { name: "🤖 Bot Name", value: bot.name, inline: true },
            { name: "🆔 Bot ID", value: bot.botID, inline: true },
            {
                name: "👤 Buyer ID",
                value: `\`${bot.buyerID}\``,
                inline: true,
            },
            {
                name: "📅 Expired At",
                value: `<t:${Math.floor(bot.expiresAt / 1000)}:F>`,
                inline: false,
            },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: "Bot folder has been deleted from the server." },
    };

    await Promise.all([
        sendWebhook(webhookUrl, { embeds: [embed] }),
        sendDM(bot.buyerID, { embeds: [embed] }),
    ]);
};

/**
 * Send a notification that a bot was suspended due to expiry.
 *
 * @param {Object} bot - Bot record from DB
 */
const sendExpirySuspended = async (bot) => {
    const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK;

    const embed = {
        title: "🛑 Bot Expired & Suspended",
        color: 0xff0000,
        description:
            "**Your bot has expired and has been stopped.** Please extend the expiry within 7 days to avoid permanent deletion.",
        fields: [
            { name: "🤖 Bot Name", value: bot.name, inline: true },
            { name: "🆔 Bot ID", value: `\`${bot.botID}\``, inline: true },
            {
                name: "📅 Expired At",
                value: `<t:${Math.floor(bot.expiresAt / 1000)}:F>`,
                inline: true,
            },
            {
                name: "🔗 Extend This Bot",
                value: `<#1480431381808152586> or create ticket at <#1246028759597846650> for a support.`,
                inline: false,
            },
        ],
        timestamp: new Date().toISOString(),
    };

    await Promise.all([
        sendWebhook(webhookUrl, {
            content: `<@${bot.buyerID}>`,
            embeds: [embed],
        }),
        sendDM(bot.buyerID, { embeds: [embed] }),
    ]);
};

// ─────────────────────────────────────────────────────────────────────────────
//  Lavalink
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Report the outcome of a Lavalink release check to the log channel.
 *
 * Goes to DISCORD_LAVALINK_WEBHOOK, falling back to DISCORD_ALERT_WEBHOOK so
 * the feature still reports on a panel that never configured a separate one.
 *
 * @param {Object} report
 * @param {string} report.title
 * @param {number} report.color
 * @param {string} report.version      - the release being moved to
 * @param {string} [report.url]        - GitHub release page
 * @param {string} report.description
 * @param {Array}  report.results      - [{ nodeName, ok, from, error, rolledBack }]
 * @param {Array}  [report.skipped]    - [{ nodeName, state }] nodes that could not take it
 */
const sendLavalinkReport = async ({ title, color, version, url, description, results = [], skipped = [] }) => {
    const webhookUrl = process.env.DISCORD_LAVALINK_WEBHOOK || process.env.DISCORD_ALERT_WEBHOOK;
    if (!webhookUrl) return;

    const line = (r) => {
        const name = `**${r.nodeName}**`;
        if (r.ok === null) return `• ⏳ ${name} — đang ở \`${r.from || r.version || "?"}\``;
        // A node that was stopped keeps its jar swapped but is never started by
        // the scheduled job — say so, or "✅" would read as "it is running now".
        if (r.ok) return `• ✅ ${name} — \`${r.from || "?"}\` → \`${version}\`${r.started === false ? " _(vẫn đang tắt)_" : ""}`;
        return `• ❌ ${name} — ${r.rolledBack ? "đã rollback về bản cũ" : "thất bại"}: ${String(r.error || "").slice(0, 180)}`;
    };

    const fields = [];
    if (results.length) {
        fields.push({ name: "Node", value: results.map(line).join("\n").slice(0, 1024), inline: false });
    }
    if (skipped.length) {
        fields.push({
            name: "Bỏ qua",
            value: skipped.map((s) => `• ${s.nodeName} — \`${s.state}\``).join("\n").slice(0, 1024),
            inline: false,
        });
    }

    await sendWebhook(webhookUrl, {
        embeds: [
            {
                title,
                color,
                url: url || undefined,
                description,
                fields,
                footer: { text: `Lavalink ${version}` },
                timestamp: new Date().toISOString(),
            },
        ],
    });
};

// ─────────────────────────────────────────────────────────────────────────────
//  Backup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send the database file to DISCORD_BACKUP_WEBHOOK.
 *
 * @param {string} filePath - Path to the file to back up
 */
const sendBackup = async (filePath) => {
    const webhookUrl = process.env.DISCORD_BACKUP_WEBHOOK;
    if (!webhookUrl || !fs.existsSync(filePath)) return;

    const form = new FormData();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    
    // Webhook body
    form.append(
        "payload_json",
        JSON.stringify({
            embeds: [
                {
                    title: "💾 Hourly Database Backup",
                    color: 0x5865f2,
                    fields: [
                        {
                            name: "🕐 Timestamp",
                            value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
                            inline: true,
                        },
                    ],
                    footer: { text: "panel.sqlite" },
                    timestamp: new Date().toISOString(),
                },
            ],
        }),
    );

    const content = fs.readFileSync(filePath);

    // Attach as "panel.sqlite"
    form.append("file", content, {
        filename: "panel.sqlite",
        contentType: "application/octet-stream",
    });

    try {
        await axios.post(webhookUrl, form, { headers: form.getHeaders() });
    } catch (err) {
        console.error(`[Discord] Backup error: ${err.message}`);
    }
};

module.exports = {
    sendWebhook,
    sendDM,
    sendExpiryWarning,
    sendExpiryRemoval,
    sendExpirySuspended,
    sendLavalinkReport,
    sendBackup,
};
