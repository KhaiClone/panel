const QuickDBExtension = require('./QuickDB');
const path = require('path');
const fs = require('fs');

// Ensure the data directory exists before initializing the DB
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

/**
 * Single shared database instance for the entire server.
 * File: /data/panel.sqlite
 *
 * Models used:
 *  - 'bots'  → array of bot records (see routes/bots.js for schema)
 */
const db = new QuickDBExtension({
  filePath: path.join(dataDir, 'panel.sqlite'),
});

module.exports = db;
