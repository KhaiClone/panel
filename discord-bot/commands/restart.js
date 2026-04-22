const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { pm2Service, db } = require("../utils/helpers");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("restart")
        .setDescription("Restart one of your bots")
        .addStringOption((opt) =>
            opt
                .setName("bot_id")
                .setDescription("The Bot ID to restart")
                .setRequired(true),
        ),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const buyerID = interaction.user.id;
        const botID = interaction.options.getString("bot_id");

        const bot = await db.findOne("bots", { buyerID, botID });
        if (!bot) {
            return interaction.editReply({
                content: `❌ No bot found with ID \`${botID}\`. Use **/mybots** to see your bots.`,
            });
        }

        // Block if expired
        if (bot.expiresAt && Date.now() > bot.expiresAt) {
            return interaction.editReply({
                content:
                    "❌ Your bot subscription has expired. Please contact the admin to renew.",
            });
        }

        try {
            await pm2Service.restartBot(bot.pm2Name);

            const embed = new EmbedBuilder()
                .setTitle("🔄 Bot Restarted")
                .setColor(0xfee75c)
                .addFields(
                    { name: "🤖 Bot", value: bot.name, inline: true },
                    { name: "🆔 ID", value: `\`${bot.botID}\``, inline: true },
                )
                .setTimestamp();

            interaction.editReply({ embeds: [embed] });
        } catch (err) {
            interaction.editReply({
                content: `❌ Failed to restart: \`${err.message}\``,
            });
        }
    },
};
