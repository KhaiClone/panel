const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const {
    getBuyerBots,
    formatTimeLeft,
    statusEmoji,
    pm2Service,
} = require("../utils/helpers");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("expiry")
        .setDescription(
            "Check how much time is left on your bot subscription(s)",
        ),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const bots = await getBuyerBots(interaction.user.id);

        if (!bots.length) {
            return interaction.editReply({
                content: "❌ You have no bots registered under your account.",
            });
        }

        const now = Date.now();
        const fields = await Promise.all(
            bots.map(async (bot) => {
                const live = await pm2Service.getBotStatus(bot.pm2Name);
                const emoji = statusEmoji(live.status);

                let expiryLine;
                if (!bot.expiresAt) {
                    expiryLine = "♾️ No expiry set";
                } else {
                    const msLeft = bot.expiresAt - now;
                    const expired = msLeft <= 0;
                    expiryLine = expired
                        ? "🚨 **EXPIRED** — contact admin to renew"
                        : `⏳ **${formatTimeLeft(msLeft)}** remaining\n📅 Expires <t:${Math.floor(bot.expiresAt / 1000)}:F>`;
                }

                return {
                    name: `${emoji} ${bot.name} (\`${bot.botID}\`)`,
                    value: expiryLine,
                    inline: false,
                };
            }),
        );

        const embed = new EmbedBuilder()
            .setTitle("📅 Bot Subscription Expiry")
            .setColor(0x5865f2)
            .addFields(fields)
            .setFooter({ text: "Contact the admin if you need to renew." })
            .setTimestamp();

        interaction.editReply({ embeds: [embed] });
    },
};
