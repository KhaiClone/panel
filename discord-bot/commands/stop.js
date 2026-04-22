const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { pm2Service, db } = require("../utils/helpers");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Stop one of your bots")
        .addStringOption((opt) =>
            opt
                .setName("bot_id")
                .setDescription("The Bot ID to stop")
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

        try {
            await pm2Service.stopBot(bot.pm2Name);

            const embed = new EmbedBuilder()
                .setTitle("⏹️ Bot Stopped")
                .setColor(0xed4245)
                .addFields(
                    { name: "🤖 Bot", value: bot.name, inline: true },
                    { name: "🆔 ID", value: `\`${bot.botID}\``, inline: true },
                )
                .setTimestamp();

            interaction.editReply({ embeds: [embed] });
        } catch (err) {
            interaction.editReply({
                content: `❌ Failed to stop: \`${err.message}\``,
            });
        }
    },
};
