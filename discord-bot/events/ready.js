const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'ready',
  once: true,

  async execute(client) {
    console.log(`[BuyerBot] Logged in as ${client.user.tag}`);

    // Build command list from the commands folder
    const commands = [];
    const commandDir = path.join(__dirname, '../commands');
    const files = fs.readdirSync(commandDir).filter((f) => f.endsWith('.js'));

    for (const file of files) {
      const cmd = require(path.join(commandDir, file));
      commands.push(cmd.data.toJSON());
    }

    // Register slash commands globally via REST
    const rest = new REST({ version: '10' }).setToken(process.env.BUYER_BOT_TOKEN);

    try {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log(`[BuyerBot] ${commands.length} slash command(s) registered globally`);
    } catch (err) {
      console.error('[BuyerBot] Failed to register commands:', err.message);
    }
  },
};
