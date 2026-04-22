const path = require('path');
// Load .env from project root
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');

if (!process.env.BUYER_BOT_TOKEN) {
  console.error('[BuyerBot] BUYER_BOT_TOKEN is not set in .env');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Client Setup
// ─────────────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ─────────────────────────────────────────────────────────────────────────────
//  Load Commands
// ─────────────────────────────────────────────────────────────────────────────
client.commands = new Collection();

const commandDir = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandDir).filter((f) => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandDir, file));
  if (!command.data || !command.execute) {
    console.warn(`[BuyerBot] Skipping ${file} — missing data or execute`);
    continue;
  }
  client.commands.set(command.data.name, command);
  console.log(`[BuyerBot] Loaded command: /${command.data.name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Load Events
// ─────────────────────────────────────────────────────────────────────────────
const eventDir = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventDir).filter((f) => f.endsWith('.js'));

for (const file of eventFiles) {
  const event = require(path.join(eventDir, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Login
// ─────────────────────────────────────────────────────────────────────────────
client.login(process.env.BUYER_BOT_TOKEN).catch((err) => {
  console.error('[BuyerBot] Login failed:', err.message);
  process.exit(1);
});
