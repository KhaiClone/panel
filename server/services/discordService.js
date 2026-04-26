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

// ─────────────────────────────────────────────────────────────────────────────
//  Expiry Notifications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send an expiry warning embed to DISCORD_ALERT_WEBHOOK.
 * Color scales from yellow → orange → red as expiry approaches.
 *
 * @param {Object} bot      - Bot record from DB
 * @param {number} daysLeft - Days remaining before expiry
 */
const sendExpiryWarning = async (bot, daysLeft) => {
    const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK;

    // Color: red (<= 1d), orange (<= 3d), yellow (<= 7d)
    const color =
        daysLeft <= 1 ? 0xff4444 : daysLeft <= 3 ? 0xff8c00 : 0xffd700;

    await sendWebhook(webhookUrl, {
        content: `<@${bot.buyerID}>`,
        embeds: [
            {
                title: "⚠️ Bot Expiry Warning",
                color,
                description: "**Bot is expiring soon!**",
                fields: [
                    { name: "🤖 Bot Name", value: bot.name, inline: true },
                    {
                        name: "🆔 Bot ID",
                        value: `\`${bot.botID}\``,
                        inline: true,
                    },
                    {
                        name: "⏳ Days Left",
                        value: `**${daysLeft}** day(s)`,
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
            },
        ],
    });
};

/**
 * Send a notification that a bot was auto-removed due to expiry.
 *
 * @param {Object} bot - Bot record from DB (before deletion)
 */
const sendExpiryRemoval = async (bot) => {
    const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK;

    await sendWebhook(webhookUrl, {
        embeds: [
            {
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
                footer: {
                    text: "Bot folder has been deleted from the server.",
                },
            },
        ],
    });
};

/**
 * Send a notification that a bot was suspended due to expiry.
 *
 * @param {Object} bot - Bot record from DB
 */
const sendExpirySuspended = async (bot) => {
    const webhookUrl = process.env.DISCORD_ALERT_WEBHOOK;

    await sendWebhook(webhookUrl, {
        content: `<@${bot.buyerID}>`,
        embeds: [
            {
                title: "🛑 Bot Expired & Suspended",
                color: 0xff0000,
                description: "**Your bot has expired and has been stopped.** Please extend the expiry within 7 days to avoid permanent deletion.",
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
    sendExpiryWarning,
    sendExpiryRemoval,
    sendExpirySuspended,
    sendBackup,
};
