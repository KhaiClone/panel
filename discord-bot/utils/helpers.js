const path = require('path');
// Load .env from project root (one level up from discord-bot/)
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const db = require('../../server/db');
const pm2Service = require('../../server/services/pm2Service');

/**
 * Fetch all bots belonging to a Discord user.
 *
 * @param {string} discordUserID - The buyer's Discord user ID
 * @returns {Promise<Object[]>} Array of bot records
 */
const getBuyerBots = async (discordUserID) => {
  return db.find('bots', { buyerID: discordUserID });
};

/**
 * Format milliseconds remaining into a human-readable string.
 * e.g. 1_234_567_890 → "14d 6h 56m"
 *
 * @param {number} ms
 * @returns {string}
 */
const formatTimeLeft = (ms) => {
  if (ms <= 0) return 'Expired';

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.join(' ') || '< 1m';
};

/**
 * Status badge emoji for a PM2 status string.
 */
const statusEmoji = (status) => {
  const map = {
    online: '🟢',
    stopped: '🔴',
    errored: '🟠',
    launching: '🟡',
  };
  return map[status] ?? '⚫';
};

module.exports = { getBuyerBots, formatTimeLeft, statusEmoji, db, pm2Service };
