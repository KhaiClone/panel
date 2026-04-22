module.exports = {
  name: 'interactionCreate',

  async execute(interaction, client) {
    // Only handle slash commands
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`[BuyerBot] Error in /${interaction.commandName}: ${err.message}`);

      const errorMsg = { content: '❌ Something went wrong. Please try again.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(errorMsg);
      } else {
        await interaction.reply(errorMsg);
      }
    }
  },
};
