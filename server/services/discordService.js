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
        title: "⚠️ Cảnh báo hết hạn của Bot",
        color,
        description: "**Bot sắp hết hạn!**",
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
                value: `<#1480431381808152586> hoặc tạo ticket tại <#1246028759597846650> để được hỗ trợ.`,
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
        title: "🛑 Bot Hết Hạn & Ngừng Hoạt Động",
        color: 0xff0000,
        description:
            "**Bot của bạn đã hết hạn và đã bị dừng.** Vui lòng gia hạn thời hạn trong vòng 7 ngày để tránh bị xóa vĩnh viễn.",
        fields: [
            { name: "🤖 Tên Bot", value: bot.name, inline: true },
            { name: "🆔 Bot ID", value: `\`${bot.botID}\``, inline: true },
            {
                name: "📅 Hết Hạn Lúc",
                value: `<t:${Math.floor(bot.expiresAt / 1000)}:F>`,
                inline: true,
            },
            {
                name: "🔗 Gia Hạn Bot",
                value: `<#1480431381808152586> hoặc tạo ticket tại <#1246028759597846650> để được hỗ trợ.`,
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
//  Stock (Kho hàng) Expiry — same channels as a bot's: ping on the alert
//  webhook + a DM. Never the item itself: the webhook channel is not private.
// ─────────────────────────────────────────────────────────────────────────────

const RENEW_HINT = `<#1480431381808152586> hoặc tạo ticket tại <#1246028759597846650> để được hỗ trợ.`;

const stockFields = (product, delivery) => [
    { name: "📦 Sản Phẩm", value: product.name, inline: true },
    { name: "🧾 Mã Giao Hàng", value: `\`${delivery.id}\``, inline: true },
    { name: "📅 Hết Hạn Lúc", value: `<t:${Math.floor(delivery.expiresAt / 1000)}:F>`, inline: true },
];

/**
 * @param {{ product: Object, delivery: Object, hoursLeft: number }} args - from stockService
 */
const sendStockExpiryWarning = async ({ product, delivery, hoursLeft }) => {
    const embed = {
        title: "⚠️ Sản Phẩm Sắp Hết Hạn",
        color: hoursLeft <= 24 ? 0xff4444 : hoursLeft <= 72 ? 0xff8c00 : 0xffd700,
        description: `**${product.name}** của bạn sẽ hết hạn sau **${hoursLeft}** giờ nữa.`,
        fields: [...stockFields(product, delivery), { name: "🔗 Gia Hạn", value: RENEW_HINT, inline: false }],
        timestamp: new Date().toISOString(),
    };
    await Promise.all([
        sendWebhook(process.env.DISCORD_ALERT_WEBHOOK, { content: `<@${delivery.buyerId}>`, embeds: [embed] }),
        sendDM(delivery.buyerId, { embeds: [embed] }),
    ]);
};

const sendStockExpired = async ({ product, delivery }) => {
    const embed = {
        title: "🛑 Sản Phẩm Đã Hết Hạn",
        color: 0xff0000,
        description: `**${product.name}** của bạn đã hết hạn. Gia hạn để tiếp tục sử dụng nhé!`,
        fields: [...stockFields(product, delivery), { name: "🔗 Gia Hạn", value: RENEW_HINT, inline: false }],
        timestamp: new Date().toISOString(),
    };
    await Promise.all([
        sendWebhook(process.env.DISCORD_ALERT_WEBHOOK, { content: `<@${delivery.buyerId}>`, embeds: [embed] }),
        sendDM(delivery.buyerId, { embeds: [embed] }),
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

module.exports = {
    sendWebhook,
    sendDM,
    sendExpiryWarning,
    sendExpiryRemoval,
    sendExpirySuspended,
    sendStockExpiryWarning,
    sendStockExpired,
    sendLavalinkReport,
};
