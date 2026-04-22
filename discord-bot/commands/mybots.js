const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getBuyerBots, formatTimeLeft, statusEmoji, pm2Service } = require('../utils/helpers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mybots')
    .setDescription('List all your bots and their current status'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const bots = await getBuyerBots(interaction.user.id);

    if (!bots.length) {
      return interaction.editReply({
        content: '❌ You have no bots registered under your account.',
      });
    }

    // Fetch live PM2 status for each bot
    const fields = await Promise.all(
      bots.map(async (bot) => {
        const live = await pm2Service.getBotStatus(bot.pm2Name);
        const emoji = statusEmoji(live.status);
        const now = Date.now();
        const msLeft = bot.expiresAt ? bot.expiresAt - now : null;
        const expiryText = msLeft === null
          ? 'No expiry'
          : msLeft <= 0
            ? '⚠️ Expired'
            : `⏳ ${formatTimeLeft(msLeft)} left`;

        return {
          name: `${emoji} ${bot.name} (\`${bot.botID}\`)`,
          value: `Status: **${live.status}** | ${expiryText}`,
          inline: false,
        };
      })
    );

    const embed = new EmbedBuilder()
      .setTitle('🤖 Your Bots')
      .setColor(0x5865f2)
      .addFields(fields)
      .setFooter({ text: `Use /start, /stop, /restart <bot_id> to control your bots` })
      .setTimestamp();

    interaction.editReply({ embeds: [embed] });
  },
};
