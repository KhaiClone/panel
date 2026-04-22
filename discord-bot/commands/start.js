const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const path = require("path");
const { getBuyerBots, pm2Service, db } = require("../utils/helpers");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("start")
        .setDescription("Start one of your bots")
        .addStringOption((opt) =>
            opt
                .setName("bot_id")
                .setDescription(
                    "The Bot ID to start (use /mybots to see your IDs)",
                )
                .setRequired(true),
        ),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const buyerID = interaction.user.id;
        const botID = interaction.options.getString("bot_id");

        // Find bot owned by this buyer
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
            const botDir = path.join(
                process.env.BOTS_ROOT_DIR,
                bot.buyerID,
                bot.botID,
            );
            await pm2Service.startBot(bot.pm2Name, botDir, bot.startScript);

            const embed = new EmbedBuilder()
                .setTitle("✅ Bot Started")
                .setColor(0x57f287)
                .addFields(
                    { name: "🤖 Bot", value: bot.name, inline: true },
                    { name: "🆔 ID", value: `\`${bot.botID}\``, inline: true },
                )
                .setTimestamp();

            interaction.editReply({ embeds: [embed] });
        } catch (err) {
            interaction.editReply({
                content: `❌ Failed to start: \`${err.message}\``,
            });
        }
    },
};
